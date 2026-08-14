import { describe, expect, test } from "bun:test";
import { connect } from "node:net";

import { parseRelayCommand } from "../src/relay/main.ts";
import {
  controllerTarget,
  normalizeControllerOrigin,
  rewriteControllerBody,
  RelayServer,
  type RelayServerOptions
} from "../src/relay/server.ts";

const controllerOrigin = "https://controller.invalid";

interface FetchCall {
  headers: Record<string, string>;
  url: string;
}

interface ProxyHarness {
  calls: FetchCall[];
  close: () => Promise<void>;
  logs: string[];
  origin: string;
  relay: RelayServer;
}

/** Starts a relay whose controller upstream is a stub, so no test ever reaches the network. */
async function startProxyRelay(
  respond: (url: URL) => Response,
  options: RelayServerOptions = {}
): Promise<ProxyHarness> {
  const calls: FetchCall[] = [];
  const logs: string[] = [];
  const relay = await RelayServer.start({
    controllerFetch: (url, init) => {
      calls.push({ headers: { ...(init.headers as Record<string, string>) }, url: url.toString() });
      return Promise.resolve(respond(url));
    },
    controllerOrigin,
    host: "127.0.0.1",
    onLog: (line) => logs.push(line),
    port: 0,
    ...options
  });
  return {
    calls,
    close: () => relay.close(),
    logs,
    origin: `http://127.0.0.1:${relay.port}`,
    relay
  };
}

/**
 * Sends a literal request target. `fetch` normalises paths like `//host/x` before they reach the
 * wire, which is exactly the shape the origin guard has to reject.
 */
async function rawGet(relay: RelayServer, target: string): Promise<string> {
  const socket = connect({ host: "127.0.0.1", port: relay.port });
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", () => resolve());
  });
  socket.write(`GET ${target} HTTP/1.1\r\nhost: 127.0.0.1:${relay.port}\r\nconnection: close\r\n\r\n`);
  await new Promise<void>((resolve, reject) => {
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("close", () => resolve());
  });
  return Buffer.concat(chunks).toString("utf8");
}

