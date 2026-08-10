import { describe, expect, test } from "bun:test";

import { channelRequestType, channelResponseType } from "../src/remote/channel-client.ts";
import { RemoteClient } from "../src/remote/client.ts";
import { parseRemoteConnectionUrl, type RemoteConnectionParams } from "../src/remote/connection-params.ts";
import {
  RemoteHostService,
  type RemoteHostBackend,
  type RemoteHostServiceOptions
} from "../src/remote/host.ts";
import { decodeValue, encodeValue, ValueReader, ValueWriter } from "../src/remote/ipc-codec.ts";
import { calculateProof } from "../src/remote/proof.ts";
import type { RelaySocketHandlers } from "../src/remote/relay-client.ts";
import { RpcFrameTransport, type RpcFramePayload } from "../src/remote/rpc-transport.ts";

const passHash = "HOST-PASS-SECRET";
const deviceSid = "HOST-SID-SECRET";
const hostUrl = `https://zcode.z.ai/remote/v4?sid=${deviceSid}&hash=${passHash}&t=1&mid=machine-9&name=studio&app_version=3.3.3`;

function params(): RemoteConnectionParams {
  return parseRemoteConnectionUrl(hostUrl)!;
}

function defaultBackend(overrides: Partial<RemoteHostBackend> = {}): RemoteHostBackend {
  return {
    call: async ({ args, channel, name }) => ({ echo: { args, channel, name } }),
    listWorkspaces: () => [{ key: "ws-1", name: "project", path: "/home/dev/project" }],
    ...overrides
  };
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
  host: RemoteHostService;
  logs: string[];
  socket: () => FakeSocket;
  sockets: FakeSocket[];
}

