import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { basename, dirname, join } from "node:path";

import {
  RelayCore,
  type RelayCoreSnapshot,
  type RelayRegistrationRecord
} from "./core.ts";
import { acceptWebSocketUpgrade, webSocketCloseCodes, type ServerWebSocket } from "./websocket.ts";

const defaultHost = "127.0.0.1";
const defaultPort = 8787;
const defaultPagePath = "/remote/v4";
const defaultMaximumConnections = 256;
const defaultSweepIntervalMs = 1000;
const defaultControllerTimeoutMs = 15_000;
const defaultMaximumControllerBodyBytes = 8 * 1024 * 1024;
const requestHeaderTimeoutMs = 10_000;
const maximumRequestHeaderBytes = 16 * 1024;
const stateSaveDebounceMs = 250;
const stateVersion = 1;
const webSocketPath = "/ws";

export interface RelayServerOptions {
  authTimeoutMs?: number;
  /** Injection point for tests; defaults to the global `fetch`. */
  controllerFetch?: (url: URL, init: RequestInit) => Promise<Response>;
  /**
   * Origin of the official web controller to mirror at every non-relay path, e.g.
   * `https://zcode.z.ai`. Unset (the default) serves the static pairing page instead and nothing
   * ever leaves this machine.
   */
  controllerOrigin?: string;
  controllerTimeoutMs?: number;
  host?: string;
  idleTimeoutMs?: number;
  maximumConnections?: number;
  /** Cap on a single proxied controller response held in memory before rewriting. */
  maximumControllerBodyBytes?: number;
  maximumMessageBytes?: number;
  maximumRegistrations?: number;
  now?: () => number;
  onLog?: (line: string) => void;
  /** Path served with the pairing info page; defaults to `/remote/v4` to mirror zcode.z.ai. */
  pagePath?: string;
  port?: number;
  registrationTtlMs?: number;
  /** Registration store file. Unset keeps registrations in memory only. */
  statePath?: string;
  sweepIntervalMs?: number;
}