describe("relay controller mirroring", () => {
  test("serves the static pairing page when no controller origin is configured", async () => {
    const relay = await RelayServer.start({ host: "127.0.0.1", port: 0 });
    try {
      const response = await fetch(`http://127.0.0.1:${relay.port}/remote/v4`);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toContain("remote control is not hosted here.");
    } finally {
      await relay.close();
    }
  });

  test("re-serves the controller and points its origins back at the relay", async () => {
    const harness = await startProxyRelay(() =>
      new Response(
        `<script>const relay = "wss://controller.invalid/ws"; const api = "${controllerOrigin}/api";</script>`,
        { headers: { "content-type": "text/html; charset=utf-8" } }
      )
    );
    try {
      const response = await fetch(`${harness.origin}/remote/v4?sid=abc`);
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(harness.calls[0]?.url).toBe(`${controllerOrigin}/remote/v4?sid=abc`);
      expect(body).toContain(`ws://127.0.0.1:${harness.relay.port}/ws`);
      expect(body).toContain(`http://127.0.0.1:${harness.relay.port}/api`);
      expect(body).not.toContain("controller.invalid");
      expect(response.headers.get("cache-control")).toBe("no-store");
    } finally {
      await harness.close();
    }
  });

  test("emits https and wss origins when a tunnel forwards the request", async () => {
    const harness = await startProxyRelay(() =>
      new Response(`connect("wss://controller.invalid/ws")`, {
        headers: { "content-type": "application/javascript" }
      })
    );
    try {
      const response = await fetch(`${harness.origin}/app.js`, {
        headers: { "x-forwarded-host": "relay.example.com", "x-forwarded-proto": "https" }
      });
      expect(await response.text()).toBe(`connect("wss://relay.example.com/ws")`);
    } finally {
      await harness.close();
    }
  });

  test("falls back to the Cloudflare visitor scheme when x-forwarded-proto is absent", async () => {
    const harness = await startProxyRelay(() =>
      new Response(`connect("wss://controller.invalid/ws")`, {
        headers: { "content-type": "application/javascript" }
      })
    );
    try {
      const response = await fetch(`${harness.origin}/app.js`, {
        headers: { "cf-visitor": '{"scheme":"https"}', "x-forwarded-host": "relay.example.com" }
      });
      expect(await response.text()).toBe(`connect("wss://relay.example.com/ws")`);
    } finally {
      await harness.close();
    }
  });

  test("refuses a protocol-relative path instead of fetching a foreign origin", async () => {
    const harness = await startProxyRelay(() => new Response("secret", { headers: { "content-type": "text/plain" } }));
    try {
      const response = await rawGet(harness.relay, "//example.invalid/x");
      expect(response).toStartWith("HTTP/1.1 404 Not Found");
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  test("keeps the relay's own endpoints off the controller", async () => {
    const harness = await startProxyRelay(() => new Response("nope", { headers: { "content-type": "text/plain" } }));
    try {
      const health = await fetch(`${harness.origin}/healthz`);
      expect(health.status).toBe(200);
      expect(((await health.json()) as { ok: boolean }).ok).toBe(true);
      expect(harness.calls).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  test("drops the upstream content policy that would block the rewritten origins", async () => {
    const harness = await startProxyRelay(() =>
      new Response("<html></html>", {
        headers: {
          "content-security-policy": "connect-src https://controller.invalid",
          "content-type": "text/html"
        }
      })
    );
    try {
      const response = await fetch(`${harness.origin}/`);
      expect(response.headers.get("content-security-policy")).toBeNull();
    } finally {
      await harness.close();
    }
  });

  test("passes binary assets through untouched", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
    const harness = await startProxyRelay(() => new Response(bytes, { headers: { "content-type": "image/png" } }));
    try {
      const response = await fetch(`${harness.origin}/logo.png`);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    } finally {
      await harness.close();
    }
  });

  test("forwards only the allowlisted request headers", async () => {
    const harness = await startProxyRelay(() => new Response("ok", { headers: { "content-type": "text/plain" } }));
    try {
      await fetch(`${harness.origin}/`, {
        headers: { "accept-language": "en-GB", cookie: "session=secret", "user-agent": "probe/1" }
      });
      const forwarded = harness.calls[0]?.headers ?? {};
      expect(forwarded["accept-language"]).toBe("en-GB");
      expect(forwarded["user-agent"]).toBe("probe/1");
      expect(forwarded["cookie"]).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  test("answers 502 without logging anything derived from the request", async () => {
    const harness = await startProxyRelay(() => {
      throw new Error(`upstream ${controllerOrigin}/remote/v4?sid=CREDENTIAL failed`);
    });
    try {
      const response = await fetch(`${harness.origin}/remote/v4?sid=CREDENTIAL`);
      expect(response.status).toBe(502);
      expect(harness.logs.join("\n")).not.toContain("CREDENTIAL");
      expect(harness.logs.join("\n")).not.toContain("controller.invalid");
    } finally {
      await harness.close();
    }
  });

  test("rejects a controller response past the size cap", async () => {
    const harness = await startProxyRelay(
      () => new Response("x".repeat(4096), { headers: { "content-type": "text/plain" } }),
      { maximumControllerBodyBytes: 512 }
    );
    try {
      const response = await fetch(`${harness.origin}/big.txt`);
      expect(response.status).toBe(502);
    } finally {
      await harness.close();
    }
  });
});

describe("controller origin handling", () => {
  test("reduces a configured origin to scheme and host", () => {
    expect(normalizeControllerOrigin("https://zcode.z.ai/remote/v4?x=1")).toBe("https://zcode.z.ai");
    expect(normalizeControllerOrigin(undefined)).toBeUndefined();
  });

  test("rejects origins that are not absolute http(s) URLs", () => {
    expect(() => normalizeControllerOrigin("zcode.z.ai")).toThrow("absolute http(s) URL");
    expect(() => normalizeControllerOrigin("file:///etc/passwd")).toThrow("http or https");
  });

  test("resolves only same-origin targets", () => {
    expect(controllerTarget("/a/b?c=1", controllerOrigin)?.toString()).toBe(`${controllerOrigin}/a/b?c=1`);
    expect(controllerTarget("//example.invalid/x", controllerOrigin)).toBeUndefined();
    expect(controllerTarget("https://example.invalid/x", controllerOrigin)).toBeUndefined();
    expect(controllerTarget("relative", controllerOrigin)).toBeUndefined();
  });

  test("rewrites both absolute origins and bare hostnames", () => {
    const rewritten = rewriteControllerBody(
      'a="https://controller.invalid/x" b="wss://controller.invalid/ws" c="controller.invalid"',
      "https://relay.example.com",
      controllerOrigin
    );
    expect(rewritten).toBe(
      'a="https://relay.example.com/x" b="wss://relay.example.com/ws" c="relay.example.com"'
    );
  });

  test("accepts the origin from the CLI flag and the environment", () => {
    expect(parseRelayCommand(["--controller-origin", "https://zcode.z.ai/"], {}).options.controllerOrigin)
      .toBe("https://zcode.z.ai");
    expect(parseRelayCommand([], { ZCODE_RELAY_CONTROLLER_ORIGIN: "https://zcode.z.ai" }).options.controllerOrigin)
      .toBe("https://zcode.z.ai");
    expect(parseRelayCommand([], {}).options.controllerOrigin).toBeUndefined();
  });
});
