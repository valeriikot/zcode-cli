import { describe, expect, test } from "bun:test";

import {
  ServerWebSocket,
  webSocketAcceptValue,
  webSocketCloseCodes,
  type ServerWebSocketOptions,
  type WebSocketStream
} from "../src/relay/websocket.ts";

type Listener = (...args: unknown[]) => void;

class FakeStream implements WebSocketStream {
  destroyed = false;
  writableLength = 0;
  written: Buffer[] = [];

  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  write(chunk: Buffer | string): boolean {
    this.written.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, "utf8"));
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("close");
  }
}

interface DecodedFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/** Decodes the unmasked frames a server writes. */
function decodeServerFrames(chunks: Buffer[]): DecodedFrame[] {
  let buffer = Buffer.concat(chunks);
  const frames: DecodedFrame[] = [];
  while (buffer.length >= 2) {
    const fin = (buffer[0]! & 0x80) !== 0;
    const opcode = buffer[0]! & 0x0f;
    let length = buffer[1]! & 0x7f;
    let offset = 2;
    if (length === 126) {
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      length = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    if (buffer.length < offset + length) break;
    frames.push({ fin, opcode, payload: Buffer.from(buffer.subarray(offset, offset + length)) });
    buffer = buffer.subarray(offset + length);
  }
  return frames;
}

/** Encodes a client-to-server frame; client frames must be masked unless the test says otherwise. */
function clientFrame(
  opcode: number,
  payload: Buffer,
  options: { fin?: boolean; masked?: boolean } = {}
): Buffer {
  const fin = options.fin ?? true;
  const masked = options.masked ?? true;
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  let header: Buffer;
  if (payload.length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, (masked ? 0x80 : 0) | payload.length]);
  } else if (payload.length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = (masked ? 0x80 : 0) | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = (masked ? 0x80 : 0) | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  if (!masked) return Buffer.concat([header, payload]);
  const bytes = Buffer.from(payload);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = bytes[index]! ^ mask[index % 4]!;
  return Buffer.concat([header, mask, bytes]);
}

function textFrame(text: string, options: { fin?: boolean; masked?: boolean } = {}): Buffer {
  return clientFrame(0x1, Buffer.from(text, "utf8"), options);
}

interface Harness {
  closes: Array<{ code: number; reason: string }>;
  messages: string[];
  stream: FakeStream;
  webSocket: ServerWebSocket;
}

function harness(options: ServerWebSocketOptions = {}): Harness {
  const stream = new FakeStream();
  const closes: Array<{ code: number; reason: string }> = [];
  const messages: string[] = [];
  const webSocket = new ServerWebSocket(stream, {
    onClose: (code, reason) => closes.push({ code, reason }),
    onMessage: (text) => messages.push(text)
  }, options);
  return { closes, messages, stream, webSocket };
}

