import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { parseRemoteConnectionUrl } from "../src/remote/connection-params.ts";
import {
  createRemoteHostLink,
  readRemoteHostLink,
  registerRemoteHostLink,
  remoteHostLinkParams,
  remoteHostLinkUrl,
  writeRemoteHostLink,
  type RemoteHostLinkRecord
} from "../src/remote/host-link.ts";
import { RemoteHostService, type RemoteHostBackend } from "../src/remote/host.ts";
import { probeRemoteDevice, RemoteClient } from "../src/remote/client.ts";
import type { RelayFailure, RelayState } from "../src/remote/relay-client.ts";
import { runRemoteCommand } from "../src/remote-cli.ts";
import { RelayServer, type RelayServerOptions } from "../src/relay/server.ts";

const appVersion = "1.0.0-test";

/** Options that keep reconnect behaviour fast enough for tests without changing its shape. */
const fastRelayOptions = {
  heartbeatIntervalMs: 50,
  reconnectDelayMs: () => 25
};

async function temporaryEnv(prefix: string): Promise<NodeJS.ProcessEnv> {
  const home = await mkdtemp(join(tmpdir(), prefix));
  return { HOME: home, USERPROFILE: home };
}

async function startRelay(options: RelayServerOptions = {}): Promise<RelayServer> {
  return await RelayServer.start({ host: "127.0.0.1", port: 0, ...options });
}

/** Restarting on a fixed port can race the old listener's teardown, so retry briefly. */
async function startRelayOnPort(port: number, options: RelayServerOptions = {}): Promise<RelayServer> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await RelayServer.start({ host: "127.0.0.1", ...options, port });
    } catch (error) {
      lastError = error;
      await Bun.sleep(50);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function createRegisteredLink(relay: RelayServer, env: NodeJS.ProcessEnv): Promise<RemoteHostLinkRecord> {
  const created = await createRemoteHostLink({
    name: "integration-host",
    relayUrl: `http://127.0.0.1:${relay.port}/remote/v4`
  }, env);
  const record = await registerRemoteHostLink(created.record, { appVersion });
  await writeRemoteHostLink(record, env);
  return record;
}

const echoBackend: RemoteHostBackend = {
  call: async ({ args, channel, name, workspaceKey }) => ({ args, channel, name, workspaceKey }),
  listWorkspaces: () => [{ key: "ws-test", name: "Test Workspace", path: "/tmp/integration" }]
};

interface HostHarness {
  failures: RelayFailure[];
  service: RemoteHostService;
  states: RelayState[];
}

function startHost(record: RemoteHostLinkRecord): HostHarness {
  const service = new RemoteHostService(remoteHostLinkParams(record, appVersion), echoBackend, {
    ...fastRelayOptions,
    appVersion,
    deviceName: "integration-host"
  });
  const failures: RelayFailure[] = [];
  const states: RelayState[] = [];
  service.onFailure((failure) => failures.push(failure));
  service.onState((state) => states.push(state));
  service.start();
  return { failures, service, states };
}

function captureStream(): { stream: Writable; text: () => string } {
  const parts: string[] = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        parts.push(String(chunk));
        callback();
      }
    }),
    text: () => parts.join("")
  };
}

