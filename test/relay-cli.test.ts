import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { parseRelayCommand, runRelayServer } from "../src/relay/main.ts";
import type { RelayServer } from "../src/relay/server.ts";

function capture(): { stream: Writable; text: () => string } {
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

describe("relay command parsing", () => {
  test("parses defaults with no arguments", () => {
    const command = parseRelayCommand([], {});
    expect(command.help).toBe(false);
    expect(command.json).toBe(false);
    expect(command.options).toEqual({});
  });

  test("parses flags into server options", () => {
    const command = parseRelayCommand([
      "--host", "0.0.0.0",
      "--port", "9000",
      "--state", "relay-state.json",
      "--page-path", "/pair",
      "--max-connections", "32",
      "--max-message-bytes", "65536",
      "--max-registrations", "10",
      "--auth-timeout-seconds", "5",
      "--idle-timeout-seconds", "45",
      "--registration-ttl-days", "7",
      "--json"
    ], {});
    expect(command.json).toBe(true);
    expect(command.options.host).toBe("0.0.0.0");
    expect(command.options.port).toBe(9000);
    expect(command.options.statePath).toContain("relay-state.json");
    expect(command.options.pagePath).toBe("/pair");
    expect(command.options.maximumConnections).toBe(32);
    expect(command.options.maximumMessageBytes).toBe(65_536);
    expect(command.options.maximumRegistrations).toBe(10);
    expect(command.options.authTimeoutMs).toBe(5000);
    expect(command.options.idleTimeoutMs).toBe(45_000);
    expect(command.options.registrationTtlMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("falls back to environment variables and lets flags win", () => {
    const env = { ZCODE_RELAY_HOST: "10.0.0.1", ZCODE_RELAY_PORT: "9100", ZCODE_RELAY_STATE: "env-state.json" };
    const fromEnv = parseRelayCommand([], env);
    expect(fromEnv.options.host).toBe("10.0.0.1");
    expect(fromEnv.options.port).toBe(9100);
    expect(fromEnv.options.statePath).toContain("env-state.json");

    const flagged = parseRelayCommand(["--port", "9200"], env);
    expect(flagged.options.port).toBe(9200);
  });

  test("rejects invalid values", () => {
    expect(() => parseRelayCommand(["--port", "notaport"], {})).toThrow("--port");
    expect(() => parseRelayCommand(["--port", "70000"], {})).toThrow("--port");
    expect(() => parseRelayCommand(["--page-path", "pair"], {})).toThrow("--page-path");
    expect(() => parseRelayCommand(["--auth-timeout-seconds", "0"], {})).toThrow("--auth-timeout-seconds");
    expect(() => parseRelayCommand(["--unknown"], {})).toThrow();
  });
});

describe("relay command execution", () => {
  test("prints usage for --help", async () => {
    const stdout = capture();
    const stderr = capture();
    const code = await runRelayServer(["--help"], { env: {}, stderr: stderr.stream, stdout: stdout.stream });
    expect(code).toBe(0);
    expect(stdout.text()).toContain("Usage:");
    expect(stdout.text()).toContain("Cloudflare Tunnel");
  });

  test("reports invalid arguments with usage on stderr", async () => {
    const stdout = capture();
    const stderr = capture();
    const code = await runRelayServer(["--port", "bad"], { env: {}, stderr: stderr.stream, stdout: stdout.stream });
    expect(code).toBe(1);
    expect(stderr.text()).toContain("--port");
    expect(stderr.text()).toContain("Usage:");
  });

  test("starts, serves health, persists state, and stops on abort", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-relay-cli-"));
    const statePath = join(directory, "state.json");
    const stdout = capture();
    const stderr = capture();
    const abort = new AbortController();
    let started: RelayServer | undefined;
    const done = runRelayServer(["--port", "0", "--state", statePath, "--json"], {
      env: {},
      onStarted: (server) => {
        started = server;
      },
      signal: abort.signal,
      stderr: stderr.stream,
      stdout: stdout.stream
    });

    const deadline = Date.now() + 5000;
    while (started === undefined && Date.now() < deadline) await Bun.sleep(10);
    expect(started).toBeDefined();

    const health = await fetch(`http://127.0.0.1:${started!.port}/healthz`);
    expect(health.status).toBe(200);

    abort.abort();
    expect(await done).toBe(0);

    const lines = stdout.text().trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.some((line) => line["event"] === "listening")).toBe(true);
    expect(lines.some((line) => line["event"] === "stopped")).toBe(true);
    expect(stderr.text()).toBe("");
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ version: 1 });
  }, 15_000);
});

describe("relay packaging boundaries", () => {
  test("the relay ships as repo tooling, not in the npm package", async () => {
    const packageJson = await Bun.file(new URL("../package.json", import.meta.url)).json() as {
      bin: Record<string, string>;
      files: string[];
      scripts: Record<string, string>;
    };
    // The published npm surface must stay exactly as reviewed; the relay is deployed from the
    // repository (bun src/relay/main.ts or the build:relay bundle), never from the package.
    expect(packageJson.bin).toEqual({ zcode: "bin/zcode.js" });
    expect(packageJson.files.some((entry) => entry.includes("relay"))).toBe(false);
    expect(packageJson.scripts["relay"]).toBe("bun src/relay/main.ts");
    expect(packageJson.scripts["build:relay"]).toBe("tsdown --filter relay");
  });
});
