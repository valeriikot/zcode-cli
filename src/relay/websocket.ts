import { createHash } from "node:crypto";

const webSocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const defaultMaximumMessageBytes = 1024 * 1024;
const defaultMaximumBufferedBytes = 4 * 1024 * 1024;
const closeLingerMs = 2_000;
const maximumControlPayloadBytes = 125;

const opcodes = {
  binary: 0x2,
  close: 0x8,
  continuation: 0x0,
  ping: 0x9,
  pong: 0xa,
  text: 0x1
} as const;

/** RFC 6455 close codes the relay uses; protocol-outcome codes (4xxx) live in the relay core. */
export const webSocketCloseCodes = {
  abnormal: 1006,
  goingAway: 1001,
  messageTooBig: 1009,
  normal: 1000,
  policyViolation: 1008,
  protocolError: 1002,
  tryAgainLater: 1013,
  unsupportedData: 1003
} as const;

/**
 * The slice of a `net.Socket`/`Duplex` the WebSocket layer needs; unit tests substitute a fake.
 * The listener signature mirrors Node's own `EventEmitter.on` so every stream type fits.
 */
export interface WebSocketStream {
  destroy(): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches EventEmitter.on
  on(event: string, listener: (...args: any[]) => void): unknown;
  write(chunk: Buffer | string): boolean;
  writableLength?: number | undefined;
}

export interface ServerWebSocketOptions {
  /** Outbound backlog beyond which the peer is considered dead and dropped. */
  maximumBufferedBytes?: number;
  /** Largest accepted message after fragment reassembly; larger closes with 1009. */
  maximumMessageBytes?: number;
}

export interface ServerWebSocketHandlers {
  /** Fires exactly once, whatever ends the connection (close handshake, error, drop). */
  onClose: (code: number, reason: string) => void;
  onMessage: (text: string) => void;
  /** Any inbound frame counts as liveness; the relay uses this for idle tracking. */
  onActivity?: () => void;
}

export function webSocketAcceptValue(key: string): string {
  return createHash("sha1").update(`${key}${webSocketGuid}`, "latin1").digest("base64");
}

