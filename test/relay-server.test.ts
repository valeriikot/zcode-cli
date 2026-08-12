import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { calculateProof } from "../src/remote/proof.ts";
import { RelayServer, type RelayServerOptions } from "../src/relay/server.ts";

const passHash = "PASS-HASH-1234567890";

async function startRelay(options: RelayServerOptions = {}): Promise<RelayServer> {
  return await RelayServer.start({ host: "127.0.0.1", port: 0, ...options });
}

function wsUrl(relay: RelayServer): string {
  return `ws://127.0.0.1:${relay.port}/ws`;
}

interface TestSocket {
  close: () => void;
  closed: Promise<{ code: number; reason: string }>;
  next: () => Promise<Record<string, unknown>>;
  send: (frame: Record<string, unknown>) => void;
  socket: WebSocket;
}

/** Wraps the runtime WebSocket client with promise-based receive to keep tests linear. */
async function openSocket(relay: RelayServer): Promise<TestSocket> {
  const socket = new WebSocket(wsUrl(relay));
  const queue: Record<string, unknown>[] = [];
  const waiters: Array<(frame: Record<string, unknown>) => void> = [];
  let closeResolve: (value: { code: number; reason: string }) => void;
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    closeResolve = resolve;
  });
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(frame);
    else queue.push(frame);
  });
  socket.addEventListener("close", (event) => closeResolve({ code: event.code, reason: event.reason }));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("connect failed")), { once: true });
  });
  return {
    close: () => socket.close(),
    closed,
    next: () => {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), 5000);
        waiters.push((frame) => {
          clearTimeout(timer);
          resolve(frame);
        });
      });
    },
    send: (frame) => socket.send(JSON.stringify(frame)),
    socket
  };
}

async function registerDevice(relay: RelayServer, mid = `machine-${randomUUID()}`): Promise<string> {
  const socket = await openSocket(relay);
  socket.send({ type: "device_register_init", device_mid: mid, pass_hash: passHash, meta: { name: "host" } });
  const ack = await socket.next();
  expect(ack["type"]).toBe("device_register_ack");
  socket.close();
  return ack["device_sid"] as string;
}

async function authenticate(
  relay: RelayServer,
  sid: string,
  role: "device" | "terminal"
): Promise<TestSocket> {
  const socket = await openSocket(relay);
  socket.send({ type: "auth_init", role, device_sid: sid, meta: { name: role } });
  const challenge = await socket.next();
  expect(challenge["type"]).toBe("auth_challenge");
  socket.send({
    type: "auth_response",
    device_sid: sid,
    proof: calculateProof({ deviceSid: sid, nonce: challenge["nonce"] as string, passHash, role })
  });
  const ack = await socket.next();
  expect(ack["type"]).toBe("auth_ack");
  return socket;
}

