import { afterEach, describe, expect, test } from "bun:test";

import { calculateProof } from "../src/remote/proof.ts";
import { startPrivateRelayServer, type PrivateRelayServer } from "../src/remote/relay-server.ts";

const servers: PrivateRelayServer[] = [];

function once(target: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 1000);
    target.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (frame.type !== type) return;
      clearTimeout(timer);
      resolve(frame);
    });
  });
}

async function open(path: string): Promise<WebSocket> {
  const socket = new WebSocket(path);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("socket failed to open")), { once: true });
  });
  return socket;
}

async function auth(base: string, input: { deviceSid: string; passHash: string; role: "device" | "terminal" }): Promise<{ ack: Record<string, unknown>; socket: WebSocket }> {
  const socket = await open(`${base}/ws`);
  socket.send(JSON.stringify({ type: "auth_init", role: input.role, device_sid: input.deviceSid }));
  const challenge = await once(socket, "auth_challenge");
  socket.send(JSON.stringify({
    type: "auth_response",
    device_sid: input.deviceSid,
    proof: calculateProof({
      deviceSid: input.deviceSid,
      nonce: String(challenge.nonce ?? ""),
      passHash: input.passHash,
      role: input.role
    })
  }));
  const ack = await once(socket, "auth_ack");
  return { ack, socket };
}

async function register(base: string, passHash = "hash-1"): Promise<{ deviceSid: string; passHash: string }> {
  const socket = await open(`${base}/ws?mid=machine-1`);
  socket.send(JSON.stringify({ type: "device_register_init", device_mid: "machine-1", pass_hash: passHash }));
  const ack = await once(socket, "device_register_ack");
  socket.close();
  return { deviceSid: String(ack.device_sid), passHash };
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

describe("private relay server", () => {
  test("registers a device, authenticates both roles with calculateProof, pairs and forwards data", async () => {
    const server = startPrivateRelayServer({ hostname: "127.0.0.1", port: 0 });
    servers.push(server);
    const base = `ws://127.0.0.1:${server.port}`;
    const credentials = await register(base);

    const device = await auth(base, { ...credentials, role: "device" });
    const terminal = await auth(base, { ...credentials, role: "terminal" });
    expect(terminal.ack).toMatchObject({ pair_status: "matched" });

    const received = once(device.socket, "data");
    terminal.socket.send(JSON.stringify({ type: "data", payload: { zcode_type: "ping" } }));
    expect(await received).toMatchObject({ payload: { zcode_type: "ping" } });

    terminal.socket.close();
    device.socket.close();
  });

  test("rejects invalid proofs without pairing", async () => {
    const server = startPrivateRelayServer({ hostname: "127.0.0.1", port: 0 });
    servers.push(server);
    const base = `ws://127.0.0.1:${server.port}`;
    const credentials = await register(base);
    const socket = await open(`${base}/ws`);
    socket.send(JSON.stringify({ type: "auth_init", role: "terminal", device_sid: credentials.deviceSid }));
    await once(socket, "auth_challenge");
    socket.send(JSON.stringify({ type: "auth_response", device_sid: credentials.deviceSid, proof: "wrong" }));
    expect(await once(socket, "error")).toMatchObject({ code: "INVALID_PROOF" });
    socket.close();
  });

  test("kicks the older same-role connection and keeps the newest role", async () => {
    const server = startPrivateRelayServer({ hostname: "127.0.0.1", port: 0 });
    servers.push(server);
    const base = `ws://127.0.0.1:${server.port}`;
    const credentials = await register(base);
    const first = await auth(base, { ...credentials, role: "terminal" });
    const kicked = once(first.socket, "error");
    const second = await auth(base, { ...credentials, role: "terminal" });
    expect(await kicked).toMatchObject({ code: "KICKED" });
    first.socket.close();
    second.socket.close();
  });

  test("answers heartbeat pair_status_query with current pair status", async () => {
    const server = startPrivateRelayServer({ hostname: "127.0.0.1", port: 0 });
    servers.push(server);
    const base = `ws://127.0.0.1:${server.port}`;
    const credentials = await register(base);
    const terminal = await auth(base, { ...credentials, role: "terminal" });
    terminal.socket.send(JSON.stringify({ type: "pair_status_query", device_sid: credentials.deviceSid }));
    expect(await once(terminal.socket, "pair_status_ack")).toMatchObject({ pair_status: "waiting" });
    terminal.socket.close();
  });

  test("serves the official controller page through the local origin", async () => {
    const server = startPrivateRelayServer({
      controllerFetch: async () => new Response("connect to wss://zcode.z.ai/ws and https://zcode.z.ai/assets/app.js", {
        headers: { "content-type": "text/html" }
      }),
      hostname: "127.0.0.1",
      port: 0
    });
    servers.push(server);
    const response = await fetch(`http://127.0.0.1:${server.port}/remote/v4`);
    const body = await response.text();
    expect(body).toContain(`ws://127.0.0.1:${server.port}/ws`);
    expect(body).toContain(`http://127.0.0.1:${server.port}/assets/app.js`);
  });
});