function headerText(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function headerIncludesToken(value: string | undefined, token: string): boolean {
  if (value === undefined) return false;
  return value.split(",").some((part) => part.trim().toLowerCase() === token);
}

/**
 * A server-side WebSocket over an already-upgraded stream: text messages, ping/pong, a close
 * handshake with a linger deadline, bounded message and backlog sizes. Compression and
 * subprotocols are never negotiated, so no extension handling is needed.
 */
export class ServerWebSocket {
  private readonly handlers: ServerWebSocketHandlers;
  private readonly maximumBufferedBytes: number;
  private readonly maximumMessageBytes: number;
  private readonly socket: WebSocketStream;

  private buffer: Buffer = Buffer.alloc(0);
  private closeSent = false;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private finished = false;
  private fragments: Buffer[] = [];
  private fragmentedBytes = 0;
  private fragmentedOpcode: number | undefined;
  private pendingClose: { code: number; reason: string } | undefined;

  constructor(socket: WebSocketStream, handlers: ServerWebSocketHandlers, options: ServerWebSocketOptions = {}) {
    this.handlers = handlers;
    this.maximumBufferedBytes = options.maximumBufferedBytes ?? defaultMaximumBufferedBytes;
    this.maximumMessageBytes = options.maximumMessageBytes ?? defaultMaximumMessageBytes;
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => this.acceptBytes(chunk));
    socket.on("error", () => this.teardown(webSocketCloseCodes.abnormal, "socket error"));
    socket.on("close", () => this.teardown(webSocketCloseCodes.abnormal, "connection dropped"));
    socket.on("end", () => this.teardown(webSocketCloseCodes.abnormal, "connection ended"));
  }

  /** Bytes that arrived with the HTTP upgrade itself are fed in before any 'data' event. */
  acceptBytes(chunk: Buffer): void {
    if (this.finished || chunk.length === 0) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    try {
      this.drainFrames();
    } catch {
      this.close(webSocketCloseCodes.protocolError, "unparseable frame");
    }
  }

  sendText(text: string): void {
    this.sendFrame(opcodes.text, Buffer.from(text, "utf8"));
  }

  ping(): void {
    this.sendFrame(opcodes.ping, Buffer.alloc(0));
  }

  /**
   * Starts the close handshake and reports `code`/`reason` to the handler immediately; the
   * caller considers the connection gone from this point. The socket itself lingers briefly so
   * the close frame can flush, then is destroyed.
   */
  close(code: number, reason: string): void {
    if (this.finished) return;
    this.sendClose(code, reason);
    this.armCloseTimer();
    this.report(code, reason);
  }

  /** Immediate teardown without a close handshake, e.g. on backpressure. */
  destroy(code: number, reason: string): void {
    this.teardown(code, reason);
  }

  private armCloseTimer(): void {
    if (this.closeTimer !== undefined) return;
    this.closeTimer = setTimeout(() => this.socket.destroy(), closeLingerMs);
    this.closeTimer.unref?.();
  }

  /** Reports the end of the connection to the handler exactly once and stops inbound parsing. */
  private report(code: number, reason: string): void {
    if (this.finished) return;
    this.finished = true;
    this.pendingClose ??= { code, reason };
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentedOpcode = undefined;
    this.fragmentedBytes = 0;
    this.handlers.onClose(this.pendingClose.code, this.pendingClose.reason);
  }

  /** Reports (if not yet reported) and destroys the transport right away. */
  private teardown(code: number, reason: string): void {
    if (this.closeTimer !== undefined) clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
    this.report(code, reason);
    this.socket.destroy();
  }

  private sendClose(code: number, reason: string): void {
    if (this.closeSent) return;
    this.closeSent = true;
    const reasonBytes = Buffer.from(reason, "utf8").subarray(0, 123);
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this.write(this.encodeFrame(opcodes.close, payload));
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    if (this.finished || this.closeSent) return;
    this.write(this.encodeFrame(opcode, payload));
  }

  private write(frame: Buffer): void {
    const writableLength = this.socket.writableLength ?? 0;
    if (writableLength > this.maximumBufferedBytes) {
      this.destroy(webSocketCloseCodes.messageTooBig, "outbound backlog exceeded");
      return;
    }
    try {
      this.socket.write(frame);
    } catch {
      this.destroy(webSocketCloseCodes.abnormal, "write failed");
    }
  }

  private encodeFrame(opcode: number, payload: Buffer): Buffer {
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, payload.length]);
    } else if (payload.length < 65_536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    return Buffer.concat([header, payload]);
  }

  private drainFrames(): void {
    while (!this.finished) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      const fin = (first & 0x80) !== 0;
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let payloadLength = second & 0x7f;
      let offset = 2;

      if (rsv !== 0) {
        this.close(webSocketCloseCodes.protocolError, "unsupported reserved bits");
        return;
      }
      // RFC 6455 §5.1: client frames must be masked.
      if (!masked) {
        this.close(webSocketCloseCodes.protocolError, "unmasked client frame");
        return;
      }
      if (payloadLength === 126) {
        if (this.buffer.length < offset + 2) return;
        payloadLength = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (this.buffer.length < offset + 8) return;
        const wide = this.buffer.readBigUInt64BE(offset);
        if (wide > BigInt(this.maximumMessageBytes)) {
          this.close(webSocketCloseCodes.messageTooBig, "frame too large");
          return;
        }
        payloadLength = Number(wide);
        offset += 8;
      }
      if (payloadLength > this.maximumMessageBytes) {
        this.close(webSocketCloseCodes.messageTooBig, "frame too large");
        return;
      }
      if (this.buffer.length < offset + 4 + payloadLength) return;
      const maskKey = this.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + payloadLength));
      this.buffer = this.buffer.subarray(offset + payloadLength);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = payload[index]! ^ maskKey[index % 4]!;
      }
      this.handlers.onActivity?.();
      this.handleFrame(fin, opcode, payload);
    }
  }

  private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode === opcodes.close) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : webSocketCloseCodes.normal;
      const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
      this.sendClose(code, reason);
      this.teardown(code, reason);
      return;
    }
    if (opcode === opcodes.ping || opcode === opcodes.pong) {
      if (!fin || payload.length > maximumControlPayloadBytes) {
        this.close(webSocketCloseCodes.protocolError, "invalid control frame");
        return;
      }
      if (opcode === opcodes.ping) this.sendFrame(opcodes.pong, payload);
      return;
    }
    if (opcode === opcodes.binary) {
      this.close(webSocketCloseCodes.unsupportedData, "binary frames are not supported");
      return;
    }
    if (opcode === opcodes.text) {
      if (this.fragmentedOpcode !== undefined) {
        this.close(webSocketCloseCodes.protocolError, "interleaved message start");
        return;
      }
      if (fin) {
        this.emitMessage(payload);
        return;
      }
      this.fragmentedOpcode = opcode;
      this.fragments = [payload];
      this.fragmentedBytes = payload.length;
      return;
    }
    if (opcode === opcodes.continuation) {
      if (this.fragmentedOpcode === undefined) {
        this.close(webSocketCloseCodes.protocolError, "continuation without a start frame");
        return;
      }
      this.fragmentedBytes += payload.length;
      if (this.fragmentedBytes > this.maximumMessageBytes) {
        this.close(webSocketCloseCodes.messageTooBig, "message too large");
        return;
      }
      this.fragments.push(payload);
      if (!fin) return;
      const message = Buffer.concat(this.fragments);
      this.fragmentedOpcode = undefined;
      this.fragments = [];
      this.fragmentedBytes = 0;
      this.emitMessage(message);
      return;
    }
    this.close(webSocketCloseCodes.protocolError, "unsupported opcode");
  }

  private emitMessage(payload: Buffer): void {
    if (payload.length > this.maximumMessageBytes) {
      this.close(webSocketCloseCodes.messageTooBig, "message too large");
      return;
    }
    this.handlers.onMessage(payload.toString("utf8"));
  }
}

