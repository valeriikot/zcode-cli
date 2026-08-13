import { createHash } from "node:crypto";
import { chmod, open, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";

import { probeRemoteDevice, type RemoteConnectionSnapshot } from "./remote/client.ts";
import type { RemoteConnectionParams } from "./remote/connection-params.ts";
import {
  addRemoteDevice,
  findRemoteDevice,
  readRemoteDevices,
  recordRemoteDeviceState,
  remoteDeviceParams,
  remoteDeviceStorePath,
  remoteDeviceSummary,
  removeRemoteDevice,
  type RemoteDeviceRecord
} from "./remote/device-store.ts";
import {
  createRemoteHostLink,
  readRemoteHostLink,
  remoteHostLinkParams,
  remoteHostLinkStorePath,
  registerRemoteHostLink,
  remoteHostLinkSummary,
  remoteHostLinkUrl,
  removeRemoteHostLink,
  writeRemoteHostLink,
  type RegisterRemoteHostLinkOptions,
  type RemoteHostLinkRecord
} from "./remote/host-link.ts";
import {
  RemoteHostService,
  type RemoteHostBackend,
  type RemoteHostServiceOptions,
  type RemoteHostWorkspace
} from "./remote/host.ts";
import type { RelayFailure, RelayState } from "./remote/relay-client.ts";
import { startPrivateRelayServer } from "./remote/relay-server.ts";

const managedActions = new Set(["add", "connect", "help", "link", "list", "relay", "remove", "serve"]);
const linkActions = new Set(["create", "revoke", "show"]);
const minimumTimeoutSeconds = 5;
const maximumTimeoutSeconds = 600;
const defaultTimeoutSeconds = 60;
const workspaceKeyCharacters = 12;

const remoteUsage = `Usage:
  zcode remote add <url> [--name <name>] [--json]
  zcode remote add --url-file <file> [--name <name>] [--json]
  zcode remote list [--json]
  zcode remote remove <name|id> [--yes] [--json]
  zcode remote connect [<name|id>] [--workspace <key>] [--timeout <seconds>] [--json]
  zcode remote link [show] [--reveal] [--json]
  zcode remote link create [--name <name>] [--relay <url>] [--url-file <file>] [--json]
  zcode remote link revoke [--yes] [--json]
  zcode remote serve [--workspace <path>] [--json]
  zcode remote relay serve [--host <host>] [--port <port>] [--json]

A remote-control URL contains device credentials. Prefer --url-file so the credential never
enters the shell history or the process argument list. \`link\` manages this machine's own
pairing URL; \`serve\` makes this machine controllable through it, e.g. from the web remote
control.

\`link create\` mints URLs for the public relay (https://zcode.z.ai/remote/v4) by default.
Point it at a private relay with --relay <url> or the ZCODE_RELAY_URL environment variable
(--relay wins); see docs/REMOTE-RELAY.md for running one behind a Cloudflare Tunnel.`;

interface ParsedRemoteCommand {
  action: string;
  host?: string;
  help: boolean;
  json: boolean;
  name?: string;
  positionals: string[];
  port?: number;
  relay?: string;
  reveal: boolean;
  timeoutSeconds?: number;
  urlFile?: string;
  workspace?: string;
  yes: boolean;
}

export interface RemoteAppServerRequestInput {
  method: string;
  params: Record<string, unknown>;
  signal?: AbortSignal;
  workingDirectory: string;
}

/** The slice of {@link RemoteHostService} the serve command drives; tests substitute a fake. */
export interface RemoteHostServiceLike {
  dispose(): void;
  onFailure(listener: (failure: RelayFailure) => void): () => void;
  onState(listener: (state: RelayState) => void): () => void;
  start(): void;
}

export interface RunRemoteCommandOptions {
  /** Local app-server access for `serve`; wired to the extracted runtime by the launcher. */
  appServerRequest?: (input: RemoteAppServerRequestInput) => Promise<unknown>;
  /** Reported in generated pairing URLs and to connecting controllers. */
  appVersion?: string;
  confirm?: (question: string) => Promise<boolean>;
  /** Overridden by tests so no unit test opens a socket. */
  connect?: (record: RemoteDeviceRecord, input: RemoteConnectInput) => Promise<RemoteConnectionSnapshot>;
  /** Overridden by tests so no unit test opens a registration socket. */
  registerHostLink?: (
    record: RemoteHostLinkRecord,
    options: RegisterRemoteHostLinkOptions
  ) => Promise<RemoteHostLinkRecord>;
  /** Overridden by tests so no unit test opens a socket. */
  createHost?: (
    params: RemoteConnectionParams,
    backend: RemoteHostBackend,
    hostOptions: RemoteHostServiceOptions
  ) => RemoteHostServiceLike;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  stderr?: Writable & { isTTY?: boolean };
  stdin?: Readable & { isTTY?: boolean };
  stdout?: Writable & { isTTY?: boolean };
}

export interface RemoteConnectInput {
  pairingTimeoutMs: number;
  signal?: AbortSignal;
  workspaceKey?: string;
}

type RemoteSpecificOption = "host" | "name" | "port" | "relay" | "reveal" | "timeout" | "urlFile" | "workspace" | "yes";

const leadingBooleanOptions = new Set(["--json", "--no-color", "--verbose"]);
const leadingValueOptions = new Set(["--cwd", "--locale"]);

function skipGlobalOptions(args: string[], from: number): number {
  let index = from;
  while (index < args.length) {
    const argument = args[index]!;
    if (leadingBooleanOptions.has(argument)) {
      index += 1;
      continue;
    }
    if (leadingValueOptions.has(argument)) {
      index += 2;
      continue;
    }
    if (["--cwd=", "--locale="].some((prefix) => argument.startsWith(prefix))) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

function managedAction(args: string[]): string | undefined {
  const index = skipGlobalOptions(args, 0);
  if (args[index] !== "remote") return undefined;
  const action = args[skipGlobalOptions(args, index + 1)];
  if (action === undefined || action.startsWith("-")) return "help";
  return managedActions.has(action) ? action : undefined;
}

function printable(value: unknown): string {
  const raw = typeof value === "string" ? value : String(value ?? "");
  return Array.from(raw, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? "?" : character;
  }).join("");
}

function printableError(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  return raw.split(/\r\n?|\n/u).map((line) => printable(line)).join("\n");
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function writeJson(output: Writable, value: unknown): void {
  output.write(`${JSON.stringify(value, null, 2)}\n`);
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d{1,5}$/u.test(raw)) throw new Error("--port expects a whole number.");
  const port = Number(raw);
  if (port < 0 || port > 65535) throw new Error("--port must be between 0 and 65535.");
  return port;
}

function parseTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d{1,4}$/u.test(raw)) throw new Error("--timeout expects a whole number of seconds.");
  const seconds = Number(raw);
  if (seconds < minimumTimeoutSeconds || seconds > maximumTimeoutSeconds) {
    throw new Error(`--timeout must be between ${minimumTimeoutSeconds} and ${maximumTimeoutSeconds} seconds.`);
  }
  return seconds;
}

