import { decodeValue, encodeValue, ValueReader, ValueWriter } from "./ipc-codec.ts";

/** Outbound request kinds of the IPC channel protocol. */
export const channelRequestType = {
  eventDispose: 103,
  eventListen: 102,
  promise: 100,
  promiseCancel: 101
} as const;

/** Inbound response kinds of the IPC channel protocol. */
export const channelResponseType = {
  eventFire: 204,
  initialize: 200,
  promiseError: 202,
  promiseErrorObject: 203,
  promiseSuccess: 201
} as const;

const defaultCallTimeoutMs = 30_000;
const defaultReadyTimeoutMs = 30_000;

export type ChannelEventListener = (event: unknown) => void;

export class ChannelRpcError extends Error {
  readonly data: unknown;

  // Fields are assigned explicitly because Node's strip-only TypeScript mode rejects
  // constructor parameter properties.
  constructor(message: string, data?: unknown) {
    super(message);
    this.name = "ChannelRpcError";
    this.data = data;
  }
}

export interface ChannelClientOptions {
  callTimeoutMs?: number;
  onLog?: (line: string) => void;
  readyTimeoutMs?: number;
  sendBody: (body: Uint8Array) => void;
}

export interface ChannelCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

type ResponseHandler = (type: number, data: unknown) => void;

function numberAt(header: unknown[], index: number): number | undefined {
  const value = header[index];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorMessageOf(data: unknown): string {
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const message = (data as Record<string, unknown>)["message"];
    if (typeof message === "string" && message.length > 0) return message;
  }
  if (typeof data === "string" && data.length > 0) return data;
  return "remote channel call failed";
}

function abortError(): Error {
  const error = new Error("Remote channel call cancelled.");
  error.name = "AbortError";
  return error;
}

function timeoutError(message: string): Error {
  const error = new Error(message);
  error.name = "TimeoutError";
  return error;
}

/**
 * IPC channel RPC over an already-framed body transport.
 *
 * A request body is the header value `[requestType, requestId, channel, name]` followed by one
 * argument value; a response body is `[responseType, requestId]` followed by one data value. The
 * desktop opens the conversation with a single Initialize frame, so calls wait for it before their
 * first request goes out.
 */
export class ChannelClient {
  private readonly callTimeoutMs: number;
  private readonly handlers = new Map<number, ResponseHandler>();
  private readonly onLog: ((line: string) => void) | undefined;
  private readonly readyPromise: Promise<void>;
  private readonly readyTimeoutMs: number;
  private readonly sendBody: (body: Uint8Array) => void;

  private disposed = false;
  private lastRequestId = 0;
  private markReady: () => void = () => {};
  private ready = false;

  constructor(options: ChannelClientOptions) {
    this.callTimeoutMs = options.callTimeoutMs ?? defaultCallTimeoutMs;
    this.onLog = options.onLog;
    this.readyTimeoutMs = options.readyTimeoutMs ?? defaultReadyTimeoutMs;
    this.sendBody = options.sendBody;
    // Never rejects, so an unawaited handshake cannot surface as an unhandled rejection.
    this.readyPromise = new Promise<void>((resolve) => {
      this.markReady = resolve;
    });
  }

  get initialized(): boolean {
    return this.ready;
  }

  get pendingCallCount(): number {
    return this.handlers.size;
  }