describe("relay http surface", () => {
  test("serves health, the pairing page, and 404/405 elsewhere", async () => {
    const relay = await startRelay();
    try {
      const health = await fetch(`http://127.0.0.1:${relay.port}/healthz`);
      expect(health.status).toBe(200);
      const body = await health.json() as Record<string, unknown>;
      expect(body["ok"]).toBe(true);
      expect(body["connections"]).toBe(0);

      const page = await fetch(`http://127.0.0.1:${relay.port}/remote/v4?sid=SECRET&hash=SECRET&t=1`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("ZCode private relay");
      expect(html).not.toContain("SECRET");

      expect((await fetch(`http://127.0.0.1:${relay.port}/elsewhere`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${relay.port}/healthz`, { method: "POST" })).status).toBe(405);
    } finally {
      await relay.close();
    }
  });

  test("serves a custom page path", async () => {
    const relay = await startRelay({ pagePath: "/pair" });
    try {
      expect((await fetch(`http://127.0.0.1:${relay.port}/pair`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${relay.port}/remote/v4`)).status).toBe(404);
    } finally {
      await relay.close();
    }
  });
});

describe("relay websocket protocol over real sockets", () => {
  test("registers, authenticates, pairs and forwards data", async () => {
    const relay = await startRelay();
    try {
      const sid = await registerDevice(relay);
      const host = await authenticate(relay, sid, "device");

      const controller = await authenticate(relay, sid, "terminal");
      const hostStatus = await host.next();
      expect(hostStatus).toMatchObject({ type: "pair_status_ack", pair_status: "matched" });

      controller.send({ type: "data", payload: { zcode_type: "bootstrap-request", requestId: "r1" } });
      const forwarded = await host.next();
      expect(forwarded["type"]).toBe("data");
      expect(forwarded["payload"]).toEqual({ zcode_type: "bootstrap-request", requestId: "r1" });

      host.send({ type: "data", payload: { zcode_type: "bootstrap-response", requestId: "r1" } });
      const response = await controller.next();
      expect(response["payload"]).toEqual({ zcode_type: "bootstrap-response", requestId: "r1" });

      expect(relay.snapshot().pairedSessions).toBe(1);
      host.close();
      controller.close();
    } finally {
      await relay.close();
    }
  });

  test("closes 4004/4013 for unknown sessions and invalid proofs", async () => {
    const relay = await startRelay();
    try {
      const unknown = await openSocket(relay);
      unknown.send({ type: "auth_init", role: "terminal", device_sid: "missing" });
      expect((await unknown.closed).code).toBe(4004);

      const sid = await registerDevice(relay);
      const badProof = await openSocket(relay);
      badProof.send({ type: "auth_init", role: "terminal", device_sid: sid });
      await badProof.next();
      badProof.send({ type: "auth_response", device_sid: sid, proof: "wrong" });
      expect((await badProof.closed).code).toBe(4013);
    } finally {
      await relay.close();
    }
  });

  test("kicks a duplicate host with an error frame and 4009", async () => {
    const relay = await startRelay();
    try {
      const sid = await registerDevice(relay);
      const first = await authenticate(relay, sid, "device");
      const second = await authenticate(relay, sid, "device");
      const kicked = await first.next();
      expect(kicked).toMatchObject({ type: "error", code: "KICKED" });
      expect((await first.closed).code).toBe(4009);
      second.close();
    } finally {
      await relay.close();
    }
  });

  test("closes connections that never authenticate within the deadline", async () => {
    const relay = await startRelay({ authTimeoutMs: 100, sweepIntervalMs: 20 });
    try {
      const socket = await openSocket(relay);
      const closed = await socket.closed;
      expect(closed.code).toBe(1008);
      expect(closed.reason).toBe("authentication timeout");
    } finally {
      await relay.close();
    }
  });

  test("closes idle authenticated connections", async () => {
    const relay = await startRelay({ idleTimeoutMs: 100, sweepIntervalMs: 20 });
    try {
      const sid = await registerDevice(relay);
      const host = await authenticate(relay, sid, "device");
      const closed = await host.closed;
      // The relay sends 1001; Bun's client normalizes it to 1000 while Node keeps it. The reason
      // string is delivered verbatim either way.
      expect([1000, 1001]).toContain(closed.code);
      expect(closed.reason).toBe("idle timeout");
    } finally {
      await relay.close();
    }
  });

  test("closes 1008 on malformed JSON frames", async () => {
    const relay = await startRelay();
    try {
      const socket = await openSocket(relay);
      socket.socket.send("this is not json");
      const closed = await socket.closed;
      expect(closed.code).toBe(1008);
      expect(closed.reason).toBe("invalid frame");
    } finally {
      await relay.close();
    }
  });

  test("closes 1009 on oversized messages", async () => {
    const relay = await startRelay({ maximumMessageBytes: 1024 });
    try {
      const socket = await openSocket(relay);
      socket.send({ type: "data", padding: "x".repeat(4096) });
      expect((await socket.closed).code).toBe(1009);
    } finally {
      await relay.close();
    }
  });

  test("rejects upgrades beyond the connection limit", async () => {
    const relay = await startRelay({ maximumConnections: 1 });
    try {
      const first = await openSocket(relay);
      await expect(openSocket(relay)).rejects.toThrow("connect failed");
      first.close();
    } finally {
      await relay.close();
    }
  });

  test("rejects non-websocket upgrade paths", async () => {
    const relay = await startRelay();
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/elsewhere`);
      await new Promise<void>((resolve) => {
        socket.addEventListener("error", () => resolve(), { once: true });
        socket.addEventListener("close", () => resolve(), { once: true });
      });
    } finally {
      await relay.close();
    }
  });
});

describe("relay raw-socket handling", () => {
  function rawUpgrade(relay: RelayServer): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = connect(relay.port, "127.0.0.1", () => {
        socket.write(
          "GET /ws HTTP/1.1\r\n"
          + `Host: 127.0.0.1:${relay.port}\r\n`
          + "Upgrade: websocket\r\n"
          + "Connection: Upgrade\r\n"
          + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
          + "Sec-WebSocket-Version: 13\r\n"
          + "\r\n"
        );
      });
      socket.once("error", reject);
      socket.once("data", (chunk: Buffer) => {
        if (!chunk.toString("latin1").startsWith("HTTP/1.1 101")) {
          reject(new Error(`unexpected handshake response: ${chunk.toString("latin1").split("\r\n")[0]}`));
          return;
        }
        resolve(socket);
      });
    });
  }

  function readCloseCode(socket: Socket): Promise<number> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => reject(new Error("no close frame")), 5000);
      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        const data = Buffer.concat(chunks);
        if (data.length < 2) return;
        if ((data[0]! & 0x0f) !== 0x8) return;
        clearTimeout(timer);
        resolve(data.length >= 4 ? data.readUInt16BE(2) : 1005);
      });
    });
  }

  test("closes 1002 on an unmasked client frame", async () => {
    const relay = await startRelay();
    try {
      const socket = await rawUpgrade(relay);
      const payload = Buffer.from("{}", "utf8");
      socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
      expect(await readCloseCode(socket)).toBe(1002);
      socket.destroy();
    } finally {
      await relay.close();
    }
  });

  test("closes 1003 on binary frames", async () => {
    const relay = await startRelay();
    try {
      const socket = await rawUpgrade(relay);
      const mask = Buffer.from([1, 2, 3, 4]);
      const body = Buffer.from([9, 9, 9]);
      const masked = Buffer.from(body.map((byte, index) => byte ^ mask[index % 4]!));
      socket.write(Buffer.concat([Buffer.from([0x82, 0x80 | body.length]), mask, masked]));
      expect(await readCloseCode(socket)).toBe(1003);
      socket.destroy();
    } finally {
      await relay.close();
    }
  });

  test("rejects a plain GET to /ws and a bad upgrade", async () => {
    const relay = await startRelay();
    try {
      const plain = await fetch(`http://127.0.0.1:${relay.port}/ws`);
      expect(plain.status).toBe(404);

      const response = await new Promise<string>((resolve, reject) => {
        const socket = connect(relay.port, "127.0.0.1", () => {
          socket.write(
            "GET /ws HTTP/1.1\r\n"
            + `Host: 127.0.0.1:${relay.port}\r\n`
            + "Upgrade: websocket\r\n"
            + "Connection: Upgrade\r\n"
            + "Sec-WebSocket-Version: 12\r\n"
            + "\r\n"
          );
        });
        socket.once("error", reject);
        socket.once("data", (chunk: Buffer) => resolve(chunk.toString("latin1")));
      });
      expect(response.startsWith("HTTP/1.1 400")).toBe(true);
    } finally {
      await relay.close();
    }
  });
});

describe("relay state persistence", () => {
  test("keeps registrations usable across a relay restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-relay-state-"));
    const statePath = join(directory, "state.json");
    const first = await startRelay({ statePath });
    const sid = await registerDevice(first, "machine-persist");
    await first.close();

    const raw = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    expect(Array.isArray(raw["registrations"])).toBe(true);
    if (process.platform !== "win32") {
      expect(((await stat(statePath)).mode & 0o077)).toBe(0);
    }

    const second = await startRelay({ statePath });
    try {
      const host = await authenticate(second, sid, "device");
      host.close();
    } finally {
      await second.close();
    }
  });

  test("starts with an empty store when the state file does not exist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-relay-state-"));
    const relay = await startRelay({ statePath: join(directory, "missing.json") });
    try {
      expect(relay.snapshot().registrations).toBe(0);
    } finally {
      await relay.close();
    }
  });
});