function harness(backend: RemoteHostBackend = defaultBackend(), options: RemoteHostServiceOptions = {}): Harness {
  const logs: string[] = [];
  const sockets: FakeSocket[] = [];
  const host = new RemoteHostService(params(), backend, {
    onLog: (line) => logs.push(line),
    platform: "linux",
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
  return { host, logs, socket: () => sockets[sockets.length - 1]!, sockets };
}

/** Drives the fake controller through open, challenge and match. */
function pair(target: Harness): void {
  target.host.start();
  target.socket().onOpen();
  target.socket().onMessage(JSON.stringify({ type: "auth_challenge", nonce: "nonce-1" }));
  target.socket().onMessage(JSON.stringify({ type: "auth_ack", pair_status: "matched" }));
}

function deliver(target: Harness, payload: Record<string, unknown>): void {
  target.socket().onMessage(JSON.stringify({ type: "data", payload }));
}

function sentPayloads(target: Harness): Record<string, unknown>[] {
  return target.sockets
    .flatMap((socket) => socket.sent)
    .filter((frame) => frame["type"] === "data")
    .map((frame) => frame["payload"] as Record<string, unknown>);
}

function encodeChannelRequest(type: number, id: number, channel: string, name: string, arg: unknown): Uint8Array {
  const writer = new ValueWriter();
  encodeValue(writer, [type, id, channel, name]);
  encodeValue(writer, arg);
  return writer.toBytes();
}

interface ChannelResponse {
  data: unknown;
  id: number;
  type: number;
}

/**
 * Controller-side view of one bridge: a real rpc-frame transport wired into the fake socket, so
 * the host's fragmentation, checksum and codec paths are exercised end to end.
 */
class ControllerBridge {
  readonly responses: ChannelResponse[] = [];

  private drained = 0;
  private readonly harness: Harness;
  private readonly transport: RpcFrameTransport;

  constructor(target: Harness, bridgeSessionId: string) {
    this.harness = target;
    this.transport = new RpcFrameTransport({
      bridgeSessionId,
      sendPayload: (payload) => deliver(target, payload as Record<string, unknown>)
    });
    this.transport.onMessage((body) => {
      const reader = new ValueReader(body);
      const header = decodeValue(reader) as unknown[];
      this.responses.push({
        data: reader.remaining > 0 ? decodeValue(reader) : undefined,
        id: (header[1] as number | undefined) ?? -1,
        type: header[0] as number
      });
    });
  }

  /** Feeds every host-sent rpc-frame that has not been consumed yet into the transport. */
  drain(): void {
    const payloads = sentPayloads(this.harness);
    for (; this.drained < payloads.length; this.drained += 1) {
      const payload = payloads[this.drained]!;
      const type = payload["zcode_type"];
      if (type === "rpc-frame" || type === "rpc-frame-ack") this.transport.acceptPayload(payload as RpcFramePayload);
    }
  }

  send(type: number, id: number, channel: string, name: string, arg: unknown): void {
    this.transport.sendMessage(encodeChannelRequest(type, id, channel, name, arg));
  }

  dispose(): void {
    this.transport.dispose();
  }
}

async function openBridge(target: Harness, bridgeSessionId = "bridge-1", workspaceKey = "ws-1"):
Promise<ControllerBridge> {
  deliver(target, {
    zcode_type: "workspace-bridge-open",
    requestId: "open-1",
    bridgeSessionId,
    bridgeGeneration: 1,
    workspaceKey
  });
  await Bun.sleep(1);
  const bridge = new ControllerBridge(target, bridgeSessionId);
  bridge.drain();
  return bridge;
}

describe("host relay authentication", () => {
  test("announces itself in the desktop role and proves with the desktop proof", () => {
    const target = harness();
    target.host.start();
    expect(target.socket().url).toBe("wss://zcode.z.ai/ws?mid=machine-9");
    target.socket().onOpen();
    expect(target.socket().sent[0]).toEqual({
      type: "auth_init",
      role: "desktop",
      device_sid: deviceSid,
      meta: { platform: "linux", version: "3.3.3", name: "studio" },
      client_ts: expect.any(Number)
    });
    target.socket().onMessage(JSON.stringify({ type: "auth_challenge", nonce: "nonce-7" }));
    expect(target.socket().sent[1]).toEqual({
      type: "auth_response",
      device_sid: deviceSid,
      proof: calculateProof({ deviceSid, nonce: "nonce-7", passHash, role: "desktop" }),
      client_ts: expect.any(Number)
    });
    target.host.dispose();
  });

  test("waits for a controller without a pairing deadline", async () => {
    const target = harness();
    target.host.start();
    target.socket().onOpen();
    target.socket().onMessage(JSON.stringify({ type: "auth_ack", pair_status: "waiting" }));
    expect(target.host.state).toBe("waiting");
    await Bun.sleep(10);
    expect(target.host.state).toBe("waiting");
    target.socket().onMessage(JSON.stringify({ type: "pair_status_ack", pair_status: "matched" }));
    expect(target.host.state).toBe("paired");
    target.host.dispose();
  });

  test("reconnects when the relay drops before any controller ever paired", async () => {
    const target = harness();
    target.host.start();
    target.socket().onOpen();
    target.socket().onClose(1006, "network blip");
    expect(target.host.state).toBe("reconnecting");
    await Bun.sleep(2);
    expect(target.sockets).toHaveLength(2);
    target.host.dispose();
  });
});

describe("host overview envelopes", () => {
  test("answers bootstrap-request with the host description and workspaces", async () => {
    const target = harness();
    pair(target);
    deliver(target, { zcode_type: "bootstrap-request", requestId: "boot-1" });
    await Bun.sleep(1);
    expect(sentPayloads(target)).toEqual([{
      zcode_type: "bootstrap-response",
      requestId: "boot-1",
      result: {
        appVersion: "3.3.3",
        deviceName: "studio",
        platform: "linux",
        workspaces: [{ workspaceKey: "ws-1", name: "project", workspacePath: "/home/dev/project" }]
      }
    }]);
    target.host.dispose();
  });

  test("answers workspace-list-request with the workspace list only", async () => {
    const target = harness();
    pair(target);
    deliver(target, { zcode_type: "workspace-list-request", requestId: "list-1" });
    await Bun.sleep(1);
    expect(sentPayloads(target)).toEqual([{
      zcode_type: "workspace-list-response",
      requestId: "list-1",
      result: { workspaces: [{ workspaceKey: "ws-1", name: "project", workspacePath: "/home/dev/project" }] }
    }]);
    target.host.dispose();
  });

  test("serves an empty workspace list when the backend fails", async () => {
    const target = harness(defaultBackend({
      listWorkspaces: () => {
        throw new Error("backend broke");
      }
    }));
    pair(target);
    deliver(target, { zcode_type: "workspace-list-request", requestId: "list-1" });
    await Bun.sleep(1);
    expect(sentPayloads(target)[0]!["result"]).toEqual({ workspaces: [] });
    target.host.dispose();
  });
});

describe("host workspace bridges", () => {
  test("rejects an unknown workspace with workspace-bridge-error", async () => {
    const target = harness();
    pair(target);
    deliver(target, {
      zcode_type: "workspace-bridge-open",
      requestId: "open-1",
      bridgeSessionId: "bridge-1",
      workspaceKey: "nope"
    });
    await Bun.sleep(1);
    expect(sentPayloads(target)).toEqual([{
      zcode_type: "workspace-bridge-error",
      requestId: "open-1",
      bridgeSessionId: "bridge-1",
      error: "unknown workspace: nope"
    }]);
    expect(target.host.activeBridgeCount).toBe(0);
    target.host.dispose();
  });

  test("opens a bridge, reports it ready and sends the Initialize frame", async () => {
    const target = harness();
    pair(target);
    const bridge = await openBridge(target);
    const ready = sentPayloads(target).find((payload) => payload["zcode_type"] === "workspace-bridge-ready");
    expect(ready).toEqual({
      zcode_type: "workspace-bridge-ready",
      requestId: "open-1",
      bridgeSessionId: "bridge-1",
      bridge: {
        bridgeSessionId: "bridge-1",
        bridgeGeneration: 1,
        recoveryId: expect.stringMatching(/^recovery-/u),
        workspaceKey: "ws-1"
      }
    });
    expect(bridge.responses).toEqual([{ data: undefined, id: 0, type: channelResponseType.initialize }]);
    expect(target.host.activeBridgeCount).toBe(1);
    bridge.dispose();
    target.host.dispose();
  });

  test("answers reconnect requests by bridge liveness", async () => {
    const target = harness();
    pair(target);
    deliver(target, { zcode_type: "workspace-reconnect-request", requestId: "rc-1", workspaceKey: "ws-1" });
    await Bun.sleep(1);
    const bridge = await openBridge(target);
    deliver(target, { zcode_type: "workspace-reconnect-request", requestId: "rc-2", workspaceKey: "ws-1" });
    await Bun.sleep(1);
    const responses = sentPayloads(target).filter((payload) =>
      payload["zcode_type"] === "workspace-reconnect-response");
    expect(responses[0]).toMatchObject({ requestId: "rc-1", success: false });
    expect(responses[1]).toEqual({
      zcode_type: "workspace-reconnect-response",
      requestId: "rc-2",
      workspaceKey: "ws-1",
      success: true
    });
    bridge.dispose();
    target.host.dispose();
  });

  test("a reopen carrying the previous recoveryId replaces the stale bridge", async () => {
    const target = harness();
    pair(target);
    const first = await openBridge(target);
    const ready = sentPayloads(target).find((payload) => payload["zcode_type"] === "workspace-bridge-ready")!;
    const recoveryId = (ready["bridge"] as Record<string, unknown>)["recoveryId"] as string;

    deliver(target, {
      zcode_type: "workspace-bridge-open",
      requestId: "open-2",
      bridgeSessionId: "bridge-2",
      bridgeGeneration: 2,
      recoveryId,
      workspaceKey: "ws-1"
    });
    await Bun.sleep(1);
    expect(target.host.activeBridgeCount).toBe(1);
    const readyAgain = sentPayloads(target).filter((payload) =>
      payload["zcode_type"] === "workspace-bridge-ready");
    expect(readyAgain[1]).toMatchObject({
      bridgeSessionId: "bridge-2",
      bridge: { recoveryId, bridgeGeneration: 2 }
    });
    first.dispose();
    target.host.dispose();
  });

  test("records the controller view state", async () => {
    const target = harness();
    pair(target);
    const seen: Record<string, unknown>[] = [];
    target.host.onViewState((viewState) => seen.push(viewState));
    deliver(target, {
      zcode_type: "mobile-view-state-update",
      viewState: { activeWorkspaceKey: "ws-1", updatedAt: 5 }
    });
    expect(seen).toEqual([{ activeWorkspaceKey: "ws-1", updatedAt: 5 }]);
    expect(target.host.snapshot()).toEqual({
      activeBridges: 0,
      state: "paired",
      viewState: { activeWorkspaceKey: "ws-1", updatedAt: 5 }
    });
    target.host.dispose();
  });
});

describe("host channel calls", () => {
  test("serves a promise call through the backend", async () => {
    const calls: Record<string, unknown>[] = [];
    const target = harness(defaultBackend({
      call: async ({ args, channel, name, workspaceKey }) => {
        calls.push({ args, channel, name, workspaceKey });
        return { ok: true };
      }
    }));
    pair(target);
    const bridge = await openBridge(target);
    bridge.send(channelRequestType.promise, 1, "plugins", "overview", [{ filter: "all" }]);
    await Bun.sleep(2);
    bridge.drain();
    expect(calls).toEqual([{ args: [{ filter: "all" }], channel: "plugins", name: "overview", workspaceKey: "ws-1" }]);
    expect(bridge.responses[1]).toEqual({
      data: { ok: true },
      id: 1,
      type: channelResponseType.promiseSuccess
    });
    bridge.dispose();
    target.host.dispose();
  });

  test("reports a failing backend call as a promise error", async () => {
    const target = harness(defaultBackend({
      call: async () => {
        throw new Error("no such method");
      }
    }));
    pair(target);
    const bridge = await openBridge(target);
    bridge.send(channelRequestType.promise, 4, "plugins", "missing", []);
    await Bun.sleep(2);
    bridge.drain();
    expect(bridge.responses[1]).toEqual({
      data: { message: "no such method" },
      id: 4,
      type: channelResponseType.promiseError
    });
    bridge.dispose();
    target.host.dispose();
  });

  test("promiseCancel aborts the backend call and suppresses the response", async () => {
    let aborted = false;
    const target = harness(defaultBackend({
      call: ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("cancelled"));
        });
      })
    }));
    pair(target);
    const bridge = await openBridge(target);
    bridge.send(channelRequestType.promise, 9, "git", "status", []);
    await Bun.sleep(1);
    bridge.send(channelRequestType.promiseCancel, 9, "git", "status", undefined);
    await Bun.sleep(2);
    bridge.drain();
    expect(aborted).toBe(true);
    expect(bridge.responses.filter((response) => response.id === 9)).toHaveLength(0);
    bridge.dispose();
    target.host.dispose();
  });

  test("forwards backend events until the listener is disposed", async () => {
    let emitEvent: ((data: unknown) => void) | undefined;
    let disposed = 0;
    const target = harness(defaultBackend({
      subscribe: (_request, emit) => {
        emitEvent = emit;
        return () => {
          disposed += 1;
        };
      }
    }));
    pair(target);
    const bridge = await openBridge(target);
    bridge.send(channelRequestType.eventListen, 3, "system", "statusChanged", { scope: "all" });
    await Bun.sleep(2);
    emitEvent!({ status: "busy" });
    await Bun.sleep(2);
    bridge.drain();
    expect(bridge.responses[1]).toEqual({
      data: { status: "busy" },
      id: 3,
      type: channelResponseType.eventFire
    });

    bridge.send(channelRequestType.eventDispose, 3, "system", "statusChanged", undefined);
    await Bun.sleep(2);
    expect(disposed).toBe(1);
    emitEvent!({ status: "idle" });
    await Bun.sleep(2);
    bridge.drain();
    expect(bridge.responses.filter((response) => response.type === channelResponseType.eventFire)).toHaveLength(1);
    bridge.dispose();
    target.host.dispose();
  });

  test("ignores event subscriptions when the backend has no event support", async () => {
    const target = harness();
    pair(target);
    const bridge = await openBridge(target);
    bridge.send(channelRequestType.eventListen, 3, "system", "statusChanged", undefined);
    await Bun.sleep(2);
    expect(target.logs.some((line) => line.includes("no event support"))).toBe(true);
    bridge.dispose();
    target.host.dispose();
  });
});

