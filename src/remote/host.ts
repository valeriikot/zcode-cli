import { randomUUID } from "node:crypto";

import { channelRequestType, channelResponseType } from "./channel-client.ts";
import type { RemoteConnectionParams } from "./connection-params.ts";
import { decodeValue, encodeValue, ValueReader, ValueWriter } from "./ipc-codec.ts";
import {
  RelayClient,
  relayRoles,
  type RelayClientOptions,
  type RelayFailure,
  type RelayPayload,
  type RelayState
} from "./relay-client.ts";
import { RpcFrameTransport } from "./rpc-transport.ts";

const maximumBridges = 8;

export interface RemoteHostWorkspace {
  key: string;
  name?: string;
  path?: string;
}

export interface RemoteHostCall {
  args: unknown[];
  channel: string;
  name: string;
  signal: AbortSignal;
  workspaceKey: string;
}

export interface RemoteHostSubscription {
  arg: unknown;
  channel: string;
  event: string;
  workspaceKey: string;
}

/**
 * What this host exposes to a paired controller. `call` receives every channel promise request a
 * controller issues over a workspace bridge; `subscribe` is optional and hosts without event
 * support simply never fire channel events.
 */
export interface RemoteHostBackend {
  call(request: RemoteHostCall): Promise<unknown>;
  listWorkspaces(): Promise<RemoteHostWorkspace[]> | RemoteHostWorkspace[];
  subscribe?(request: RemoteHostSubscription, emit: (data: unknown) => void): () => void;
}

export interface RemoteHostServiceOptions extends RelayClientOptions {
  appVersion?: string;
  deviceName?: string;
}

export interface RemoteHostSnapshot {
  activeBridges: number;
  state: RelayState;
  viewState?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integerField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reasons the official web controller's `workspace-bridge-error` schema accepts; anything else
 * makes it reject (and silently drop) the whole payload.
 */
export type RemoteBridgeErrorReason = "unsupported-action" | "workspace-closed";

/**
 * One workspace as the official web controller's overview schemas require it: `workspacePath` and
 * `label` are mandatory non-empty strings, and the controller derives its workspace key from
 * `workspacePath` when no `workspaceIdentity` is present. `workspaceKey` and `name` are not in
 * that schema but zcode-cli's own controller reads them; the official one strips unknown keys.
 */
function workspaceOverviewEntry(workspace: RemoteHostWorkspace): Record<string, unknown> {
  return {
    kind: "local",
    label: workspace.name ?? workspace.key,
    workspacePath: workspace.path ?? workspace.key,
    workspaceKey: workspace.key,
    ...(workspace.name !== undefined ? { name: workspace.name } : {})
  };
}

function encodeChannelFrame(type: number, id: number, data: unknown): Uint8Array {
  const writer = new ValueWriter();
  encodeValue(writer, [type, id]);
  encodeValue(writer, data);
  return writer.toBytes();
}

interface DecodedChannelRequest {
  arg: unknown;
  channel: string;
  id: number;
  name: string;
  type: number;
}

function decodeChannelRequest(body: Uint8Array): DecodedChannelRequest | undefined {
  const reader = new ValueReader(body);
  let header: unknown;
  let arg: unknown;
  try {
    header = decodeValue(reader);
    arg = reader.remaining > 0 ? decodeValue(reader) : undefined;
  } catch {
    return undefined;
  }
  if (!Array.isArray(header)) return undefined;
  const type = integerField(header[0]);
  const id = integerField(header[1]);
  const channel = stringField(header[2]);
  const name = stringField(header[3]);
  if (type === undefined || id === undefined || channel === undefined || name === undefined) return undefined;
  return { arg, channel, id, name, type };
}

/** One bridged workspace on the host side: transport, in-flight calls and event subscriptions. */
class HostBridge {
  readonly bridgeSessionId: string;
  readonly eventSubscriptions = new Map<number, () => void>();
  readonly openedAt: number;
  readonly pendingCalls = new Map<number, AbortController>();
  readonly recoveryId: string;
  readonly transport: RpcFrameTransport;
  readonly workspaceKey: string;

  disposed = false;

  constructor(input: {
    bridgeSessionId: string;
    openedAt: number;
    recoveryId: string;
    transport: RpcFrameTransport;
    workspaceKey: string;
  }) {
    this.bridgeSessionId = input.bridgeSessionId;
    this.openedAt = input.openedAt;
    this.recoveryId = input.recoveryId;
    this.transport = input.transport;
    this.workspaceKey = input.workspaceKey;
  }