function parseRemoteCommand(args: string[]): ParsedRemoteCommand | undefined {
  const expectedAction = managedAction(args);
  if (expectedAction === undefined) return undefined;
  const parsed = parseArgs({
    allowPositionals: true,
    args,
    options: {
      cwd: { type: "string" },
      help: { short: "h", type: "boolean" },
      json: { type: "boolean" },
      locale: { type: "string" },
      host: { type: "string" },
      name: { type: "string" },
      "no-color": { type: "boolean" },
      port: { type: "string" },
      relay: { type: "string" },
      reveal: { type: "boolean" },
      timeout: { type: "string" },
      "url-file": { type: "string" },
      verbose: { type: "boolean" },
      workspace: { type: "string" },
      yes: { short: "y", type: "boolean" }
    },
    strict: true
  });

  if (parsed.positionals[0] !== "remote") return undefined;
  const timeoutSeconds = parseTimeout(text(parsed.values.timeout));
  const port = parsePort(text(parsed.values.port));
  return {
    action: parsed.positionals[1] ?? expectedAction,
    help: parsed.values.help === true,
    host: text(parsed.values.host),
    json: parsed.values.json === true,
    name: text(parsed.values.name),
    positionals: parsed.positionals.slice(2),
    ...(port !== undefined ? { port } : {}),
    relay: text(parsed.values.relay),
    reveal: parsed.values.reveal === true,
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
    urlFile: text(parsed.values["url-file"]),
    workspace: text(parsed.values.workspace),
    yes: parsed.values.yes === true
  };
}

