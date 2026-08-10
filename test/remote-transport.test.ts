import { describe, expect, test } from "bun:test";

import { crc32Hex } from "../src/remote/crc32.ts";
import {
  fragmentPayloadBytes,
  maxFragments,
  maxMessageBytes,
  RpcFrameTransport,
  type RpcFramePayload
} from "../src/remote/rpc-transport.ts";

interface Harness {
  messages: Uint8Array[];
  sent: RpcFramePayload[];
  transport: RpcFrameTransport;
}

function harness(options: { fragmentBytes?: number; now?: () => number } = {}): Harness {
  const messages: Uint8Array[] = [];
  const sent: RpcFramePayload[] = [];
  const transport = new RpcFrameTransport({
    bridgeSessionId: "bridge-1",
    ...(options.fragmentBytes !== undefined ? { fragmentBytes: options.fragmentBytes } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    sendPayload: (payload) => sent.push(payload)
  });
  transport.onMessage((message) => messages.push(message));
  return { messages, sent, transport };
}

function frame(fields: RpcFramePayload): RpcFramePayload {
  return { zcode_type: "rpc-frame", bridgeSessionId: "bridge-1", ...fields };
}

function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function ramp(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = index % 256;
  return bytes;
}

describe("rpc frame sending", () => {
  test("sends a small message as a single checksummed fragment", () => {
    const { sent, transport } = harness();
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    transport.sendMessage(payload);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      zcode_type: "rpc-frame",
      bridgeSessionId: "bridge-1",
      seq: 1,
      messageSeq: 1,
      fragmentIndex: 0,
      fragmentCount: 1,
      messageBytes: 5,
      checksum: { algorithm: "crc32", value: crc32Hex(payload) },
      dataBase64: base64Of(payload)
    });
    transport.dispose();
  });

  test("includes the bridge generation and recovery id when the desktop provided them", () => {
    const sent: RpcFramePayload[] = [];
    const transport = new RpcFrameTransport({
      bridgeGeneration: 4,
      bridgeSessionId: "bridge-1",
      recoveryId: "recovery-7",
      sendPayload: (payload) => sent.push(payload)
    });
    transport.sendMessage(new Uint8Array([1]));
    expect(sent[0]!["bridgeGeneration"]).toBe(4);
    expect(sent[0]!["recoveryId"]).toBe("recovery-7");
    transport.dispose();
  });

  test("splits a message larger than one fragment and reassembles it out of order", () => {
    const { messages, sent, transport } = harness();
    const payload = ramp(fragmentPayloadBytes * 2 + 100);
    transport.sendMessage(payload);
    expect(sent).toHaveLength(3);
    expect(sent.map((entry) => entry["fragmentIndex"])).toEqual([0, 1, 2]);
    for (const outbound of [...sent].reverse()) transport.acceptPayload(outbound);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(payload);
    transport.dispose();
  });

  test("rejects an empty message, an oversized message and too many fragments", () => {
    const { transport } = harness();
    expect(() => transport.sendMessage(new Uint8Array(0))).toThrow("remote.rpcFrame.emptyMessage");
    expect(() => transport.sendMessage(new Uint8Array(maxMessageBytes + 1)))
      .toThrow("remote.rpcFrame.messageTooLarge");
    transport.dispose();

    const small = harness({ fragmentBytes: 8 });
    expect(() => small.transport.sendMessage(new Uint8Array(8 * (maxFragments + 1))))
      .toThrow("remote.rpcFrame.fragmentLimitExceeded");
    small.transport.dispose();
  });
});

