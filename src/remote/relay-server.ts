import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ServerWebSocket } from "bun";

import { calculateProof } from "./proof.ts";

export type PrivateRelayRole = "device" | "terminal";
export type PrivateRelayPairStatus = "matched" | "waiting";

export interface PrivateRelayServerOptions {
  controllerFetch?: (input: URL, init?: RequestInit) => Promise<Response>;
  controllerOrigin?: string;
  hostname?: string;
  maxFrameBytes?: number;
  maxSessions?: number;
  maxSockets?: number;
  now?: () => number;
  port?: number;
  sessionTtlMs?: number;
}

export interface PrivateRelayServer {
  hostname: string;
  port: number;
  stop(): void;
}

interface RelaySession {
  createdAt: number;
  device?: ServerWebSocket<SocketState>;
  deviceMid: string;
  deviceSid: string;
  passHash: string;
  terminal?: ServerWebSocket<SocketState>;
}

interface SocketState {
  challenged?: {
    deviceSid: string;
    nonce: string;
    role: PrivateRelayRole;
  };
  role?: PrivateRelayRole;
  session?: RelaySession;
}

const defaultControllerOrigin = "https://zcode.z.ai";
const defaultHostname = "127.0.0.1";
const defaultMaxFrameBytes = 256 * 1024;
const defaultMaxSessions = 1000;
const defaultMaxSockets = 2000;
const registerSidBytes = 24;
const challengeBytes = 18;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function send(socket: ServerWebSocket<SocketState>, frame: Record<string, unknown>): void {
  try {
    socket.send(JSON.stringify({ ...frame, server_ts: Date.now() }));
  } catch {
    socket.close();
  }
}

