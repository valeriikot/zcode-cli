import { randomUUID } from "node:crypto";

import { ChannelClient, type ChannelEventListener } from "./channel-client.ts";
import { redactRemoteConnectionUrl, type RemoteConnectionParams } from "./connection-params.ts";
import {
  RelayClient,
  type RelayClientOptions,
  type RelayFailure,
  type RelayPayload,
  type RelayState
} from "./relay-client.ts";
import { RpcFrameTransport } from "./rpc-transport.ts";

const defaultRequestTimeoutMs = 30_000;
const defaultPairingTimeoutMs = 60_000;
const defaultBridgeReconnectTimeoutMs = 15_000;

/** Relay states that can never become `paired` again without another `start()`. */
const terminalRelayStates = new Set<RelayState>(["closed", "error", "kicked"]);

export type RemoteLogger = (line: string) => void;

export interface RemoteRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RemoteMethod {
  channel: string;
  name: string;
}

export interface RemoteWorkspaceSummary {
  key: string;
  name?: string;
  path?: string;
}

export interface RemoteConnectionSnapshot {
  appVersion?: string;
  bridgedWorkspaceKey?: string;
  deviceName?: string;
  host: string;
  paired: boolean;
  state: RelayState;
  workspaces: RemoteWorkspaceSummary[];
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

function requestId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function abortError(): Error {
  const error = new Error("Remote request cancelled.");
  error.name = "AbortError";
  return error;
}

function timeoutError(message: string): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

/**
 * Splits an app-server-style method name into the channel and member the desktop exposes.
 * `plugins/overview` and `plugins.overview` both address `overview` on the `plugins` channel.
 */
export function parseRemoteMethod(method: string): RemoteMethod {
  const trimmed = method.trim();
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("."));
  const channel = separator > 0 ? trimmed.slice(0, separator) : "";
  const name = separator > 0 ? trimmed.slice(separator + 1) : "";
  if (channel.length === 0 || name.length === 0) {
    throw new Error(`Invalid remote method: ${method}. Expected <channel>/<name>.`);
  }
  return { channel, name };
}

/** Reads a workspace overview out of a bootstrap or workspace-list result of unknown shape. */
export function remoteWorkspaceSummaries(result: unknown): RemoteWorkspaceSummary[] {
  const entries = Array.isArray(result)
    ? result
    : isRecord(result) && Array.isArray(result["workspaces"])
      ? result["workspaces"]
      : [];
  const summaries: RemoteWorkspaceSummary[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const key = stringField(entry["workspaceKey"]) ?? stringField(entry["key"]) ?? stringField(entry["workspaceIdentity"]);
    if (key === undefined) continue;
    const path = stringField(entry["workspacePath"]) ?? stringField(entry["path"]);
    const name = stringField(entry["name"]) ?? stringField(entry["title"]);
    summaries.push({ key, ...(name !== undefined ? { name } : {}), ...(path !== undefined ? { path } : {}) });
  }
  return summaries;
}

/**
 * One workspace bridge: the rpc-frame transport plus the IPC channel client built on top of it.
 * The stack is replaced in place when the bridge is recovered, so callers keep their handle.
 */
export class RemoteBridgeSession {
  private bridgeInfo: Record<string, unknown>;
  private channelClient: ChannelClient | undefined;
  private degraded: string | undefined;
  private disposed = false;
  private readonly onDispose: (session: RemoteBridgeSession) => void;
  private readonly recoveredListeners = new Set<() => void>();
  private recoveredCount = 0;
  private transport: RpcFrameTransport | undefined;

  constructor(bridge: Record<string, unknown>, onDispose: (session: RemoteBridgeSession) => void) {
    this.bridgeInfo = bridge;
    this.onDispose = onDispose;
  }

  get bridge(): Record<string, unknown> {
    return this.bridgeInfo;
  }

  get bridgeSessionId(): string | undefined {
    return stringField(this.bridgeInfo["bridgeSessionId"]);
  }

  get channels(): ChannelClient {
    if (this.channelClient === undefined) throw new Error("Remote bridge has no channel client yet.");
    return this.channelClient;
  }

  get degradedReason(): string | undefined {
    return this.degraded;
  }

  get initialTaskId(): string | undefined {
    return stringField(this.bridgeInfo["initialTaskId"]);
  }

  get recoveries(): number {
    return this.recoveredCount;
  }