describe("relay end-to-end pairing", () => {
  test("registers a host link against the relay and pairs a probe with it", async () => {
    const relay = await startRelay();
    const env = await temporaryEnv("zcode-relay-e2e-");
    const record = await createRegisteredLink(relay, env);
    expect(record.deviceSid.length).toBeGreaterThanOrEqual(32);

    const host = startHost(record);
    try {
      await waitFor(() => host.service.state === "waiting", "host to reach waiting");

      const params = parseRemoteConnectionUrl(remoteHostLinkUrl(record, appVersion))!;
      const snapshot = await probeRemoteDevice(params, { ...fastRelayOptions, pairingTimeoutMs: 5000 });
      expect(snapshot.paired).toBe(true);
      expect(snapshot.state).toBe("paired");
      expect(snapshot.workspaces).toEqual([
        { key: "ws-test", name: "Test Workspace", path: "/tmp/integration" }
      ]);
      expect(snapshot.host).toBe(`127.0.0.1:${relay.port}`);
      expect(host.failures).toHaveLength(0);
    } finally {
      host.service.dispose();
      await relay.close();
    }
  }, 20_000);

  test("routes channel RPC calls from controller to host backend over a workspace bridge", async () => {
    const relay = await startRelay();
    const env = await temporaryEnv("zcode-relay-e2e-");
    const record = await createRegisteredLink(relay, env);
    const host = startHost(record);
    const params = parseRemoteConnectionUrl(remoteHostLinkUrl(record, appVersion))!;
    const client = new RemoteClient(params, fastRelayOptions);
    try {
      await waitFor(() => host.service.state === "waiting", "host to reach waiting");
      const snapshot = await client.connect({ pairingTimeoutMs: 5000, workspaceKey: "ws-test" });
      expect(snapshot.paired).toBe(true);
      expect(snapshot.bridgedWorkspaceKey).toBe("ws-test");
      await waitFor(() => host.service.activeBridgeCount === 1, "host bridge to open");

      const result = await client.request("workspace/echo", { value: 42 });
      expect(result).toEqual({
        args: [{ value: 42 }],
        channel: "workspace",
        name: "echo",
        workspaceKey: "ws-test"
      });
    } finally {
      client.dispose();
      host.service.dispose();
      await relay.close();
    }
  }, 20_000);

  test("recovers pairing and bridge after the controller drops its socket", async () => {
    const relay = await startRelay();
    const env = await temporaryEnv("zcode-relay-e2e-");
    const record = await createRegisteredLink(relay, env);
    const host = startHost(record);
    const params = parseRemoteConnectionUrl(remoteHostLinkUrl(record, appVersion))!;
    const client = new RemoteClient(params, fastRelayOptions);
    try {
      await waitFor(() => host.service.state === "waiting", "host to reach waiting");
      await client.connect({ pairingTimeoutMs: 5000, workspaceKey: "ws-test" });
      // A completed call proves the channel handshake finished before the mid-session drop.
      await client.request("workspace/echo", { before: "controller-drop" }, { timeoutMs: 5000 });

      client.relay.debugDropSocket();
      await waitFor(() => client.state === "paired", "controller to re-pair");
      const result = await client.request("workspace/echo", { after: "controller-drop" }, { timeoutMs: 5000 });
      expect((result as Record<string, unknown>)["args"]).toEqual([{ after: "controller-drop" }]);
    } finally {
      client.dispose();
      host.service.dispose();
      await relay.close();
    }
  }, 20_000);

  test("recovers pairing after the host drops its socket", async () => {
    const relay = await startRelay();
    const env = await temporaryEnv("zcode-relay-e2e-");
    const record = await createRegisteredLink(relay, env);
    const host = startHost(record);
    const params = parseRemoteConnectionUrl(remoteHostLinkUrl(record, appVersion))!;
    const client = new RemoteClient(params, fastRelayOptions);
    try {
      await waitFor(() => host.service.state === "waiting", "host to reach waiting");
      await client.connect({ pairingTimeoutMs: 5000, workspaceKey: "ws-test" });

      host.service.relay.debugDropSocket();
      await waitFor(() => host.service.state === "paired", "host to re-pair", 15_000);
      const result = await client.request("workspace/echo", { after: "host-drop" }, { timeoutMs: 10_000 });
      expect((result as Record<string, unknown>)["args"]).toEqual([{ after: "host-drop" }]);
      expect(host.failures).toHaveLength(0);
    } finally {
      client.dispose();
      host.service.dispose();
      await relay.close();
    }
  }, 20_000);

  test("survives a relay restart when registrations are persisted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-relay-restart-"));
    const statePath = join(directory, "state.json");
    const relay = await startRelay({ statePath });
    const port = relay.port;
    const env = await temporaryEnv("zcode-relay-e2e-");
    const record = await createRegisteredLink(relay, env);
    const host = startHost(record);
    const params = parseRemoteConnectionUrl(remoteHostLinkUrl(record, appVersion))!;
    const client = new RemoteClient(params, fastRelayOptions);
    let restarted: RelayServer | undefined;
    try {
      await waitFor(() => host.service.state === "waiting", "host to reach waiting");
      await client.connect({ pairingTimeoutMs: 5000, workspaceKey: "ws-test" });

      // Simulates a tunnel/relay restart: every socket dies, the registration store survives.
      await relay.close();
      restarted = await startRelayOnPort(port, { statePath });

      await waitFor(() => host.service.state === "paired", "host and controller to re-pair", 15_000);
      await waitFor(() => client.state === "paired", "controller to re-pair", 15_000);
      const result = await client.request("workspace/echo", { after: "relay-restart" }, { timeoutMs: 10_000 });
      expect((result as Record<string, unknown>)["args"]).toEqual([{ after: "relay-restart" }]);
      expect(host.failures).toHaveLength(0);
    } finally {
      client.dispose();
      host.service.dispose();
      await restarted?.close();
      await relay.close();
    }
  }, 30_000);

  test("kicks the previous host deterministically when a duplicate host connects", async () => {
    const relay = await startRelay();
    const env = await temporaryEnv("zcode-relay-e2e-");
    const record = await createRegisteredLink(relay, env);
    const first = startHost(record);
    try {
      await waitFor(() => first.service.state === "waiting", "first host to reach waiting");
      const second = startHost(record);
      try {
        await waitFor(() => first.failures.length > 0, "first host to be kicked");
        expect(first.failures[0]!.reason).toBe("kicked");
        expect(first.service.state).toBe("kicked");
        await waitFor(() => second.service.state === "waiting", "second host to take the slot");

        // The second host is the live one: a probe pairs with it, and the first stays kicked.
        const params = parseRemoteConnectionUrl(remoteHostLinkUrl(record, appVersion))!;
        const snapshot = await probeRemoteDevice(params, { ...fastRelayOptions, pairingTimeoutMs: 5000 });
        expect(snapshot.paired).toBe(true);
        expect(first.service.state).toBe("kicked");
      } finally {
        second.service.dispose();
      }
    } finally {
      first.service.dispose();
      await relay.close();
    }
  }, 20_000);
});

