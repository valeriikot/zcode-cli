import { describe, expect, test } from "bun:test";

import { calculateProof } from "../src/remote/proof.ts";
import {
  parseRelayRegistrationRecord,
  RelayCore,
  relayProtocolCloseCodes,
  type RelayCoreOptions,
  type RelayLink
} from "../src/relay/core.ts";

interface FakeLink {
  closed: Array<{ code: number; reason: string }>;
  link: RelayLink;
  sent: Record<string, unknown>[];
}

function fakeLink(): FakeLink {
  const closed: Array<{ code: number; reason: string }> = [];
  const sent: Record<string, unknown>[] = [];
  return {
    closed,
    link: {
      close: (code, reason) => closed.push({ code, reason }),
      send: (text) => sent.push(JSON.parse(text) as Record<string, unknown>)
    },
    sent
  };
}

interface Harness {
  clock: { now: number };
  core: RelayCore;
  logs: string[];
  registrationsChanged: number[];
}

function harness(options: Omit<RelayCoreOptions, "now" | "onLog" | "onRegistrationsChanged"> = {}): Harness {
  const clock = { now: 1_000_000 };
  const logs: string[] = [];
  const registrationsChanged: number[] = [];
  const core = new RelayCore({
    ...options,
    now: () => clock.now,
    onLog: (line) => logs.push(line),
    onRegistrationsChanged: () => registrationsChanged.push(clock.now)
  });
  return { clock, core, logs, registrationsChanged };
}

const passHash = "PASS-HASH-1234567890";

function register(target: Harness, mid = "machine-1", hash = passHash): string {
  const registrar = fakeLink();
  const handle = target.core.open(registrar.link);
  target.core.message(handle, JSON.stringify({
    type: "device_register_init",
    device_mid: mid,
    pass_hash: hash,
    meta: { platform: "linux", version: "1.0.0", name: "test-host" },
    client_ts: target.clock.now
  }));
  const ack = registrar.sent.find((frame) => frame["type"] === "device_register_ack");
  expect(ack).toBeDefined();
  target.core.closed(handle);
  return ack!["device_sid"] as string;
}

interface AuthedConnection {
  handle: ReturnType<RelayCore["open"]>;
  peer: FakeLink;
}

function authenticate(
  target: Harness,
  sid: string,
  role: "device" | "terminal",
  hash = passHash
): AuthedConnection {
  const peer = fakeLink();
  const handle = target.core.open(peer.link);
  target.core.message(handle, JSON.stringify({ type: "auth_init", role, device_sid: sid, client_ts: 0 }));
  const challenge = peer.sent.find((frame) => frame["type"] === "auth_challenge");
  expect(challenge).toBeDefined();
  target.core.message(handle, JSON.stringify({
    type: "auth_response",
    device_sid: sid,
    proof: calculateProof({ deviceSid: sid, nonce: challenge!["nonce"] as string, passHash: hash, role }),
    client_ts: 0
  }));
  return { handle, peer };
}

function lastPairStatus(link: FakeLink): string | undefined {
  const frames = link.sent.filter((frame) => frame["type"] === "auth_ack" || frame["type"] === "pair_status_ack");
  return frames.length === 0 ? undefined : frames[frames.length - 1]!["pair_status"] as string;
}