  get workspaceKey(): string | undefined {
    return stringField(this.bridgeInfo["workspaceKey"]);
  }

  /**
   * Server-side subscription state dies with the old bridge, so listeners must resubscribe every
   * time this fires.
   */
  onRecovered(listener: () => void): () => void {
    this.recoveredListeners.add(listener);
    return () => {
      this.recoveredListeners.delete(listener);
    };
  }

  async call(
    channel: string,
    name: string,
    args: unknown[] = [],
    options: RemoteRequestOptions = {}
  ): Promise<unknown> {
    return await this.channels.call(channel, name, args, options);
  }

  subscribe(channel: string, event: string, listener: ChannelEventListener, arg?: unknown): () => void {
    return this.channels.addEventListener(channel, event, listener, arg);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.channelClient?.dispose();
    this.transport?.dispose();
    this.recoveredListeners.clear();
    this.onDispose(this);
  }

  /** @internal Replaces the transport stack after a fresh `workspace-bridge-ready`. */
  swapStack(bridge: Record<string, unknown>, transport: RpcFrameTransport, channels: ChannelClient): void {
    this.channelClient?.dispose();
    this.transport?.dispose();
    this.bridgeInfo = bridge;
    this.channelClient = channels;
    this.transport = transport;
  }

  /** @internal */
  markDegraded(reason: string | undefined): void {
    this.degraded = reason;
  }

  /** @internal */
  markRecovered(): void {
    this.degraded = undefined;
    this.recoveredCount += 1;
    for (const listener of [...this.recoveredListeners]) {
      try {
        listener();
      } catch {
        // A resubscribe failure must not abort recovery of the remaining listeners.
      }
    }
  }
}

export interface RemoteClientOptions extends RelayClientOptions {
  requestTimeoutMs?: number;
}

export interface RemoteConnectOptions {
  pairingTimeoutMs?: number;
  signal?: AbortSignal;
  /** Opens a workspace bridge as part of connecting, so `request()` is usable immediately. */
  workspaceKey?: string;
}

interface PendingRelayRequest {
  match: (payload: RelayPayload) => boolean;
  reject: (error: Error) => void;
  resolve: (payload: RelayPayload) => void;
}

/**
 * High-level remote-desktop client: relay connect, pair, bootstrap, workspace bridge, channel RPC.
 *
 * `request()` mirrors the local app-server surface (`requestAppServer`) so callers do not have to
 * know which transport they were given; the method name is mapped to `<channel>/<name>` on the
 * bridged workspace, and the resolved value is the decoded RPC result.
 */
export class RemoteClient {
  readonly relay: RelayClient;

  private readonly activeBridges = new Set<RemoteBridgeSession>();
  private readonly bufferedBridgePayloads = new Map<string, RelayPayload[]>();
  private readonly frameRouters = new Map<string, (payload: RelayPayload) => boolean>();
  private readonly onLog: RemoteLogger | undefined;
  private readonly params: RemoteConnectionParams;
  private readonly pendingRequests = new Map<string, PendingRelayRequest>();
  private readonly requestTimeoutMs: number;
  private readonly workspaceListListeners = new Set<(result: unknown) => void>();

  private bridgeGeneration = 0;
  private defaultBridge: RemoteBridgeSession | undefined;
  private disposed = false;
  private needsBridgeRecovery = false;

  constructor(params: RemoteConnectionParams, options: RemoteClientOptions = {}) {
    this.onLog = options.onLog;
    this.params = params;
    this.requestTimeoutMs = options.requestTimeoutMs ?? defaultRequestTimeoutMs;
    this.relay = new RelayClient(params, options);
    this.relay.onPayload((payload) => this.dispatchPayload(payload));
    this.relay.onState((state) => this.handleRelayState(state));
  }

  get state(): RelayState {
    return this.relay.state;
  }

  /** Loggable identity of the connected device; never the credential URL. */
  get description(): string {
    return redactRemoteConnectionUrl(this.params);
  }

  onFailure(listener: (failure: RelayFailure) => void): () => void {
    return this.relay.onFailure(listener);
  }

  onWorkspaceListUpdated(listener: (result: unknown) => void): () => void {
    this.workspaceListListeners.add(listener);
    return () => {
      this.workspaceListListeners.delete(listener);
    };
  }

