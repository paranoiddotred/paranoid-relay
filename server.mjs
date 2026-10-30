// PARANOID's IP shield relay, as a tiny standalone server on its own Railway service.
// It forwards opaque sealed blobs to the gateway and keeps nothing: no logs, no storage, and it
// rebuilds every upstream request from scratch so the caller's address never reaches the gateway.
import { createServer } from "node:http";

const UPSTREAM = (process.env.PARANOID_GATEWAY_URL ?? "https://paranoid.red").replace(/\/$/, "");
const ORIGIN = process.env.PARANOID_SITE_ORIGIN ?? "https://paranoid.red";
const MAX = 1_000_000;
const cors = { "access-control-allow-origin": ORIGIN, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, incremental", "access-control-max-age": "86400", vary: "origin" };

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size > MAX) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Each piece goes on as it arrives, so a sealed answer that streams keeps streaming.
async function pass(res, upstream, fallbackType, cache) {
  res.writeHead(upstream.status, { ...cors, "content-type": upstream.headers.get("content-type") ?? fallbackType, "cache-control": cache });
  if (upstream.body) for await (const piece of upstream.body) res.write(piece);
  res.end();
}

createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://relay").pathname;
    if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
    if (path === "/config" && req.method === "GET") {
      return pass(res, await fetch(`${UPSTREAM}/api/ohttp/config`, { cache: "no-store" }), "application/ohttp-keys", "public, max-age=3600");
    }
    if (path === "/gateway" && req.method === "POST") {
      const body = await readBody(req);
      // Only the content type (plain or chunked) crosses over: no forwarding headers, no client address.
      // A caller who leaves stops the upstream answer too.
      const gone = new AbortController();
      res.on("close", () => gone.abort());
      const type = req.headers["content-type"] === "message/ohttp-chunked-req" ? "message/ohttp-chunked-req" : "message/ohttp-req";
      const up = await fetch(`${UPSTREAM}/api/ohttp`, { method: "POST", headers: { "content-type": type }, body, signal: gone.signal });
      return pass(res, up, "message/ohttp-res", "no-store");
    }
    if (path === "/health") { res.writeHead(200, { "content-type": "text/plain" }); return res.end("ok"); }
    res.writeHead(404, cors); res.end();
  } catch {
    if (!res.headersSent) res.writeHead(502, cors);
    res.end();
  }
}).listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
