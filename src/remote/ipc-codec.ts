const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const maxIntTag = 0x7fffffff;
const varintShiftLimit = 35;
const initialWriterCapacity = 256;
const emptyBytes = new Uint8Array(0);

/** Wire tags of the value codec. Lengths and counts are 7-bit little-endian varints. */
export const ipcValueTag = {
  array: 4,
  buffer: 2,
  int: 6,
  object: 5,
  string: 1,
  undefined: 0,
  vsBuffer: 3
} as const;

export const ipcFrameHeaderBytes = 13;
export const ipcFrameTypeRegular = 1;

export class ValueWriter {
  private buffer: Uint8Array = new Uint8Array(initialWriterCapacity);
  private length = 0;

  private reserve(extra: number): void {
    const required = this.length + extra;
    if (required <= this.buffer.length) return;
    let capacity = this.buffer.length * 2;
    while (capacity < required) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.buffer.subarray(0, this.length));
    this.buffer = grown;
  }

  writeByte(value: number): void {
    this.reserve(1);
    this.buffer[this.length] = value & 0xff;
    this.length += 1;
  }

  writeVarint(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`ValueWriter: cannot write ${value} as a varint`);
    }
    let rest = value;
    do {
      let byte = rest % 128;
      rest = Math.floor(rest / 128);
      if (rest > 0) byte |= 0x80;
      this.writeByte(byte);
    } while (rest > 0);
  }

  writeBytes(bytes: Uint8Array): void {
    this.reserve(bytes.length);
    this.buffer.set(bytes, this.length);
    this.length += bytes.length;
  }

  toBytes(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

export class ValueReader {
  readonly data: Uint8Array;
  pos = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  get remaining(): number {
    return this.data.length - this.pos;
  }

  read(count: number): Uint8Array {
    if (count < 0 || this.pos + count > this.data.length) {
      throw new Error(`ValueReader: cannot read ${count} bytes, only ${this.remaining} remaining`);
    }
    const end = this.pos + count;
    const out = this.data.subarray(this.pos, end);
    this.pos = end;
    return out;
  }

  readVarint(): number {
    let value = 0;
    let shift = 0;
    while (this.pos < this.data.length) {
      const byte = this.data[this.pos];
      this.pos += 1;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7;
      if (shift >= varintShiftLimit) break;
    }
    throw new Error(`ValueReader: invalid varint at pos ${this.pos}`);
  }
}

function writeLengthPrefixed(writer: ValueWriter, tag: number, bytes: Uint8Array): void {
  writer.writeByte(tag);
  writer.writeVarint(bytes.length);
  writer.writeBytes(bytes);
}

export function encodeValue(writer: ValueWriter, value: unknown): void {
  if (value === null || value === undefined) {
    writer.writeByte(ipcValueTag.undefined);
    return;
  }
  if (typeof value === "string") {
    writeLengthPrefixed(writer, ipcValueTag.string, textEncoder.encode(value));
    return;
  }
  if (value instanceof Uint8Array) {
    writeLengthPrefixed(writer, ipcValueTag.vsBuffer, value);
    return;
  }
  if (Array.isArray(value)) {
    writer.writeByte(ipcValueTag.array);
    writer.writeVarint(value.length);
    for (const item of value) encodeValue(writer, item);
    return;
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maxIntTag) {
    writer.writeByte(ipcValueTag.int);
    writer.writeVarint(value);
    return;
  }
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("encodeValue: value is not JSON serialisable");
  writeLengthPrefixed(writer, ipcValueTag.object, textEncoder.encode(json));
}

export function decodeValue(reader: ValueReader): unknown {
  const tag = reader.read(1)[0];
  switch (tag) {
    case ipcValueTag.undefined:
      return undefined;
    case ipcValueTag.string:
      return textDecoder.decode(reader.read(reader.readVarint()));
    case ipcValueTag.buffer:
    case ipcValueTag.vsBuffer:
      return reader.read(reader.readVarint()).slice();
    case ipcValueTag.array: {
      const count = reader.readVarint();
      const items: unknown[] = [];
      for (let index = 0; index < count; index += 1) items.push(decodeValue(reader));
      return items;
    }
    case ipcValueTag.object:
      return JSON.parse(textDecoder.decode(reader.read(reader.readVarint())));
    case ipcValueTag.int:
      return reader.readVarint();
    default:
      throw new Error(`unknown value tag ${tag}`);
  }
}

export function encodeIpcValue(value: unknown): Uint8Array {
  const writer = new ValueWriter();
  encodeValue(writer, value);
  return writer.toBytes();
}

export function decodeIpcValue(bytes: Uint8Array): unknown {
  return decodeValue(new ValueReader(bytes));
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
  );
}

/** Frame layout: `[type:u8][id:u32be][ack:u32be][bodyLen:u32be]` followed by the body. */
export function encodeIpcFrame(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(ipcFrameHeaderBytes + body.length);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint8(0, ipcFrameTypeRegular);
  view.setUint32(1, 0);
  view.setUint32(5, 0);
  view.setUint32(9, body.length);
  out.set(body, ipcFrameHeaderBytes);
  return out;
}

export class IpcFrameParser {
  private pending: Uint8Array = emptyBytes;

  acceptChunk(chunk: Uint8Array): Uint8Array[] {
    const data = this.pending.length === 0 ? chunk : concatBytes(this.pending, chunk);
    const bodies: Uint8Array[] = [];
    let offset = 0;
    while (data.length - offset >= ipcFrameHeaderBytes) {
      const type = data[offset];
      const bodyLength = readUint32BE(data, offset + 9);
      const total = ipcFrameHeaderBytes + bodyLength;
      if (data.length - offset < total) break;
      if (type === ipcFrameTypeRegular) {
        bodies.push(data.slice(offset + ipcFrameHeaderBytes, offset + total));
      }
      offset += total;
    }
    this.pending = offset >= data.length ? emptyBytes : data.slice(offset);
    return bodies;
  }

  reset(): void {
    this.pending = emptyBytes;
  }
}

function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  const out = new Uint8Array(first.length + second.length);
  out.set(first, 0);
  out.set(second, first.length);
  return out;
}
