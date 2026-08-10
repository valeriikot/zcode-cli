const polynomial = 0xedb88320;

let lookupTable: Uint32Array | undefined;

function table(): Uint32Array {
  if (lookupTable) return lookupTable;
  const next = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? polynomial ^ (value >>> 1) : value >>> 1;
    }
    next[index] = value >>> 0;
  }
  lookupTable = next;
  return next;
}

export function crc32(bytes: Uint8Array): number {
  const entries = table();
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = entries[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function crc32Hex(bytes: Uint8Array): string {
  return crc32(bytes).toString(16).padStart(8, "0");
}
