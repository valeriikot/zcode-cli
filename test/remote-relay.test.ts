import { describe, expect, test } from "bun:test";

import { parseRemoteConnectionUrl, type RemoteConnectionParams } from "../src/remote/connection-params.ts";
import { calculateProof } from "../src/remote/proof.ts";
import {
  relayCloseReason,
  relayReconnectDelayMs,
  RelayClient,
  type RelayClientOptions,
  type RelayFailure,
  type RelayState
} from "../src/remote/relay-client.ts";

const passHash = "PASS-HASH-SECRET";
const deviceSid = "DEVICE-SID-SECRET";
const deviceUrl = `https://zcode.z.ai/remote/v4?sid=${deviceSid}&hash=${passHash}&t=1&mid=machine-1`;

function params(): RemoteConnectionParams {
  return parseRemoteConnectionUrl(deviceUrl)!;
}

interface FakeSocket {
  closed?: { code?: number; reason?: string };
  onClose: (code: number, reason: string) => void;
  onError: (message: string) => void;
  onMessage: (data: string) => void;
  onOpen: () => void;
  sent: Record<string, unknown>[];
  url: string;
}

interface Harness {
  client: RelayClient;
  failures: RelayFailure[];
  logs: string[];
  socket: () => FakeSocket;
  sockets: FakeSocket[];
  states: RelayState[];
}

function harness(options: RelayClientOptions = {}): Harness {
  const failures: RelayFailure[] = [];
  const logs: string[] = [];
  const sockets: FakeSocket[] = [];
  const states: RelayState[] = [];
  const client = new RelayClient(params(), {
    onLog: (line) => logs.push(line),
    reconnectDelayMs: () => 0,
    socketFactory: (url, handlers) => {
      const socket: FakeSocket = { ...handlers, sent: [], url: url.toString() };
      sockets.push(socket);
      return {
        close: (code, reason) => {
          socket.closed = { code, reason };
        },
        send: (data) => socket.sent.push(JSON.parse(data) as Record<string, unknown>)
      };
    },
    ...options
  });
  client.onFailure((failure) => failures.push(failure));
  client.onState((state) => states.push(state));
  return { client, failures, logs, socket: () => sockets[sockets.length - 1]!, sockets, states };
}

/** Drives the fake desktop through open, challenge and match. */
function pair(target: Harness): void {
  target.socket().onOpen();
  target.socket().onMessage(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
  target.socket().onMessage(JSON.stringify({ type: "auth_ack", pair_status: "matched" }));
}

describe("relay close-code mapping", () => {
  test("maps the documented protocol codes and nothing else", () => {
    expect(relayCloseReason(4004)).toBe("session-not-found");
    expect(relayCloseReason(4009)).toBe("session-conflict");
    expect(relayCloseReason(4010)).toBe("desktop-disconnected");
    expect(relayCloseReason(4011)).toBe("session-expired");
    expect(relayCloseReason(4012)).toBe("workspace-closed");
    expect(relayCloseReason(4013)).toBe("invalid-mobile-connection");
    expect(relayCloseReason(1006)).toBeUndefined();
    expect(relayCloseReason(1000)).toBeUndefined();
  });
});

describe("relay reconnect backoff", () => {
  test("doubles up to a fifteen-second ceiling", () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(relayReconnectDelayMs)).toEqual([
      1000,
      2000,
      4000,
      8000,
      15_000,
      15_000,
      15_000
    ]);
    expect(relayReconnectDelayMs(-3)).toBe(1000);
  });
});

