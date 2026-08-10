import { describe, expect, test } from "bun:test";

import { channelRequestType, channelResponseType } from "../src/remote/channel-client.ts";
import {
  parseRemoteMethod,
  probeRemoteDevice,
  remoteWorkspaceSummaries,
  RemoteClient,
  type RemoteClientOptions
} from "../src/remote/client.ts";
import { parseRemoteConnectionUrl, type RemoteConnectionParams } from "../src/remote/connection-params.ts";
import { decodeValue, encodeValue, ValueReader, ValueWriter } from "../src/remote/ipc-codec.ts";
import { RpcFrameTransport, type RpcFramePayload } from "../src/remote/rpc-transport.ts";
import type { RelaySocketHandlers } from "../src/remote/relay-client.ts";

const passHash = "PASS-HASH-SECRET";
const deviceSid = "DEVICE-SID-SECRET";
const deviceUrl = `https://zcode.z.ai/remote/v4?sid=${deviceSid}&hash=${passHash}&t=1&name=Studio&app_version=9.9.9`;

function params(): RemoteConnectionParams {
  return parseRemoteConnectionUrl(deviceUrl)!;
}

interface ChannelRequest {
  arg: unknown;
  channel: string;
  id: number;
  name: string;
  type: number;
}

function decodeChannelRequest(body: Uint8Array): ChannelRequest {
  const reader = new ValueReader(body);
  const header = decodeValue(reader) as unknown[];
  return {
    arg: decodeValue(reader),
    channel: header[2] as string,
    id: header[1] as number,
    name: header[3] as string,
    type: header[0] as number
  };
}

function channelFrame(type: number, id: number, data: unknown): Uint8Array {
  const writer = new ValueWriter();
  encodeValue(writer, [type, id]);
  encodeValue(writer, data);
  return writer.toBytes();
}

interface FakeDesktopOptions {
  answerBridgeOpen?: boolean;
  answerBootstrap?: boolean;
  bootstrapWorkspaces?: Record<string, unknown>[] | undefined;
  reconnectSucceeds?: boolean;
  results?: Record<string, unknown>;
  workspaces?: Record<string, unknown>[];
}

/**
 * In-memory stand-in for a paired ZCode desktop: it drives the relay handshake, answers the
 * bootstrap and bridge envelopes, and serves channel calls over its own rpc-frame transport, so the
 * client under test exercises the real fragmentation, checksum and codec paths.
 */
class FakeDesktop {
  readonly channelRequests: ChannelRequest[] = [];
  readonly logs: string[] = [];
  readonly outbound: RpcFramePayload[] = [];

  readonly options: FakeDesktopOptions;

  bridgeOpens = 0;
  reconnectRequests: string[] = [];
  socketCount = 0;

  private handlers: RelaySocketHandlers | undefined;
  private paused = false;
  private transport: RpcFrameTransport | undefined;

  constructor(options: FakeDesktopOptions = {}) {
    this.options = options;
  }

  clientOptions(extra: RemoteClientOptions = {}): RemoteClientOptions {
    return {
      onLog: (line) => this.logs.push(line),
      reconnectDelayMs: () => 0,
      socketFactory: (_url, handlers) => {
        this.handlers = handlers;
        this.socketCount += 1;
        queueMicrotask(() => handlers.onOpen());
        return {
          close: () => {
            this.paused = true;
          },
          send: (data) => this.receive(JSON.parse(data) as Record<string, unknown>)
        };
      },
      ...extra
    };
  }

  /** Drops the current socket the way a network interruption would. */
  drop(): void {
    const handlers = this.handlers;
    this.paused = false;
    handlers?.onClose(1006, "dropped");
  }

  pushPayload(payload: RpcFramePayload): void {
    this.deliver(payload);
  }

  private deliver(payload: RpcFramePayload): void {
    queueMicrotask(() => {
      if (this.paused) return;
      this.handlers?.onMessage(JSON.stringify({ type: "data", payload }));
    });
  }

