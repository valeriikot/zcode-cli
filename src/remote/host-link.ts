import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

import { userConfigPath } from "../model-access.ts";
import {
  parseRemoteConnectionUrl,
  redactRemoteConnectionUrl,
  type RemoteConnectionParams
} from "./connection-params.ts";
import { remoteDeviceId } from "./device-store.ts";

const storeFileName = "remote-host.json";
const storeVersion = 1;
const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const sidBytes = 24;
const passHashBytes = 32;
const machineIdBytes = 8;

export const defaultRelayPageUrl = "https://zcode.z.ai/remote/v4";

/**
 * This machine's remote-control identity: the credentials a controller (usually the official web
 * remote control) needs to reach this CLI over the relay. `deviceSid` and `passHash` are the
 * credential pair embedded in the pairing URL, so a record must never be logged or printed
 * verbatim; use {@link remoteHostLinkSummary} for anything that reaches a terminal.
 */
export interface RemoteHostLinkRecord {
  createdAt: string;
  deviceSid: string;
  mid: string;
  name: string;
  passHash: string;
  relayUrl: string;
  rotatedAt?: string;
}

/** Credential-free projection of the host link, safe to print. */
export interface RemoteHostLinkSummary {
  createdAt: string;
  host: string;
  id: string;
  mid: string;
  name: string;
  redactedUrl: string;
  rotatedAt?: string;
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

export function remoteHostLinkStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(userConfigPath(env)), storeFileName);
}

function sanitizeName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]/gu, "-").replace(/^-+/u, "").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "zcode-cli";
}

function validateRelayUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("The relay URL is not an absolute URL.");
  }
  if (!["https:", "http:", "wss:", "ws:"].includes(url.protocol)) {
    throw new Error(`The relay URL must use http(s) or ws(s), not ${url.protocol}`);
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error("The relay URL must not carry query parameters or a fragment.");
  }
  return url;
}

/** Builds the full pairing URL. The result is a device credential; treat it like one. */
export function remoteHostLinkUrl(record: RemoteHostLinkRecord, appVersion?: string): string {
  const url = new URL(record.relayUrl);
  url.searchParams.set("sid", record.deviceSid);
  url.searchParams.set("hash", record.passHash);
  url.searchParams.set("t", String(Date.parse(record.rotatedAt ?? record.createdAt) || 0));
  url.searchParams.set("mid", record.mid);
  url.searchParams.set("name", record.name);
  if (appVersion !== undefined) url.searchParams.set("app_version", appVersion);
  return url.toString();
}

/** The host link expressed as relay connection parameters, e.g. for {@link RemoteHostService}. */
export function remoteHostLinkParams(record: RemoteHostLinkRecord, appVersion?: string): RemoteConnectionParams {
  const params = parseRemoteConnectionUrl(remoteHostLinkUrl(record, appVersion));
  if (params === undefined) {
    throw new Error("The stored remote host link no longer produces a usable remote-control URL.");
  }
  return params;
}

export function remoteHostLinkSummary(record: RemoteHostLinkRecord): RemoteHostLinkSummary {
  return {
    createdAt: record.createdAt,
    host: new URL(record.relayUrl).host,
    id: remoteDeviceId(record.deviceSid),
    mid: record.mid,
    name: record.name,
    redactedUrl: redactRemoteConnectionUrl(remoteHostLinkUrl(record)),
    ...(record.rotatedAt !== undefined ? { rotatedAt: record.rotatedAt } : {})
  };
}