  respond(type: number, id: number, data: unknown): void {
    if (this.disposed) return;
    this.transport.sendMessage(encodeChannelFrame(type, id, data));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of [...this.pendingCalls.values()]) controller.abort();
    this.pendingCalls.clear();
    for (const disposeSubscription of [...this.eventSubscriptions.values()]) {
      try {
        disposeSubscription();
      } catch {
        // A failing unsubscribe must not stop the rest of the teardown.
      }
    }
    this.eventSubscriptions.clear();
    this.transport.dispose();
  }
}

/**
 * The controllable side of the relay protocol: authenticates in the `desktop` role, waits for a
 * controller (the official web remote control or another `RemoteClient`), and answers its
 * bootstrap, workspace-list and workspace-bridge envelopes. Channel promise calls that arrive over
 * a bridge are handed to the {@link RemoteHostBackend}.
 *
 * The service never logs a frame verbatim: relay frames carry the device credential and proofs.
 */
export class RemoteHostService {
  readonly relay: RelayClient;

  private readonly backend: RemoteHostBackend;
  private readonly bridges = new Map<string, HostBridge>();
  private readonly now: () => number;
  private readonly onLog: ((line: string) => void) | undefined;
  private readonly viewStateListeners = new Set<(viewState: Record<string, unknown>) => void>();

  private appVersion: string | undefined;
  private deviceName: string | undefined;
  private disposed = false;
  private lastViewState: Record<string, unknown> | undefined;
  private platform: string;
  /**
   * Opaque session id the official controller requires in every bootstrap result. It identifies
   * the desktop's optional window-control session; CLI hosts never open one, but the field must
   * be a non-empty string or the whole payload is rejected.
   */
  private readonly windowControlSessionId = randomUUID();

  constructor(params: RemoteConnectionParams, backend: RemoteHostBackend, options: RemoteHostServiceOptions = {}) {
    this.backend = backend;
    this.now = options.now ?? (() => Date.now());
    this.onLog = options.onLog;
    this.appVersion = options.appVersion ?? params.appVersion;
    this.deviceName = options.deviceName ?? params.deviceName;
    this.platform = options.platform ?? process.platform;
    this.relay = new RelayClient(params, {
      ...(this.deviceName !== undefined ? { clientName: this.deviceName } : {}),
      ...options,
      role: relayRoles.desktop,
      // A host is a long-running server. Its reconnect backoff must keep the process alive even
      // while no WebSocket is open, otherwise Node can terminate a pending top-level await.
      keepAliveOnReconnect: true,
      // A host is listening, not pairing: it waits for its next controller indefinitely.
      waitingTimeoutMs: 0
    });
    this.relay.onPayload((payload) => this.handlePayload(payload));
  }

  get state(): RelayState {
    return this.relay.state;
  }

  get activeBridgeCount(): number {
    return this.bridges.size;
  }

  snapshot(): RemoteHostSnapshot {
    return {
      activeBridges: this.bridges.size,
      state: this.relay.state,
      ...(this.lastViewState !== undefined ? { viewState: this.lastViewState } : {})
    };
  }

  onState(listener: (state: RelayState) => void): () => void {
    return this.relay.onState(listener);
  }

  onFailure(listener: (failure: RelayFailure) => void): () => void {
    return this.relay.onFailure(listener);
  }

  /** Fires on `mobile-view-state-update`, i.e. when the controller reports what it is viewing. */
  onViewState(listener: (viewState: Record<string, unknown>) => void): () => void {
    this.viewStateListeners.add(listener);
    return () => {
      this.viewStateListeners.delete(listener);
    };
  }

