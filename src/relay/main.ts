import { resolve as resolvePath } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { normalizeControllerOrigin, RelayServer, type RelayServerOptions } from "./server.ts";

const minimumPort = 0;
const maximumPort = 65_535;
const secondsPerDay = 24 * 60 * 60;

const relayUsage = `Usage:
  zcode-relay [--host <address>] [--port <port>] [--state <file>] [--json]
              [--page-path <path>] [--max-connections <n>] [--max-message-bytes <n>]
              [--auth-timeout-seconds <n>] [--idle-timeout-seconds <n>]
              [--registration-ttl-days <n>] [--max-registrations <n>]
              [--controller-origin <url>]

A private, single-instance relay for zcode remote control. It binds a loopback port by default
and is meant to be published through a Cloudflare Tunnel (or any TLS-terminating reverse proxy).

Environment defaults: ZCODE_RELAY_HOST, ZCODE_RELAY_PORT, ZCODE_RELAY_STATE,
ZCODE_RELAY_CONTROLLER_ORIGIN. Flags win over environment variables.

Endpoints:
  /ws        relay WebSocket (hosts and controllers)
  /healthz   JSON health snapshot
  /remote/v4 pairing info page (configurable with --page-path)

With --controller-origin <url> (for example https://zcode.z.ai) the relay mirrors the official
web controller at every other path instead of serving the info page, rewriting its origins so
the page drives this relay. Only that one origin is ever fetched.`;

export interface RunRelayServerOptions {
  env?: NodeJS.ProcessEnv;
  /** Invoked once the server is listening; tests use it to reach the bound port. */
  onStarted?: (server: RelayServer) => void;
  signal?: AbortSignal;
  stderr?: Writable;
  stdout?: Writable;
}

interface ParsedRelayCommand {
  help: boolean;
  json: boolean;
  options: RelayServerOptions;
}

function integerOption(raw: string | undefined, name: string, minimum: number, maximum: number): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d{1,10}$/u.test(raw.trim())) throw new Error(`${name} expects a whole number.`);
  const value = Number(raw.trim());
  if (value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function parseRelayCommand(args: string[], env: NodeJS.ProcessEnv = process.env): ParsedRelayCommand {
  const parsed = parseArgs({
    allowPositionals: false,
    args,
    options: {
      "auth-timeout-seconds": { type: "string" },
      "controller-origin": { type: "string" },
      help: { short: "h", type: "boolean" },
      host: { type: "string" },
      "idle-timeout-seconds": { type: "string" },
      json: { type: "boolean" },
      "max-connections": { type: "string" },
      "max-message-bytes": { type: "string" },
      "max-registrations": { type: "string" },
      "page-path": { type: "string" },
      port: { type: "string" },
      "registration-ttl-days": { type: "string" },
      state: { type: "string" }
    },
    strict: true
  });

  const host = text(parsed.values.host) ?? text(env["ZCODE_RELAY_HOST"]);
  const port = integerOption(
    text(parsed.values.port) ?? text(env["ZCODE_RELAY_PORT"]),
    "--port",
    minimumPort,
    maximumPort
  );
  const statePath = text(parsed.values.state) ?? text(env["ZCODE_RELAY_STATE"]);
  const pagePath = text(parsed.values["page-path"]);
  if (pagePath !== undefined && !pagePath.startsWith("/")) {
    throw new Error("--page-path must start with '/'.");
  }
  const authTimeoutSeconds = integerOption(text(parsed.values["auth-timeout-seconds"]), "--auth-timeout-seconds", 1, 600);
  const idleTimeoutSeconds = integerOption(text(parsed.values["idle-timeout-seconds"]), "--idle-timeout-seconds", 5, 3600);
  const registrationTtlDays = integerOption(text(parsed.values["registration-ttl-days"]), "--registration-ttl-days", 1, 3650);
  const maximumConnections = integerOption(text(parsed.values["max-connections"]), "--max-connections", 1, 65_536);
  const maximumMessageBytes = integerOption(
    text(parsed.values["max-message-bytes"]),
    "--max-message-bytes",
    1024,
    64 * 1024 * 1024
  );
  const maximumRegistrations = integerOption(text(parsed.values["max-registrations"]), "--max-registrations", 1, 1_000_000);
  const controllerOrigin = normalizeControllerOrigin(
    text(parsed.values["controller-origin"]) ?? text(env["ZCODE_RELAY_CONTROLLER_ORIGIN"])
  );

  return {
    help: parsed.values.help === true,
    json: parsed.values.json === true,
    options: {
      ...(authTimeoutSeconds !== undefined ? { authTimeoutMs: authTimeoutSeconds * 1000 } : {}),
      ...(controllerOrigin !== undefined ? { controllerOrigin } : {}),
      ...(host !== undefined ? { host } : {}),
      ...(idleTimeoutSeconds !== undefined ? { idleTimeoutMs: idleTimeoutSeconds * 1000 } : {}),
      ...(maximumConnections !== undefined ? { maximumConnections } : {}),
      ...(maximumMessageBytes !== undefined ? { maximumMessageBytes } : {}),
      ...(maximumRegistrations !== undefined ? { maximumRegistrations } : {}),
      ...(pagePath !== undefined ? { pagePath } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(registrationTtlDays !== undefined
        ? { registrationTtlMs: registrationTtlDays * secondsPerDay * 1000 }
        : {}),
      ...(statePath !== undefined ? { statePath: resolvePath(statePath) } : {})
    }
  };
}

/**
 * Starts the relay and runs until the abort signal (or SIGINT/SIGTERM when none is given).
 * Returns a process exit code. Log lines never contain frames, URLs or credentials.
 */
export async function runRelayServer(args: string[], io: RunRelayServerOptions = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  let command: ParsedRelayCommand;
  try {
    command = parseRelayCommand(args, io.env ?? process.env);
  } catch (error) {
    stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n${relayUsage}\n`);
    return 1;
  }
  if (command.help) {
    stdout.write(`${relayUsage}\n`);
    return 0;
  }

  const emit = (event: Record<string, unknown>, human: string): void => {
    if (command.json) stdout.write(`${JSON.stringify(event)}\n`);
    else stdout.write(`${human}\n`);
  };

  let server: RelayServer;
  try {
    server = await RelayServer.start({
      ...command.options,
      onLog: (line) => emit({ event: "log", line }, line)
    });
  } catch (error) {
    stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const host = command.options.host ?? "127.0.0.1";
  emit(
    {
      event: "listening",
      controllerOrigin: command.options.controllerOrigin ?? null,
      host,
      port: server.port,
      state: command.options.statePath ?? null
    },
    `zcode-relay listening on http://${host}:${server.port} `
    + `(ws: /ws, health: /healthz${command.options.statePath !== undefined
      ? `, state: ${command.options.statePath}`
      : ", state: in-memory"}${command.options.controllerOrigin !== undefined
      ? `, controller: ${command.options.controllerOrigin}`
      : ""})`
  );
  io.onStarted?.(server);

  return await new Promise<number>((resolveExit) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      io.signal?.removeEventListener("abort", onAbort);
      void server.close().finally(() => {
        emit({ event: "stopped" }, "zcode-relay stopped.");
        resolveExit(code);
      });
    };
    const onAbort = (): void => finish(0);
    const onSignal = (): void => finish(0);
    if (io.signal !== undefined) {
      io.signal.addEventListener("abort", onAbort, { once: true });
      if (io.signal.aborted) onAbort();
      return;
    }
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

const invokedDirectly = process.argv[1] !== undefined
  && resolvePath(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exitCode = await runRelayServer(process.argv.slice(2));
}