describe("relay registration", () => {
  test("issues a device sid and reports the change", () => {
    const target = harness();
    const sid = register(target);
    expect(sid.length).toBeGreaterThanOrEqual(32);
    expect(target.registrationsChanged).toHaveLength(1);
    expect(target.core.snapshot().registrations).toBe(1);
  });

  test("rejects malformed registrations", () => {
    const target = harness();
    for (const frame of [
      { type: "device_register_init", pass_hash: passHash },
      { type: "device_register_init", device_mid: "m", pass_hash: "short" },
      { type: "device_register_init", device_mid: "bad mid!", pass_hash: passHash },
      { type: "device_register_init", device_mid: "m".repeat(200), pass_hash: passHash }
    ]) {
      const registrar = fakeLink();
      const handle = target.core.open(registrar.link);
      target.core.message(handle, JSON.stringify(frame));
      expect(registrar.sent[0]!["code"]).toBe("REGISTRATION_INVALID");
      expect(registrar.closed[0]!.code).toBe(1008);
    }
    expect(target.core.snapshot().registrations).toBe(0);
  });

  test("caps the registration store", () => {
    const target = harness({ maximumRegistrations: 2 });
    register(target, "machine-1");
    register(target, "machine-2");
    const registrar = fakeLink();
    const handle = target.core.open(registrar.link);
    target.core.message(handle, JSON.stringify({
      type: "device_register_init",
      device_mid: "machine-3",
      pass_hash: passHash
    }));
    expect(registrar.sent[0]!["code"]).toBe("REGISTRATION_LIMIT");
    expect(registrar.closed[0]!.code).toBe(1013);
    expect(target.core.snapshot().registrations).toBe(2);
  });

  test("re-registering a machine id rotates the credential and kills the old session", () => {
    const target = harness();
    const oldSid = register(target, "machine-1");
    const host = authenticate(target, oldSid, "device");
    expect(lastPairStatus(host.peer)).toBe("waiting");

    const newSid = register(target, "machine-1", "ROTATED-HASH-1234567890");
    expect(newSid).not.toBe(oldSid);
    expect(target.core.snapshot().registrations).toBe(1);
    expect(host.peer.closed[0]!.code).toBe(relayProtocolCloseCodes.sessionExpired);

    // The old sid no longer authenticates.
    const stale = fakeLink();
    const handle = target.core.open(stale.link);
    target.core.message(handle, JSON.stringify({ type: "auth_init", role: "device", device_sid: oldSid }));
    expect(stale.closed[0]!.code).toBe(relayProtocolCloseCodes.sessionNotFound);
  });
});

describe("relay authentication", () => {
  test("authenticates a host with a valid proof and reports waiting", () => {
    const target = harness();
    const sid = register(target);
    const host = authenticate(target, sid, "device");
    expect(lastPairStatus(host.peer)).toBe("waiting");
    expect(target.core.snapshot().authenticatedConnections).toBe(1);
  });

  test("closes 4004 for an unknown session id", () => {
    const target = harness();
    const link = fakeLink();
    const handle = target.core.open(link.link);
    target.core.message(handle, JSON.stringify({ type: "auth_init", role: "terminal", device_sid: "nope" }));
    expect(link.closed).toEqual([{ code: 4004, reason: "session-not-found" }]);
  });

  test("closes 4011 for an expired registration and prunes it", () => {
    const target = harness({ registrationTtlMs: 1000 });
    const sid = register(target);
    target.clock.now += 2000;
    const link = fakeLink();
    const handle = target.core.open(link.link);
    target.core.message(handle, JSON.stringify({ type: "auth_init", role: "device", device_sid: sid }));
    expect(link.closed).toEqual([{ code: 4011, reason: "session-expired" }]);
    expect(target.core.snapshot().registrations).toBe(0);
  });

  test("closes 4013 on an invalid proof", () => {
    const target = harness();
    const sid = register(target);
    const link = fakeLink();
    const handle = target.core.open(link.link);
    target.core.message(handle, JSON.stringify({ type: "auth_init", role: "terminal", device_sid: sid }));
    target.core.message(handle, JSON.stringify({
      type: "auth_response",
      device_sid: sid,
      proof: "not-the-right-proof"
    }));
    expect(link.closed).toEqual([{ code: 4013, reason: "invalid-proof" }]);
    expect(target.core.snapshot().authenticatedConnections).toBe(0);
  });

  test("closes 4013 on a proof computed with the wrong pass hash", () => {
    const target = harness();
    const sid = register(target);
    const link = fakeLink();
    const handle = target.core.open(link.link);
    target.core.message(handle, JSON.stringify({ type: "auth_init", role: "terminal", device_sid: sid }));
    const challenge = link.sent[0]!;
    target.core.message(handle, JSON.stringify({
      type: "auth_response",
      device_sid: sid,
      proof: calculateProof({
        deviceSid: sid,
        nonce: challenge["nonce"] as string,
        passHash: "WRONG-HASH-1234567890",
        role: "terminal"
      })
    }));
    expect(link.closed[0]!.code).toBe(4013);
  });

  test("closes 4013 on a proof for the wrong role", () => {
    const target = harness();
    const sid = register(target);
    const link = fakeLink();
    const handle = target.core.open(link.link);
    target.core.message(handle, JSON.stringify({ type: "auth_init", role: "terminal", device_sid: sid }));
    const challenge = link.sent[0]!;
    target.core.message(handle, JSON.stringify({
      type: "auth_response",
      device_sid: sid,
      proof: calculateProof({
        deviceSid: sid,
        nonce: challenge["nonce"] as string,
        passHash,
        role: "device"
      })
    }));
    expect(link.closed[0]!.code).toBe(4013);
  });

  test("rejects out-of-order and mismatched auth frames", () => {
    const target = harness();
    const sid = register(target);

    const early = fakeLink();
    const earlyHandle = target.core.open(early.link);
    target.core.message(earlyHandle, JSON.stringify({ type: "auth_response", device_sid: sid, proof: "x" }));
    expect(early.closed[0]!.code).toBe(1008);

    const badRole = fakeLink();
    const badRoleHandle = target.core.open(badRole.link);
    target.core.message(badRoleHandle, JSON.stringify({ type: "auth_init", role: "admin", device_sid: sid }));
    expect(badRole.closed[0]!.code).toBe(1008);

    const mismatch = fakeLink();
    const mismatchHandle = target.core.open(mismatch.link);
    target.core.message(mismatchHandle, JSON.stringify({ type: "auth_init", role: "device", device_sid: sid }));
    target.core.message(mismatchHandle, JSON.stringify({
      type: "auth_response",
      device_sid: "different",
      proof: "x"
    }));
    expect(mismatch.closed[0]!.code).toBe(1008);
  });
});