  start(): void {
    this.relay.start();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const bridge of [...this.bridges.values()]) bridge.dispose();
    this.bridges.clear();
    this.viewStateListeners.clear();
    this.relay.dispose();
  }

  private log(line: string): void {
    this.onLog?.(line);
  }

  private handlePayload(payload: RelayPayload): void {
    const type = payload["zcode_type"];
    if (type === "bootstrap-request") {
      void this.serveOverview(payload, "bootstrap-response", true);
      return;
    }
    if (type === "workspace-list-request") {
      void this.serveOverview(payload, "workspace-list-response", false);
      return;
    }
    if (type === "workspace-bridge-open") {
      void this.serveBridgeOpen(payload);
      return;
    }
    if (type === "workspace-reconnect-request") {
      this.serveReconnect(payload);
      return;
    }
    if (type === "rpc-frame" || type === "rpc-frame-ack") {
      const bridgeSessionId = stringField(payload["bridgeSessionId"]);
      const bridge = bridgeSessionId === undefined ? undefined : this.bridges.get(bridgeSessionId);
      if (bridge === undefined) {
        this.log(`[host] dropped ${String(type)} for unknown bridge`);
        return;
      }
      bridge.transport.acceptPayload(payload);
      return;
    }
    if (type === "mobile-view-state-update") {
      const viewState = payload["viewState"];
      if (!isRecord(viewState)) return;
      this.lastViewState = viewState;
      for (const listener of [...this.viewStateListeners]) {
        try {
          listener(viewState);
        } catch (error) {
          this.log(`[host] view-state listener failed: ${errorText(error)}`);
        }
      }
    }
  }

  private async listWorkspaces(): Promise<RemoteHostWorkspace[]> {
    try {
      return await this.backend.listWorkspaces();
    } catch (error) {
      this.log(`[host] listWorkspaces failed: ${errorText(error)}`);
      return [];
    }
  }

  private async serveOverview(payload: RelayPayload, responseType: string, describeHost: boolean): Promise<void> {
    const workspaces = (await this.listWorkspaces()).map(workspaceOverviewEntry);
    this.relay.sendPayload({
      zcode_type: responseType,
      ...(stringField(payload["requestId"]) !== undefined ? { requestId: payload["requestId"] } : {}),
      // The official web controller validates every payload against a schema that requires a
      // literal `success: true` (plus `windowControlSessionId` and `tasks` for bootstrap) and
      // drops responses not matching it, which surfaces as a desktop-bootstrap timeout.
      success: true,
      result: {
        ...(describeHost ? { windowControlSessionId: this.windowControlSessionId } : {}),
        tasks: [],
        ...(describeHost && this.appVersion !== undefined ? { appVersion: this.appVersion } : {}),
        ...(describeHost && this.deviceName !== undefined ? { deviceName: this.deviceName } : {}),
        ...(describeHost ? { platform: this.platform } : {}),
        workspaces
      }
    });
  }

  private async serveBridgeOpen(payload: RelayPayload): Promise<void> {
    const requestId = stringField(payload["requestId"]);
    const bridgeSessionId = stringField(payload["bridgeSessionId"]);
    const workspaceKey = stringField(payload["workspaceKey"]);
    if (bridgeSessionId === undefined) return;
    const fail = (error: string, reason: RemoteBridgeErrorReason): void => {
      this.relay.sendPayload({
        zcode_type: "workspace-bridge-error",
        ...(requestId !== undefined ? { requestId } : {}),
        bridgeSessionId,
        reason,
        error
      });
    };
    if (workspaceKey === undefined) {
      fail("workspace-bridge-open carried no workspaceKey", "unsupported-action");
      return;
    }
    const workspaces = await this.listWorkspaces();
    // The official controller derives its workspace key from `workspacePath` (unless the overview
    // advertised a `workspaceIdentity`), while zcode-cli's own controller echoes the advertised
    // `workspaceKey`; a bridge-open for either must land on the same workspace.
    const workspace = workspaces.find((entry) => entry.key === workspaceKey || entry.path === workspaceKey);
    if (workspace === undefined) {
      fail(`unknown workspace: ${workspaceKey}`, "workspace-closed");
      return;
    }
    if (this.disposed) return;

    // A reopen after a relay drop carries the previous recoveryId; the stale bridge dies with it.
    const recoveryId = stringField(payload["recoveryId"]);
    for (const [id, bridge] of [...this.bridges]) {
      if (bridge.recoveryId === recoveryId || id === bridgeSessionId) {
        bridge.dispose();
        this.bridges.delete(id);
      }
    }
    this.evictOldestBridges(maximumBridges - 1);

    const bridgeGeneration = integerField(payload["bridgeGeneration"]) ?? 1;
    const bridge = new HostBridge({
      bridgeSessionId,
      openedAt: this.now(),
      recoveryId: recoveryId ?? `recovery-${randomUUID()}`,
      transport: new RpcFrameTransport({
        bridgeGeneration,
        bridgeSessionId,
        ...(this.onLog !== undefined ? { onLog: this.onLog } : {}),
        sendPayload: (frame) => this.relay.sendPayload(frame)
      }),
      workspaceKey
    });
    bridge.transport.onMessage((body) => this.handleChannelRequest(bridge, body));
    this.bridges.set(bridgeSessionId, bridge);

    const taskId = stringField(payload["taskId"]);
    this.relay.sendPayload({
      zcode_type: "workspace-bridge-ready",
      ...(requestId !== undefined ? { requestId } : {}),
      bridgeSessionId,
      bridge: {
        // The official controller's bridge schema is a discriminated union on `kind` and requires
        // a non-empty `workspacePath`; a payload without both is dropped and the bridge stalls.
        kind: "local",
        bridgeSessionId,
        bridgeGeneration,
        recoveryId: bridge.recoveryId,
        workspaceKey,
        workspacePath: workspace.path ?? workspaceKey,
        ...(taskId !== undefined ? { initialTaskId: taskId } : {})
      }
    });
    // The channel conversation opens from this side with a single Initialize frame.
    bridge.respond(channelResponseType.initialize, 0, undefined);
    this.log(`[host] bridge opened for ${workspaceKey}`);
  }

  private serveReconnect(payload: RelayPayload): void {
    const workspaceKey = stringField(payload["workspaceKey"]);
    const alive = workspaceKey !== undefined
      && [...this.bridges.values()].some((bridge) => bridge.workspaceKey === workspaceKey);
    this.relay.sendPayload({
      zcode_type: "workspace-reconnect-response",
      ...(stringField(payload["requestId"]) !== undefined ? { requestId: payload["requestId"] } : {}),
      // Both variants of the controller's reconnect-response schema require a non-empty
      // workspaceKey; the request schema guarantees one, the fallback only guards the type.
      workspaceKey: workspaceKey ?? "unknown",
      success: alive,
      ...(alive ? {} : { error: "no live bridge for that workspace" })
    });
  }

  private evictOldestBridges(keep: number): void {
    const excess = this.bridges.size - keep;
    if (excess <= 0) return;
    const oldestFirst = [...this.bridges.values()].sort((a, b) => a.openedAt - b.openedAt);
    for (const bridge of oldestFirst.slice(0, excess)) {
      this.log(`[host] evicting bridge for ${bridge.workspaceKey}`);
      bridge.dispose();
      this.bridges.delete(bridge.bridgeSessionId);
    }
  }

  private handleChannelRequest(bridge: HostBridge, body: Uint8Array): void {
    const request = decodeChannelRequest(body);
    if (request === undefined) {
      this.log("[host] undecodable channel request");
      return;
    }
    if (request.type === channelRequestType.promise) {
      const args = Array.isArray(request.arg) ? request.arg : request.arg === undefined ? [] : [request.arg];
      void this.servePromise(bridge, request.id, request.channel, request.name, args);
      return;
    }
    if (request.type === channelRequestType.promiseCancel) {
      bridge.pendingCalls.get(request.id)?.abort();
      return;
    }
    if (request.type === channelRequestType.eventListen) {
      this.serveEventListen(bridge, request);
      return;
    }
    if (request.type === channelRequestType.eventDispose) {
      const disposeSubscription = bridge.eventSubscriptions.get(request.id);
      bridge.eventSubscriptions.delete(request.id);
      try {
        disposeSubscription?.();
      } catch (error) {
        this.log(`[host] event dispose failed: ${errorText(error)}`);
      }
    }
  }

  private async servePromise(
    bridge: HostBridge,
    id: number,
    channel: string,
    name: string,
    args: unknown[]
  ): Promise<void> {
    const controller = new AbortController();
    bridge.pendingCalls.set(id, controller);
    this.log(`[host] call ${channel}.${name} id=${id}`);
    try {
      const result = await this.backend.call({
        args,
        channel,
        name,
        signal: controller.signal,
        workspaceKey: bridge.workspaceKey
      });
      if (controller.signal.aborted) return;
      bridge.respond(channelResponseType.promiseSuccess, id, result);
    } catch (error) {
      if (controller.signal.aborted) return;
      try {
        bridge.respond(channelResponseType.promiseError, id, { message: errorText(error) });
      } catch (respondError) {
        this.log(`[host] failed to report call error: ${errorText(respondError)}`);
      }
    } finally {
      bridge.pendingCalls.delete(id);
    }
  }

  private serveEventListen(bridge: HostBridge, request: DecodedChannelRequest): void {
    const subscribe = this.backend.subscribe;
    if (subscribe === undefined) {
      this.log(`[host] event ${request.channel}.${request.name} ignored: backend has no event support`);
      return;
    }
    // Registered before subscribe() so an event emitted synchronously during registration lands.
    bridge.eventSubscriptions.set(request.id, () => {});
    try {
      const disposeSubscription = subscribe.call(this.backend, {
        arg: request.arg,
        channel: request.channel,
        event: request.name,
        workspaceKey: bridge.workspaceKey
      }, (data) => {
        if (!bridge.eventSubscriptions.has(request.id)) return;
        try {
          bridge.respond(channelResponseType.eventFire, request.id, data);
        } catch (error) {
          this.log(`[host] event emit failed: ${errorText(error)}`);
        }
      });
      if (bridge.eventSubscriptions.has(request.id)) {
        bridge.eventSubscriptions.set(request.id, disposeSubscription);
      } else {
        disposeSubscription();
      }
    } catch (error) {
      bridge.eventSubscriptions.delete(request.id);
      this.log(`[host] subscribe ${request.channel}.${request.name} failed: ${errorText(error)}`);
    }
  }
}
