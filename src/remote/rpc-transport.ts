import { crc32Hex } from "./crc32.ts";

/** JSON envelope ceiling of the relay; fragments are sized so a frame stays below it. */
export const maxPhysicalFrameBytes = 1024 * 1024;
export const maxMessageBytes = 16 * 1024 * 1024;
export const maxFragments = 64;
/** Raw bytes per fragment; base64 expands by 4/3, keeping the envelope under 1 MiB. */
export const fragmentPayloadBytes = 512 * 1024;

const assemblyPurgeIntervalMs = 30_000;
const assemblyMaxAgeSeconds = 60;
const base64Pattern = /^[A-Za-z0-9+/\-_]*={0,2}$/u;

export type RpcFramePayload = Record<string, unknown>;

export type RpcFrameMessageListener = (message: Uint8Array) => void;

export interface RpcFrameTransportOptions {
  bridgeGeneration?: number;
  bridgeSessionId: string;
  /** Overrides the raw fragment size; the protocol default is 512 KiB. */
  fragmentBytes?: number;
  now?: () => number;
  onLog?: (line: string) => void;
  /** Overrides the stale-assembly sweep interval; the protocol default is 30s. */
  purgeIntervalMs?: number;
  recoveryId?: string;
  sendPayload: (payload: RpcFramePayload) => void;
}

class FragmentAssembly {
  readonly checksum: string | undefined;
  readonly createdAt: number;
  readonly fragmentCount: number;
  readonly fragments: (Uint8Array | undefined)[];
  readonly messageBytes: number;
  received = 0;

  constructor(fragmentCount: number, messageBytes: number, checksum: string | undefined, createdAt: number) {
    this.checksum = checksum;
    this.createdAt = createdAt;
    this.fragmentCount = fragmentCount;
    this.fragments = new Array<Uint8Array | undefined>(fragmentCount).fill(undefined);
    this.messageBytes = messageBytes;
  }

  add(index: number, data: Uint8Array): void {
    if (index < 0 || index >= this.fragmentCount) return;
    if (this.fragments[index] === undefined) this.received += 1;
    this.fragments[index] = data;
  }

  get complete(): boolean {
    return this.received === this.fragmentCount;
  }

  assemble(): Uint8Array {
    let total = 0;
    for (const fragment of this.fragments) total += fragment?.length ?? 0;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const fragment of this.fragments) {
      if (fragment === undefined) continue;
      out.set(fragment, offset);
      offset += fragment.length;
    }
    return out;
  }
}

function integerField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function checksumValue(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)["value"];
  return typeof candidate === "string" ? candidate : undefined;
}

function decodeBase64(value: string): Uint8Array | undefined {
  if (!base64Pattern.test(value)) return undefined;
  return Buffer.from(value, "base64");
}

/**
 * Fragmentation transport for the relay's `rpc-frame` envelopes: logical messages are split so
 * every physical frame stays below the relay envelope limit, each message carries a crc32
 * checksum, and the receiver replies with `rpc-frame-ack` once a message is assembled.
 */
export class RpcFrameTransport {
  readonly bridgeGeneration: number | undefined;
  readonly bridgeSessionId: string;
  readonly recoveryId: string | undefined;

  private readonly assemblies = new Map<number, FragmentAssembly>();
  private readonly fragmentBytes: number;
  private readonly listeners = new Set<RpcFrameMessageListener>();
  private readonly now: () => number;
  private readonly onLog: ((line: string) => void) | undefined;
  private readonly sendPayload: (payload: RpcFramePayload) => void;
  private messageSeq = 0;
  private purgeTimer: ReturnType<typeof setInterval> | undefined;
  private seq = 0;

  constructor(options: RpcFrameTransportOptions) {
    this.bridgeGeneration = options.bridgeGeneration;
    this.bridgeSessionId = options.bridgeSessionId;
    this.recoveryId = options.recoveryId;
    this.fragmentBytes = options.fragmentBytes ?? fragmentPayloadBytes;
    this.now = options.now ?? (() => Date.now());
    this.onLog = options.onLog;
    this.sendPayload = options.sendPayload;
    this.purgeTimer = setInterval(() => this.purgeStaleAssemblies(), options.purgeIntervalMs ?? assemblyPurgeIntervalMs);
    this.purgeTimer.unref();
  }

  get pendingAssemblyCount(): number {
    return this.assemblies.size;
  }