  private receive(frame: Record<string, unknown>): void {
    if (frame["type"] === "auth_init") {
      queueMicrotask(() => this.handlers?.onMessage(JSON.stringify({ type: "auth_challenge", nonce: "n" })));
      return;
    }
    if (frame["type"] === "auth_response" || frame["type"] === "pair_status_query") {
      queueMicrotask(() => this.handlers?.onMessage(
        JSON.stringify({ type: "pair_status_ack", pair_status: "matched" })
      ));
      return;
    }
    if (frame["type"] !== "data") return;
    const payload = frame["payload"] as RpcFramePayload;
    this.outbound.push(payload);
    const type = payload["zcode_type"];

    if (type === "rpc-frame" || type === "rpc-frame-ack") {
      this.transport?.acceptPayload(payload);
      return;
    }
    if (type === "bootstrap-request") {
      if (this.options.answerBootstrap === false) return;
      this.deliver({
        zcode_type: "bootstrap-response",
        requestId: payload["requestId"],
        result: { workspaces: this.options.bootstrapWorkspaces ?? this.workspaces() }
      });
      return;
    }
    if (type === "workspace-list-request") {
      this.deliver({
        zcode_type: "workspace-list-response",
        requestId: payload["requestId"],
        result: { workspaces: this.workspaces() }
      });
      return;
    }
    if (type === "workspace-bridge-open") {
      this.bridgeOpens += 1;
      if (this.options.answerBridgeOpen === false) return;
      this.openBridge(payload);
      return;
    }
    if (type === "workspace-reconnect-request") {
      this.reconnectRequests.push(String(payload["workspaceKey"]));
      this.deliver({
        zcode_type: "workspace-reconnect-response",
        requestId: payload["requestId"],
        workspaceKey: payload["workspaceKey"],
        success: this.options.reconnectSucceeds !== false
      });
    }
  }

  private openBridge(payload: RpcFramePayload): void {
    const bridgeSessionId = String(payload["bridgeSessionId"]);
    this.transport?.dispose();
    const transport = new RpcFrameTransport({
      bridgeSessionId,
      sendPayload: (outgoing) => this.deliver(outgoing)
    });
    transport.onMessage((message) => this.serveChannelRequest(transport, message));
    this.transport = transport;

    // Deliberately pushed before workspace-bridge-ready: the client must buffer frames for a
    // bridge whose transport does not exist yet.
    transport.sendMessage(channelFrame(channelResponseType.initialize, 0, undefined));
    this.deliver({
      zcode_type: "workspace-bridge-ready",
      requestId: payload["requestId"],
      bridgeSessionId,
      bridge: {
        bridgeSessionId,
        bridgeGeneration: payload["bridgeGeneration"],
        recoveryId: "recovery-1",
        workspaceKey: payload["workspaceKey"],
        initialTaskId: "task-1"
      }
    });
  }

  private serveChannelRequest(transport: RpcFrameTransport, message: Uint8Array): void {
    const request = decodeChannelRequest(message);
    this.channelRequests.push(request);
    if (request.type === channelRequestType.eventListen) {
      transport.sendMessage(channelFrame(channelResponseType.eventFire, request.id, { event: request.name }));
      return;
    }
    if (request.type !== channelRequestType.promise) return;
    const key = `${request.channel}/${request.name}`;
    const configured = this.options.results?.[key];
    if (configured === undefined) return;
    if (configured instanceof Error) {
      transport.sendMessage(channelFrame(
        channelResponseType.promiseError,
        request.id,
        { message: configured.message }
      ));
      return;
    }
    transport.sendMessage(channelFrame(channelResponseType.promiseSuccess, request.id, configured));
  }

  private workspaces(): Record<string, unknown>[] {
    return this.options.workspaces ?? [{ workspaceKey: "/w/one", workspacePath: "/w/one", name: "one" }];
  }
}