describe("rpc frame receiving", () => {
  test("assembles a single fragment and acknowledges it", () => {
    const { messages, sent, transport } = harness();
    const payload = new Uint8Array([7, 8, 9]);
    expect(transport.acceptPayload(frame({
      messageSeq: 1,
      fragmentIndex: 0,
      fragmentCount: 1,
      messageBytes: 3,
      checksum: { algorithm: "crc32", value: crc32Hex(payload) },
      dataBase64: base64Of(payload)
    }))).toBe(true);
    expect(messages).toHaveLength(1);
    expect([...messages[0]!]).toEqual([7, 8, 9]);
    expect(sent).toEqual([{ zcode_type: "rpc-frame-ack", bridgeSessionId: "bridge-1", ackMessageSeq: 1 }]);
    transport.dispose();
  });

  test("assembles without a checksum when the sender omitted one", () => {
    const { messages, transport } = harness();
    transport.acceptPayload(frame({
      messageSeq: 1,
      fragmentIndex: 0,
      fragmentCount: 1,
      messageBytes: 2,
      dataBase64: base64Of(new Uint8Array([1, 2]))
    }));
    expect(messages).toHaveLength(1);
    transport.dispose();
  });

  test("waits for every fragment before emitting a message", () => {
    const { messages, transport } = harness();
    const payload = ramp(200);
    transport.acceptPayload(frame({
      messageSeq: 1,
      fragmentIndex: 1,
      fragmentCount: 2,
      messageBytes: 200,
      dataBase64: base64Of(payload.subarray(100))
    }));
    expect(messages).toHaveLength(0);
    expect(transport.pendingAssemblyCount).toBe(1);
    transport.acceptPayload(frame({
      messageSeq: 1,
      fragmentIndex: 0,
      fragmentCount: 2,
      messageBytes: 200,
      dataBase64: base64Of(payload.subarray(0, 100))
    }));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(payload);
    expect(transport.pendingAssemblyCount).toBe(0);
    transport.dispose();
  });

  test("drops a message whose checksum does not match and never acknowledges it", () => {
    const { messages, sent, transport } = harness();
    transport.acceptPayload(frame({
      messageSeq: 1,
      fragmentIndex: 0,
      fragmentCount: 1,
      messageBytes: 3,
      checksum: { algorithm: "crc32", value: "00000000" },
      dataBase64: base64Of(new Uint8Array([1, 2, 3]))
    }));
    expect(messages).toHaveLength(0);
    expect(sent).toHaveLength(0);
    transport.dispose();
  });

  test("consumes malformed frames without emitting or throwing", () => {
    const { messages, transport } = harness();
    expect(transport.acceptPayload(frame({ messageSeq: 1 }))).toBe(true);
    expect(transport.acceptPayload(frame({
      messageSeq: 1,
      fragmentIndex: 0,
      fragmentCount: 1,
      messageBytes: 5,
      dataBase64: "!!!not-valid-base64!!!"
    }))).toBe(true);
    expect(transport.acceptPayload(frame({
      messageSeq: 2,
      fragmentIndex: 0,
      fragmentCount: maxFragments + 1,
      messageBytes: 5,
      dataBase64: base64Of(new Uint8Array([1]))
    }))).toBe(true);
    expect(transport.acceptPayload(frame({
      messageSeq: 3,
      fragmentIndex: 0,
      fragmentCount: 0,
      messageBytes: 0,
      dataBase64: ""
    }))).toBe(true);
    expect(messages).toHaveLength(0);
    transport.dispose();
  });

  test("ignores fragment indexes outside the declared range", () => {
    const { messages, transport } = harness();
    transport.acceptPayload(frame({
      messageSeq: 1,
      fragmentIndex: 5,
      fragmentCount: 2,
      messageBytes: 2,
      dataBase64: base64Of(new Uint8Array([9]))
    }));
    expect(messages).toHaveLength(0);
    expect(transport.pendingAssemblyCount).toBe(1);
    transport.dispose();
  });

  test("claims acks and rejects frames for other bridges or other envelope types", () => {
    const { transport } = harness();
    expect(transport.acceptPayload({ zcode_type: "rpc-frame-ack", bridgeSessionId: "bridge-1" })).toBe(true);
    expect(transport.acceptPayload({ zcode_type: "workspace-list-updated" })).toBe(false);
    expect(transport.acceptPayload({ zcode_type: "rpc-frame", bridgeSessionId: "other" })).toBe(false);
    transport.dispose();
  });

  test("purges assemblies that never completed", () => {
    let clock = 0;
    const { transport } = harness({ now: () => clock });
    transport.acceptPayload(frame({
      messageSeq: 1,
      fragmentIndex: 0,
      fragmentCount: 2,
      messageBytes: 2,
      dataBase64: base64Of(new Uint8Array([1]))
    }));
    expect(transport.pendingAssemblyCount).toBe(1);
    clock = 30_000;
    transport.purgeStaleAssemblies();
    expect(transport.pendingAssemblyCount).toBe(1);
    clock = 61_001;
    transport.purgeStaleAssemblies();
    expect(transport.pendingAssemblyCount).toBe(0);
    transport.dispose();
  });

  test("stops delivering to removed listeners and survives a throwing listener", () => {
    const { transport } = harness();
    const seen: string[] = [];
    const removeFirst = transport.onMessage(() => seen.push("first"));
    transport.onMessage(() => {
      throw new Error("listener failure");
    });
    transport.onMessage(() => seen.push("third"));
    const payload = new Uint8Array([1]);
    const incoming = (seq: number): RpcFramePayload => frame({
      messageSeq: seq,
      fragmentIndex: 0,
      fragmentCount: 1,
      messageBytes: 1,
      dataBase64: base64Of(payload)
    });
    transport.acceptPayload(incoming(1));
    expect(seen).toEqual(["first", "third"]);
    removeFirst();
    transport.acceptPayload(incoming(2));
    expect(seen).toEqual(["first", "third", "third"]);
    transport.dispose();
  });
});