function parseStoredRecord(value: unknown): RemoteHostLinkRecord | undefined {
  if (!isRecord(value)) return undefined;
  const deviceSid = text(value["deviceSid"]);
  const passHash = text(value["passHash"]);
  const mid = text(value["mid"]);
  const name = text(value["name"]);
  const relayUrl = text(value["relayUrl"]);
  if (
    deviceSid === undefined || passHash === undefined || mid === undefined
    || name === undefined || relayUrl === undefined
  ) {
    return undefined;
  }
  return {
    createdAt: text(value["createdAt"]) ?? new Date(0).toISOString(),
    deviceSid,
    mid,
    name,
    passHash,
    relayUrl,
    ...(text(value["rotatedAt"]) !== undefined ? { rotatedAt: text(value["rotatedAt"])! } : {})
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

export async function readRemoteHostLink(
  env: NodeJS.ProcessEnv = process.env
): Promise<RemoteHostLinkRecord | undefined> {
  const path = remoteHostLinkStorePath(env);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new Error(`Unable to read the remote host link store ${path}: ${errorMessage(error)}`, { cause: error });
  }
  await enforcePrivateMode(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`The remote host link store ${path} is not valid JSON.`);
  }
  if (!isRecord(parsed)) throw new Error(`The remote host link store ${path} does not contain a host link.`);
  return parseStoredRecord(parsed["host"]);
}

async function writeRemoteHostLink(
  record: RemoteHostLinkRecord,
  env: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const path = remoteHostLinkStorePath(env);
  const directory = dirname(path);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error(`Unable to create the ZCode config directory ${directory}: ${errorMessage(error)}`, {
      cause: error
    });
  }
  const temporaryPath = join(directory, `.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let file;
  try {
    file = await open(temporaryPath, "wx", 0o600);
    await file.writeFile(`${JSON.stringify({ version: storeVersion, host: record }, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporaryPath, path);
    return path;
  } catch (error) {
    throw new Error(`Unable to update the remote host link store ${path}: ${errorMessage(error)}`, { cause: error });
  } finally {
    await file?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export interface CreateRemoteHostLinkOptions {
  /** Advertised device name; defaults to the sanitized machine hostname. */
  name?: string;
  /** Pairing page base URL; defaults to {@link defaultRelayPageUrl}. */
  relayUrl?: string;
}

export interface CreateRemoteHostLinkResult {
  path: string;
  record: RemoteHostLinkRecord;
  /** True when an earlier link existed; its credentials are now invalid. */
  rotated: boolean;
}

/**
 * Creates this machine's pairing link, or rotates it when one already exists. Rotation always mints
 * a fresh `sid`/`passHash` pair — that is how a leaked URL is revoked — while the machine id stays
 * stable so the relay keeps recognising this installation.
 */
export async function createRemoteHostLink(
  options: CreateRemoteHostLinkOptions = {},
  env: NodeJS.ProcessEnv = process.env
): Promise<CreateRemoteHostLinkResult> {
  if (options.name !== undefined && !namePattern.test(options.name)) {
    throw new Error(`Invalid device name: ${options.name}. Use letters, digits, dot, dash or underscore.`);
  }
  const relayUrl = validateRelayUrl(options.relayUrl ?? defaultRelayPageUrl).toString();
  const existing = await readRemoteHostLink(env);
  const now = new Date().toISOString();
  const record: RemoteHostLinkRecord = {
    createdAt: existing?.createdAt ?? now,
    deviceSid: randomBytes(sidBytes).toString("base64url"),
    mid: existing?.mid ?? randomBytes(machineIdBytes).toString("hex"),
    name: options.name ?? existing?.name ?? sanitizeName(hostname()),
    passHash: randomBytes(passHashBytes).toString("base64url"),
    relayUrl,
    ...(existing !== undefined ? { rotatedAt: now } : {})
  };
  return { path: await writeRemoteHostLink(record, env), record, rotated: existing !== undefined };
}

export interface RemoveRemoteHostLinkResult {
  path: string;
  record: RemoteHostLinkRecord;
}

export async function removeRemoteHostLink(
  env: NodeJS.ProcessEnv = process.env
): Promise<RemoveRemoteHostLinkResult | undefined> {
  const path = remoteHostLinkStorePath(env);
  const record = await readRemoteHostLink(env);
  if (record === undefined) return undefined;
  await rm(path, { force: true });
  return { path, record };
}