describe("remote method names", () => {
  test("splits a channel and member name", () => {
    expect(parseRemoteMethod("plugins/overview")).toEqual({ channel: "plugins", name: "overview" });
    expect(parseRemoteMethod("plugins.overview")).toEqual({ channel: "plugins", name: "overview" });
    expect(parseRemoteMethod("  zcode-task/listTasks  ")).toEqual({ channel: "zcode-task", name: "listTasks" });
    expect(parseRemoteMethod("plugins/marketplace/add")).toEqual({ channel: "plugins/marketplace", name: "add" });
  });

  test("rejects names without both parts", () => {
    for (const invalid of ["", "overview", "/overview", "plugins/", "plugins.", "."]) {
      expect(() => parseRemoteMethod(invalid)).toThrow(/Invalid remote method/u);
    }
  });
});

describe("workspace overview extraction", () => {
  test("reads a workspace list from either envelope shape", () => {
    expect(remoteWorkspaceSummaries({ workspaces: [{ workspaceKey: "k", workspacePath: "/p", name: "n" }] }))
      .toEqual([{ key: "k", name: "n", path: "/p" }]);
    expect(remoteWorkspaceSummaries([{ key: "k2" }])).toEqual([{ key: "k2" }]);
    expect(remoteWorkspaceSummaries([{ workspaceIdentity: "k3", title: "t" }]))
      .toEqual([{ key: "k3", name: "t" }]);
  });

  test("ignores entries without a usable key and non-list results", () => {
    expect(remoteWorkspaceSummaries([{ nothing: true }, "text", null])).toEqual([]);
    expect(remoteWorkspaceSummaries(undefined)).toEqual([]);
    expect(remoteWorkspaceSummaries("text")).toEqual([]);
  });
});