  /** Resolves once the desktop has sent its Initialize frame. */
  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  handleMessage(body: Uint8Array): void {
    let header: unknown;
    const reader = new ValueReader(body);
    try {
      header = decodeValue(reader);
    } catch (error) {
      this.onLog?.(`[ipc] undecodable frame header: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!Array.isArray(header) || header.length === 0) return;
    const type = numberAt(header, 0);
    if (type === undefined) return;
    if (type === channelResponseType.initialize) {
      this.onLog?.("[ipc] initialized");
      this.ready = true;
      this.markReady();
      return;
    }
    const id = numberAt(header, 1);
    if (id === undefined) return;
    const handler = this.handlers.get(id);
    if (handler === undefined) return;
    let data: unknown;
    try {
      data = decodeValue(reader);
    } catch (error) {
      this.onLog?.(`[ipc] undecodable frame body for id=${id}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    handler(type, data);
  }

  async call(
    channel: string,
    name: string,
    args: unknown[] = [],
    options: ChannelCallOptions = {}
  ): Promise<unknown> {
    if (this.disposed) throw new Error("Remote channel client is disposed.");
    if (options.signal?.aborted) throw abortError();
    await this.awaitReady(options.signal);
    if (this.disposed) throw new Error("Remote channel client is disposed.");
    if (options.signal?.aborted) throw abortError();

    const id = this.nextRequestId();
    const timeoutMs = options.timeoutMs ?? this.callTimeoutMs;
    return await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        settled = true;
        this.handlers.delete(id);
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        if (settled) return;
        finish();
        this.sendRequest(channelRequestType.promiseCancel, id, channel, name, undefined);
        reject(abortError());
      };

      this.handlers.set(id, (type, data) => {
        if (settled) return;
        if (type === channelResponseType.promiseSuccess) {
          finish();
          resolve(data);
          return;
        }
        if (type === channelResponseType.promiseError || type === channelResponseType.promiseErrorObject) {
          finish();
          reject(new ChannelRpcError(errorMessageOf(data), data));
        }
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        if (settled) return;
        finish();
        reject(timeoutError(`Remote channel call ${channel}.${name} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      timer.unref?.();

      this.onLog?.(`[ipc] call ${channel}.${name} id=${id}`);
      try {
        this.sendRequest(channelRequestType.promise, id, channel, name, args);
      } catch (error) {
        if (settled) return;
        finish();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Subscribes to a channel event. The returned function sends EventDispose; the subscription is
   * registered immediately so events that arrive before the handshake completes still land.
   */
  addEventListener(
    channel: string,
    event: string,
    listener: ChannelEventListener,
    arg?: unknown
  ): () => void {
    const id = this.nextRequestId();
    this.handlers.set(id, (type, data) => {
      if (type !== channelResponseType.eventFire) return;
      try {
        listener(data);
      } catch (error) {
        this.onLog?.(`[ipc] event listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    void this.readyPromise.then(() => {
      if (this.disposed || !this.handlers.has(id)) return;
      this.onLog?.(`[ipc] listen ${channel}.${event} id=${id}`);
      this.sendRequest(channelRequestType.eventListen, id, channel, event, arg);
    });
    return () => {
      if (!this.handlers.delete(id) || this.disposed) return;
      this.sendRequest(channelRequestType.eventDispose, id, channel, event, undefined);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const pending = [...this.handlers.values()];
    this.handlers.clear();
    // Reported as a channel error so in-flight callers reject instead of waiting for their timeout.
    for (const handler of pending) {
      handler(channelResponseType.promiseError, { message: "Remote channel client is disposed." });
    }
  }

  private nextRequestId(): number {
    const id = this.lastRequestId;
    this.lastRequestId += 1;
    return id;
  }

  private async awaitReady(signal: AbortSignal | undefined): Promise<void> {
    if (this.ready) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        reject(timeoutError("Remote channel handshake timed out (no Initialize frame from the desktop)."));
      }, this.readyTimeoutMs);
      timer.unref?.();
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      void this.readyPromise.then(() => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }

  private sendRequest(
    requestType: number,
    id: number,
    channel: string,
    name: string,
    arg: unknown
  ): void {
    const writer = new ValueWriter();
    encodeValue(writer, [requestType, id, channel, name]);
    encodeValue(writer, arg);
    this.sendBody(writer.toBytes());
  }
}

/** Channel names the desktop exposes over a workspace bridge. */
export const remoteChannels = {
  bots: "bots",
  broadcast: "broadcast",
  codingPlanSubscription: "coding-plan-subscription",
  commands: "commands",
  credential: "credential",
  feedback: "feedback",
  file: "file",
  fileWatcher: "file-watcher",
  git: "git",
  gitCheckpoint: "git-checkpoint",
  hooks: "hooks",
  mcpSync: "mcp-sync",
  memory: "memory",
  modelProvider: "model-provider",
  oauth: "oauth",
  offPeakTask: "off-peak-task",
  outputStyle: "output-style",
  pluginManagement: "plugin-management",
  plugins: "plugins",
  pluginSync: "plugin-sync",
  promptAttachmentTransfer: "prompt-attachment-transfer",
  repoWiki: "repo-wiki",
  setting: "setting",
  settingsSync: "settings-sync",
  skills: "skills",
  skillSync: "skill-sync",
  subagents: "subagents",
  system: "system",
  terminal: "terminal",
  usageStats: "usage-stats",
  zcodeAgent: "zcode-agent",
  zcodeSession: "zcode-session",
  zcodeTask: "zcode-task"
} as const;