function sameString(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function opposite(role: PrivateRelayRole): PrivateRelayRole {
  return role === "device" ? "terminal" : "device";
}

function socketFor(session: RelaySession, role: PrivateRelayRole): ServerWebSocket<SocketState> | undefined {
  return role === "device" ? session.device : session.terminal;
}

function setSocketFor(session: RelaySession, role: PrivateRelayRole, socket: ServerWebSocket<SocketState> | undefined): void {
  if (role === "device") session.device = socket;
  else session.terminal = socket;
}

function pairStatus(session: RelaySession): PrivateRelayPairStatus {
  return session.device !== undefined && session.terminal !== undefined ? "matched" : "waiting";
}

function requestOrigin(request: Request): string {
  const origin = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim();
  const cloudflareScheme = request.headers.get("cf-visitor")?.match(/"scheme"\s*:\s*"(https?)"/u)?.[1];
  const protocol = forwardedProto === "http" || forwardedProto === "https"
    ? forwardedProto
    : cloudflareScheme ?? origin.protocol.slice(0, -1);
  return `${protocol}://${forwardedHost || origin.host}`;
}

function rewriteControllerBody(body: string, request: Request, controllerOrigin: string): string {
  const localHttp = requestOrigin(request);
  const localWs = localHttp.replace(/^http/u, "ws");
  const controller = new URL(controllerOrigin);
  const controllerWs = `${controller.protocol === "https:" ? "wss" : "ws"}://${controller.host}`;
  return body
    .replaceAll(`${controllerWs}/ws`, `${localWs}/ws`)
    .replaceAll(controllerWs, localWs)
    .replaceAll(controllerOrigin, localHttp)
    .replaceAll(controller.host, new URL(request.url).host);
}

function boundedText(raw: string | Buffer, limit: number): string | undefined {
  if (typeof raw === "string") return Buffer.byteLength(raw, "utf8") <= limit ? raw : undefined;
  return raw.byteLength <= limit ? raw.toString("utf8") : undefined;
}

export function startPrivateRelayServer(options: PrivateRelayServerOptions = {}): PrivateRelayServer {
  const controllerFetch = options.controllerFetch ?? fetch;
  const controllerOrigin = options.controllerOrigin ?? defaultControllerOrigin;
  const hostname = options.hostname ?? defaultHostname;
  const maxFrameBytes = options.maxFrameBytes ?? defaultMaxFrameBytes;
  const maxSessions = options.maxSessions ?? defaultMaxSessions;
  const maxSockets = options.maxSockets ?? defaultMaxSockets;
  const now = options.now ?? (() => Date.now());
  const sessions = new Map<string, RelaySession>();
  const sockets = new Set<ServerWebSocket<SocketState>>();

  const expireSessions = (): void => {
    const ttl = options.sessionTtlMs;
    if (ttl === undefined || ttl <= 0) return;
    const cutoff = now() - ttl;
    for (const [deviceSid, session] of sessions) {
      if (session.createdAt > cutoff) continue;
      for (const role of ["device", "terminal"] as const) {
        const socket = socketFor(session, role);
        if (socket !== undefined) send(socket, { type: "error", code: "SESSION_EXPIRED" });
        socket?.close(4011, "session expired");
      }
      sessions.delete(deviceSid);
    }
  };

  const server = Bun.serve<SocketState>({
    fetch: async (request, bunServer) => {
      expireSessions();
      const url = new URL(request.url);
      if (url.pathname === "/ws") {
        if (sockets.size >= maxSockets) return new Response("too many sockets", { status: 503 });
        return bunServer.upgrade(request, { data: {} }) ? undefined : new Response("upgrade failed", { status: 400 });
      }

      const upstream = new URL(`${url.pathname}${url.search}`, controllerOrigin);
      const proxyHeaders = new Headers(request.headers);
      proxyHeaders.delete("host");
      const response = await controllerFetch(upstream, { headers: proxyHeaders, method: "GET" });
      const headers = new Headers(response.headers);
      headers.delete("content-security-policy");
      headers.delete("content-security-policy-report-only");
      headers.delete("content-encoding");
      const contentType = headers.get("content-type") ?? "";
      if (/text|javascript|json|css|html/u.test(contentType)) {
        const body = rewriteControllerBody(await response.text(), request, controllerOrigin);
        headers.set("cache-control", "no-store");
        headers.set("content-length", String(Buffer.byteLength(body)));
        return new Response(body, { headers, status: response.status });
      }
      return new Response(response.body, { headers, status: response.status });
    },
    hostname,
    port: options.port ?? 0,
    websocket: {
      close(socket) {
        sockets.delete(socket);
        const session = socket.data.session;
        const role = socket.data.role;
        if (session !== undefined && role !== undefined && socketFor(session, role) === socket) {
          setSocketFor(session, role, undefined);
          const peer = socketFor(session, opposite(role));
          if (peer !== undefined) send(peer, { type: "pair_status_ack", pair_status: "waiting" });
        }
      },
      message(socket, raw) {
        expireSessions();
        const data = boundedText(raw, maxFrameBytes);
        if (data === undefined) {
          send(socket, { type: "error", code: "FRAME_TOO_LARGE" });
          socket.close(1009, "frame too large");
          return;
        }
        let frame: unknown;
        try {
          frame = JSON.parse(data);
        } catch {
          send(socket, { type: "error", code: "BAD_JSON" });
          return;
        }
        if (!isRecord(frame)) return;
        const type = text(frame.type);

        if (type === "device_register_init") {
          if (sessions.size >= maxSessions) {
            send(socket, { type: "error", code: "SESSION_LIMIT" });
            return;
          }
          const passHash = text(frame.pass_hash);
          const deviceMid = text(frame.device_mid) ?? new URL(socket.remoteAddress ?? "http://local").host;
          if (passHash === undefined) {
            send(socket, { type: "error", code: "BAD_REGISTER" });
            return;
          }
          const deviceSid = randomBytes(registerSidBytes).toString("base64url");
          sessions.set(deviceSid, { createdAt: now(), deviceMid, deviceSid, passHash });
          send(socket, { type: "device_register_ack", device_sid: deviceSid });
          return;
        }

        if (type === "auth_init") {
          const role = text(frame.role) as PrivateRelayRole | undefined;
          const deviceSid = text(frame.device_sid);
          const session = deviceSid === undefined ? undefined : sessions.get(deviceSid);
          if ((role !== "device" && role !== "terminal") || session === undefined) {
            send(socket, { type: "error", code: "SESSION_NOT_FOUND" });
            socket.close(4004, "session not found");
            return;
          }
          const nonce = randomBytes(challengeBytes).toString("base64url");
          socket.data.challenged = { deviceSid: deviceSid!, nonce, role };
          send(socket, { type: "auth_challenge", nonce });
          return;
        }

        if (type === "auth_response") {
          const challenged = socket.data.challenged;
          if (challenged === undefined) {
            send(socket, { type: "error", code: "AUTH_REQUIRED" });
            return;
          }
          const session = sessions.get(challenged.deviceSid);
          const proof = text(frame.proof);
          if (session === undefined || proof === undefined) {
            send(socket, { type: "error", code: "SESSION_NOT_FOUND" });
            socket.close(4004, "session not found");
            return;
          }
          const expected = calculateProof({
            deviceSid: challenged.deviceSid,
            nonce: challenged.nonce,
            passHash: session.passHash,
            role: challenged.role
          });
          if (!sameString(proof, expected)) {
            send(socket, { type: "error", code: "INVALID_PROOF" });
            socket.close(4003, "invalid proof");
            return;
          }

          const previous = socketFor(session, challenged.role);
          if (previous !== undefined && previous !== socket) {
            send(previous, { type: "error", code: "KICKED", message: "A newer connection for this role replaced this socket." });
            previous.close(4009, "session conflict");
          }
          socket.data.session = session;
          socket.data.role = challenged.role;
          setSocketFor(session, challenged.role, socket);
          send(socket, { type: "auth_ack", pair_status: pairStatus(session) });
          const peer = socketFor(session, opposite(challenged.role));
          if (peer !== undefined) send(peer, { type: "pair_status_ack", pair_status: "matched" });
          return;
        }

        const session = socket.data.session;
        const role = socket.data.role;
        if (type === "pair_status_query") {
          send(socket, { type: "pair_status_ack", pair_status: session === undefined ? "waiting" : pairStatus(session) });
          return;
        }
        if (type === "data" && session !== undefined && role !== undefined) {
          const peer = socketFor(session, opposite(role));
          if (peer === undefined) {
            send(socket, { type: "pair_status_ack", pair_status: "waiting" });
            return;
          }
          send(peer, { type: "data", payload: frame.payload });
        }
      },
      open(socket) {
        sockets.add(socket);
      }
    }
  });

  return {
    hostname,
    port: server.port ?? options.port ?? 0,
    stop: () => server.stop(true)
  };
}