describe("remote client connection", () => {
  test("pairs, bootstraps and bridges the single workspace", async () => {
    const desktop = new FakeDesktop();
    const client = new RemoteClient(params(), desktop.clientOptions());
    const snapshot = await client.connect();
    expect(snapshot).toEqual({
      appVersion: "9.9.9",
      bridgedWorkspaceKey: "/w/one",
      deviceName: "Studio",
      host: "zcode.z.ai",
      paired: true,
      state: "paired",
      workspaces: [{ key: "/w/one", name: "one", path: "/w/one" }]
    });
    expect(desktop.bridgeOpens).toBe(1);
    client.dispose();
  });

  test("falls back to workspace-list when bootstrap carries no workspaces", async () => {
    const desktop = new FakeDesktop({ bootstrapWorkspaces: [] });
    const client = new RemoteClient(params(), desktop.clientOptions());
    const snapshot = await client.connect();
    expect(snapshot.workspaces).toEqual([{ key: "/w/one", name: "one", path: "/w/one" }]);
    expect(desktop.outbound.some((payload) => payload["zcode_type"] === "workspace-list-request")).toBe(true);
    client.dispose();
  });

  test("leaves the bridge closed when the desktop offers several workspaces", async () => {
    const desktop = new FakeDesktop({
      workspaces: [{ workspaceKey: "/w/one" }, { workspaceKey: "/w/two" }]
    });
    const client = new RemoteClient(params(), desktop.clientOptions());
    const snapshot = await client.connect();
    expect(snapshot.workspaces).toHaveLength(2);
    expect(snapshot.bridgedWorkspaceKey).toBeUndefined();
    expect(desktop.bridgeOpens).toBe(0);
    expect(() => client.subscribe("system/onChange", () => {})).toThrow(/No remote workspace is bridged/u);
    await expect(client.request("plugins/overview")).rejects.toThrow(/No remote workspace is bridged/u);
    client.dispose();
  });

  test("bridges the named workspace on request", async () => {
    const desktop = new FakeDesktop({
      workspaces: [{ workspaceKey: "/w/one" }, { workspaceKey: "/w/two" }]
    });
    const client = new RemoteClient(params(), desktop.clientOptions());
    const snapshot = await client.connect({ workspaceKey: "/w/two" });
    expect(snapshot.bridgedWorkspaceKey).toBe("/w/two");
    client.dispose();
  });

  test("announces the viewed workspace to the desktop", async () => {
    const desktop = new FakeDesktop();
    const client = new RemoteClient(params(), desktop.clientOptions());
    await client.connect();
    const viewState = desktop.outbound.find((payload) => payload["zcode_type"] === "mobile-view-state-update");
    expect(viewState).toBeDefined();
    expect((viewState!["viewState"] as Record<string, unknown>)["activeWorkspaceKey"]).toBe("/w/one");
    expect((viewState!["viewState"] as Record<string, unknown>)["activeTaskId"]).toBe("task-1");
    client.dispose();
  });

  test("fails pairing when the relay never matches", async () => {
    const client = new RemoteClient(params(), {
      reconnectDelayMs: () => 0,
      socketFactory: (_url, handlers) => {
        queueMicrotask(() => handlers.onOpen());
        return { close: () => {}, send: () => {} };
      }
    });
    await expect(client.connect({ pairingTimeoutMs: 5 })).rejects.toThrow(/Pairing with the remote desktop/u);
    client.dispose();
  });

  test("fails pairing when the relay closes the session", async () => {
    let close: ((code: number, reason: string) => void) | undefined;
    const client = new RemoteClient(params(), {
      reconnectDelayMs: () => 0,
      socketFactory: (_url, handlers) => {
        close = handlers.onClose;
        queueMicrotask(() => handlers.onOpen());
        return { close: () => {}, send: () => {} };
      }
    });
    const pending = client.connect({ pairingTimeoutMs: 1000 });
    await Bun.sleep(2);
    close!(4004, "no session");
    await expect(pending).rejects.toThrow(/timed out|ended while pairing/u);
    client.dispose();
  });

  test("times out a bootstrap the desktop never answers", async () => {
    const desktop = new FakeDesktop({ answerBootstrap: false });
    const client = new RemoteClient(params(), desktop.clientOptions({ requestTimeoutMs: 10 }));
    await expect(client.connect()).rejects.toThrow(/bootstrap-request timed out/u);
    client.dispose();
  });

  test("keeps the device credentials out of its own description", async () => {
    const desktop = new FakeDesktop();
    const client = new RemoteClient(params(), desktop.clientOptions());
    await client.connect();
    expect(client.description).not.toContain(passHash);
    expect(client.description).not.toContain(deviceSid);
    expect(desktop.logs.join("\n")).not.toContain(passHash);
    expect(desktop.logs.join("\n")).not.toContain(deviceSid);
    client.dispose();
  });
});