describe("relay pairing", () => {
  test("matches a host and a controller on the same sid and pushes the status to the peer", () => {
    const target = harness();
    const sid = register(target);
    const host = authenticate(target, sid, "device");
    expect(lastPairStatus(host.peer)).toBe("waiting");

    const controller = authenticate(target, sid, "terminal");
    expect(lastPairStatus(controller.peer)).toBe("matched");
    expect(lastPairStatus(host.peer)).toBe("matched");
    expect(target.core.snapshot().pairedSessions).toBe(1);
  });

  test("keeps sessions with different sids apart", () => {
    const target = harness();
    const sidA = register(target, "machine-a");
    const sidB = register(target, "machine-b");
    const hostA = authenticate(target, sidA, "device");
    const controllerB = authenticate(target, sidB, "terminal");
    expect(lastPairStatus(hostA.peer)).toBe("waiting");
    expect(lastPairStatus(controllerB.peer)).toBe("waiting");
    expect(target.core.snapshot().pairedSessions).toBe(0);
  });

  test("answers pair_status_query with the current status", () => {
    const target = harness();
    const sid = register(target);
    const host = authenticate(target, sid, "device");
    target.core.message(host.handle, JSON.stringify({ type: "pair_status_query", device_sid: sid }));
    expect(lastPairStatus(host.peer)).toBe("waiting");

    authenticate(target, sid, "terminal");
    target.core.message(host.handle, JSON.stringify({ type: "pair_status_query", device_sid: sid }));
    expect(lastPairStatus(host.peer)).toBe("matched");
  });

  test("pushes waiting to the survivor when its peer disconnects", () => {
    const target = harness();
    const sid = register(target);
    const host = authenticate(target, sid, "device");
    const controller = authenticate(target, sid, "terminal");
    target.core.closed(controller.handle);
    expect(lastPairStatus(host.peer)).toBe("waiting");

    const controller2 = authenticate(target, sid, "terminal");
    expect(lastPairStatus(host.peer)).toBe("matched");
    target.core.closed(host.handle);
    expect(lastPairStatus(controller2.peer)).toBe("waiting");
  });

  test("kicks the older duplicate connection deterministically", () => {
    const target = harness();
    const sid = register(target);
    const firstHost = authenticate(target, sid, "device");
    const controller = authenticate(target, sid, "terminal");

    const secondHost = authenticate(target, sid, "device");
    const kicked = firstHost.peer.sent.find((frame) => frame["code"] === "KICKED");
    expect(kicked).toBeDefined();
    expect(firstHost.peer.closed).toEqual([{ code: 4009, reason: "session-conflict" }]);
    // The controller never saw a `waiting` gap: the slot was replaced atomically.
    expect(lastPairStatus(controller.peer)).toBe("matched");
    expect(lastPairStatus(secondHost.peer)).toBe("matched");

    const secondController = authenticate(target, sid, "terminal");
    expect(controller.peer.sent.some((frame) => frame["code"] === "KICKED")).toBe(true);
    expect(controller.peer.closed[0]!.code).toBe(4009);
    expect(lastPairStatus(secondController.peer)).toBe("matched");
    expect(target.core.snapshot().pairedSessions).toBe(1);
  });

  test("a host replaced while it was the only session member can still be paired with", () => {
    const target = harness();
    const sid = register(target);
    const firstHost = authenticate(target, sid, "device");
    const secondHost = authenticate(target, sid, "device");
    expect(firstHost.peer.closed[0]!.code).toBe(4009);
    expect(lastPairStatus(secondHost.peer)).toBe("waiting");

    // Regression: kicking the sole occupant used to strand its replacement in an orphaned
    // session, so a later controller could never match.
    const controller = authenticate(target, sid, "terminal");
    expect(lastPairStatus(controller.peer)).toBe("matched");
    expect(lastPairStatus(secondHost.peer)).toBe("matched");
    expect(target.core.snapshot().pairedSessions).toBe(1);
    expect(target.core.snapshot().sessions).toBe(1);
  });
});

