import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";

import { probeRemoteDevice, type RemoteConnectionSnapshot } from "./remote/client.ts";
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

const managedActions = new Set(["add", "connect", "help", "list", "remove"]);
const minimumTimeoutSeconds = 5;
const maximumTimeoutSeconds = 600;
const defaultTimeoutSeconds = 60;

const remoteUsage = `Usage:
  zcode remote add <url> [--name <name>] [--json]
  zcode remote add --url-file <file> [--name <name>] [--json]
  zcode remote list [--json]
  zcode remote remove <name|id> [--yes] [--json]
  zcode remote connect [<name|id>] [--workspace <key>] [--timeout <seconds>] [--json]

A remote-control URL contains the desktop's device credentials. Prefer --url-file so the
credential never enters the shell history or the process argument list.`;

interface ParsedRemoteCommand {
  action: string;
  help: boolean;
  json: boolean;
  name?: string;
  positionals: string[];
  timeoutSeconds?: number;
  urlFile?: string;
  workspace?: string;
  yes: boolean;
}

export interface RunRemoteCommandOptions {
  confirm?: (question: string) => Promise<boolean>;
  /** Overridden by tests so no unit test opens a socket. */
  connect?: (record: RemoteDeviceRecord, input: RemoteConnectInput) => Promise<RemoteConnectionSnapshot>;
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

type RemoteSpecificOption = "name" | "timeout" | "urlFile" | "workspace" | "yes";

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
      name: { type: "string" },
      "no-color": { type: "boolean" },
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
  return {
    action: parsed.positionals[1] ?? expectedAction,
    help: parsed.values.help === true,
    json: parsed.values.json === true,
    name: text(parsed.values.name),
    positionals: parsed.positionals.slice(2),
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
    ["name", command.name !== undefined],
    ["timeout", command.timeoutSeconds !== undefined],
    ["urlFile", command.urlFile !== undefined],
    ["workspace", command.workspace !== undefined],
    ["yes", command.yes]
  ];
  const unsupported = used.filter(([name, present]) => present && !allowed.has(name));
  if (unsupported.length === 0) return;

  const displayNames: Record<RemoteSpecificOption, string> = {
    name: "--name",
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

    throw new Error(remoteUsage);
  } catch (error) {
    stderr.write(`Error: ${printableError(error)}\n`);
    return error instanceof Error && error.name === "AbortError" ? 130 : 1;
  }
}
