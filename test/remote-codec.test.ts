import { describe, expect, test } from "bun:test";

import {
  decodeIpcValue,
  decodeValue,
  encodeIpcFrame,
  encodeIpcValue,
  encodeValue,
  ipcFrameHeaderBytes,
  ipcValueTag,
  IpcFrameParser,
  ValueReader,
  ValueWriter
} from "../src/remote/ipc-codec.ts";

function tagOf(bytes: Uint8Array): number {
  return bytes[0]!;
}

function varintBytes(value: number): Uint8Array {
  const writer = new ValueWriter();
  writer.writeVarint(value);
  return writer.toBytes();
}

describe("value reader", () => {
  test("rejects reads past the end and allows exact boundary reads", () => {
    expect(() => new ValueReader(new Uint8Array([1, 2, 3])).read(5)).toThrow(/cannot read 5 bytes/u);
    const reader = new ValueReader(new Uint8Array([1, 2, 3]));
    expect([...reader.read(3)]).toEqual([1, 2, 3]);
    expect(reader.remaining).toBe(0);
  });

  test("round-trips varints across byte-length boundaries", () => {
    for (const value of [0, 1, 127, 128, 300, 16_383, 16_384, 0x7fffffff, 2 ** 34]) {
      expect(new ValueReader(varintBytes(value)).readVarint()).toBe(value);
    }
  });

  test("rejects truncated, empty and over-long varints", () => {
    expect(() => new ValueReader(new Uint8Array(0)).readVarint()).toThrow(/invalid varint/u);
    expect(() => new ValueReader(new Uint8Array([0x80])).readVarint()).toThrow(/invalid varint/u);
    expect(() => new ValueReader(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80])).readVarint())
      .toThrow(/invalid varint/u);
  });

  test("rejects negative and unsafe varint writes", () => {
    expect(() => new ValueWriter().writeVarint(-1)).toThrow(/cannot write/u);
    expect(() => new ValueWriter().writeVarint(1.5)).toThrow(/cannot write/u);
  });
});

describe("value codec tags", () => {
  test("uses the documented tag for every supported shape", () => {
    expect(tagOf(encodeIpcValue(null))).toBe(ipcValueTag.undefined);
    expect(tagOf(encodeIpcValue(undefined))).toBe(ipcValueTag.undefined);
    expect(tagOf(encodeIpcValue("text"))).toBe(ipcValueTag.string);
    expect(tagOf(encodeIpcValue(new Uint8Array([1, 2])))).toBe(ipcValueTag.vsBuffer);
    expect(tagOf(encodeIpcValue([1, 2]))).toBe(ipcValueTag.array);
    expect(tagOf(encodeIpcValue({ a: 1 }))).toBe(ipcValueTag.object);
    expect(tagOf(encodeIpcValue(7))).toBe(ipcValueTag.int);
  });

  test("falls back to the JSON tag for values the int tag cannot carry", () => {
    expect(tagOf(encodeIpcValue(-1))).toBe(ipcValueTag.object);
    expect(tagOf(encodeIpcValue(1.5))).toBe(ipcValueTag.object);
    expect(tagOf(encodeIpcValue(0x80000000))).toBe(ipcValueTag.object);
    expect(tagOf(encodeIpcValue(true))).toBe(ipcValueTag.object);
    expect(decodeIpcValue(encodeIpcValue(-1))).toBe(-1);
    expect(decodeIpcValue(encodeIpcValue(1.5))).toBe(1.5);
    expect(decodeIpcValue(encodeIpcValue(true))).toBe(true);
  });

  test("decodes the legacy buffer tag like the current buffer tag", () => {
    const writer = new ValueWriter();
    writer.writeByte(ipcValueTag.buffer);
    writer.writeVarint(3);
    writer.writeBytes(new Uint8Array([9, 8, 7]));
    expect([...(decodeIpcValue(writer.toBytes()) as Uint8Array)]).toEqual([9, 8, 7]);
  });

  test("rejects an unknown tag", () => {
    expect(() => decodeIpcValue(new Uint8Array([99]))).toThrow(/unknown value tag 99/u);
  });
});