function assertSupportedOptions(
  command: ParsedRemoteCommand,
  supported: RemoteSpecificOption[],
  usage: string
): void {
  const allowed = new Set(supported);
  const used: Array<[RemoteSpecificOption, boolean]> = [
    ["host", command.host !== undefined],
    ["name", command.name !== undefined],
    ["port", command.port !== undefined],
    ["relay", command.relay !== undefined],
    ["reveal", command.reveal],
    ["timeout", command.timeoutSeconds !== undefined],
    ["urlFile", command.urlFile !== undefined],
    ["workspace", command.workspace !== undefined],
    ["yes", command.yes]
  ];
  const unsupported = used.filter(([name, present]) => present && !allowed.has(name));
  if (unsupported.length === 0) return;

  const displayNames: Record<RemoteSpecificOption, string> = {
    host: "--host",
    name: "--name",
    port: "--port",
    relay: "--relay",
    reveal: "--reveal",
    timeout: "--timeout",
    urlFile: "--url-file",
    workspace: "--workspace",
    yes: "--yes"
  };
  const options = unsupported.map(([name]) => displayNames[name]).join(", ");
  throw new Error(`${options} ${unsupported.length === 1 ? "is" : "are"} not supported.\n${usage}`);
}

async function defaultConfirm(
  question: string,
  input: Readable & { isTTY?: boolean },
  output: Writable & { isTTY?: boolean },
  signal?: AbortSignal
): Promise<boolean> {
  if (!input.isTTY || !output.isTTY) return false;
  const readline = createInterface({ input, output });
  try {
    const answer = await readline.question(`${question} [y/N] `, { signal });
    return /^(?:y|yes)$/iu.test(answer.trim());
  } finally {
    readline.close();
  }
}

/**
 * Reads a remote-control URL from a file so the credential stays out of the shell history and the
 * process argument list. Blank lines and `#` comments are skipped; the first remaining line is used.
 */
async function readUrlFile(path: string): Promise<string> {
  const raw = await readFile(path, "utf8");
  const line = raw
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0 && !entry.startsWith("#"));
  if (line === undefined) throw new Error(`No remote-control URL was found in ${printable(path)}.`);
  return line;
}

/**
 * Writes a freshly created pairing URL to a file with owner-only permissions, so the credential
 * never has to appear on the terminal.
 */
async function writeUrlFile(path: string, url: string): Promise<void> {
  const file = await open(path, "w", 0o600);
  try {
    await file.writeFile(`${url}\n`, "utf8");
  } finally {
    await file.close();
  }
  if (process.platform !== "win32") await chmod(path, 0o600).catch(() => {});
}

/** The served workspace: a stable non-reversible key plus the label a controller shows. */
export function remoteHostWorkspaceForPath(path: string): RemoteHostWorkspace {
  const key = `ws-${createHash("sha256").update(path, "utf8").digest("hex").slice(0, workspaceKeyCharacters)}`;
  const name = basename(path);
  return { key, name: name.length > 0 ? name : path, path };
}

function isParamsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderDeviceLine(record: RemoteDeviceRecord): string {
  const summary = remoteDeviceSummary(record);
  const seen = summary.lastConnectedAt === undefined
    ? ""
    : ` last ${printable(summary.lastConnectedAt)}`;
  return `${printable(summary.name)} (${printable(summary.id)}) ${printable(summary.host)}`
    + ` [${printable(summary.lastState)}]${seen}`;
}