  async connect(options: RemoteConnectOptions = {}): Promise<RemoteConnectionSnapshot> {
    this.relay.start();
    await this.waitPaired(options);
    const bootstrap = await this.bootstrap({ signal: options.signal });
    let workspaces = remoteWorkspaceSummaries(bootstrap);
    if (workspaces.length === 0) {
      workspaces = remoteWorkspaceSummaries(await this.listWorkspaces({ signal: options.signal }));
    }
    if (options.workspaceKey !== undefined) {
      this.defaultBridge = await this.openBridge(options.workspaceKey, { signal: options.signal });
      return this.snapshot(workspaces);
    }
    // Bridging the only workspace is a convenience, so its failure must not hide a working pairing.
    if (workspaces.length === 1) {
      try {
        this.defaultBridge = await this.openBridge(workspaces[0]!.key, { signal: options.signal });
      } catch (error) {
        this.log(`[bridge] optional bridge failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return this.snapshot(workspaces);
  }

  snapshot(workspaces: RemoteWorkspaceSummary[] = []): RemoteConnectionSnapshot {
    return {
      ...(this.params.appVersion !== undefined ? { appVersion: this.params.appVersion } : {}),
      ...(this.defaultBridge?.workspaceKey !== undefined
        ? { bridgedWorkspaceKey: this.defaultBridge.workspaceKey }
        : {}),
      ...(this.params.deviceName !== undefined ? { deviceName: this.params.deviceName } : {}),
      host: this.params.source.host,
      paired: this.relay.state === "paired",
      state: this.relay.state,
      workspaces
    };
  }

  async waitPaired(options: { pairingTimeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    if (this.relay.state === "paired") return;
    if (terminalRelayStates.has(this.relay.state)) {
      throw new Error(`The remote relay connection ended while pairing (${this.relay.state}).`);
    }
    const timeoutMs = options.pairingTimeoutMs ?? defaultPairingTimeoutMs;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (): void => {
        settled = true;
        clearTimeout(timer);
        removeFailureListener();
        removeStateListener();
        options.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        if (settled) return;
        finish();
        reject(abortError());
      };
      const timer = setTimeout(() => {
        if (settled) return;
        finish();
        reject(timeoutError(`Pairing with the remote desktop timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      timer.unref?.();
      // A reported failure is terminal for this attempt, so surface it instead of burning the whole
      // pairing timeout on a host that is never going to answer.
      const removeFailureListener = this.relay.onFailure((failure) => {
        if (settled) return;
        finish();
        reject(new Error(`The remote desktop could not be paired: ${failure.reason}.`));
      });
      const removeStateListener = this.relay.onState((state) => {
        if (settled) return;
        if (state === "paired") {
          finish();
          resolve();
          return;
        }
        if (terminalRelayStates.has(state)) {
          finish();
          reject(new Error(`The remote relay connection ended while pairing (${state}).`));
        }
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (this.relay.state === "paired") {
        finish();
        resolve();
      }
    });
  }

  /** `bootstrap-request` -> `bootstrap-response`; the desktop's workspace overview. */
  async bootstrap(options: RemoteRequestOptions = {}): Promise<unknown> {
    const id = requestId("bootstrap");
    const response = await this.sendRelayRequest(
      { zcode_type: "bootstrap-request", requestId: id },
      (payload) => payload["zcode_type"] === "bootstrap-response" && payload["requestId"] === id,
      options
    );
    return isRecord(response["result"]) ? response["result"] : response;
  }

  /** `workspace-list-request` -> `workspace-list-response`. */
  async listWorkspaces(options: RemoteRequestOptions = {}): Promise<unknown> {
    const id = requestId("workspace-list");
    const response = await this.sendRelayRequest(
      { zcode_type: "workspace-list-request", requestId: id },
      (payload) => payload["zcode_type"] === "workspace-list-response" && payload["requestId"] === id,
      options
    );
    return response["result"];
  }

  /** `workspace-bridge-open` -> `workspace-bridge-ready`, then builds the transport stack. */
  async openBridge(
    workspaceKey: string,
    options: RemoteRequestOptions & { taskId?: string } = {}
  ): Promise<RemoteBridgeSession> {
    const bridgeSessionId = requestId("bridge");
    this.bridgeGeneration += 1;
    const bridge = await this.requestBridge(bridgeSessionId, this.bridgeGeneration, workspaceKey, {
      ...(options.taskId !== undefined ? { taskId: options.taskId } : {}),
      ...options
    });
    const session = new RemoteBridgeSession(bridge, (closed) => this.forgetBridge(closed));
    this.attachStack(session, bridgeSessionId, bridge);
    this.activeBridges.add(session);
    this.defaultBridge ??= session;
    this.sendMobileViewState(
      stringField(bridge["workspaceKey"]) ?? workspaceKey,
      stringField(bridge["initialTaskId"]) ?? options.taskId
    );
    return session;
  }

  /** Opens (or reuses) the bridge that plain `request()` calls travel over. */
  async useWorkspace(workspaceKey: string, options: RemoteRequestOptions = {}): Promise<RemoteBridgeSession> {
    if (this.defaultBridge?.workspaceKey === workspaceKey) return this.defaultBridge;
    const session = await this.openBridge(workspaceKey, options);
    this.defaultBridge = session;
    return session;
  }

  /**
   * Calls one method on the bridged workspace. `method` is `<channel>/<name>`; `params` is passed
   * as the single RPC argument, and the decoded result is returned exactly as the local app-server
   * path returns its `result`.
   */
  async request(
    method: string,
    params: Record<string, unknown> = {},
    options: RemoteRequestOptions = {}
  ): Promise<unknown> {
    const { channel, name } = parseRemoteMethod(method);
    const bridge = this.requireBridge();
    const args = Object.keys(params).length === 0 ? [] : [params];
    return await bridge.call(channel, name, args, options);
  }

  /** Subscribes to `<channel>/<event>` on the bridged workspace. */
  subscribe(method: string, listener: ChannelEventListener, arg?: unknown): () => void {
    const { channel, name } = parseRemoteMethod(method);
    return this.requireBridge().subscribe(channel, name, listener, arg);
  }

  /** `workspace-reconnect-request`; the cheap recovery path after a relay drop. */
  async reconnectWorkspace(workspaceKey: string, options: RemoteRequestOptions = {}): Promise<RelayPayload> {
    const id = requestId("workspace-reconnect");
    return await this.sendRelayRequest(
      { zcode_type: "workspace-reconnect-request", requestId: id, workspaceKey },
      (payload) => payload["zcode_type"] === "workspace-reconnect-response"
        && payload["requestId"] === id
        && payload["workspaceKey"] === workspaceKey,
      options
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const session of [...this.activeBridges]) session.dispose();
    this.activeBridges.clear();
    this.frameRouters.clear();
    this.bufferedBridgePayloads.clear();
    this.defaultBridge = undefined;
    for (const pending of [...this.pendingRequests.values()]) {
      pending.reject(new Error("Remote client disposed."));
    }
    this.pendingRequests.clear();
    this.workspaceListListeners.clear();
    this.relay.dispose();
  }

  private log(line: string): void {
    this.onLog?.(line);
  }

  private requireBridge(): RemoteBridgeSession {
    if (this.defaultBridge === undefined) {
      throw new Error("No remote workspace is bridged. Call useWorkspace() or connect({ workspaceKey }) first.");
    }
    return this.defaultBridge;
  }

  private forgetBridge(session: RemoteBridgeSession): void {
    this.activeBridges.delete(session);
    if (this.defaultBridge === session) this.defaultBridge = undefined;
    const id = session.bridgeSessionId;
    if (id !== undefined) {
      this.frameRouters.delete(id);
      this.bufferedBridgePayloads.delete(id);
    }
  }

  /**
   * Relay reconnects happen silently (heartbeat timeout, sleep, network switch). Every bridge that
   * was alive before the drop has to be recovered once the relay re-pairs.
   */
  private handleRelayState(state: RelayState): void {
    if (state === "reconnecting" || state === "error") {
      if (this.activeBridges.size > 0) this.needsBridgeRecovery = true;
      return;
    }
    if (state !== "paired" || !this.needsBridgeRecovery) return;
    this.needsBridgeRecovery = false;
    void this.recoverActiveBridges();
  }

  private async recoverActiveBridges(): Promise<void> {
    this.log(`[bridge] recovering ${this.activeBridges.size} bridge(s)`);
    for (const session of [...this.activeBridges]) await this.recoverBridge(session);
  }

  private async recoverBridge(session: RemoteBridgeSession): Promise<void> {
    const workspaceKey = session.workspaceKey;
    if (workspaceKey === undefined) return;
    session.markDegraded("recovering");
    try {
      const response = await this.reconnectWorkspace(workspaceKey, {
        timeoutMs: defaultBridgeReconnectTimeoutMs
      });
      if (response["success"] === true) {
        this.log(`[bridge] reconnected ${workspaceKey}`);
        session.markRecovered();
        return;
      }
    } catch (error) {
      this.log(`[bridge] reconnect-request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await this.reopenBridge(session, workspaceKey);
      session.markRecovered();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.log(`[bridge] reopen failed: ${reason}`);
      session.markDegraded(`reopen-failed: ${reason}`);
    }
  }

  private async reopenBridge(session: RemoteBridgeSession, workspaceKey: string): Promise<void> {
    const bridgeSessionId = requestId("bridge");
    this.bridgeGeneration += 1;
    this.log(`[bridge] reopen ${workspaceKey} (generation ${this.bridgeGeneration})`);
    const recoveryId = stringField(session.bridge["recoveryId"]);
    const bridge = await this.requestBridge(bridgeSessionId, this.bridgeGeneration, workspaceKey, {
      ...(recoveryId !== undefined ? { recoveryId } : {})
    });
    this.attachStack(session, bridgeSessionId, bridge);
  }

  private async requestBridge(
    bridgeSessionId: string,
    generation: number,
    workspaceKey: string,
    options: RemoteRequestOptions & { recoveryId?: string; taskId?: string }
  ): Promise<Record<string, unknown>> {
    const response = await this.sendRelayRequest(
      {
        zcode_type: "workspace-bridge-open",
        requestId: requestId("workspace-bridge"),
        bridgeSessionId,
        bridgeGeneration: generation,
        workspaceKey,
        ...(options.recoveryId !== undefined ? { recoveryId: options.recoveryId } : {}),
        ...(options.taskId !== undefined ? { taskId: options.taskId } : {})
      },
      (payload) => (payload["zcode_type"] === "workspace-bridge-ready"
        || payload["zcode_type"] === "workspace-bridge-error")
        && payload["bridgeSessionId"] === bridgeSessionId,
      options
    );
    if (response["zcode_type"] === "workspace-bridge-error") {
      throw new Error(`workspace-bridge-error: ${stringField(response["error"]) ?? "unknown error"}`);
    }
    return isRecord(response["bridge"]) ? response["bridge"] : {};
  }

  /**
   * Over a workspace bridge each rpc-frame message is exactly one channel body, so the 13-byte IPC
   * framing of the direct desktop socket does not apply here.
   */
  private attachStack(
    session: RemoteBridgeSession,
    requestedBridgeSessionId: string,
    bridge: Record<string, unknown>
  ): void {
    const previousId = session.bridgeSessionId;
    const bridgeSessionId = stringField(bridge["bridgeSessionId"]) ?? requestedBridgeSessionId;
    const transport = new RpcFrameTransport({
      bridgeSessionId,
      ...(integerField(bridge["bridgeGeneration"]) !== undefined
        ? { bridgeGeneration: integerField(bridge["bridgeGeneration"])! }
        : {}),
      ...(stringField(bridge["recoveryId"]) !== undefined
        ? { recoveryId: stringField(bridge["recoveryId"])! }
        : {}),
      ...(this.onLog !== undefined ? { onLog: this.onLog } : {}),
      sendPayload: (payload) => this.relay.sendPayload(payload)
    });
    const channels = new ChannelClient({
      ...(this.onLog !== undefined ? { onLog: this.onLog } : {}),
      callTimeoutMs: this.requestTimeoutMs,
      sendBody: (body) => transport.sendMessage(body)
    });
    transport.onMessage((message) => channels.handleMessage(message));
    session.swapStack({ ...bridge, bridgeSessionId }, transport, channels);

    if (previousId !== undefined && previousId !== bridgeSessionId) this.frameRouters.delete(previousId);
    this.frameRouters.set(bridgeSessionId, (payload) => transport.acceptPayload(payload));
    // The desktop can push the IPC Initialize frame before this attach runs, so replay anything
    // that arrived for the bridge while no router existed.
    const buffered = this.bufferedBridgePayloads.get(bridgeSessionId);
    this.bufferedBridgePayloads.delete(bridgeSessionId);
    if (buffered === undefined) return;
    for (const payload of buffered) transport.acceptPayload(payload);
  }

  private dispatchPayload(payload: RelayPayload): void {
    const type = payload["zcode_type"];
    if (type === "workspace-list-updated") {
      for (const listener of [...this.workspaceListListeners]) {
        try {
          listener(payload["result"]);
        } catch (error) {
          this.log(`[remote] workspace listener failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return;
    }
    if (type === "bridge-degraded") {
      void this.handleBridgeDegraded(payload);
      return;
    }
    if (type === "rpc-frame" || type === "rpc-frame-ack") {
      const id = stringField(payload["bridgeSessionId"]);
      if (id === undefined) return;
      const router = this.frameRouters.get(id);
      if (router !== undefined) {
        router(payload);
        return;
      }
      const buffered = this.bufferedBridgePayloads.get(id) ?? [];
      buffered.push(payload);
      this.bufferedBridgePayloads.set(id, buffered);
      return;
    }
    // Responses are not guaranteed to echo the request id, so every pending matcher is offered
    // every payload.
    for (const [id, pending] of [...this.pendingRequests]) {
      if (!pending.match(payload)) continue;
      this.pendingRequests.delete(id);
      pending.resolve(payload);
    }
  }

  private async handleBridgeDegraded(payload: RelayPayload): Promise<void> {
    const bridgeSessionId = stringField(payload["bridgeSessionId"]);
    const reason = stringField(payload["reason"]);
    this.log(`[bridge] degraded: ${bridgeSessionId ?? "unknown"} reason=${reason ?? "unknown"}`);
    const affected = [...this.activeBridges].filter((session) => session.bridgeSessionId === bridgeSessionId);
    for (const session of affected) session.markDegraded(reason ?? "unknown");
    const workspaceKey = affected[0]?.workspaceKey;
    if (workspaceKey === undefined) return;
    try {
      const response = await this.reconnectWorkspace(workspaceKey);
      const success = response["success"] === true;
      this.log(`[bridge] reconnect ${workspaceKey} success=${success}`);
      for (const session of affected) {
        if (success) session.markRecovered();
        else session.markDegraded(stringField(response["error"]) ?? "reconnect-failed");
      }
    } catch (error) {
      this.log(`[bridge] reconnect failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** `mobile-view-state-update`: tells the desktop which workspace this client is looking at. */
  private sendMobileViewState(workspaceKey: string, taskId: string | undefined): void {
    this.relay.sendPayload({
      zcode_type: "mobile-view-state-update",
      viewState: {
        activeWorkspaceKey: workspaceKey,
        ...(taskId !== undefined ? { activeTaskId: taskId } : {}),
        updatedAt: Date.now()
      },
      deviceInfo: {
        platform: process.platform,
        version: this.params.appVersion ?? "web",
        name: "zcode-app-cli"
      }
    });
  }

  private async sendRelayRequest(
    payload: RelayPayload,
    match: (payload: RelayPayload) => boolean,
    options: RemoteRequestOptions
  ): Promise<RelayPayload> {
    const id = stringField(payload["requestId"]);
    if (id === undefined) throw new Error("Relay request payloads must carry a requestId.");
    if (options.signal?.aborted) throw abortError();
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    return await new Promise<RelayPayload>((resolve, reject) => {
      let settled = false;
      const finish = (): void => {
        settled = true;
        this.pendingRequests.delete(id);
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        if (settled) return;
        finish();
        reject(abortError());
      };
      const timer = setTimeout(() => {
        if (settled) return;
        finish();
        reject(timeoutError(`Remote request ${String(payload["zcode_type"])} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      timer.unref?.();
      this.pendingRequests.set(id, {
        match,
        reject: (error) => {
          if (settled) return;
          finish();
          reject(error);
        },
        resolve: (response) => {
          if (settled) return;
          finish();
          resolve(response);
        }
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.relay.sendPayload(payload);
    });
  }
}

export interface ProbeRemoteDeviceOptions extends RemoteClientOptions {
  pairingTimeoutMs?: number;
  signal?: AbortSignal;
  workspaceKey?: string;
}

/**
 * Connects, pairs, bootstraps and disconnects again, reporting what the desktop offered. Used by
 * `zcode remote connect` so the command can verify a stored device without holding a session open.
 */
export async function probeRemoteDevice(
  params: RemoteConnectionParams,
  options: ProbeRemoteDeviceOptions = {}
): Promise<RemoteConnectionSnapshot> {
  const client = new RemoteClient(params, options);
  try {
    return await client.connect({
      ...(options.pairingTimeoutMs !== undefined ? { pairingTimeoutMs: options.pairingTimeoutMs } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.workspaceKey !== undefined ? { workspaceKey: options.workspaceKey } : {})
    });
  } finally {
    client.dispose();
  }
}