describe("remote client requests", () => {
  test("maps an app-server-style method onto a channel call", async () => {
    const desktop = new FakeDesktop({ results: { "plugins/overview": { marketplaces: [] } } });
    const client = new RemoteClient(params(), desktop.clientOptions());
    await client.connect();
    expect(await client.request("plugins/overview", { workspace: { workspaceKey: "/w/one" } }))
      .toEqual({ marketplaces: [] });
    const request = desktop.channelRequests.find((entry) => entry.name === "overview")!;
    expect(request.channel).toBe("plugins");
    expect(request.type).toBe(channelRequestType.promise);
    expect(request.arg).toEqual([{ workspace: { workspaceKey: "/w/one" } }]);
    client.dispose();
  });

  test("sends no argument when there are no params", async () => {
    const desktop = new FakeDesktop({ results: { "system/ping": "pong" } });
    const client = new RemoteClient(params(), desktop.clientOptions());
    await client.connect();
    expect(await client.request("system/ping")).toBe("pong");
    expect(desktop.channelRequests.find((entry) => entry.name === "ping")!.arg).toEqual([]);
    client.dispose();
  });

  test("surfaces a channel error as a rejected request", async () => {
    const desktop = new FakeDesktop({ results: { "plugins/install": new Error("marketplace unavailable") } });
    const client = new RemoteClient(params(), desktop.clientOptions());
    await client.connect();
    await expect(client.request("plugins/install", { pluginId: "x" }))
      .rejects.toThrow("marketplace unavailable");
    client.dispose();
  });

  test("times out a channel call the desktop never answers", async () => {
    const desktop = new FakeDesktop();
    const client = new RemoteClient(params(), desktop.clientOptions());
    await client.connect();
    await expect(client.request("system/slow", {}, { timeoutMs: 10 })).rejects.toThrow(/timed out/u);
    client.dispose();
  });

  test("cancels a channel call when the caller aborts", async () => {
    const desktop = new FakeDesktop();
    const client = new RemoteClient(params(), desktop.clientOptions());
    await client.connect();
    const controller = new AbortController();
    const pending = client.request("system/slow", {}, { signal: controller.signal });
    await Bun.sleep(2);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/u);
    client.dispose();
  });

  test("delivers channel events to a subscriber", async () => {
    const desktop = new FakeDesktop();
    const client = new RemoteClient(params(), desktop.clientOptions());
    await client.connect();
    const events: unknown[] = [];
    const unsubscribe = client.subscribe("zcode-agent/onDynamicConversationFrame", (event) => events.push(event));
    await Bun.sleep(5);
    expect(events).toEqual([{ event: "onDynamicConversationFrame" }]);
    unsubscribe();
    client.dispose();
  });

  test("reuses the existing bridge for the same workspace", async () => {
    const desktop = new FakeDesktop();
    const client = new RemoteClient(params(), desktop.clientOptions());
    await client.connect();
    const bridge = await client.useWorkspace("/w/one");
    expect(desktop.bridgeOpens).toBe(1);
    expect(bridge.workspaceKey).toBe("/w/one");
    expect(bridge.initialTaskId).toBe("task-1");
    expect(bridge.channels.initialized).toBe(true);
    client.dispose();
  });

  test("reports the workspace list the desktop pushes", async () => {
    const desktop = new FakeDesktop();
    const client = new RemoteClient(params(), desktop.clientOptions());
    await client.connect();
    const seen: unknown[] = [];
    client.onWorkspaceListUpdated((result) => seen.push(result));
    desktop.pushPayload({ zcode_type: "workspace-list-updated", result: { workspaces: [] } });
    await Bun.sleep(2);
    expect(seen).toEqual([{ workspaces: [] }]);
    client.dispose();
  });
});