function renderSnapshot(output: Writable, record: RemoteDeviceRecord, snapshot: RemoteConnectionSnapshot): void {
  output.write(`${snapshot.paired ? "Paired with" : "Reached"} ${printable(record.name)}`
    + ` (${printable(record.host)}).\n`);
  output.write(`Relay state: ${printable(snapshot.state)}\n`);
  if (snapshot.appVersion !== undefined) output.write(`Desktop version: ${printable(snapshot.appVersion)}\n`);
  output.write(`Workspaces: ${snapshot.workspaces.length}\n`);
  for (const workspace of snapshot.workspaces) {
    const label = workspace.name ?? workspace.path ?? workspace.key;
    output.write(`  - ${printable(label)}\n`);
  }
  if (snapshot.bridgedWorkspaceKey !== undefined) {
    output.write(`Bridged workspace: ${printable(snapshot.bridgedWorkspaceKey)}\n`);
  }
}

/**
 * `zcode remote …` device management. Returns `undefined` when the arguments are not a managed
 * remote command, so the launcher can hand them to the ZCode runtime unchanged.
 */
export async function runRemoteCommand(
  args: string[],
  options: RunRemoteCommandOptions = {}
): Promise<number | undefined> {
  let command: ParsedRemoteCommand | undefined;
  try {
    command = parseRemoteCommand(args);
  } catch (error) {
    (options.stderr ?? process.stderr).write(`Error: ${printableError(error)}\n`);
    return 1;
  }
  if (command === undefined) return undefined;

  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const stdin = options.stdin ?? process.stdin;
  const env = options.env ?? process.env;
  const confirm = options.confirm ?? ((question: string) => defaultConfirm(question, stdin, stderr, options.signal));
  const connect = options.connect ?? ((record, input) => probeRemoteDevice(remoteDeviceParams(record), input));
  const print = (value: unknown, human: () => void): void => {
    if (command!.json) writeJson(stdout, value);
    else human();
  };

  if (command.help || command.action === "help") {
    stdout.write(`${remoteUsage}\n`);
    return 0;
  }

  try {
    if (command.action === "add") {
      const [target, ...extra] = command.positionals;
      const usage = "Usage: zcode remote add <url> | --url-file <file> [--name <name>]";
      assertSupportedOptions(command, ["name", "urlFile"], usage);
      if (extra.length > 0) throw new Error(usage);
      if ((target === undefined) === (command.urlFile === undefined)) throw new Error(usage);
      const url = command.urlFile === undefined ? target! : await readUrlFile(command.urlFile);
      const result = await addRemoteDevice(url, command.name, env);
      const summary = remoteDeviceSummary(result.record);
      print({ device: summary, path: result.path, replaced: result.replaced }, () => {
        stdout.write(`${result.replaced ? "Updated" : "Added"} remote device ${printable(summary.name)}`
          + ` (${printable(summary.id)}).\n`);
        stdout.write(`Host: ${printable(summary.host)}\n`);
        stdout.write(`Credentials stored with owner-only permissions in ${printable(result.path)}\n`);
        stdout.write(`Run \`zcode remote connect ${printable(summary.name)}\` to verify pairing.\n`);
      });
      return 0;
    }

    if (command.action === "list") {
      const usage = "Usage: zcode remote list";
      assertSupportedOptions(command, [], usage);
      if (command.positionals.length > 0) throw new Error(usage);
      const records = await readRemoteDevices(env);
      print({ devices: records.map(remoteDeviceSummary), path: remoteDeviceStorePath(env) }, () => {
        stdout.write("Remote devices:\n");
        if (records.length === 0) {
          stdout.write("  (none)\n");
          stdout.write("Add one with `zcode remote add <url>` using the desktop's remote-control URL.\n");
          return;
        }
        for (const record of records) stdout.write(`  - ${renderDeviceLine(record)}\n`);
      });
      return 0;
    }

    if (command.action === "remove") {
      const [selector, ...extra] = command.positionals;
      const usage = "Usage: zcode remote remove <name|id> [--yes]";
      assertSupportedOptions(command, ["yes"], usage);
      if (selector === undefined || extra.length > 0) throw new Error(usage);
      if (!command.yes && !await confirm(`Remove remote device ${printable(selector)}?`)) {
        throw new Error("Remote device removal cancelled. Use --yes for non-interactive use.");
      }
      const removed = await removeRemoteDevice(selector, env);
      if (removed === undefined) throw new Error(`No remote device matches ${printable(selector)}.`);
      const summary = remoteDeviceSummary(removed.record);
      print({ device: summary, path: removed.path }, () => {
        stdout.write(`Removed remote device ${printable(summary.name)} (${printable(summary.id)}).\n`);
        stdout.write("The desktop pairing itself is unchanged; regenerate it there to revoke the credential.\n");
      });
      return 0;
    }

    if (command.action === "connect") {
      const [selector, ...extra] = command.positionals;
      const usage = "Usage: zcode remote connect [<name|id>] [--workspace <key>] [--timeout <seconds>]";
      assertSupportedOptions(command, ["timeout", "workspace"], usage);
      if (extra.length > 0) throw new Error(usage);
      const records = await readRemoteDevices(env);
      if (records.length === 0) {
        throw new Error("No remote devices are configured. Add one with `zcode remote add <url>`.");
      }
      let record: RemoteDeviceRecord | undefined;
      if (selector !== undefined) record = findRemoteDevice(records, selector);
      else if (records.length === 1) record = records[0];
      else throw new Error(`Several remote devices are configured; name one.\n${usage}`);
      if (record === undefined) throw new Error(`No remote device matches ${printable(selector ?? "")}.`);

      let snapshot: RemoteConnectionSnapshot;
      try {
        snapshot = await connect(record, {
          pairingTimeoutMs: (command.timeoutSeconds ?? defaultTimeoutSeconds) * 1000,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
          ...(command.workspace !== undefined ? { workspaceKey: command.workspace } : {})
        });
      } catch (error) {
        await recordRemoteDeviceState(record.id, "unreachable", env).catch(() => undefined);
        throw error;
      }
      await recordRemoteDeviceState(record.id, snapshot.state, env);
      const summary = remoteDeviceSummary(record);
      print({ connection: snapshot, device: summary }, () => renderSnapshot(stdout, record!, snapshot));
      return snapshot.paired ? 0 : 1;
    }

    if (command.action === "link") {
      const [subaction = "show", ...extra] = command.positionals;
      const usage = "Usage: zcode remote link [show|create|revoke] [--reveal] [--name <name>]"
        + " [--relay <url>] [--url-file <file>] [--yes]";
      if (extra.length > 0 || !linkActions.has(subaction)) throw new Error(usage);

      if (subaction === "create") {
        assertSupportedOptions(
          command,
          ["name", "relay", "urlFile"],
          "Usage: zcode remote link create [--name <name>] [--relay <url>] [--url-file <file>]"
        );
        // --relay wins over the environment so a one-off command can override a machine default.
        const relayUrl = command.relay ?? text(env["ZCODE_RELAY_URL"]);
        const created = await createRemoteHostLink({
          ...(command.name !== undefined ? { name: command.name } : {}),
          ...(relayUrl !== undefined ? { relayUrl } : {})
        }, env);
        const record = await (options.registerHostLink ?? registerRemoteHostLink)(created.record, {
          ...(options.appVersion !== undefined ? { appVersion: options.appVersion } : {})
        });
        const result = { ...created, path: await writeRemoteHostLink(record, env), record };
        const url = remoteHostLinkUrl(result.record, options.appVersion);
        const summary = remoteHostLinkSummary(result.record);
        if (command.urlFile !== undefined) await writeUrlFile(command.urlFile, url);
        print({
          link: summary,
          path: result.path,
          rotated: result.rotated,
          ...(command.urlFile !== undefined ? { urlFile: command.urlFile } : { url })
        }, () => {
          stdout.write(`${result.rotated ? "Rotated" : "Created"} the remote-control link for this machine`
            + ` (${printable(summary.id)}).\n`);
          if (result.rotated) stdout.write("Previously issued pairing URLs no longer work.\n");
          stdout.write(`Device name: ${printable(summary.name)}\n`);
          stdout.write(`Relay: ${printable(summary.host)}\n`);
          stdout.write(`Credentials stored with owner-only permissions in ${printable(result.path)}\n`);
          if (command.urlFile !== undefined) {
            stdout.write(`Pairing URL written to ${printable(command.urlFile)} with owner-only permissions.\n`);
          } else {
            stdout.write("Pairing URL (a device credential; share it only with your own devices):\n");
            stdout.write(`${printable(url)}\n`);
          }
          stdout.write("Open it in the ZCode web remote control or register it elsewhere with"
            + " `zcode remote add`,\nthen run `zcode remote serve` here to accept the connection.\n");
        });
        return 0;
      }

      if (subaction === "revoke") {
        assertSupportedOptions(command, ["yes"], "Usage: zcode remote link revoke [--yes]");
        if (!command.yes && !await confirm("Revoke this machine's remote-control link?")) {
          throw new Error("Remote link revocation cancelled. Use --yes for non-interactive use.");
        }
        const removed = await removeRemoteHostLink(env);
        if (removed === undefined) throw new Error("No remote-control link exists. Nothing to revoke.");
        const summary = remoteHostLinkSummary(removed.record);
        print({ link: summary, path: removed.path }, () => {
          stdout.write(`Revoked the remote-control link ${printable(summary.id)}.\n`);
          stdout.write("Controllers holding the old pairing URL can no longer pair with this machine.\n");
        });
        return 0;
      }

      assertSupportedOptions(command, ["reveal"], "Usage: zcode remote link [show] [--reveal]");
      const record = await readRemoteHostLink(env);
      if (record === undefined) {
        throw new Error("No remote-control link exists yet. Create one with `zcode remote link create`.");
      }
      const summary = remoteHostLinkSummary(record);
      const url = command.reveal ? remoteHostLinkUrl(record, options.appVersion) : undefined;
      print({ link: summary, path: remoteHostLinkStorePath(env), ...(url !== undefined ? { url } : {}) }, () => {
        stdout.write(`Remote-control link ${printable(summary.id)} for this machine:\n`);
        stdout.write(`  Device name: ${printable(summary.name)}\n`);
        stdout.write(`  Relay: ${printable(summary.host)}\n`);
        stdout.write(`  Created: ${printable(summary.createdAt)}\n`);
        if (summary.rotatedAt !== undefined) stdout.write(`  Rotated: ${printable(summary.rotatedAt)}\n`);
        stdout.write(`  URL: ${printable(url ?? summary.redactedUrl)}\n`);
        if (url === undefined) stdout.write("Use --reveal to print the full pairing URL.\n");
      });
      return 0;
    }

    if (command.action === "relay") {
      const [subaction = "serve", ...extra] = command.positionals;
      const usage = "Usage: zcode remote relay serve [--host <host>] [--port <port>]";
      assertSupportedOptions(command, ["host", "port"], usage);
      if (subaction !== "serve" || extra.length > 0) throw new Error(usage);
      if (typeof Bun === "undefined") {
        throw new Error("The private relay requires Bun. Run this launcher with `bun bin/zcode.js remote relay serve`.");
      }
      const relay = startPrivateRelayServer({ hostname: command.host ?? "127.0.0.1", port: command.port ?? 7331 });
      const url = "http://" + relay.hostname + ":" + String(relay.port) + "/remote/v4";
      print({ event: "serving", host: relay.hostname, port: relay.port, url }, () => {
        stdout.write("Private relay listening on " + printable(url) + "\n");
        stdout.write("Open that URL to use the official controller through this relay. Press Ctrl+C to stop.\n");
      });
      return await new Promise<number>((resolveExit) => {
        const stop = (): void => {
          options.signal?.removeEventListener("abort", stop);
          relay.stop();
          if (!command!.json) stdout.write("Private relay stopped.\n");
          resolveExit(0);
        };
        options.signal?.addEventListener("abort", stop, { once: true });
        if (options.signal?.aborted) stop();
      });
    }

    if (command.action === "serve") {
      const usage = "Usage: zcode remote serve [--workspace <path>]";
      assertSupportedOptions(command, ["workspace"], usage);
      if (command.positionals.length > 0) throw new Error(usage);
      const record = await readRemoteHostLink(env);
      if (record === undefined) {
        throw new Error("No remote-control link exists yet. Create one with `zcode remote link create`.");
      }
      const workspacePath = resolve(options.cwd ?? process.cwd(), command.workspace ?? ".");
      const workspace = remoteHostWorkspaceForPath(workspacePath);
      const appServerRequest = options.appServerRequest;
      const backend: RemoteHostBackend = {
        call: async ({ args, channel, name, signal }) => {
          if (appServerRequest === undefined) {
            throw new Error("The local ZCode runtime is not available for remote calls.");
          }
          const first = args[0];
          return await appServerRequest({
            method: `${channel}/${name}`,
            params: isParamsRecord(first) ? first : {},
            signal,
            workingDirectory: workspacePath
          });
        },
        listWorkspaces: () => [workspace]
      };
      const createHost = options.createHost
        ?? ((params, hostBackend, hostOptions) => new RemoteHostService(params, hostBackend, hostOptions));
      const host = createHost(remoteHostLinkParams(record, options.appVersion), backend, {
        ...(options.appVersion !== undefined ? { appVersion: options.appVersion } : {}),
        deviceName: record.name
      });
      const summary = remoteHostLinkSummary(record);
      const jsonMode = command.json;
      const emit = (event: Record<string, unknown>, human: () => void): void => {
        if (jsonMode) writeJson(stdout, event);
        else human();
      };

      emit({ event: "serving", link: summary, workspace }, () => {
        stdout.write(`Serving workspace ${printable(workspace.name)} (${printable(workspacePath)})`
          + ` as ${printable(summary.name)} via ${printable(summary.host)}.\n`);
        stdout.write("Press Ctrl+C to stop. Controllers pair with this machine's URL"
          + " (`zcode remote link show --reveal`).\n");
      });

      return await new Promise<number>((resolveExit) => {
        let settled = false;
        let offState = (): void => {};
        let offFailure = (): void => {};
        const finish = (code: number): void => {
          if (settled) return;
          settled = true;
          offState();
          offFailure();
          options.signal?.removeEventListener("abort", onAbort);
          host.dispose();
          resolveExit(code);
        };
        const onAbort = (): void => {
          emit({ event: "stopped" }, () => stdout.write("Stopped serving.\n"));
          finish(0);
        };
        offState = host.onState((state) => {
          if (state === "waiting") {
            emit({ event: "state", state }, () => stdout.write("Waiting for a controller to connect.\n"));
          } else if (state === "paired") {
            emit({ event: "state", state }, () => stdout.write("Controller connected.\n"));
          } else if (state === "reconnecting") {
            emit({ event: "state", state }, () => stdout.write("Relay connection lost; reconnecting.\n"));
          }
        });
        offFailure = host.onFailure((failure) => {
          stderr.write(`Error: relay connection failed (${printable(failure.reason)})`
            + `${failure.message !== undefined ? `: ${printable(failure.message)}` : ""}\n`);
          finish(1);
        });
        options.signal?.addEventListener("abort", onAbort, { once: true });
        if (options.signal?.aborted) {
          onAbort();
          return;
        }
        host.start();
      });
    }

    throw new Error(remoteUsage);
  } catch (error) {
    stderr.write(`Error: ${printableError(error)}\n`);
    return error instanceof Error && error.name === "AbortError" ? 130 : 1;
  }
}