/** The request slice the handshake needs; both `node:http` requests and hand-parsed ones fit. */
export interface WebSocketUpgradeRequest {
  headers: Record<string, string | string[] | undefined>;
  method?: string | undefined;
}

export interface AcceptWebSocketInput {
  handlers: ServerWebSocketHandlers;
  head?: Buffer;
  options?: ServerWebSocketOptions;
  request: WebSocketUpgradeRequest;
  socket: WebSocketStream;
}

/**
 * Validates an HTTP upgrade and answers the RFC 6455 handshake. Returns `undefined` after writing
 * an HTTP error response when the request is not an acceptable WebSocket upgrade.
 */
export function acceptWebSocketUpgrade(input: AcceptWebSocketInput): ServerWebSocket | undefined {
  const { request, socket } = input;
  const key = headerText(request.headers["sec-websocket-key"])?.trim();
  const version = headerText(request.headers["sec-websocket-version"])?.trim();
  const upgrade = headerText(request.headers.upgrade)?.trim().toLowerCase();
  const connection = headerText(request.headers.connection);
  if (
    request.method !== "GET"
    || upgrade !== "websocket"
    || !headerIncludesToken(connection, "upgrade")
    || key === undefined || key.length === 0
    || version !== "13"
  ) {
    socket.write(
      "HTTP/1.1 400 Bad Request\r\n"
      + "Connection: close\r\n"
      + "Content-Type: text/plain; charset=utf-8\r\n"
      + "Content-Length: 26\r\n"
      + "\r\n"
      + "invalid websocket upgrade\n"
    );
    socket.destroy();
    return undefined;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n"
    + "Upgrade: websocket\r\n"
    + "Connection: Upgrade\r\n"
    + `Sec-WebSocket-Accept: ${webSocketAcceptValue(key)}\r\n`
    + "\r\n"
  );
  const webSocket = new ServerWebSocket(socket, input.handlers, input.options ?? {});
  if (input.head !== undefined && input.head.length > 0) webSocket.acceptBytes(input.head);
  return webSocket;
}