export interface RelayServerSnapshot extends RelayCoreSnapshot {
  uptimeMs: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Static pairing page. Pairing URLs open this path carrying `sid`/`hash` query credentials, so the
 * response (and the server's logging) must never reflect anything from the request back.
 */
const pageHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>ZCode private relay</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1rem; line-height: 1.5; }
  code { background: rgba(127, 127, 127, 0.15); padding: 0.1rem 0.35rem; border-radius: 0.25rem; }
</style>
</head>
<body>
<h1>ZCode private relay</h1>
<p>This host relays ZCode remote-control sessions between your own devices. The official web
remote control is not hosted here.</p>
<p>If you opened a pairing link, register it from a terminal instead:</p>
<ol>
<li>Save the full pairing URL to a file (it is a device credential).</li>
<li>Run <code>zcode remote add --url-file &lt;file&gt;</code> on the controlling machine.</li>
<li>Run <code>zcode remote connect</code> to pair with the host.</li>
</ol>
<p>The host machine keeps <code>zcode remote serve</code> running to stay reachable.</p>
</body>
</html>
`;

async function writeStateFile(path: string, records: RelayRegistrationRecord[]): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let file;
  try {
    file = await open(temporaryPath, "wx", 0o600);
    await file.writeFile(`${JSON.stringify({ version: stateVersion, registrations: records }, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporaryPath, path);
  } finally {
    await file?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function readStateFile(path: string): Promise<unknown[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw new Error(`Unable to read the relay state file ${path}: ${errorMessage(error)}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`The relay state file ${path} is not valid JSON.`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["registrations"])) {
    throw new Error(`The relay state file ${path} does not contain a registration list.`);
  }
  return parsed["registrations"];
}

interface ParsedHttpRequest {
  headers: Record<string, string>;
  method: string;
  path: string;
}

/**
 * Parses one HTTP/1.1 request head. The relay speaks just enough HTTP for a health endpoint, a
 * static page and the WebSocket handshake — every plain response closes the connection, so
 * keep-alive, bodies and chunking never come into play.
 */
function parseHttpRequestHead(head: Buffer): ParsedHttpRequest | undefined {
  const lines = head.toString("latin1").split("\r\n");
  const requestLine = lines[0] ?? "";
  const parts = requestLine.split(" ");
  if (parts.length !== 3 || !parts[2]!.startsWith("HTTP/1.")) return undefined;
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    if (line.length === 0) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) return undefined;
    const name = line.slice(0, separator).trim().toLowerCase();
    if (!(name in headers)) headers[name] = line.slice(separator + 1).trim();
  }
  return { headers, method: parts[0]!, path: parts[1]! };
}

interface HttpResponse {
  body?: Buffer | string;
  /** An array value repeats the header, which `set-cookie` needs. */
  headers?: Record<string, string | string[]>;
  status: number;
  statusText: string;
}

function writeHttpResponse(socket: Socket, method: string, response: HttpResponse): void {
  const body = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body ?? "", "utf8");
  const lines = [
    `HTTP/1.1 ${response.status} ${response.statusText}`,
    "connection: close",
    `content-length: ${body.length}`
  ];
  for (const [name, value] of Object.entries(response.headers ?? {})) {
    for (const single of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${single}`);
  }
  try {
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (method !== "HEAD" && body.length > 0) socket.write(body);
    socket.end();
  } catch {
    socket.destroy();
  }
}

/** Request headers passed upstream. An allowlist keeps cookies and tunnel headers off the wire. */
const forwardedControllerRequestHeaders = ["accept", "accept-language", "user-agent"] as const;

/** Response headers the relay must own rather than copy from upstream. */
const strippedControllerResponseHeaders = new Set([
  "connection",
  // `fetch` already decoded the payload, and rewriting changes its length.
  "content-encoding",
  "content-length",
  // The upstream policy names the controller's origin and would block every rewritten URL.
  "content-security-policy",
  "content-security-policy-report-only",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const rewritableControllerTypes = /\b(?:css|html|javascript|json|text|xml)\b/u;

function firstHeaderValue(raw: string | undefined): string | undefined {
  const value = raw?.split(",", 1)[0]?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * The origin browsers actually use to reach this relay. Behind a Cloudflare Tunnel the relay only
 * ever sees plain HTTP on loopback, so the forwarded headers are the only evidence that the public
 * origin is HTTPS — rewriting the bundle to `http://`/`ws://` there would break the controller.
 */
function requestOrigin(request: ParsedHttpRequest, fallbackHost: string): string {
  const forwardedProtocol = firstHeaderValue(request.headers["x-forwarded-proto"]);
  const cloudflareScheme = request.headers["cf-visitor"]?.match(/"scheme"\s*:\s*"(https?)"/u)?.[1];
  const protocol = forwardedProtocol === "http" || forwardedProtocol === "https"
    ? forwardedProtocol
    : cloudflareScheme ?? "http";
  const host = firstHeaderValue(request.headers["x-forwarded-host"])
    ?? firstHeaderValue(request.headers["host"])
    ?? fallbackHost;
  return `${protocol}://${host}`;
}

/** Reduces a controller origin to bare `scheme://host[:port]`, rejecting anything else. */
export function normalizeControllerOrigin(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("The controller origin must be an absolute http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("The controller origin must use http or https.");
  }
  return parsed.origin;
}

/**
 * Resolves a request path against the controller origin, refusing anything that lands elsewhere.
 * Without the origin check a protocol-relative path such as `//example.invalid/x` resolves to a
 * foreign host and turns the relay into an open proxy.
 */
export function controllerTarget(path: string, controllerOrigin: string): URL | undefined {
  if (!path.startsWith("/")) return undefined;
  try {
    const target = new URL(path, controllerOrigin);
    return target.origin === new URL(controllerOrigin).origin ? target : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Points the controller bundle back at this relay so the page opens a WebSocket to `/ws` here
 * instead of the public relay. Absolute origins are rewritten first, then bare hostnames, which
 * covers the host-only forms the bundle builds URLs from at runtime.
 */
export function rewriteControllerBody(body: string, localOrigin: string, controllerOrigin: string): string {
  const controller = new URL(controllerOrigin);
  const controllerWebSocket = `${controller.protocol === "https:" ? "wss" : "ws"}://${controller.host}`;
  const local = new URL(localOrigin);
  const localWebSocket = `${local.protocol === "https:" ? "wss" : "ws"}://${local.host}`;
  return body
    .replaceAll(controllerWebSocket, localWebSocket)
    .replaceAll(controller.origin, local.origin)
    .replaceAll(controller.host, local.host);
}

/** Reads at most `limit` bytes, returning `undefined` when the response exceeds it. */
async function readBoundedBody(response: Response, limit: number): Promise<Buffer | undefined> {
  const stream = response.body;
  if (stream === null) return Buffer.alloc(0);
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) return undefined;
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
    if (total > limit) await stream.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}

/**
 * The runnable relay: a plain `node:net` server speaking minimal HTTP/1.1 — `/ws` (relay
 * protocol), `/healthz` (deployment health) and the pairing info page. HTTP is hand-parsed so the
 * exact same code path runs under Node and Bun (Bun's `node:http` upgrade sockets drop server
 * writes). Designed to sit behind a Cloudflare Tunnel on a loopback port, so it speaks plain HTTP
 * and binds 127.0.0.1 by default.
 */
export class RelayServer {
  private readonly controllerFetch: (url: URL, init: RequestInit) => Promise<Response>;
  private readonly controllerOrigin: string | undefined;
  private readonly controllerTimeoutMs: number;
  private readonly core: RelayCore;
  private readonly maximumConnections: number;
  private readonly maximumControllerBodyBytes: number;
  private readonly maximumMessageBytes: number | undefined;
  private readonly now: () => number;
  private readonly onLog: ((line: string) => void) | undefined;
  private readonly pagePath: string;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly startedAt: number;
  private readonly statePath: string | undefined;
  private readonly webSockets = new Set<ServerWebSocket>();

  private closed = false;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private savingChain: Promise<void> = Promise.resolve();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  private constructor(options: RelayServerOptions) {
    this.controllerFetch = options.controllerFetch ?? ((url, init) => fetch(url, init));
    this.controllerOrigin = normalizeControllerOrigin(options.controllerOrigin);
    this.controllerTimeoutMs = options.controllerTimeoutMs ?? defaultControllerTimeoutMs;
    this.maximumConnections = options.maximumConnections ?? defaultMaximumConnections;
    this.maximumControllerBodyBytes = options.maximumControllerBodyBytes ?? defaultMaximumControllerBodyBytes;
    this.maximumMessageBytes = options.maximumMessageBytes;
    this.now = options.now ?? (() => Date.now());
    this.onLog = options.onLog;
    this.pagePath = options.pagePath ?? defaultPagePath;
    this.startedAt = this.now();
    this.statePath = options.statePath;
    this.core = new RelayCore({
      ...(options.authTimeoutMs !== undefined ? { authTimeoutMs: options.authTimeoutMs } : {}),
      ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
      ...(options.maximumRegistrations !== undefined
        ? { maximumRegistrations: options.maximumRegistrations }
        : {}),
      now: this.now,
      ...(options.onLog !== undefined ? { onLog: options.onLog } : {}),
      onRegistrationsChanged: () => this.scheduleStateSave(),
      ...(options.registrationTtlMs !== undefined ? { registrationTtlMs: options.registrationTtlMs } : {})
    });
    this.server = createServer((socket) => this.handleConnection(socket));
    this.sweepTimer = setInterval(() => this.core.tick(), options.sweepIntervalMs ?? defaultSweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  static async start(options: RelayServerOptions = {}): Promise<RelayServer> {
    const relay = new RelayServer(options);
    if (relay.statePath !== undefined) {
      const loaded = relay.core.loadRegistrations(await readStateFile(relay.statePath));
      relay.log(`[relay] loaded ${loaded} registration(s) from ${relay.statePath}`);
      // An eager write surfaces an unwritable state path at startup instead of on first use.
      await writeStateFile(relay.statePath, relay.core.registrationRecords());
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        relay.server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        relay.server.off("error", onError);
        resolve();
      };
      relay.server.once("error", onError);
      relay.server.once("listening", onListening);
      relay.server.listen(options.port ?? defaultPort, options.host ?? defaultHost);
    });
    return relay;
  }

  get port(): number {
    const address = this.server.address();
    if (address === null || typeof address === "string") throw new Error("The relay server is not listening.");
    return address.port;
  }

  snapshot(): RelayServerSnapshot {
    return { ...this.core.snapshot(), uptimeMs: this.now() - this.startedAt };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    for (const webSocket of [...this.webSockets]) {
      webSocket.close(webSocketCloseCodes.goingAway, "relay shutting down");
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      for (const socket of [...this.sockets]) socket.destroy();
    });
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      this.queueStateSave();
    }
    await this.savingChain;
  }

  private log(line: string): void {
    this.onLog?.(line);
  }

  private scheduleStateSave(): void {
    if (this.statePath === undefined) return;
    if (this.saveTimer !== undefined) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.queueStateSave();
    }, stateSaveDebounceMs);
    this.saveTimer.unref?.();
  }

  /** Saves are chained so a slow disk cannot interleave two atomic writes. */
  private queueStateSave(): void {
    const path = this.statePath;
    if (path === undefined) return;
    const records = this.core.registrationRecords();
    this.savingChain = this.savingChain
      .then(() => writeStateFile(path, records))
      .catch((error: unknown) => {
        this.log(`[relay] failed to persist state: ${errorMessage(error)}`);
      });
  }

  /** Buffers one request head per connection, then routes to HTTP handling or the upgrade path. */
  private handleConnection(socket: Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());

    let buffer: Buffer = Buffer.alloc(0);
    let routed = false;
    const headerTimer = setTimeout(() => {
      if (!routed) socket.destroy();
    }, requestHeaderTimeoutMs);
    headerTimer.unref?.();

    const onData = (chunk: Buffer): void => {
      if (routed) return;
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      const headEnd = buffer.indexOf("\r\n\r\n");
      if (headEnd === -1) {
        if (buffer.length > maximumRequestHeaderBytes) {
          routed = true;
          clearTimeout(headerTimer);
          writeHttpResponse(socket, "GET", { status: 431, statusText: "Request Header Fields Too Large" });
        }
        return;
      }
      routed = true;
      clearTimeout(headerTimer);
      socket.off("data", onData);
      const request = parseHttpRequestHead(buffer.subarray(0, headEnd));
      const rest = Buffer.from(buffer.subarray(headEnd + 4));
      buffer = Buffer.alloc(0);
      if (request === undefined) {
        writeHttpResponse(socket, "GET", { status: 400, statusText: "Bad Request", body: "bad request\n" });
        return;
      }
      this.route(socket, request, rest);
    };
    socket.on("data", onData);
  }

