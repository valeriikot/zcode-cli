# Private remote-control relay

`zcode remote` normally pairs devices through the public relay at
`zcode.z.ai`. This repository also ships a standalone, single-instance relay
server that speaks the exact same protocol, so hosts and controllers can pair
through infrastructure you run yourself — typically a loopback service
published through a Cloudflare Tunnel. Nothing about the CLI's defaults
changes: without explicit configuration it keeps using
`https://zcode.z.ai/remote/v4`.

```
controller (zcode remote connect)          host (zcode remote serve)
        |                                          |
        | wss://relay.example.com/ws               | wss://relay.example.com/ws
        v                                          v
   Cloudflare edge ── Cloudflare Tunnel ── cloudflared ── zcode-relay (127.0.0.1:8787)
```

The relay is implemented in `src/relay/` with no dependencies beyond the
Node.js standard library. It relays opaque `data` envelopes between exactly
two roles per session — it cannot decrypt, store or replay workspace traffic,
and it never logs frames, URLs or credentials.

## What the relay implements

- **Device registration** (`device_register_init` → `device_register_ack`):
  a host announces its machine id and pass hash and receives a relay-issued
  device session id (`sid`). Re-registering the same machine id rotates the
  credential and immediately invalidates the old `sid`.
- **Proof authentication** (`auth_init` → `auth_challenge` →
  `auth_response` → `auth_ack`): each connection proves possession of the
  pass hash with an HMAC-SHA256 over a relay-issued nonce, its role and the
  `sid`. Proofs are compared in constant time. Invalid proofs close with
  `4013`, unknown sids with `4004`, expired registrations with `4011` — the
  same close codes the CLI already maps.
- **Pairing**: one `device` (host) and one `terminal` (controller) per `sid`.
  Status changes are pushed to the peer immediately, so payloads queued
  client-side flush without waiting for the next heartbeat.
- **Heartbeat** (`pair_status_query` → `pair_status_ack`) and idle
  detection: silent authenticated connections are dropped after
  `--idle-timeout-seconds` (default 60s), letting the client's reconnect
  logic take over.
- **Deterministic duplicates**: a second connection for an occupied slot
  kicks the old one (`error` frame `KICKED`, close `4009`). The newest
  connection always wins, so a restarted host can always take its slot back,
  and the kicked side never reconnect-loops.
- **Bounded resources**: connection cap (default 256), message-size cap
  (default 1 MiB), registration cap (default 1024), authentication deadline
  (default 15s), header-size and header-time limits, and outbound
  backpressure limits. Malformed frames close the connection with standard
  WebSocket close codes (1002/1003/1008/1009).
- **Optional persistence** (`--state <file>`): registrations survive relay
  restarts, so a relay or tunnel restart never invalidates pairing URLs.
  The file contains credentials and is written atomically with mode `0600`.

## Running the relay

The npm package ships the relay as a second binary, so any machine that installed
`zcode-app-cli` can serve one (Node.js 22.19+ is the only requirement):

```bash
zcode-relay --port 8787 --state ~/.zcode-relay/state.json
```

From a checkout of this repository you can also run the TypeScript source directly:

```bash
bun run relay -- --port 8787 --state ~/.zcode-relay/state.json
```

Or build a single-file Node.js bundle (no Bun required on the server):

```bash
bun run build:relay
node relay/dist/zcode-relay.js --port 8787 --state /var/lib/zcode-relay/state.json
```

Flags (environment fallbacks in parentheses, flags win):

| Flag | Default | Purpose |
| --- | --- | --- |
| `--host` (`ZCODE_RELAY_HOST`) | `127.0.0.1` | Bind address; keep loopback behind a tunnel |
| `--port` (`ZCODE_RELAY_PORT`) | `8787` | TCP port |
| `--state` (`ZCODE_RELAY_STATE`) | in-memory | Registration store file |
| `--page-path` | `/remote/v4` | Path of the pairing info page |
| `--max-connections` | `256` | Concurrent WebSocket cap |
| `--max-message-bytes` | `1048576` | Per-message cap |
| `--max-registrations` | `1024` | Registration store cap |
| `--auth-timeout-seconds` | `15` | Deadline to finish authenticating |
| `--idle-timeout-seconds` | `60` | Drop silent authenticated connections |
| `--registration-ttl-days` | `30` | Expire unused registrations |
| `--controller-origin` (`ZCODE_RELAY_CONTROLLER_ORIGIN`) | off | Mirror the official web controller (see below) |
| `--json` | off | Machine-readable log lines |

Endpoints: `/ws` (relay protocol), `/healthz` (JSON health snapshot with
connection/session/registration counts), and the pairing info page. The
relay speaks plain HTTP because TLS is the tunnel's job; if you expose it
some other way, terminate TLS in front of it.

## Mirroring the official web controller

By default the relay serves a static info page and tells you to pair from a
terminal, because the browser UI at `zcode.z.ai` is wired to the public relay.

