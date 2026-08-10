import { relayWebSocketUrl, type RemoteConnectionParams } from "./connection-params.ts";
import { calculateProof } from "./proof.ts";

export type RelayState =
  | "authenticating"
  | "closed"
  | "connecting"
  | "error"
  | "idle"
  | "kicked"
  | "paired"
  | "reconnecting"
  | "waiting";

export interface RelayFailure {
  message?: string;
  reason: string;
}

export type RelayPayload = Record<string, unknown>;

export type RelayFailureListener = (failure: RelayFailure) => void;
export type RelayPayloadListener = (payload: RelayPayload) => void;
export type RelayStateListener = (state: RelayState) => void;

const relayRole = "terminal";
const defaultClientName = "zcode-app-cli";
const defaultHeartbeatIntervalMs = 10_000;
const defaultHeartbeatAckTimeoutMs = 30_000;
const defaultWaitingTimeoutMs = 30_000;
const defaultMaximumQueuedPayloads = 100;
const abnormalCloseCode = 1006;
const debugDropCloseCode = 3000;
const minimumReconnectDelayMs = 1000;
const maximumReconnectDelayMs = 15_000;
const maximumReconnectExponent = 4;

/** Relay close codes that describe a protocol outcome rather than a transport fault. */
const closeReasons = new Map<number, string>([
  [4004, "session-not-found"],
  [4009, "session-conflict"],
  [4010, "desktop-disconnected"],
  [4011, "session-expired"],
  [4012, "workspace-closed"],
  [4013, "invalid-mobile-connection"]
]);

export function relayCloseReason(code: number): string | undefined {
  return closeReasons.get(code);
}

/** Bounded exponential backoff: 1s, 2s, 4s, 8s, then 15s for every later attempt. */
export function relayReconnectDelayMs(attempt: number): number {
  const exponent = Math.min(Math.max(attempt, 0), maximumReconnectExponent);
  return Math.min(Math.max(minimumReconnectDelayMs * 2 ** exponent, minimumReconnectDelayMs), maximumReconnectDelayMs);
}

export interface RelaySocketHandlers {
  onClose: (code: number, reason: string) => void;
  onError: (message: string) => void;
  onMessage: (data: string) => void;
  onOpen: () => void;
}

/** The slice of a WebSocket the relay protocol needs; unit tests substitute a fake. */
export interface RelaySocket {
  close: (code?: number, reason?: string) => void;
  send: (data: string) => void;
}

export type RelaySocketFactory = (url: URL, handlers: RelaySocketHandlers) => RelaySocket;

function textOf(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return undefined;
}

/** Adapts the Node 22 global `WebSocket` to {@link RelaySocket}. */
export function webSocketRelaySocket(url: URL, handlers: RelaySocketHandlers): RelaySocket {
  const socket = new WebSocket(url);
  try {
    socket.binaryType = "arraybuffer";
  } catch {
    // Some hosts pin binaryType; textOf() copes with whatever arrives instead.
  }
  socket.addEventListener("open", () => handlers.onOpen());
  socket.addEventListener("message", (event) => {
    const text = textOf(event.data);
    if (text !== undefined) handlers.onMessage(text);
  });
  socket.addEventListener("error", () => handlers.onError("relay socket error"));
  socket.addEventListener("close", (event) => handlers.onClose(event.code, event.reason));
  return {
    close: (code, reason) => {
      try {
        socket.close(code, reason);
      } catch {
        // Closing an already-closing socket is not an error worth propagating.
      }
    },
    send: (data) => socket.send(data)
  };
}

