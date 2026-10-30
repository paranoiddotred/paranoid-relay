// Runs server.mjs in front of a stand-in gateway and checks what crosses over: the sealed body and its
// content type go through untouched, nothing that identifies the caller does, and the relay prints nothing.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const RELAY = fileURLToPath(new URL("../server.mjs", import.meta.url));
const seen = [];
let gateway, relay, relayPort, printed = "";

before(async () => {
  gateway = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      if (req.url === "/api/ohttp/config") { res.writeHead(200, { "content-type": "application/ohttp-keys" }); return res.end(Buffer.from([1, 2, 3])); }
      res.writeHead(200, { "content-type": "message/ohttp-res" });
      res.end(Buffer.concat([Buffer.from("sealed answer to: "), Buffer.concat(chunks)]));
    });
  });
  await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
  relayPort = 40_000 + Math.floor(Math.random() * 20_000);
  relay = spawn(process.execPath, [RELAY], {
    env: { ...process.env, PORT: String(relayPort), PARANOID_GATEWAY_URL: `http://127.0.0.1:${gateway.address().port}` },
  });
  relay.stdout.on("data", (b) => (printed += b));
  relay.stderr.on("data", (b) => (printed += b));
  for (let i = 0; i < 50; i++) {
    if ((await call("GET", "/health").catch(() => null))?.status === 200) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("relay did not start");
});

after(() => {
  relay.kill();
  gateway.close();
});

function call(method, path, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: relayPort, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("a sealed request reaches the gateway with its body and nothing about the caller", async () => {
  const sealed = Buffer.from([0, 1, 2, 250, 251, 252, 9, 9, 9]);
  const res = await call("POST", "/gateway", {
    "content-type": "message/ohttp-req",
    "x-forwarded-for": "203.0.113.7",
    "x-real-ip": "203.0.113.7",
    forwarded: "for=203.0.113.7",
    "cf-connecting-ip": "203.0.113.7",
    "user-agent": "Caller Browser 1.0",
    cookie: "session=caller",
    authorization: "Bearer caller",
    referer: "https://example.com/caller",
    "accept-language": "ko-KR",
  }, sealed);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, Buffer.concat([Buffer.from("sealed answer to: "), sealed]));
  const got = seen.at(-1);
  assert.equal(got.url, "/api/ohttp");
  assert.deepEqual(got.body, sealed);
  assert.equal(got.headers["content-type"], "message/ohttp-req");
  const crossed = JSON.stringify(got.headers);
  for (const trace of ["203.0.113.7", "Caller Browser", "session=caller", "Bearer caller", "example.com", "ko-KR"]) {
    assert.ok(!crossed.includes(trace), `the gateway must not see ${trace}: ${crossed}`);
  }
  for (const name of ["x-forwarded-for", "x-real-ip", "forwarded", "cf-connecting-ip", "cookie", "authorization", "referer"]) {
    assert.equal(got.headers[name], undefined, name);
  }
});

test("only the two sealed content types exist upstream", async () => {
  await call("POST", "/gateway", { "content-type": "message/ohttp-chunked-req" }, Buffer.from("x"));
  assert.equal(seen.at(-1).headers["content-type"], "message/ohttp-chunked-req");
  await call("POST", "/gateway", { "content-type": "text/caller-chosen" }, Buffer.from("x"));
  assert.equal(seen.at(-1).headers["content-type"], "message/ohttp-req");
});

test("the gateway's public key is served through the relay", async () => {
  const res = await call("GET", "/config", { "user-agent": "Caller Browser 1.0" });
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "application/ohttp-keys");
  assert.deepEqual(res.body, Buffer.from([1, 2, 3]));
  assert.ok(!JSON.stringify(seen.at(-1).headers).includes("Caller Browser"));
});

test("a body over 1 MB is cut off before anything is sent upstream", async () => {
  const before = seen.length;
  // The relay drops the connection mid-upload rather than reading the rest.
  const res = await call("POST", "/gateway", { "content-type": "message/ohttp-req" }, Buffer.alloc(1_000_001)).catch((e) => e);
  assert.ok(res instanceof Error ? res.code === "ECONNRESET" || /hang up/.test(res.message) : res.status !== 200, String(res));
  assert.equal(seen.length, before);
});

test("browsers may call it only from the site, and other paths do not exist", async () => {
  const pre = await call("OPTIONS", "/gateway", { origin: "https://example.com" });
  assert.equal(pre.headers["access-control-allow-origin"], "https://paranoid.red");
  assert.equal((await call("GET", "/gateway")).status, 404);
  assert.equal((await call("GET", "/anything")).status, 404);
});

test("the relay writes nothing to its output, so there is no log to keep", () => {
  assert.equal(printed, "");
});