`--controller-origin https://zcode.z.ai` changes that. Every path other than
`/ws` and `/healthz` is then fetched from that origin and re-served from
yours, with the controller's origins rewritten to point back at this relay —
so the page you load in a browser drives your own relay over `/ws`:

```bash
node relay/dist/zcode-relay.js --port 8787 \
  --controller-origin https://zcode.z.ai \
  --state /var/lib/zcode-relay/state.json
```

Behind a Cloudflare Tunnel the relay only ever sees plain HTTP on loopback, so
the rewrite reads `x-forwarded-proto`, `x-forwarded-host` and Cloudflare's
`cf-visitor` header to emit the `https://`/`wss://` origin browsers actually
use. Without that the rewritten bundle would point at `ws://` and be blocked.

Worth knowing before turning it on:

- **Only the configured origin is ever fetched.** Request paths are resolved
  against it and rejected unless they land on the same origin, so a
  protocol-relative path such as `//example.invalid/x` cannot make the relay
  fetch a foreign host.
- Requests upstream carry only `accept`, `accept-language` and `user-agent`;
  cookies and tunnel headers are not forwarded.
- Responses are capped at 8 MiB and time out after 15s. The upstream
  `Content-Security-Policy` is dropped because it names the controller's
  origin and would block every rewritten URL.
- The relay still never logs frames, URLs or credentials — pairing URLs carry
  `sid`/`hash` credentials in the query string, so a proxy failure logs a
  fixed message with no request detail.
- You are re-serving someone else's application from your origin, fetched
  live on every request. It changes when they change it.

## Publishing through a Cloudflare Tunnel

A named tunnel gives the relay a stable private hostname on a domain in your
Cloudflare account. One-time setup on the relay machine:

```bash
cloudflared tunnel login
cloudflared tunnel create zcode-relay
cloudflared tunnel route dns zcode-relay relay.example.com
```

Copy `deploy/relay/cloudflared-config.example.yml` to
`~/.cloudflared/config.yml` (or `/etc/cloudflared/config.yml`), fill in the
tunnel id, then run both services. On systemd machines, copy
`deploy/relay/zcode-relay.service` to `/etc/systemd/system/`, adjust the
paths, and:

```bash
sudo systemctl enable --now zcode-relay
sudo cloudflared service install   # installs cloudflared as a service
```

`cloudflared` proxies WebSocket upgrades to the loopback origin unchanged, so
no extra Cloudflare configuration is needed. Because both host and controller
dial *out* to the Cloudflare edge, neither machine needs an open inbound
port.

For a quick throwaway test without a Cloudflare account,
`deploy/relay/quick-tunnel.sh` starts the relay plus a
[quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
(`cloudflared tunnel --url`), which prints a random `*.trycloudflare.com`
hostname.

### Restart behaviour

Both sides reconnect through the existing client logic: the host
(`zcode remote serve`) retries with bounded backoff indefinitely, and a
paired controller reconnects and re-pairs as soon as the relay is back. Run
the relay with `--state` so registrations survive the restart — without it, a
relay restart invalidates every pairing URL and hosts exit with
`session-not-found` until `zcode remote link create` is run again.

## Pointing zcode-cli at the private relay

On the **host** machine (the one being controlled), mint the pairing link
against the private relay and serve:

```bash
zcode remote link create --relay https://relay.example.com/remote/v4 --url-file ./pairing-url.txt
zcode remote serve
```

`--relay` can be omitted by exporting `ZCODE_RELAY_URL`
(`export ZCODE_RELAY_URL=https://relay.example.com/remote/v4`); the flag wins
when both are set, and the public default applies when neither is. `link
create` registers the credentials with the relay over the same WebSocket
endpoint, so the relay must be reachable when the link is created.

On the **controller** machine, register the pairing URL exactly as with the
public relay — the URL itself carries the relay hostname, so no extra
configuration is needed:

```bash
zcode remote add --url-file ./pairing-url.txt --name workstation
zcode remote connect workstation
```

Opening the pairing URL in a browser shows a static info page unless the relay
runs with `--controller-origin`, in which case the official web controller is
mirrored from your relay and the pairing URL drives it directly (see
"Mirroring the official web controller" above). Pairing from the CLI
(`zcode remote add` + `zcode remote connect`) works either way.

## Security notes

- The relay authenticates *possession of the pairing credential*, not user
  identity. Anyone holding a pairing URL can control the host that serves
  it — exactly as with the public relay. Treat pairing URLs and the
  `--state` file as secrets.
- Registration is open by design (mirroring the public relay), bounded by
  `--max-registrations` and the registration TTL. A private hostname plus
  Cloudflare Access in front of the tunnel tightens this further if needed;
  the CLI sends no cookies, so use Access service tokens or network policies
  rather than browser-interactive rules.
- Rotation and revocation work unchanged: `zcode remote link create` mints a
  fresh credential and the relay drops the old one the moment the host
  re-registers; `zcode remote link revoke` plus a relay restart without state
  (or waiting out the TTL) removes it entirely.