export interface RelayClientOptions {
  /** Reported to the desktop as the connected client's name. */
  clientName?: string;
  heartbeatAckTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  maximumQueuedPayloads?: number;
  now?: () => number;
  onLog?: (line: string) => void;
  platform?: string;
  /** Overrides {@link relayReconnectDelayMs}; tests use it to keep reconnects instant. */
  reconnectDelayMs?: (attempt: number) => number;
  socketFactory?: RelaySocketFactory;
  waitingTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function relayPlatformName(platform: NodeJS.Platform): string {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return platform;
}

/**
 * Persistent relay terminal socket: JSON text frames over `ws(s)://<host>/ws`, an HMAC-SHA256
 * pairing proof, a pair-status heartbeat, and bounded reconnect once the desktop has been seen.
 *
 * No frame is ever logged verbatim: `auth_init`/`auth_response` carry the device session id and
 * the pairing proof, which are credentials.
 */
export class RelayClient {
  private readonly clientName: string;
  private readonly failureListeners = new Set<RelayFailureListener>();
  private readonly heartbeatAckTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly maximumQueuedPayloads: number;
  private readonly now: () => number;
  private readonly onLog: ((line: string) => void) | undefined;
  private readonly outboundQueue: RelayPayload[] = [];
  private readonly params: RemoteConnectionParams;
  private readonly payloadListeners = new Set<RelayPayloadListener>();
  private readonly platform: string;
  private readonly reconnectDelayMs: (attempt: number) => number;
  private readonly socketFactory: RelaySocketFactory;
  private readonly stateListeners = new Set<RelayStateListener>();
  private readonly waitingTimeoutMs: number;

  private currentState: RelayState = "idle";
  private disposed = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private intentionallyClosed = false;
  private lastPairStatusAckAt: number;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private socket: RelaySocket | undefined;
  private socketGeneration = 0;
  private waitingTimer: ReturnType<typeof setTimeout> | undefined;
  private wasPaired = false;

  constructor(params: RemoteConnectionParams, options: RelayClientOptions = {}) {
    this.clientName = options.clientName ?? defaultClientName;
    this.heartbeatAckTimeoutMs = options.heartbeatAckTimeoutMs ?? defaultHeartbeatAckTimeoutMs;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? defaultHeartbeatIntervalMs;
    this.maximumQueuedPayloads = options.maximumQueuedPayloads ?? defaultMaximumQueuedPayloads;
    this.now = options.now ?? (() => Date.now());
    this.onLog = options.onLog;
    this.params = params;
    this.platform = options.platform ?? relayPlatformName(process.platform);
    this.reconnectDelayMs = options.reconnectDelayMs ?? relayReconnectDelayMs;
    this.socketFactory = options.socketFactory ?? webSocketRelaySocket;
    this.waitingTimeoutMs = options.waitingTimeoutMs ?? defaultWaitingTimeoutMs;
    this.lastPairStatusAckAt = this.now();
  }

  get state(): RelayState {
    return this.currentState;
  }

  get queuedPayloadCount(): number {
    return this.outboundQueue.length;
  }

  onState(listener: RelayStateListener): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  onPayload(listener: RelayPayloadListener): () => void {
    this.payloadListeners.add(listener);
    return () => {
      this.payloadListeners.delete(listener);
    };
  }

  onFailure(listener: RelayFailureListener): () => void {
    this.failureListeners.add(listener);
    return () => {
      this.failureListeners.delete(listener);
    };
  }

  start(): void {
    this.disposed = false;
    this.intentionallyClosed = false;
    this.reconnectAttempt = 0;
    this.setState("connecting");
    this.connect();
  }

  /**
   * Queues data payloads while unpaired and flushes them once the relay reports `matched`;
   * without the queue, anything sent during a reconnect disappears into a dead socket and the
   * caller waits for its timeout instead.
   */
  sendPayload(payload: RelayPayload): void {
    if (this.currentState !== "paired" || this.socket === undefined) {
      if (this.outboundQueue.length < this.maximumQueuedPayloads) {
        this.outboundQueue.push(payload);
        this.log(`[relay] queued ${String(payload["zcode_type"] ?? "payload")} (state=${this.currentState})`);
      } else {
        this.log(`[relay] dropped ${String(payload["zcode_type"] ?? "payload")}: outbound queue is full`);
      }
      return;
    }
    this.send({ type: "data", payload, client_ts: this.now() });
  }

