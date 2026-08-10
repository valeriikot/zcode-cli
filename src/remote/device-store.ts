import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { userConfigPath } from "../model-access.ts";
import {
  parseRemoteConnectionUrl,
  redactRemoteConnectionUrl,
  type RemoteConnectionParams
} from "./connection-params.ts";

const storeFileName = "remote-devices.json";
const storeVersion = 1;
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const deviceIdCharacters = 12;
const maximumDeviceCount = 64;

/**
 * A stored remote device. `url` is the full remote-control URL and therefore a credential: it must
 * never be logged, printed or included in an error message. Use {@link remoteDeviceSummary} for
 * anything that reaches a terminal, and keep the file at mode 0600.
 */
export interface RemoteDeviceRecord {
  addedAt: string;
  appVersion?: string;
  host: string;
  id: string;
  lastConnectedAt?: string;
  lastState?: string;
  mid?: string;
  name: string;
  theme?: string;
  url: string;
}

/** Credential-free projection of a stored device, safe to print. */
export interface RemoteDeviceSummary {
  addedAt: string;
  appVersion?: string;
  host: string;
  id: string;
  lastConnectedAt?: string;
  lastState: string;
  mid?: string;
  name: string;
  redactedUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function remoteDeviceStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const configPath = userConfigPath(env);
  return join(dirname(configPath), storeFileName);
}

/**
 * Stable, non-reversible device identifier derived from the device session id, so a device can be
 * named in commands and listings without exposing its credential.
 */
export function remoteDeviceId(deviceSid: string): string {
  return createHash("sha256").update(deviceSid, "utf8").digest("hex").slice(0, deviceIdCharacters);
}

export function remoteDeviceSummary(record: RemoteDeviceRecord): RemoteDeviceSummary {
  return {
    addedAt: record.addedAt,
    ...(record.appVersion !== undefined ? { appVersion: record.appVersion } : {}),
    host: record.host,
    id: record.id,
    ...(record.lastConnectedAt !== undefined ? { lastConnectedAt: record.lastConnectedAt } : {}),
    lastState: record.lastState ?? "never-connected",
    ...(record.mid !== undefined ? { mid: record.mid } : {}),
    name: record.name,
    redactedUrl: redactRemoteConnectionUrl(record.url)
  };
}

/** Re-parses a stored device back into connection parameters. */
export function remoteDeviceParams(record: RemoteDeviceRecord): RemoteConnectionParams {
  const params = parseRemoteConnectionUrl(record.url);
  if (params === undefined) {
    throw new Error(`Stored remote device ${record.name} no longer has a usable remote-control URL.`);
  }
  return params;
}

function sanitizeName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/gu, "-").replace(/^-+/u, "").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "device";
}

function uniqueName(candidate: string, taken: Set<string>): string {
  if (!taken.has(candidate)) return candidate;
  for (let suffix = 2; suffix < maximumDeviceCount + 2; suffix += 1) {
    const next = `${candidate}-${suffix}`;
    if (!taken.has(next)) return next;
  }
  return `${candidate}-${randomUUID().slice(0, 8)}`;
}

function parseRecord(value: unknown): RemoteDeviceRecord | undefined {
  if (!isRecord(value)) return undefined;
  const url = text(value["url"]);
  const id = text(value["id"]);
  const name = text(value["name"]);
  const host = text(value["host"]);
  if (url === undefined || id === undefined || name === undefined || host === undefined) return undefined;
  return {
    addedAt: text(value["addedAt"]) ?? new Date(0).toISOString(),
    ...(text(value["appVersion"]) !== undefined ? { appVersion: text(value["appVersion"])! } : {}),
    host,
    id,
    ...(text(value["lastConnectedAt"]) !== undefined ? { lastConnectedAt: text(value["lastConnectedAt"])! } : {}),
    ...(text(value["lastState"]) !== undefined ? { lastState: text(value["lastState"])! } : {}),
    ...(text(value["mid"]) !== undefined ? { mid: text(value["mid"])! } : {}),
    name,
    ...(text(value["theme"]) !== undefined ? { theme: text(value["theme"])! } : {}),
    url
  };
}

/** Tightens a store file that an earlier tool, backup or sync left group- or world-readable. */
async function enforcePrivateMode(path: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const existing = await stat(path);
    if ((existing.mode & 0o077) === 0) return;
    await chmod(path, 0o600);
  } catch {
    // A store we cannot stat or chmod is reported by the read/write path instead.
  }
}

