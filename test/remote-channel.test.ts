import { describe, expect, test } from "bun:test";

import {
  channelRequestType,
  channelResponseType,
  ChannelClient,
  ChannelRpcError
} from "../src/remote/channel-client.ts";
import { decodeValue, encodeValue, ValueReader, ValueWriter } from "../src/remote/ipc-codec.ts";

interface DecodedRequest {
  arg: unknown;
  channel: string;
  id: number;
  name: string;
  type: number;
}

function frame(type: number, id: number, data?: unknown): Uint8Array {
  const writer = new ValueWriter();
  encodeValue(writer, [type, id]);
  if (data !== undefined) encodeValue(writer, data);
  return writer.toBytes();
}

function decodeRequest(body: Uint8Array): DecodedRequest {
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

function harness(options: { callTimeoutMs?: number; readyTimeoutMs?: number } = {}): {
  client: ChannelClient;
  requests: DecodedRequest[];
} {
  const requests: DecodedRequest[] = [];
  const client = new ChannelClient({
    ...(options.callTimeoutMs !== undefined ? { callTimeoutMs: options.callTimeoutMs } : {}),
    ...(options.readyTimeoutMs !== undefined ? { readyTimeoutMs: options.readyTimeoutMs } : {}),
    sendBody: (body) => requests.push(decodeRequest(body))
  });
  return { client, requests };
}

describe("channel handshake", () => {
  test("becomes ready on the desktop's Initialize frame", async () => {
    const { client } = harness();
    expect(client.initialized).toBe(false);
    client.handleMessage(frame(channelResponseType.initialize, 0));
    expect(client.initialized).toBe(true);
    await client.whenReady();
    client.dispose();
  });

  test("holds a call until the handshake completes, then sends it", async () => {
    const { client, requests } = harness();
    const pending = client.call("zcode-task", "listTasks", []);
    await Bun.sleep(1);
    expect(requests).toHaveLength(0);

    client.handleMessage(frame(channelResponseType.initialize, 0));
    await Bun.sleep(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      arg: [],
      channel: "zcode-task",
      id: 0,
      name: "listTasks",
      type: channelRequestType.promise
    });

    client.handleMessage(frame(channelResponseType.promiseSuccess, 0, { tasks: [] }));
    expect(await pending).toEqual({ tasks: [] });
    client.dispose();
  });

  test("fails a call when the desktop never sends Initialize", async () => {
    const { client, requests } = harness({ readyTimeoutMs: 5 });
    await expect(client.call("system", "ping")).rejects.toThrow(/handshake timed out/u);
    expect(requests).toHaveLength(0);
    client.dispose();
  });
});