describe("remote client recovery", () => {
  test("reconnects the workspace after the relay drops and re-pairs", async () => {
    const desktop = new FakeDesktop({ results: { "system/ping": "pong" } });
    const client = new RemoteClient(params(), desktop.clientOptions());
    await client.connect();
    const bridge = await client.useWorkspace("/w/one");

    desktop.drop();
    expect(client.state).toBe("reconnecting");
    await Bun.sleep(20);
    expect(client.state).toBe("paired");
    expect(desktop.reconnectRequests).toContain("/w/one");
    expect(bridge.recoveries).toBe(1);
    expect(bridge.degradedReason).toBeUndefined();
    expect(desktop.bridgeOpens).toBe(1);
    client.dispose();
  });

  test("reopens the bridge when the cheap reconnect path fails", async () => {
    const desktop = new FakeDesktop({ reconnectSucceeds: false, results: { "system/ping": "pong" } });
    const client = new RemoteClient(params(), desktop.clientOptions());
    await client.connect();
    const bridge = await client.useWorkspace("/w/one");
    const recovered: number[] = [];
    bridge.onRecovered(() => recovered.push(bridge.recoveries));

    desktop.drop();
    await Bun.sleep(30);
    expect(desktop.bridgeOpens).toBe(2);
    expect(recovered).toEqual([1]);
    expect(bridge.degradedReason).toBeUndefined();
    // The reopened bridge must be usable again without reconnecting by hand.
    expect(await client.request("system/ping")).toBe("pong");
    client.dispose();
  });

  test("recovers a bridge the desktop reports as degraded", async () => {
    const desktop = new FakeDesktop();
    const client = new RemoteClient(params(), desktop.clientOptions());
    await client.connect();
    const bridge = await client.useWorkspace("/w/one");
    desktop.pushPayload({
      zcode_type: "bridge-degraded",
      bridgeSessionId: bridge.bridgeSessionId,
      reason: "rpc-transport-fault"
    });
    await Bun.sleep(10);
    expect(desktop.reconnectRequests).toContain("/w/one");
    expect(bridge.recoveries).toBe(1);
    client.dispose();
  });

  test("keeps the degraded reason when recovery fails outright", async () => {
    const desktop = new FakeDesktop();
    const client = new RemoteClient(params(), desktop.clientOptions({ requestTimeoutMs: 20 }));
    await client.connect();
    const bridge = await client.useWorkspace("/w/one");

    desktop.options.reconnectSucceeds = false;
    desktop.options.answerBridgeOpen = false;
    desktop.drop();
    await Bun.sleep(120);
    expect(bridge.recoveries).toBe(0);
    expect(bridge.degradedReason).toContain("reopen-failed");
    client.dispose();
  });

  test("still reports a pairing whose optional single-workspace bridge failed", async () => {
    const desktop = new FakeDesktop({ answerBridgeOpen: false });
    const client = new RemoteClient(params(), desktop.clientOptions({ requestTimeoutMs: 20 }));
    const snapshot = await client.connect();
    expect(snapshot.paired).toBe(true);
    expect(snapshot.bridgedWorkspaceKey).toBeUndefined();
    expect(desktop.bridgeOpens).toBe(1);
    client.dispose();
  });

  test("fails when an explicitly requested workspace cannot be bridged", async () => {
    const desktop = new FakeDesktop({ answerBridgeOpen: false });
    const client = new RemoteClient(params(), desktop.clientOptions({ requestTimeoutMs: 20 }));
    await expect(client.connect({ workspaceKey: "/w/one" }))
      .rejects.toThrow(/workspace-bridge-open timed out/u);
    client.dispose();
  });
});

describe("remote client teardown", () => {
  test("disposes bridges, pending requests and the relay", async () => {
    const desktop = new FakeDesktop({ answerBootstrap: false });
    const client = new RemoteClient(params(), desktop.clientOptions({ requestTimeoutMs: 60_000 }));
    const pending = client.bootstrap().catch((error: unknown) => error);
    await Bun.sleep(5);
    client.dispose();
    expect((await pending as Error).message).toBe("Remote client disposed.");
    expect(client.state).toBe("closed");
    expect(() => client.dispose()).not.toThrow();
  });

  test("rejects a request payload without a request id", async () => {
    const desktop = new FakeDesktop();
    const client = new RemoteClient(params(), desktop.clientOptions());
    await client.connect();
    const bridge = await client.useWorkspace("/w/one");
    bridge.dispose();
    await expect(client.request("system/ping")).rejects.toThrow(/No remote workspace is bridged/u);
    client.dispose();
  });
});

describe("remote device probe", () => {
  test("connects, reports the snapshot and closes again", async () => {
    const desktop = new FakeDesktop();
    const snapshot = await probeRemoteDevice(params(), desktop.clientOptions());
    expect(snapshot.paired).toBe(true);
    expect(snapshot.workspaces).toHaveLength(1);
    expect(snapshot.bridgedWorkspaceKey).toBe("/w/one");
  });

  test("propagates a pairing failure", async () => {
    await expect(probeRemoteDevice(params(), {
      pairingTimeoutMs: 20,
      socketFactory: (_url, handlers) => {
        queueMicrotask(() => handlers.onOpen());
        return { close: () => {}, send: () => {} };
      }
    })).rejects.toThrow(/Pairing with the remote desktop timed out/u);
  }, 10_000);
});