  private route(socket: Socket, request: ParsedHttpRequest, head: Buffer): void {
    const path = request.path.split("?", 1)[0] ?? "/";
    const wantsUpgrade = request.headers["upgrade"]?.toLowerCase() === "websocket";
    if (wantsUpgrade) {
      if (path !== webSocketPath) {
        writeHttpResponse(socket, request.method, { status: 404, statusText: "Not Found" });
        return;
      }
      this.acceptRelaySocket(socket, request, head);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      writeHttpResponse(socket, request.method, {
        status: 405,
        statusText: "Method Not Allowed",
        body: "method not allowed\n",
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
      return;
    }
    if (path === "/healthz") {
      writeHttpResponse(socket, request.method, {
        status: 200,
        statusText: "OK",
        body: `${JSON.stringify({ ok: true, ...this.snapshot() })}\n`,
        headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" }
      });
      return;
    }
    // Mirroring the controller replaces the static page: the real UI has to answer every asset path.
    if (this.controllerOrigin !== undefined) {
      void this.proxyController(socket, request, this.controllerOrigin);
      return;
    }
    if (path === this.pagePath || path === "/") {
      writeHttpResponse(socket, request.method, {
        status: 200,
        statusText: "OK",
        body: pageHtml,
        headers: {
          "cache-control": "no-store",
          "content-type": "text/html; charset=utf-8",
          "referrer-policy": "no-referrer",
          "x-robots-tag": "noindex"
        }
      });
      return;
    }
    writeHttpResponse(socket, request.method, {
      status: 404,
      statusText: "Not Found",
      body: "not found\n",
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }

  /**
   * Serves the official web controller from this origin. Fetching it here and rewriting its
   * origins is what lets the real UI drive a private relay: the browser loads one origin, so the
   * page's WebSocket lands on `/ws` above instead of the public relay.
   *
   * Pairing URLs carry `sid`/`hash` credentials in the query string, so nothing derived from the
   * request — path, query or upstream error text — is ever logged.
   */
  private async proxyController(socket: Socket, request: ParsedHttpRequest, controllerOrigin: string): Promise<void> {
    const target = controllerTarget(request.path, controllerOrigin);
    if (target === undefined) {
      writeHttpResponse(socket, request.method, {
        status: 404,
        statusText: "Not Found",
        body: "not found\n",
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
      return;
    }

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.controllerTimeoutMs);
    timer.unref?.();
    try {
      const headers: Record<string, string> = {};
      for (const name of forwardedControllerRequestHeaders) {
        const value = request.headers[name];
        if (value !== undefined) headers[name] = value;
      }
      const upstream = await this.controllerFetch(target, {
        headers,
        method: "GET",
        redirect: "follow",
        signal: abort.signal
      });
      const body = await readBoundedBody(upstream, this.maximumControllerBodyBytes);
      if (body === undefined) {
        this.log("[relay] controller response exceeded the size cap");
        writeHttpResponse(socket, request.method, {
          status: 502,
          statusText: "Bad Gateway",
          body: "controller response too large\n",
          headers: { "content-type": "text/plain; charset=utf-8" }
        });
        return;
      }

      const responseHeaders: Record<string, string | string[]> = {};
      for (const [name, value] of upstream.headers) {
        if (strippedControllerResponseHeaders.has(name)) continue;
        // A header smuggled through upstream must never break out of the response head.
        if (/[\r\n]/u.test(name) || /[\r\n]/u.test(value)) continue;
        if (name === "set-cookie") continue;
        responseHeaders[name] = value;
      }
      const cookies = upstream.headers.getSetCookie?.() ?? [];
      const safeCookies = cookies.filter((cookie) => !/[\r\n]/u.test(cookie));
      if (safeCookies.length > 0) responseHeaders["set-cookie"] = safeCookies;

      const contentType = upstream.headers.get("content-type") ?? "";
      if (rewritableControllerTypes.test(contentType)) {
        const localOrigin = requestOrigin(request, `${defaultHost}:${this.port}`);
        responseHeaders["cache-control"] = "no-store";
        writeHttpResponse(socket, request.method, {
          status: upstream.status,
          statusText: upstream.statusText || "OK",
          body: rewriteControllerBody(body.toString("utf8"), localOrigin, controllerOrigin),
          headers: responseHeaders
        });
        return;
      }
      writeHttpResponse(socket, request.method, {
        status: upstream.status,
        statusText: upstream.statusText || "OK",
        body,
        headers: responseHeaders
      });
    } catch {
      this.log("[relay] controller request failed");
      writeHttpResponse(socket, request.method, {
        status: 502,
        statusText: "Bad Gateway",
        body: "controller unavailable\n",
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private acceptRelaySocket(socket: Socket, request: ParsedHttpRequest, head: Buffer): void {
    if (this.closed || this.webSockets.size >= this.maximumConnections) {
      writeHttpResponse(socket, request.method, {
        status: 503,
        statusText: "Service Unavailable",
        headers: { "retry-after": "5" }
      });
      this.log("[relay] rejected connection: connection limit reached");
      return;
    }
    let handle: { id: number } | undefined;
    const webSocket = acceptWebSocketUpgrade({
      handlers: {
        onActivity: () => {
          if (handle !== undefined) this.core.activity(handle);
        },
        onClose: () => {
          if (webSocket !== undefined) this.webSockets.delete(webSocket);
          if (handle !== undefined) this.core.closed(handle);
        },
        onMessage: (text) => {
          if (handle !== undefined) this.core.message(handle, text);
        }
      },
      options: {
        ...(this.maximumMessageBytes !== undefined ? { maximumMessageBytes: this.maximumMessageBytes } : {})
      },
      request,
      socket
    });
    if (webSocket === undefined) {
      this.log("[relay] rejected connection: invalid websocket upgrade");
      return;
    }
    this.webSockets.add(webSocket);
    handle = this.core.open({
      close: (code, reason) => webSocket.close(code, reason),
      send: (text) => webSocket.sendText(text)
    });
    // Frame bytes that arrived glued to the upgrade request are replayed only after the core
    // connection exists, so a fast client's first frame cannot be dropped.
    if (head.length > 0) webSocket.acceptBytes(head);
  }
}
