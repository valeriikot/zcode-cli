const integerPattern = /^[+-]?\d+$/u;
const redactedMarker = "***";
const visibleSidCharacters = 4;

export interface RemoteConnectionParams {
  appVersion?: string;
  deviceMid?: string;
  deviceName?: string;
  deviceSid: string;
  passHash: string;
  source: URL;
  theme?: string;
  timestamp: number;
}

function queryValue(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key)?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function integerValue(raw: string | undefined): number | undefined {
  if (raw === undefined || !integerPattern.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Parses a remote-control URL such as
 * `https://zcode.z.ai/remote/v4?sid=...&hash=...&t=...&mid=...&name=...&app_version=...&theme=...`.
 * `sid`, `hash` and an integer `t` are required; anything else yields `undefined`.
 */
export function parseRemoteConnectionUrl(raw: string): RemoteConnectionParams | undefined {
  let source: URL;
  try {
    source = new URL(raw.trim());
  } catch {
    return undefined;
  }
  const deviceSid = queryValue(source, "sid");
  const passHash = queryValue(source, "hash");
  const timestamp = integerValue(queryValue(source, "t"));
  if (deviceSid === undefined || passHash === undefined || timestamp === undefined) return undefined;
  return {
    appVersion: queryValue(source, "app_version"),
    deviceMid: queryValue(source, "mid"),
    deviceName: queryValue(source, "name"),
    deviceSid,
    passHash,
    source,
    theme: queryValue(source, "theme"),
    timestamp
  };
}

/**
 * Relay endpoint for the parsed source: `ws(s)://<host>/ws` plus `?mid=` when the device
 * advertised a machine id. `wss` is used for `https:`/`wss:` sources, `ws` otherwise.
 */
export function relayWebSocketUrl(params: RemoteConnectionParams): URL {
  const secure = params.source.protocol === "https:" || params.source.protocol === "wss:";
  const url = new URL(`${secure ? "wss" : "ws"}://${params.source.host}/ws`);
  if (params.deviceMid !== undefined) url.searchParams.set("mid", params.deviceMid);
  return url;
}

function maskSid(value: string): string {
  if (value.length <= visibleSidCharacters) return redactedMarker;
  return `${value.slice(0, visibleSidCharacters)}${redactedMarker}`;
}

/**
 * Loggable form of a remote-control URL: the pass hash is removed entirely and the device
 * session id keeps only a short prefix. Remote-control URLs are device credentials, so only
 * this form may ever reach a log, a transcript or an error message.
 */
export function redactRemoteConnectionUrl(value: RemoteConnectionParams | string): string {
  const raw = typeof value === "string" ? value.trim() : value.source.toString();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "<unparseable remote url>";
  }
  const sid = url.searchParams.get("sid");
  if (sid !== null) url.searchParams.set("sid", maskSid(sid));
  if (url.searchParams.has("hash")) url.searchParams.set("hash", redactedMarker);
  return url.toString();
}