describe("value codec round-trips", () => {
  test("preserves strings including unicode and empty values", () => {
    for (const value of ["", "hello", "配对成功", "emoji 🌍 mixed", "line\nbreak\ttab", "a".repeat(5000)]) {
      expect(decodeIpcValue(encodeIpcValue(value))).toBe(value);
    }
  });

  test("preserves nested lists, maps and null holes", () => {
    const value = {
      ints: [1, 2, 3],
      texts: ["a", "b"],
      nested: { x: null, deep: { list: [{ k: "v" }, []] } },
      flag: false,
      negative: -42
    };
    expect(decodeIpcValue(encodeIpcValue(value))).toEqual(value);
  });

  test("preserves heterogeneous top-level arrays element by element", () => {
    const writer = new ValueWriter();
    encodeValue(writer, [1, "a", null, [2, "b"], { c: 3 }, new Uint8Array([4, 5])]);
    const decoded = decodeValue(new ValueReader(writer.toBytes())) as unknown[];
    expect(decoded[0]).toBe(1);
    expect(decoded[1]).toBe("a");
    expect(decoded[2]).toBeUndefined();
    expect(decoded[3]).toEqual([2, "b"]);
    expect(decoded[4]).toEqual({ c: 3 });
    expect([...(decoded[5] as Uint8Array)]).toEqual([4, 5]);
  });

  test("preserves binary payloads independently of the source buffer", () => {
    const backing = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const view = backing.subarray(2, 6);
    const decoded = decodeIpcValue(encodeIpcValue(view)) as Uint8Array;
    expect([...decoded]).toEqual([2, 3, 4, 5]);
    backing.fill(0xff);
    expect([...decoded]).toEqual([2, 3, 4, 5]);
  });

  test("writes two values into one body and reads them back in order", () => {
    const writer = new ValueWriter();
    encodeValue(writer, [100, 0, "plugins", "overview"]);
    encodeValue(writer, [{ workspace: "ws" }]);
    const reader = new ValueReader(writer.toBytes());
    expect(decodeValue(reader)).toEqual([100, 0, "plugins", "overview"]);
    expect(decodeValue(reader)).toEqual([{ workspace: "ws" }]);
    expect(reader.remaining).toBe(0);
  });

  test("rejects a value that cannot be serialised", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => encodeIpcValue(cyclic)).toThrow();
    expect(() => encodeIpcValue(() => 1)).toThrow(/not JSON serialisable/u);
  });
});

describe("ipc frame parser", () => {
  test("parses a frame delivered in one chunk", () => {
    const frame = encodeIpcFrame(varintBytes(42));
    expect(frame).toHaveLength(ipcFrameHeaderBytes + 1);
    const bodies = new IpcFrameParser().acceptChunk(frame);
    expect(bodies).toHaveLength(1);
    expect(new ValueReader(bodies[0]!).readVarint()).toBe(42);
  });

  test("reassembles a frame delivered one byte at a time", () => {
    const frame = encodeIpcFrame(varintBytes(999));
    const parser = new IpcFrameParser();
    const bodies: Uint8Array[] = [];
    for (let index = 0; index < frame.length; index += 1) {
      bodies.push(...parser.acceptChunk(frame.subarray(index, index + 1)));
    }
    expect(bodies).toHaveLength(1);
    expect(new ValueReader(bodies[0]!).readVarint()).toBe(999);
  });

  test("parses two frames from one chunk", () => {
    const combined = new Uint8Array([
      ...encodeIpcFrame(varintBytes(10)),
      ...encodeIpcFrame(varintBytes(20))
    ]);
    const bodies = new IpcFrameParser().acceptChunk(combined);
    expect(bodies).toHaveLength(2);
    expect(new ValueReader(bodies[0]!).readVarint()).toBe(10);
    expect(new ValueReader(bodies[1]!).readVarint()).toBe(20);
  });

  test("holds a partial header until the rest of the frame arrives", () => {
    const frame = encodeIpcFrame(varintBytes(555));
    const parser = new IpcFrameParser();
    expect(parser.acceptChunk(frame.subarray(0, 5))).toHaveLength(0);
    const bodies = parser.acceptChunk(frame.subarray(5));
    expect(bodies).toHaveLength(1);
    expect(new ValueReader(bodies[0]!).readVarint()).toBe(555);
  });

  test("skips frames with an unknown type but keeps the stream aligned", () => {
    const regular = encodeIpcFrame(varintBytes(7));
    const other = encodeIpcFrame(varintBytes(8));
    other[0] = 2;
    const bodies = new IpcFrameParser().acceptChunk(new Uint8Array([...other, ...regular]));
    expect(bodies).toHaveLength(1);
    expect(new ValueReader(bodies[0]!).readVarint()).toBe(7);
  });

  test("drops buffered bytes on reset", () => {
    const frame = encodeIpcFrame(varintBytes(11));
    const parser = new IpcFrameParser();
    expect(parser.acceptChunk(frame.subarray(0, 4))).toHaveLength(0);
    parser.reset();
    // Without the reset the stale prefix would be treated as the next frame's header.
    expect(parser.acceptChunk(frame)).toHaveLength(1);
  });
});