describe("relay end-to-end credential checks", () => {
  /** Connects and reports the {@link RelayFailure} the relay's rejection surfaces on the client. */
  async function failureReason(url: string): Promise<string> {
    const client = new RemoteClient(parseRemoteConnectionUrl(url)!, fastRelayOptions);
    const failures: RelayFailure[] = [];
    client.onFailure((failure) => failures.push(failure));
    try {
      await expect(client.connect({ pairingTimeoutMs: 5000 })).rejects.toThrow();
      await waitFor(() => failures.length > 0, "a relay failure to be reported", 5000);
      return failures[0]!.reason;
    } finally {
      client.dispose();
    }
  }

  test("rejects a controller whose pairing URL carries the wrong pass hash", async () => {
    const relay = await startRelay();
    const env = await temporaryEnv("zcode-relay-e2e-");
    const record = await createRegisteredLink(relay, env);
    const host = startHost(record);
    try {
      await waitFor(() => host.service.state === "waiting", "host to reach waiting");
      const forged = remoteHostLinkUrl({ ...record, passHash: "WRONG-HASH-1234567890" }, appVersion);
      expect(await failureReason(forged)).toBe("invalid-mobile-connection");
      expect(host.service.state).toBe("waiting");
    } finally {
      host.service.dispose();
      await relay.close();
    }
  }, 20_000);

  test("rejects a pairing URL whose session id was never registered", async () => {
    const relay = await startRelay();
    try {
      expect(await failureReason(
        `http://127.0.0.1:${relay.port}/remote/v4?sid=unregistered-sid&hash=WRONG-HASH-1234567890&t=1`
      )).toBe("session-not-found");
    } finally {
      await relay.close();
    }
  }, 20_000);

  test("rejects credentials that expired on the relay", async () => {
    const relay = await startRelay({ registrationTtlMs: 100 });
    const env = await temporaryEnv("zcode-relay-e2e-");
    const record = await createRegisteredLink(relay, env);
    await Bun.sleep(200);
    try {
      expect(await failureReason(remoteHostLinkUrl(record, appVersion))).toBe("session-expired");
    } finally {
      await relay.close();
    }
  }, 20_000);
});

describe("relay end-to-end through the zcode CLI", () => {
  test("link create, serve and connect pair through a private relay", async () => {
    const relay = await startRelay();
    const hostEnv = await temporaryEnv("zcode-relay-cli-host-");
    const controllerEnv = await temporaryEnv("zcode-relay-cli-ctl-");
    const output = captureStream();
    const errors = captureStream();
    const io = { stderr: errors.stream, stdout: output.stream } as const;

    try {
      const linkCode = await runRemoteCommand(
        ["remote", "link", "create", "--relay", `http://127.0.0.1:${relay.port}/remote/v4`],
        { appVersion, env: hostEnv, ...io }
      );
      expect(linkCode).toBe(0);
      const record = await readRemoteHostLink(hostEnv);
      expect(record).toBeDefined();

      const serveAbort = new AbortController();
      const servePromise = runRemoteCommand(["remote", "serve"], {
        appServerRequest: async ({ method, params }) => ({ method, params }),
        appVersion,
        cwd: hostEnv["HOME"]!,
        env: hostEnv,
        signal: serveAbort.signal,
        ...io
      });
      await waitFor(() => relay.snapshot().sessions > 0, "the served host to reach the relay");

      const addCode = await runRemoteCommand(
        ["remote", "add", remoteHostLinkUrl(record!, appVersion), "--name", "private-host"],
        { env: controllerEnv, ...io }
      );
      expect(addCode).toBe(0);

      const connectCode = await runRemoteCommand(
        ["remote", "connect", "private-host", "--timeout", "30", "--json"],
        { env: controllerEnv, ...io }
      );
      expect(connectCode).toBe(0);
      const lastJson = output.text().trim().split("\n\n").at(-1) ?? "";
      expect(lastJson).toContain('"paired": true');

      serveAbort.abort();
      expect(await servePromise).toBe(0);
      expect(errors.text()).toBe("");
    } finally {
      await relay.close();
    }
  }, 30_000);
});