describe("host credential hygiene", () => {
  test("never writes the device credentials to the log", async () => {
    const target = harness();
    pair(target);
    deliver(target, { zcode_type: "bootstrap-request", requestId: "boot-1" });
    const bridge = await openBridge(target);
    bridge.send(channelRequestType.promise, 1, "plugins", "overview", []);
    await Bun.sleep(2);
    const joined = target.logs.join("\n");
    expect(target.logs.length).toBeGreaterThan(0);
    expect(joined).not.toContain(passHash);
    expect(joined).not.toContain(deviceSid);
    bridge.dispose();
    target.host.dispose();
  });
});

/**
 * In-memory relay: pairs one desktop-role host with one terminal-role client and forwards their
 * data frames, so the real RemoteClient and the real RemoteHostService talk to each other through
 * every production layer except the network.
 */
class LoopbackRelay {
  private desktop: RelaySocketHandlers | undefined;
  private terminal: RelaySocketHandlers | undefined;

  factory(side: "desktop" | "terminal") {
    return (_url: URL, handlers: RelaySocketHandlers) => {
      this[side] = handlers;
      queueMicrotask(() => handlers.onOpen());
      return {
        close: () => {
          if (this[side] === handlers) this[side] = undefined;
        },
        send: (data: string) => this.receive(side, JSON.parse(data) as Record<string, unknown>)
      };
    };
  }