describe("relay data forwarding", () => {
  test("forwards data payloads in both directions", () => {
    const target = harness();
    const sid = register(target);
    const host = authenticate(target, sid, "device");
    const controller = authenticate(target, sid, "terminal");

    target.core.message(controller.handle, JSON.stringify({
      type: "data",
      payload: { zcode_type: "bootstrap-request", requestId: "r1" }
    }));
    const toHost = host.peer.sent.filter((frame) => frame["type"] === "data");
    expect(toHost).toHaveLength(1);
    expect(toHost[0]!["payload"]).toEqual({ zcode_type: "bootstrap-request", requestId: "r1" });

    target.core.message(host.handle, JSON.stringify({
      type: "data",
      payload: { zcode_type: "bootstrap-response", requestId: "r1", result: { workspaces: [] } }
    }));
    const toController = controller.peer.sent.filter((frame) => frame["type"] === "data");
    expect(toController).toHaveLength(1);
    expect(toController[0]!["payload"]).toEqual({
      zcode_type: "bootstrap-response",
      requestId: "r1",
      result: { workspaces: [] }
    });
  });

  test("drops data without a peer instead of buffering", () => {
    const target = harness();
    const sid = register(target);
    const host = authenticate(target, sid, "device");
    target.core.message(host.handle, JSON.stringify({ type: "data", payload: { zcode_type: "x" } }));
    expect(host.peer.closed).toHaveLength(0);
    expect(target.logs.some((line) => line.includes("no peer"))).toBe(true);
  });

  test("drops non-object payloads", () => {
    const target = harness();
    const sid = register(target);
    const host = authenticate(target, sid, "device");
    const controller = authenticate(target, sid, "terminal");
    target.core.message(host.handle, JSON.stringify({ type: "data", payload: "text" }));
    target.core.message(host.handle, JSON.stringify({ type: "data", payload: [1, 2] }));
    expect(controller.peer.sent.filter((frame) => frame["type"] === "data")).toHaveLength(0);
  });

  test("closes unauthenticated connections that send data or queries", () => {
    const target = harness();
    const dataLink = fakeLink();
    const dataHandle = target.core.open(dataLink.link);
    target.core.message(dataHandle, JSON.stringify({ type: "data", payload: { a: 1 } }));
    expect(dataLink.closed[0]!.code).toBe(1008);

    const queryLink = fakeLink();
    const queryHandle = target.core.open(queryLink.link);
    target.core.message(queryHandle, JSON.stringify({ type: "pair_status_query", device_sid: "x" }));
    expect(queryLink.closed[0]!.code).toBe(1008);
  });
});

describe("relay malformed frames", () => {
  test("closes 1008 on invalid JSON", () => {
    const target = harness();
    const link = fakeLink();
    const handle = target.core.open(link.link);
    target.core.message(handle, "{not json");
    expect(link.closed).toEqual([{ code: 1008, reason: "invalid frame" }]);
  });

  test("closes 1008 on non-object frames and unknown pre-auth types", () => {
    const target = harness();
    for (const raw of [JSON.stringify([1, 2]), JSON.stringify("frame"), JSON.stringify({ type: "mystery" })]) {
      const link = fakeLink();
      const handle = target.core.open(link.link);
      target.core.message(handle, raw);
      expect(link.closed[0]!.code).toBe(1008);
    }
  });

  test("tolerates unknown frame types after authentication", () => {
    const target = harness();
    const sid = register(target);
    const host = authenticate(target, sid, "device");
    target.core.message(host.handle, JSON.stringify({ type: "future-extension", x: 1 }));
    expect(host.peer.closed).toHaveLength(0);
    expect(target.core.snapshot().authenticatedConnections).toBe(1);
  });
});