describe("websocket accept value", () => {
  test("matches the RFC 6455 sample handshake", () => {
    expect(webSocketAcceptValue("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });
});

describe("websocket message parsing", () => {
  test("delivers a single-frame text message", () => {
    const target = harness();
    target.stream.emit("data", textFrame("hello relay"));
    expect(target.messages).toEqual(["hello relay"]);
    expect(target.closes).toHaveLength(0);
  });

  test("parses frames split across arbitrary chunk boundaries", () => {
    const target = harness();
    const frame = textFrame("chunked delivery");
    for (const byte of frame) target.stream.emit("data", Buffer.from([byte]));
    expect(target.messages).toEqual(["chunked delivery"]);
  });

  test("parses multiple frames arriving in one chunk", () => {
    const target = harness();
    target.stream.emit("data", Buffer.concat([textFrame("one"), textFrame("two")]));
    expect(target.messages).toEqual(["one", "two"]);
  });

  test("uses the 16-bit and 64-bit length encodings", () => {
    const target = harness();
    const medium = "m".repeat(400);
    target.stream.emit("data", textFrame(medium));
    const wide = clientFrame(0x1, Buffer.from("wide", "utf8"));
    // Rewrite the frame with a forced 64-bit length header for the same 4-byte payload.
    const forced = Buffer.alloc(2 + 8 + 4 + 4);
    forced[0] = 0x81;
    forced[1] = 0x80 | 127;
    forced.writeBigUInt64BE(4n, 2);
    wide.subarray(2).copy(forced, 10);
    target.stream.emit("data", forced);
    expect(target.messages).toEqual([medium, "wide"]);
  });

  test("reassembles fragmented text messages", () => {
    const target = harness();
    target.stream.emit("data", textFrame("frag", { fin: false }));
    target.stream.emit("data", clientFrame(0x0, Buffer.from("men", "utf8"), { fin: false }));
    target.stream.emit("data", clientFrame(0x0, Buffer.from("ted", "utf8")));
    expect(target.messages).toEqual(["fragmented"]);
  });

  test("answers ping with a matching pong, even between fragments", () => {
    const target = harness();
    target.stream.emit("data", textFrame("he", { fin: false }));
    target.stream.emit("data", clientFrame(0x9, Buffer.from("ping-body", "utf8")));
    target.stream.emit("data", clientFrame(0x0, Buffer.from("llo", "utf8")));
    expect(target.messages).toEqual(["hello"]);
    const pongs = decodeServerFrames(target.stream.written).filter((frame) => frame.opcode === 0xa);
    expect(pongs).toHaveLength(1);
    expect(pongs[0]!.payload.toString("utf8")).toBe("ping-body");
  });
});

describe("websocket protocol violations", () => {
  test("closes 1002 on an unmasked client frame", () => {
    const target = harness();
    target.stream.emit("data", textFrame("nope", { masked: false }));
    expect(target.closes).toEqual([{ code: 1002, reason: "unmasked client frame" }]);
    const closeFrames = decodeServerFrames(target.stream.written).filter((frame) => frame.opcode === 0x8);
    expect(closeFrames).toHaveLength(1);
    expect(closeFrames[0]!.payload.readUInt16BE(0)).toBe(1002);
  });

  test("closes 1002 on reserved bits", () => {
    const target = harness();
    const frame = textFrame("rsv");
    frame[0] = frame[0]! | 0x40;
    target.stream.emit("data", frame);
    expect(target.closes[0]!.code).toBe(1002);
  });

  test("closes 1003 on binary frames", () => {
    const target = harness();
    target.stream.emit("data", clientFrame(0x2, Buffer.from([1, 2, 3])));
    expect(target.closes).toEqual([{ code: 1003, reason: "binary frames are not supported" }]);
  });

  test("closes 1002 on a continuation without a start", () => {
    const target = harness();
    target.stream.emit("data", clientFrame(0x0, Buffer.from("stray", "utf8")));
    expect(target.closes[0]!.code).toBe(1002);
  });

  test("closes 1002 on an interleaved second message start", () => {
    const target = harness();
    target.stream.emit("data", textFrame("first", { fin: false }));
    target.stream.emit("data", textFrame("second", { fin: false }));
    expect(target.closes[0]!.code).toBe(1002);
  });

  test("closes 1002 on unknown opcodes", () => {
    const target = harness();
    target.stream.emit("data", clientFrame(0x3, Buffer.from("x", "utf8")));
    expect(target.closes[0]!.code).toBe(1002);
  });

  test("closes 1009 when a single frame exceeds the message limit", () => {
    const target = harness({ maximumMessageBytes: 16 });
    target.stream.emit("data", textFrame("x".repeat(64)));
    expect(target.closes).toEqual([{ code: 1009, reason: "frame too large" }]);
    expect(target.messages).toHaveLength(0);
  });

  test("closes 1009 when fragments together exceed the message limit", () => {
    const target = harness({ maximumMessageBytes: 16 });
    target.stream.emit("data", textFrame("x".repeat(10), { fin: false }));
    target.stream.emit("data", clientFrame(0x0, Buffer.from("y".repeat(10), "utf8")));
    expect(target.closes).toEqual([{ code: 1009, reason: "message too large" }]);
  });

  test("stops processing input after a violation", () => {
    const target = harness();
    target.stream.emit("data", Buffer.concat([
      textFrame("bad", { masked: false }),
      textFrame("good")
    ]));
    expect(target.messages).toHaveLength(0);
    expect(target.closes).toHaveLength(1);
  });
});

describe("websocket close handshake", () => {
  test("echoes a client close and reports its code and reason", () => {
    const target = harness();
    const payload = Buffer.alloc(2 + 4);
    payload.writeUInt16BE(4009, 0);
    payload.write("gone", 2);
    target.stream.emit("data", clientFrame(0x8, payload));
    expect(target.closes).toEqual([{ code: 4009, reason: "gone" }]);
    const closeFrames = decodeServerFrames(target.stream.written).filter((frame) => frame.opcode === 0x8);
    expect(closeFrames).toHaveLength(1);
    expect(target.stream.destroyed).toBe(true);
  });

  test("close() sends the frame once and finalizes when the peer echoes", () => {
    const target = harness();
    target.webSocket.close(4004, "session-not-found");
    target.webSocket.close(4013, "second call ignored");
    const closeFrames = decodeServerFrames(target.stream.written).filter((frame) => frame.opcode === 0x8);
    expect(closeFrames).toHaveLength(1);
    expect(closeFrames[0]!.payload.readUInt16BE(0)).toBe(4004);

    const echo = Buffer.alloc(2);
    echo.writeUInt16BE(4004, 0);
    target.stream.emit("data", clientFrame(0x8, echo));
    expect(target.closes).toEqual([{ code: 4004, reason: "session-not-found" }]);
  });

  test("reports 1006 when the transport drops without a handshake", () => {
    const target = harness();
    target.stream.emit("error", new Error("reset"));
    expect(target.closes).toEqual([{ code: 1006, reason: "socket error" }]);
  });

  test("sendText after close is a no-op", () => {
    const target = harness();
    target.webSocket.close(1000, "done");
    const before = target.stream.written.length;
    target.webSocket.sendText("late");
    expect(target.stream.written).toHaveLength(before);
  });

  test("destroys the peer when the outbound backlog exceeds the limit", () => {
    const target = harness({ maximumBufferedBytes: 8 });
    target.stream.writableLength = 64;
    target.webSocket.sendText("overflow");
    expect(target.closes).toEqual([{ code: 1009, reason: "outbound backlog exceeded" }]);
    expect(target.stream.destroyed).toBe(true);
  });

  test("close reasons longer than the control-frame limit are truncated", () => {
    const target = harness();
    target.webSocket.close(1008, "r".repeat(200));
    const closeFrames = decodeServerFrames(target.stream.written).filter((frame) => frame.opcode === 0x8);
    expect(closeFrames[0]!.payload.length).toBeLessThanOrEqual(125);
  });
});
