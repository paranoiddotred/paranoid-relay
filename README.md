# PARANOID relay

The relay half of PARANOID's IP shield. When the shield is on, the app seals each question with Oblivious HTTP
([RFC 9458](https://www.rfc-editor.org/rfc/rfc9458)) to the gateway's public key and sends it through a relay.
The relay sees the caller's address and a blob it cannot open. The gateway opens the blob but only ever sees the
relay's address. No single server holds both who is asking and what they asked.

## Who runs it

The relay the app tries first is run by Oblivious Network LLC, a company that only operates Oblivious HTTP
relays, so the relay and the gateway have different owners. This repository is PARANOID's own relay, which the
app falls back to when that one cannot be reached. It is public so anyone can check that it forwards nothing
but the sealed body and its content type, and so anyone can run another one.

## What it does

| Path | What happens |
| --- | --- |
| `POST /gateway` | Forwards the sealed body to the gateway with only its content type, `message/ohttp-req` or `message/ohttp-chunked-req`, and streams the sealed answer back as it arrives. |
| `GET /config` | Serves the gateway's public key, so even fetching the key does not reach the gateway from the caller's address. |
| `GET /health` | Answers `ok`. |

Every upstream request is built from scratch, so forwarding headers, cookies, the browser's user agent and the
caller's address never leave the relay. It keeps no logs and stores nothing, cuts off any body over 1 MB, and
lets browsers call it only from paranoid.red.

## Run your own

It is one file with no dependencies and runs on Node.js 20 or newer.

```bash
node server.mjs
```

or with Docker:

```bash
docker build -t paranoid-relay . && docker run -p 8080:8080 paranoid-relay
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Port to listen on |
| `PARANOID_GATEWAY_URL` | `https://paranoid.red` | The gateway the sealed requests go to |
| `PARANOID_SITE_ORIGIN` | `https://paranoid.red` | The only site browsers may call it from |

## Tests

`node --test test/relay.test.mjs` starts the relay in front of a stand-in gateway and checks that a sealed body
crosses byte for byte with its content type while the caller's address, forwarding headers, cookies, user agent,
referrer and language never do, that a caller cannot choose any other content type, that the public key is
served, that an oversized body is cut off before anything is sent on, that browsers are held to the site, and
that the relay prints nothing at all. CI runs it on Node.js 20, 22 and 24.

## License

[MIT](LICENSE)