describe("relay sweeping", () => {
  test("closes connections that never authenticate before the deadline", () => {
    const target = harness({ authTimeoutMs: 1000 });
    const link = fakeLink();
    target.core.open(link.link);
    target.clock.now += 500;
    target.core.tick();
    expect(link.closed).toHaveLength(0);
    target.clock.now += 600;
    target.core.tick();
    expect(link.closed).toEqual([{ code: 1008, reason: "authentication timeout" }]);
  });

  test("closes idle authenticated connections and notifies the peer", () => {
    const target = harness({ idleTimeoutMs: 1000 });
    const sid = register(target);
    const host = authenticate(target, sid, "device");
    const controller = authenticate(target, sid, "terminal");
    target.clock.now += 900;
    target.core.activity(controller.handle);
    target.core.tick();
    expect(host.peer.closed).toHaveLength(0);

    target.clock.now += 200;
    target.core.tick();
    // The host has been silent for 1100ms; the refreshed controller survives and is told waiting.
    expect(host.peer.closed).toEqual([{ code: 1001, reason: "idle timeout" }]);
    expect(controller.peer.closed).toHaveLength(0);
    expect(lastPairStatus(controller.peer)).toBe("waiting");
  });

  test("prunes expired registrations and closes their sessions", () => {
    const target = harness({ registrationTtlMs: 1000, idleTimeoutMs: 60_000 });
    const sid = register(target);
    const host = authenticate(target, sid, "device");
    const changes = target.registrationsChanged.length;
    target.clock.now += 1500;
    target.core.activity(host.handle);
    target.core.tick();
    expect(host.peer.closed).toEqual([{ code: 4011, reason: "session-expired" }]);
    expect(target.core.snapshot().registrations).toBe(0);
    expect(target.registrationsChanged.length).toBe(changes + 1);
  });
});

describe("relay persistence", () => {
  test("round-trips registrations through records", () => {
    const target = harness();
    const sid = register(target, "machine-1");
    const records = target.core.registrationRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.deviceSid).toBe(sid);
    expect(records[0]!.mid).toBe("machine-1");
    expect(records[0]!.name).toBe("test-host");

    const restored = harness();
    expect(restored.core.loadRegistrations(records)).toBe(1);
    const host = authenticate(restored, sid, "device");
    expect(lastPairStatus(host.peer)).toBe("waiting");
  });

  test("skips invalid persisted entries", () => {
    const target = harness();
    expect(target.core.loadRegistrations([
      null,
      42,
      { deviceSid: "a" },
      { deviceSid: "a", mid: "m", passHash: "p", createdAt: "notanumber", lastSeenAt: 1 }
    ])).toBe(0);
    expect(parseRelayRegistrationRecord({
      createdAt: 1,
      deviceSid: "sid",
      lastSeenAt: 2,
      mid: "mid",
      passHash: "hash"
    })).toEqual({ createdAt: 1, deviceSid: "sid", lastSeenAt: 2, mid: "mid", passHash: "hash" });
  });

  test("ignores duplicate sids or mids when loading", () => {
    const record = { createdAt: 1, deviceSid: "sid-1", lastSeenAt: 2, mid: "mid-1", passHash: "hash" };
    const target = harness();
    expect(target.core.loadRegistrations([record, { ...record }, { ...record, deviceSid: "sid-2" }])).toBe(1);
  });
});

describe("relay credential hygiene", () => {
  test("never logs sids, pass hashes or proofs", () => {
    const target = harness();
    const sid = register(target);
    const host = authenticate(target, sid, "device");
    const controller = authenticate(target, sid, "terminal");
    target.core.message(controller.handle, JSON.stringify({ type: "data", payload: { zcode_type: "x" } }));
    authenticate(target, sid, "device");
    target.core.closed(host.handle);

    const joined = target.logs.join("\n");
    expect(target.logs.length).toBeGreaterThan(0);
    expect(joined).not.toContain(sid);
    expect(joined).not.toContain(passHash);
    for (const frame of [...host.peer.sent, ...controller.peer.sent]) {
      const nonce = frame["nonce"];
      if (typeof nonce === "string") expect(joined).not.toContain(nonce);
    }
  });
});