  /** Diagnostics hook that drops the socket to exercise reconnect and bridge recovery. */
  debugDropSocket(): void {
    this.intentionallyClosed = false;
    const socket = this.socket;
    this.socket = undefined;
    this.socketGeneration += 1;
    socket?.close(debugDropCloseCode, "debug-drop");
    this.handleSocketClosed(abnormalCloseCode, "debug-drop");
  }

  dispose(): void {
    this.disposed = true;
    this.intentionallyClosed = true;
    this.stopHeartbeat();
    this.clearWaitingTimer();
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.socketGeneration += 1;
    socket?.close();
    this.setState("closed");
    this.outboundQueue.length = 0;
    this.failureListeners.clear();
    this.payloadListeners.clear();
    this.stateListeners.clear();
  }

  private log(line: string): void {
    this.onLog?.(line);
  }

  private setState(next: RelayState): void {
    this.currentState = next;
    this.log(`[relay] state -> ${next}`);
    for (const listener of [...this.stateListeners]) {
      try {
        listener(next);
      } catch (error) {
        this.log(`[relay] state listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private connect(): void {
    const previous = this.socket;
    this.socket = undefined;
    this.socketGeneration += 1;
    previous?.close();

    const generation = this.socketGeneration;
    const url = relayWebSocketUrl(this.params);
    this.log(`[relay] connecting ${url.host}${url.pathname}`);
    let socket: RelaySocket;
    try {
      socket = this.socketFactory(url, {
        onClose: (code, reason) => {
          if (generation !== this.socketGeneration) return;
          this.socket = undefined;
          this.handleSocketClosed(code, reason);
        },
        onError: (message) => {
          if (generation === this.socketGeneration) this.log(`[relay] ${message}`);
        },
        onMessage: (data) => {
          if (generation === this.socketGeneration) this.handleRawMessage(data);
        },
        onOpen: () => {
          if (generation === this.socketGeneration) this.handleSocketOpen();
        }
      });
    } catch (error) {
      this.log(`[relay] connect failed: ${error instanceof Error ? error.message : String(error)}`);
      this.handleSocketClosed(abnormalCloseCode, "connect failed");
      return;
    }
    if (this.disposed) {
      socket.close();
      return;
    }
    this.socket = socket;
  }

  private handleSocketOpen(): void {
    this.setState("authenticating");
    this.send({
      type: "auth_init",
      role: relayRole,
      device_sid: this.params.deviceSid,
      meta: {
        platform: this.platform,
        version: this.params.appVersion ?? "web",
        name: this.clientName
      },
      client_ts: this.now()
    });
  }

  private send(frame: Record<string, unknown>): void {
    const socket = this.socket;
    if (socket === undefined) return;
    this.log(`[relay] >> ${String(frame["type"])}`);
    try {
      socket.send(JSON.stringify(frame));
    } catch (error) {
      this.log(`[relay] send failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private flushOutboundQueue(): void {
    if (this.outboundQueue.length === 0) return;
    this.log(`[relay] flushing ${this.outboundQueue.length} queued payload(s)`);
    const queued = this.outboundQueue.splice(0);
    for (const payload of queued) this.send({ type: "data", payload, client_ts: this.now() });
  }

  private handleRawMessage(data: string): void {
    let frame: Record<string, unknown>;
    try {
      const decoded: unknown = JSON.parse(data);
      if (!isRecord(decoded) || !("type" in decoded)) return;
      frame = decoded;
    } catch (error) {
      this.log(`[relay] bad frame: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const type = stringField(frame["type"]);
    this.log(`[relay] << ${type ?? "unknown"}`);
    if (type === "auth_challenge") {
      this.send({
        type: "auth_response",
        device_sid: this.params.deviceSid,
        proof: calculateProof({
          deviceSid: this.params.deviceSid,
          nonce: stringField(frame["nonce"]) ?? "",
          passHash: this.params.passHash,
          role: relayRole
        }),
        client_ts: this.now()
      });
      return;
    }
    if (type === "auth_ack" || type === "pair_status_ack") {
      this.applyPairStatus(stringField(frame["pair_status"]));
      return;
    }
    if (type === "data") {
      const payload = frame["payload"];
      if (isRecord(payload)) this.emitPayload(payload);
      return;
    }
    if (type === "error") {
      this.handleRelayError(stringField(frame["code"]), stringField(frame["message"]));
    }
  }

  private emitPayload(payload: RelayPayload): void {
    for (const listener of [...this.payloadListeners]) {
      try {
        listener(payload);
      } catch (error) {
        this.log(`[relay] payload listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private emitFailure(failure: RelayFailure): void {
    for (const listener of [...this.failureListeners]) {
      try {
        listener(failure);
      } catch (error) {
        this.log(`[relay] failure listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private applyPairStatus(status: string | undefined): void {
    this.lastPairStatusAckAt = this.now();
    if (status === "waiting") {
      // A previously paired session that drops back to waiting is a desktop restart, not a
      // mispaired device, so it keeps the heartbeat instead of arming the pairing deadline.
      if (this.wasPaired) {
        this.clearWaitingTimer();
        this.setState("waiting");
        this.startHeartbeat();
        return;
      }
      this.setState("waiting");
      this.startWaitingTimer();
      return;
    }
    if (status !== "matched") return;
    this.reconnectAttempt = 0;
    this.clearWaitingTimer();
    this.setState("paired");
    this.wasPaired = true;
    this.startHeartbeat();
    this.flushOutboundQueue();
  }

  private handleRelayError(code: string | undefined, message: string | undefined): void {
    this.log(`[relay] error frame: ${code ?? "unknown"}`);
    if (code !== "KICKED") return;
    this.setState("kicked");
    this.intentionallyClosed = true;
    this.emitFailure({ reason: "kicked", ...(message !== undefined ? { message } : {}) });
    const socket = this.socket;
    this.socket = undefined;
    this.socketGeneration += 1;
    socket?.close();
  }

  private handleSocketClosed(code: number, reason: string | undefined): void {
    if (this.disposed) return;
    this.stopHeartbeat();
    this.clearWaitingTimer();
    const mapped = relayCloseReason(code);
    this.log(`[relay] closed code=${code} mapped=${mapped ?? "none"}`);
    if (this.intentionallyClosed) return;
    if (this.wasPaired || mapped === "desktop-disconnected") {
      this.scheduleReconnect();
      return;
    }
    this.setState("error");
    this.emitFailure({
      reason: mapped ?? "relay-unavailable",
      message: reason !== undefined && reason.length > 0 ? reason : `connection closed (${code})`
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.currentState !== "paired" && this.currentState !== "waiting") return;
      if (this.now() - this.lastPairStatusAckAt > this.heartbeatAckTimeoutMs) {
        this.log("[relay] heartbeat ack timeout, reconnecting");
        if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
        this.setState("reconnecting");
        this.connect();
        return;
      }
      this.send({ type: "pair_status_query", device_sid: this.params.deviceSid, client_ts: this.now() });
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private startWaitingTimer(): void {
    this.clearWaitingTimer();
    this.waitingTimer = setTimeout(() => {
      if (this.currentState !== "waiting" || this.wasPaired) return;
      this.setState("error");
      this.emitFailure({
        reason: "invalid-mobile-connection",
        message: "The desktop did not match this connection before the pairing timeout."
      });
    }, this.waitingTimeoutMs);
    this.waitingTimer.unref?.();
  }

  private clearWaitingTimer(): void {
    if (this.waitingTimer !== undefined) clearTimeout(this.waitingTimer);
    this.waitingTimer = undefined;
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.intentionallyClosed) return;
    this.setState("reconnecting");
    const delay = this.reconnectDelayMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.log(`[relay] reconnect in ${delay}ms (attempt ${this.reconnectAttempt})`);
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.disposed) this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