describe("channel call correlation", () => {
  test("carries the params object as the single RPC argument", async () => {
    const { client, requests } = harness();
    client.handleMessage(frame(channelResponseType.initialize, 0));
    const pending = client.call("plugins", "overview", [{ workspace: "ws" }]);
    await Bun.sleep(1);
    expect(requests[0]!.arg).toEqual([{ workspace: "ws" }]);
    client.handleMessage(frame(channelResponseType.promiseSuccess, requests[0]!.id, { ok: true }));
    expect(await pending).toEqual({ ok: true });
    client.dispose();
  });

  test("routes out-of-order responses to the right caller", async () => {
    const { client, requests } = harness();
    client.handleMessage(frame(channelResponseType.initialize, 0));
    const first = client.call("system", "one");
    const second = client.call("system", "two");
    const third = client.call("system", "three");
    await Bun.sleep(1);
    expect(requests.map((request) => request.name)).toEqual(["one", "two", "three"]);
    expect(new Set(requests.map((request) => request.id)).size).toBe(3);
    expect(client.pendingCallCount).toBe(3);

    client.handleMessage(frame(channelResponseType.promiseSuccess, requests[2]!.id, "third-result"));
    client.handleMessage(frame(channelResponseType.promiseSuccess, requests[0]!.id, "first-result"));
    client.handleMessage(frame(channelResponseType.promiseSuccess, requests[1]!.id, "second-result"));
    expect(await Promise.all([first, second, third])).toEqual(["first-result", "second-result", "third-result"]);
    expect(client.pendingCallCount).toBe(0);
    client.dispose();
  });

  test("ignores a response for an unknown request id", async () => {
    const { client } = harness();
    client.handleMessage(frame(channelResponseType.initialize, 0));
    client.handleMessage(frame(channelResponseType.promiseSuccess, 999, "stray"));
    const pending = client.call("system", "ping");
    await Bun.sleep(1);
    client.handleMessage(frame(channelResponseType.promiseSuccess, 0, "answer"));
    expect(await pending).toBe("answer");
    client.dispose();
  });

  test("ignores undecodable frames instead of throwing", () => {
    const { client } = harness();
    client.handleMessage(new Uint8Array([99]));
    client.handleMessage(new Uint8Array(0));
    client.handleMessage(frame(channelResponseType.initialize, 0));
    // A header without the trailing data value must not crash the reader.
    const writer = new ValueWriter();
    encodeValue(writer, [channelResponseType.promiseSuccess, 0]);
    client.handleMessage(writer.toBytes());
    expect(client.initialized).toBe(true);
    client.dispose();
  });
});

describe("channel call failures", () => {
  test("surfaces a structured error as ChannelRpcError", async () => {
    const { client, requests } = harness();
    client.handleMessage(frame(channelResponseType.initialize, 0));
    const pending = client.call("plugins", "install").catch((error: unknown) => error);
    await Bun.sleep(1);
    client.handleMessage(frame(
      channelResponseType.promiseError,
      requests[0]!.id,
      { message: "marketplace unavailable", name: "Error" }
    ));
    const failure = await pending;
    expect(failure).toBeInstanceOf(ChannelRpcError);
    expect((failure as ChannelRpcError).message).toBe("marketplace unavailable");
    expect((failure as ChannelRpcError).data).toEqual({ message: "marketplace unavailable", name: "Error" });
    client.dispose();
  });

  test("surfaces a plain error object with a fallback message", async () => {
    const { client, requests } = harness();
    client.handleMessage(frame(channelResponseType.initialize, 0));
    const withText = client.call("plugins", "one").catch((error: unknown) => error);
    const withoutText = client.call("plugins", "two").catch((error: unknown) => error);
    await Bun.sleep(1);
    client.handleMessage(frame(channelResponseType.promiseErrorObject, requests[0]!.id, "boom"));
    client.handleMessage(frame(channelResponseType.promiseErrorObject, requests[1]!.id, { code: 5 }));
    expect((await withText as Error).message).toBe("boom");
    expect((await withoutText as Error).message).toBe("remote channel call failed");
    client.dispose();
  });

  test("times out a call whose response never arrives", async () => {
    const { client } = harness({ callTimeoutMs: 5 });
    client.handleMessage(frame(channelResponseType.initialize, 0));
    await expect(client.call("system", "slow")).rejects.toThrow(/timed out after 5ms/u);
    expect(client.pendingCallCount).toBe(0);
    client.dispose();
  });

  test("respects a per-call timeout override", async () => {
    const { client } = harness({ callTimeoutMs: 60_000 });
    client.handleMessage(frame(channelResponseType.initialize, 0));
    await expect(client.call("system", "slow", [], { timeoutMs: 5 })).rejects.toThrow(/timed out after 5ms/u);
    client.dispose();
  });

  test("cancels an in-flight call on abort and tells the desktop", async () => {
    const { client, requests } = harness();
    client.handleMessage(frame(channelResponseType.initialize, 0));
    const controller = new AbortController();
    const pending = client.call("system", "slow", [], { signal: controller.signal });
    await Bun.sleep(1);
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/u);
    expect(requests.map((request) => request.type)).toEqual([
      channelRequestType.promise,
      channelRequestType.promiseCancel
    ]);
    expect(client.pendingCallCount).toBe(0);
    client.dispose();
  });

  test("refuses a call whose signal is already aborted", async () => {
    const { client, requests } = harness();
    client.handleMessage(frame(channelResponseType.initialize, 0));
    await expect(client.call("system", "ping", [], { signal: AbortSignal.abort() }))
      .rejects.toThrow(/cancelled/u);
    expect(requests).toHaveLength(0);
    client.dispose();
  });

  test("rejects pending calls on dispose and refuses new ones", async () => {
    const { client } = harness({ callTimeoutMs: 60_000 });
    client.handleMessage(frame(channelResponseType.initialize, 0));
    const pending = client.call("system", "slow");
    await Bun.sleep(1);
    client.dispose();
    await expect(pending).rejects.toThrow(/disposed/u);
    await expect(client.call("system", "ping")).rejects.toThrow(/disposed/u);
  });
});