  private peerOf(side: "desktop" | "terminal"): RelaySocketHandlers | undefined {
    return side === "desktop" ? this.terminal : this.desktop;
  }

  private receive(side: "desktop" | "terminal", frame: Record<string, unknown>): void {
    const reply = (payload: Record<string, unknown>): void => {
      queueMicrotask(() => this[side]?.onMessage(JSON.stringify(payload)));
    };
    if (frame["type"] === "auth_init" || frame["type"] === "pair_status_query") {
      const matched = this.desktop !== undefined && this.terminal !== undefined;
      reply({ type: "auth_ack", pair_status: matched ? "matched" : "waiting" });
      if (matched && frame["type"] === "auth_init") {
        const peer = this.peerOf(side);
        queueMicrotask(() => peer?.onMessage(JSON.stringify({ type: "pair_status_ack", pair_status: "matched" })));
      }
      return;
    }
    if (frame["type"] !== "data") return;
    const peer = this.peerOf(side);
    queueMicrotask(() => peer?.onMessage(JSON.stringify({ type: "data", payload: frame["payload"] })));
  }
}

describe("host and client interoperate over a loopback relay", () => {
  test("a real RemoteClient controls a real RemoteHostService end to end", async () => {
    const relay = new LoopbackRelay();
    const calls: Record<string, unknown>[] = [];
    let emitEvent: ((data: unknown) => void) | undefined;
    const host = new RemoteHostService(params(), {
      call: async ({ args, channel, name, workspaceKey }) => {
        calls.push({ args, channel, name, workspaceKey });
        if (name === "fail") throw new Error("backend rejected the call");
        return { served: `${channel}.${name}` };
      },
      listWorkspaces: () => [{ key: "ws-main", name: "project", path: "/home/dev/project" }],
      subscribe: (_request, emit) => {
        emitEvent = emit;
        return () => {
          emitEvent = undefined;
        };
      }
    }, {
      platform: "linux",
      reconnectDelayMs: () => 0,
      socketFactory: relay.factory("desktop")
    });
    host.start();

    const client = new RemoteClient(params(), {
      reconnectDelayMs: () => 0,
      socketFactory: relay.factory("terminal")
    });
    try {
      const snapshot = await client.connect({ pairingTimeoutMs: 2000 });
      expect(snapshot.paired).toBe(true);
      expect(snapshot.appVersion).toBe("3.3.3");
      expect(snapshot.workspaces).toEqual([{ key: "ws-main", name: "project", path: "/home/dev/project" }]);
      // A single workspace is bridged automatically, so request() works immediately.
      expect(snapshot.bridgedWorkspaceKey).toBe("ws-main");

      const result = await client.request("plugins/overview", { filter: "enabled" }, { timeoutMs: 2000 });
      expect(result).toEqual({ served: "plugins.overview" });
      expect(calls).toEqual([{
        args: [{ filter: "enabled" }],
        channel: "plugins",
        name: "overview",
        workspaceKey: "ws-main"
      }]);

      await expect(client.request("plugins/fail", {}, { timeoutMs: 2000 }))
        .rejects.toThrow("backend rejected the call");

      const events: unknown[] = [];
      const unsubscribe = client.subscribe("system/statusChanged", (event) => events.push(event));
      await Bun.sleep(5);
      expect(emitEvent).toBeDefined();
      emitEvent!({ status: "busy" });
      await Bun.sleep(5);
      expect(events).toEqual([{ status: "busy" }]);
      unsubscribe();
      await Bun.sleep(5);
      expect(emitEvent).toBeUndefined();

      expect(host.snapshot().viewState).toMatchObject({ activeWorkspaceKey: "ws-main" });
    } finally {
      client.dispose();
      host.dispose();
    }
  });
});