describe("relay pairing handshake", () => {
  test("connects to the relay endpoint derived from the device URL", () => {
    const target = harness();
    target.client.start();
    expect(target.client.state).toBe("connecting");
    expect(target.socket().url).toBe("wss://zcode.z.ai/ws?mid=machine-1");
    target.client.dispose();
  });

  test("announces itself as a terminal role on open", () => {
    const target = harness({ clientName: "zcode-app-cli", platform: "linux" });
    target.client.start();
    target.socket().onOpen();
    expect(target.client.state).toBe("authenticating");
    expect(target.socket().sent[0]).toEqual({
      type: "auth_init",
      role: "terminal",
      device_sid: deviceSid,
      meta: { platform: "linux", version: "web", name: "zcode-app-cli" },
      client_ts: expect.any(Number)
    });
    target.client.dispose();
  });

  test("answers the challenge with the HMAC pairing proof", () => {
    const target = harness();
    target.client.start();
    target.socket().onOpen();
    target.socket().onMessage(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
    expect(target.socket().sent[1]).toEqual({
      type: "auth_response",
      device_sid: deviceSid,
      proof: calculateProof({ deviceSid, nonce: "nonce-1", passHash, role: "terminal" }),
      client_ts: expect.any(Number)
    });
    target.client.dispose();
  });

  test("treats a challenge without a nonce as an empty nonce", () => {
    const target = harness();
    target.client.start();
    target.socket().onOpen();
    target.socket().onMessage(JSON.stringify({ type: "auth_challenge" }));
    expect(target.socket().sent[1]!["proof"]).toBe(
      calculateProof({ deviceSid, nonce: "", passHash, role: "terminal" })
    );
    target.client.dispose();
  });

  test("moves through waiting to paired", () => {
    const target = harness();
    target.client.start();
    target.socket().onOpen();
    target.socket().onMessage(JSON.stringify({ type: "auth_ack", pair_status: "waiting" }));
    expect(target.client.state).toBe("waiting");
    target.socket().onMessage(JSON.stringify({ type: "pair_status_ack", pair_status: "matched" }));
    expect(target.client.state).toBe("paired");
    expect(target.states).toEqual(["connecting", "authenticating", "waiting", "paired"]);
    target.client.dispose();
  });

  test("ignores frames that are not protocol frames", () => {
    const target = harness();
    target.client.start();
    target.socket().onOpen();
    target.socket().onMessage("not json");
    target.socket().onMessage(JSON.stringify(["array"]));
    target.socket().onMessage(JSON.stringify({ missing: "type" }));
    target.socket().onMessage(JSON.stringify({ type: "unknown-frame" }));
    expect(target.client.state).toBe("authenticating");
    target.client.dispose();
  });

  test("ignores frames from a socket that was already replaced", async () => {
    const target = harness();
    target.client.start();
    const stale = target.socket();
    pair(target);
    stale.onClose(1006, "dropped");
    await Bun.sleep(2);
    expect(target.sockets).toHaveLength(2);
    expect(target.socket()).not.toBe(stale);

    // The replaced socket must no longer change state or deliver payloads.
    const payloads: unknown[] = [];
    target.client.onPayload((payload) => payloads.push(payload));
    stale.onMessage(JSON.stringify({ type: "data", payload: { zcode_type: "late" } }));
    stale.onClose(4004, "late-close");
    expect(payloads).toHaveLength(0);
    expect(target.client.state).toBe("reconnecting");
    target.client.dispose();
  });
});

describe("relay payload delivery", () => {
  test("wraps outbound payloads in a data envelope once paired", () => {
    const target = harness();
    target.client.start();
    pair(target);
    target.client.sendPayload({ zcode_type: "bootstrap-request", requestId: "r1" });
    const data = target.socket().sent.filter((frame) => frame["type"] === "data");
    expect(data).toHaveLength(1);
    expect(data[0]!["payload"]).toEqual({ zcode_type: "bootstrap-request", requestId: "r1" });
    target.client.dispose();
  });

  test("queues payloads sent before pairing and flushes them on match", () => {
    const target = harness();
    target.client.start();
    target.client.sendPayload({ zcode_type: "first" });
    target.socket().onOpen();
    target.client.sendPayload({ zcode_type: "second" });
    expect(target.client.queuedPayloadCount).toBe(2);
    expect(target.socket().sent.filter((frame) => frame["type"] === "data")).toHaveLength(0);

    target.socket().onMessage(JSON.stringify({ type: "auth_ack", pair_status: "matched" }));
    expect(target.client.queuedPayloadCount).toBe(0);
    const flushed = target.socket().sent.filter((frame) => frame["type"] === "data");
    expect(flushed.map((frame) => (frame["payload"] as Record<string, unknown>)["zcode_type"]))
      .toEqual(["first", "second"]);
    target.client.dispose();
  });

  test("drops payloads once the outbound queue is full", () => {
    const target = harness({ maximumQueuedPayloads: 2 });
    target.client.start();
    for (let index = 0; index < 5; index += 1) target.client.sendPayload({ zcode_type: `p${index}` });
    expect(target.client.queuedPayloadCount).toBe(2);
    expect(target.logs.some((line) => line.includes("outbound queue is full"))).toBe(true);
    target.client.dispose();
  });

  test("delivers inbound data payloads to listeners", () => {
    const target = harness();
    const payloads: unknown[] = [];
    target.client.onPayload((payload) => payloads.push(payload));
    target.client.start();
    pair(target);
    target.socket().onMessage(JSON.stringify({ type: "data", payload: { zcode_type: "bootstrap-response" } }));
    target.socket().onMessage(JSON.stringify({ type: "data", payload: "not an object" }));
    expect(payloads).toEqual([{ zcode_type: "bootstrap-response" }]);
    target.client.dispose();
  });

  test("survives a throwing payload listener", () => {
    const target = harness();
    target.client.onPayload(() => {
      throw new Error("listener failure");
    });
    target.client.start();
    pair(target);
    expect(() => target.socket().onMessage(JSON.stringify({ type: "data", payload: { zcode_type: "x" } })))
      .not.toThrow();
    target.client.dispose();
  });
});

describe("relay failure handling", () => {
  test("reports a mapped close code when pairing never succeeded", () => {
    const target = harness();
    target.client.start();
    target.socket().onOpen();
    target.socket().onClose(4004, "no such session");
    expect(target.client.state).toBe("error");
    expect(target.failures).toEqual([{ reason: "session-not-found", message: "no such session" }]);
    expect(target.sockets).toHaveLength(1);
    target.client.dispose();
  });

  test("reports an unmapped close code as relay-unavailable", () => {
    const target = harness();
    target.client.start();
    target.socket().onOpen();
    target.socket().onClose(1011, "");
    expect(target.failures).toEqual([{ reason: "relay-unavailable", message: "connection closed (1011)" }]);
    target.client.dispose();
  });

  test("reconnects on a desktop-disconnected close even before the first pairing", () => {
    const target = harness();
    target.client.start();
    target.socket().onOpen();
    target.socket().onClose(4010, "desktop gone");
    expect(target.client.state).toBe("reconnecting");
    expect(target.failures).toHaveLength(0);
    target.client.dispose();
  });

  test("reconnects after a paired socket drops", async () => {
    const target = harness();
    target.client.start();
    pair(target);
    target.socket().onClose(1006, "network");
    expect(target.client.state).toBe("reconnecting");
    await Bun.sleep(2);
    expect(target.sockets).toHaveLength(2);
    pair(target);
    expect(target.client.state).toBe("paired");
    target.client.dispose();
  });

  test("stops reconnecting after the relay kicks the session", () => {
    const target = harness();
    target.client.start();
    pair(target);
    target.socket().onMessage(JSON.stringify({
      type: "error",
      code: "KICKED",
      message: "another terminal took over"
    }));
    expect(target.client.state).toBe("kicked");
    expect(target.failures).toEqual([{ reason: "kicked", message: "another terminal took over" }]);
    expect(target.sockets).toHaveLength(1);
    target.client.dispose();
  });

  test("ignores relay error frames other than KICKED", () => {
    const target = harness();
    target.client.start();
    pair(target);
    target.socket().onMessage(JSON.stringify({ type: "error", code: "RATE_LIMIT" }));
    expect(target.client.state).toBe("paired");
    expect(target.failures).toHaveLength(0);
    target.client.dispose();
  });

  test("fails a never-matched connection once the pairing deadline passes", async () => {
    const target = harness({ waitingTimeoutMs: 5 });
    target.client.start();
    target.socket().onOpen();
    target.socket().onMessage(JSON.stringify({ type: "auth_ack", pair_status: "waiting" }));
    await Bun.sleep(15);
    expect(target.client.state).toBe("error");
    expect(target.failures[0]!.reason).toBe("invalid-mobile-connection");
    target.client.dispose();
  });

  test("does not arm the pairing deadline for a desktop that went away after pairing", async () => {
    const target = harness({ waitingTimeoutMs: 5 });
    target.client.start();
    pair(target);
    target.socket().onMessage(JSON.stringify({ type: "pair_status_ack", pair_status: "waiting" }));
    expect(target.client.state).toBe("waiting");
    await Bun.sleep(15);
    expect(target.client.state).toBe("waiting");
    expect(target.failures).toHaveLength(0);
    target.client.dispose();
  });

  test("debugDropSocket forces the reconnect path", async () => {
    const target = harness();
    target.client.start();
    pair(target);
    target.client.debugDropSocket();
    expect(target.client.state).toBe("reconnecting");
    await Bun.sleep(2);
    expect(target.sockets).toHaveLength(2);
    target.client.dispose();
  });
});

describe("relay heartbeat", () => {
  test("polls the pair status while paired", async () => {
    const target = harness({ heartbeatIntervalMs: 2 });
    target.client.start();
    pair(target);
    await Bun.sleep(20);
    expect(target.socket().sent.some((frame) => frame["type"] === "pair_status_query")).toBe(true);
    target.client.dispose();
  });

  test("reconnects when the relay stops acknowledging the heartbeat", async () => {
    const target = harness({ heartbeatAckTimeoutMs: 0, heartbeatIntervalMs: 2 });
    target.client.start();
    pair(target);
    await Bun.sleep(20);
    expect(target.sockets.length).toBeGreaterThan(1);
    expect(target.logs.some((line) => line.includes("heartbeat ack timeout"))).toBe(true);
    target.client.dispose();
  });

  test("stops the heartbeat on dispose", async () => {
    const target = harness({ heartbeatIntervalMs: 2 });
    target.client.start();
    pair(target);
    target.client.dispose();
    const before = target.socket().sent.length;
    await Bun.sleep(20);
    expect(target.socket().sent).toHaveLength(before);
    expect(target.sockets).toHaveLength(1);
  });
});

describe("relay teardown", () => {
  test("closes the socket, reports closed and never reconnects", async () => {
    const target = harness();
    target.client.start();
    pair(target);
    const socket = target.socket();
    target.client.dispose();
    expect(target.client.state).toBe("closed");
    expect(socket.closed).toBeDefined();
    socket.onClose(1006, "after dispose");
    await Bun.sleep(5);
    expect(target.sockets).toHaveLength(1);
  });

  test("is idempotent", () => {
    const target = harness();
    target.client.start();
    pair(target);
    target.client.dispose();
    expect(() => target.client.dispose()).not.toThrow();
  });
});

describe("relay credential hygiene", () => {
  test("never writes the device credentials to the log", () => {
    const target = harness({ heartbeatIntervalMs: 2 });
    target.client.start();
    pair(target);
    target.client.sendPayload({ zcode_type: "bootstrap-request", requestId: "r1" });
    target.socket().onMessage(JSON.stringify({ type: "data", payload: { zcode_type: "bootstrap-response" } }));
    target.socket().onClose(4004, "gone");
    target.client.dispose();

    expect(target.logs.length).toBeGreaterThan(0);
    const joined = target.logs.join("\n");
    expect(joined).not.toContain(passHash);
    expect(joined).not.toContain(deviceSid);
    expect(joined).not.toContain(deviceUrl);
    expect(joined).not.toContain("auth_response\": ");
    for (const frame of target.socket().sent) {
      if (frame["type"] === "auth_response") expect(joined).not.toContain(String(frame["proof"]));
    }
  });

  test("keeps credentials out of reported failures", () => {
    const target = harness();
    target.client.start();
    target.socket().onOpen();
    target.socket().onClose(4011, "expired");
    const reported = JSON.stringify(target.failures);
    expect(reported).not.toContain(passHash);
    expect(reported).not.toContain(deviceSid);
    target.client.dispose();
  });
});