describe("channel event subscription", () => {
  test("subscribes after the handshake and delivers events", async () => {
    const { client, requests } = harness();
    const events: unknown[] = [];
    const unsubscribe = client.addEventListener(
      "zcode-agent",
      "onDynamicConversationFrame",
      (event) => events.push(event),
      { scope: "ws" }
    );
    await Bun.sleep(1);
    expect(requests).toHaveLength(0);

    client.handleMessage(frame(channelResponseType.initialize, 0));
    await Bun.sleep(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      arg: { scope: "ws" },
      channel: "zcode-agent",
      id: 0,
      name: "onDynamicConversationFrame",
      type: channelRequestType.eventListen
    });

    client.handleMessage(frame(channelResponseType.eventFire, 0, { frame: "hello" }));
    client.handleMessage(frame(channelResponseType.eventFire, 0, { frame: "again" }));
    expect(events).toEqual([{ frame: "hello" }, { frame: "again" }]);

    unsubscribe();
    expect(requests[1]).toEqual({
      arg: undefined,
      channel: "zcode-agent",
      id: 0,
      name: "onDynamicConversationFrame",
      type: channelRequestType.eventDispose
    });
    client.handleMessage(frame(channelResponseType.eventFire, 0, { frame: "ignored" }));
    expect(events).toHaveLength(2);
    client.dispose();
  });

  test("keeps calls and subscriptions in one request-id space", async () => {
    const { client, requests } = harness();
    client.handleMessage(frame(channelResponseType.initialize, 0));
    // A subscription claims its id immediately; a call claims one only after the handshake await.
    client.addEventListener("system", "onChange", () => {});
    const pending = client.call("system", "ping");
    await Bun.sleep(1);
    const listen = requests.find((request) => request.type === channelRequestType.eventListen)!;
    const promise = requests.find((request) => request.type === channelRequestType.promise)!;
    expect(listen.id).toBe(0);
    expect(promise.id).toBe(1);
    client.handleMessage(frame(channelResponseType.promiseSuccess, promise.id, "pong"));
    expect(await pending).toBe("pong");
    client.dispose();
  });

  test("does not resubscribe an event that was disposed before the handshake", async () => {
    const { client, requests } = harness();
    const unsubscribe = client.addEventListener("system", "onChange", () => {});
    unsubscribe();
    client.handleMessage(frame(channelResponseType.initialize, 0));
    await Bun.sleep(1);
    expect(requests.filter((request) => request.type === channelRequestType.eventListen)).toHaveLength(0);
    client.dispose();
  });

  test("survives a throwing event listener", () => {
    const { client } = harness();
    client.handleMessage(frame(channelResponseType.initialize, 0));
    client.addEventListener("system", "onChange", () => {
      throw new Error("listener failure");
    });
    expect(() => client.handleMessage(frame(channelResponseType.eventFire, 0, {}))).not.toThrow();
    client.dispose();
  });
});