export async function readRemoteDevices(
  env: NodeJS.ProcessEnv = process.env
): Promise<RemoteDeviceRecord[]> {
  const path = remoteDeviceStorePath(env);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw new Error(`Unable to read the remote device store ${path}: ${errorMessage(error)}`, { cause: error });
  }
  await enforcePrivateMode(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`The remote device store ${path} is not valid JSON.`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["devices"])) {
    throw new Error(`The remote device store ${path} does not contain a device list.`);
  }
  return parsed["devices"].flatMap((entry) => {
    const record = parseRecord(entry);
    return record === undefined ? [] : [record];
  });
}

export async function writeRemoteDevices(
  records: RemoteDeviceRecord[],
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const path = remoteDeviceStorePath(env);
  const directory = dirname(path);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error(`Unable to create the ZCode config directory ${directory}: ${errorMessage(error)}`, {
      cause: error
    });
  }
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(temporaryPath, "wx", 0o600);
    await file.writeFile(`${JSON.stringify({ version: storeVersion, devices: records }, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporaryPath, path);
    return path;
  } catch (error) {
    throw new Error(`Unable to update the remote device store ${path}: ${errorMessage(error)}`, { cause: error });
  } finally {
    await file?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export function findRemoteDevice(
  records: RemoteDeviceRecord[],
  selector: string
): RemoteDeviceRecord | undefined {
  const wanted = selector.trim();
  if (wanted.length === 0) return undefined;
  return records.find((record) => record.id === wanted)
    ?? records.find((record) => record.name === wanted)
    ?? records.find((record) => record.name.toLowerCase() === wanted.toLowerCase());
}

export interface AddRemoteDeviceResult {
  path: string;
  record: RemoteDeviceRecord;
  replaced: boolean;
}

/**
 * Validates a remote-control URL and stores it. Re-adding a known device rewrites its credential in
 * place, which is how a rotated desktop pairing is refreshed.
 */
export async function addRemoteDevice(
  url: string,
  name: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): Promise<AddRemoteDeviceResult> {
  const params = parseRemoteConnectionUrl(url);
  if (params === undefined) {
    throw new Error(
      "The remote-control URL is not usable. It must be an absolute http(s)/ws(s) URL with sid, hash and t parameters."
    );
  }
  if (name !== undefined && !namePattern.test(name)) {
    throw new Error(`Invalid device name: ${name}. Use letters, digits, dot, dash or underscore.`);
  }
  const records = await readRemoteDevices(env);
  const id = remoteDeviceId(params.deviceSid);
  const existing = records.find((record) => record.id === id);
  if (existing === undefined && records.length >= maximumDeviceCount) {
    throw new Error(`The remote device store already holds ${maximumDeviceCount} devices.`);
  }
  const taken = new Set(records.filter((record) => record.id !== id).map((record) => record.name));
  const preferred = name ?? existing?.name ?? sanitizeName(params.deviceName ?? params.source.hostname);
  const record: RemoteDeviceRecord = {
    addedAt: existing?.addedAt ?? new Date().toISOString(),
    ...(params.appVersion !== undefined ? { appVersion: params.appVersion } : {}),
    host: params.source.host,
    id,
    ...(existing?.lastConnectedAt !== undefined ? { lastConnectedAt: existing.lastConnectedAt } : {}),
    ...(existing?.lastState !== undefined ? { lastState: existing.lastState } : {}),
    ...(params.deviceMid !== undefined ? { mid: params.deviceMid } : {}),
    name: uniqueName(preferred, taken),
    ...(params.theme !== undefined ? { theme: params.theme } : {}),
    url: params.source.toString()
  };
  const next = existing === undefined
    ? [...records, record]
    : records.map((entry) => (entry.id === id ? record : entry));
  return { path: await writeRemoteDevices(next, env), record, replaced: existing !== undefined };
}

/** Records the outcome of the last connection attempt so `zcode remote list` has a real state. */
export async function recordRemoteDeviceState(
  id: string,
  state: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<RemoteDeviceRecord | undefined> {
  const records = await readRemoteDevices(env);
  const existing = records.find((record) => record.id === id);
  if (existing === undefined) return undefined;
  const updated: RemoteDeviceRecord = { ...existing, lastConnectedAt: new Date().toISOString(), lastState: state };
  await writeRemoteDevices(records.map((record) => (record.id === id ? updated : record)), env);
  return updated;
}

export interface RemoveRemoteDeviceResult {
  path: string;
  record: RemoteDeviceRecord;
}

export async function removeRemoteDevice(
  selector: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<RemoveRemoteDeviceResult | undefined> {
  const records = await readRemoteDevices(env);
  const record = findRemoteDevice(records, selector);
  if (record === undefined) return undefined;
  const next = records.filter((entry) => entry.id !== record.id);
  return { path: await writeRemoteDevices(next, env), record };
}