  onMessage(listener: RpcFrameMessageListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Fragments and sends one logical message. */
  sendMessage(bytes: Uint8Array): void {
    if (bytes.length === 0) throw new Error("remote.rpcFrame.emptyMessage");
    if (bytes.length > maxMessageBytes) throw new Error("remote.rpcFrame.messageTooLarge");
    this.messageSeq += 1;
    const messageSeq = this.messageSeq;
    const checksum = crc32Hex(bytes);
    const fragmentCount = Math.ceil(bytes.length / this.fragmentBytes);
    if (fragmentCount > maxFragments) throw new Error("remote.rpcFrame.fragmentLimitExceeded");
    for (let index = 0; index < fragmentCount; index += 1) {
      const start = index * this.fragmentBytes;
      const end = Math.min(start + this.fragmentBytes, bytes.length);
      const chunk = Buffer.from(bytes.buffer, bytes.byteOffset + start, end - start);
      this.seq += 1;
      this.sendPayload({
        zcode_type: "rpc-frame",
        ...this.identity(),
        seq: this.seq,
        messageSeq,
        fragmentIndex: index,
        fragmentCount,
        messageBytes: bytes.length,
        checksum: { algorithm: "crc32", value: checksum },
        dataBase64: chunk.toString("base64")
      });
    }
  }

  /** Feeds one relay payload. Returns true when the payload was an rpc-frame or its ack. */
  acceptPayload(payload: RpcFramePayload): boolean {
    const type = payload["zcode_type"];
    if (type === "rpc-frame-ack") return true;
    if (type !== "rpc-frame") return false;
    if (payload["bridgeSessionId"] !== this.bridgeSessionId) return false;

    const messageSeq = integerField(payload["messageSeq"]);
    const fragmentIndex = integerField(payload["fragmentIndex"]);
    const fragmentCount = integerField(payload["fragmentCount"]);
    const messageBytes = integerField(payload["messageBytes"]);
    const dataBase64 = typeof payload["dataBase64"] === "string" ? payload["dataBase64"] : undefined;
    const checksum = checksumValue(payload["checksum"]);
    if (
      messageSeq === undefined ||
      fragmentIndex === undefined ||
      fragmentCount === undefined ||
      messageBytes === undefined ||
      dataBase64 === undefined
    ) {
      return true;
    }
    if (fragmentCount < 1 || fragmentCount > maxFragments) {
      this.onLog?.(`[rpc] message ${messageSeq} rejected: fragmentCount ${fragmentCount}`);
      return true;
    }
    const chunk = decodeBase64(dataBase64);
    if (chunk === undefined) {
      this.onLog?.(`[rpc] message ${messageSeq} fragment ${fragmentIndex} is not valid base64`);
      return true;
    }

    let assembly = this.assemblies.get(messageSeq);
    if (assembly === undefined) {
      assembly = new FragmentAssembly(fragmentCount, messageBytes, checksum, this.now());
      this.assemblies.set(messageSeq, assembly);
    }
    assembly.add(fragmentIndex, chunk);
    if (!assembly.complete) return true;

    this.assemblies.delete(messageSeq);
    const message = assembly.assemble();
    if (assembly.checksum !== undefined && crc32Hex(message) !== assembly.checksum) {
      this.onLog?.(`[rpc] message ${messageSeq} checksum mismatch`);
      return true;
    }
    this.onLog?.(`[rpc] message ${messageSeq} assembled (${message.length} bytes)`);
    this.emit(message);
    this.sendPayload({
      zcode_type: "rpc-frame-ack",
      bridgeSessionId: this.bridgeSessionId,
      ackMessageSeq: messageSeq
    });
    return true;
  }

  purgeStaleAssemblies(): void {
    const now = this.now();
    for (const [seq, assembly] of [...this.assemblies]) {
      if (Math.floor((now - assembly.createdAt) / 1000) > assemblyMaxAgeSeconds) {
        this.assemblies.delete(seq);
        this.onLog?.(`[rpc] purged stale assembly ${seq}`);
      }
    }
  }

  dispose(): void {
    if (this.purgeTimer !== undefined) {
      clearInterval(this.purgeTimer);
      this.purgeTimer = undefined;
    }
    this.assemblies.clear();
    this.listeners.clear();
  }

  private emit(message: Uint8Array): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(message);
      } catch (error) {
        this.onLog?.(`[rpc] message listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private identity(): RpcFramePayload {
    return {
      bridgeSessionId: this.bridgeSessionId,
      ...(this.bridgeGeneration !== undefined ? { bridgeGeneration: this.bridgeGeneration } : {}),
      ...(this.recoveryId !== undefined ? { recoveryId: this.recoveryId } : {})
    };
  }
}
