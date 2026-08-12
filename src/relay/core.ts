import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const defaultAuthTimeoutMs = 15_000;
const defaultIdleTimeoutMs = 60_000;
const defaultMaximumRegistrations = 1024;
const defaultRegistrationTtlMs = 30 * 24 * 60 * 60 * 1000;
const deviceSidBytes = 24;
const nonceBytes = 18;
const midPattern = /^[A-Za-z0-9._-]{1,128}$/u;
const minimumPassHashLength = 16;
const maximumPassHashLength = 512;
const maximumNameLength = 64;

/** Protocol-outcome close codes; `relayCloseReason` in relay-client.ts maps the same values. */
export const relayProtocolCloseCodes = {
  desktopDisconnected: 4010,
  invalidConnection: 4013,
  sessionConflict: 4009,
  sessionExpired: 4011,
  sessionNotFound: 4004,
  workspaceClosed: 4012
} as const;

const transportCloseCodes = {
  goingAway: 1001,
  policyViolation: 1008,
  tryAgainLater: 1013
} as const;

export const relayRoleNames = ["device", "terminal"] as const;
export type RelayCoreRole = (typeof relayRoleNames)[number];

/** The slice of a connection the core drives; the server binds it to a real WebSocket. */
export interface RelayLink {
  close(code: number, reason: string): void;
  send(text: string): void;
}

/**
 * One registered device identity. `passHash` is the proof-HMAC key — a credential that must never
 * be logged; persistence writes it with owner-only file permissions.
 */
export interface RelayRegistrationRecord {
  createdAt: number;
  deviceSid: string;
  lastSeenAt: number;
  mid: string;
  name?: string;
  passHash: string;
}

export interface RelayCoreOptions {
  /** Deadline for a connection to finish authenticating (or registering) after it opens. */
  authTimeoutMs?: number;
  /** Authenticated connections silent for longer than this are dropped as dead. */
  idleTimeoutMs?: number;
  maximumRegistrations?: number;
  now?: () => number;
  onLog?: (line: string) => void;
  /** Fires after any registration change; the server persists the store from it. */
  onRegistrationsChanged?: () => void;
  /** Registrations unused for longer than this are expired; `auth_init` then closes with 4011. */
  registrationTtlMs?: number;
}

export interface RelayCoreSnapshot {
  authenticatedConnections: number;
  connections: number;
  pairedSessions: number;
  registrations: number;
  sessions: number;
}

type ConnectionStage = "authenticated" | "challenged" | "closed" | "fresh";

interface CoreConnection {
  authDeadlineAt: number;
  deviceSid?: string;
  id: number;
  lastActivityAt: number;
  link: RelayLink;
  nonce?: string;
  role?: RelayCoreRole;
  stage: ConnectionStage;
}

interface CoreSession {
  device?: CoreConnection;
  terminal?: CoreConnection;
}

/** Opaque per-connection handle handed back to the transport layer. */
export interface RelayConnectionHandle {
  readonly id: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRole(value: unknown): value is RelayCoreRole {
  return value === "device" || value === "terminal";
}

/** Mirrors `calculateProof` in src/remote/proof.ts; the two must stay in lockstep. */
export function expectedRelayProof(passHash: string, nonce: string, role: string, deviceSid: string): string {
  return createHmac("sha256", Buffer.from(passHash, "utf8"))
    .update(`${nonce}|${role}|${deviceSid}`, "utf8")
    .digest("base64url");
}

function proofsMatch(expected: string, provided: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const providedBytes = Buffer.from(provided, "utf8");
  if (expectedBytes.length !== providedBytes.length) return false;
  return timingSafeEqual(expectedBytes, providedBytes);
}

export function parseRelayRegistrationRecord(value: unknown): RelayRegistrationRecord | undefined {
  if (!isRecord(value)) return undefined;
  const deviceSid = stringField(value["deviceSid"]);
  const mid = stringField(value["mid"]);
  const passHash = stringField(value["passHash"]);
  const createdAt = typeof value["createdAt"] === "number" ? value["createdAt"] : undefined;
  const lastSeenAt = typeof value["lastSeenAt"] === "number" ? value["lastSeenAt"] : undefined;
  if (deviceSid === undefined || mid === undefined || passHash === undefined
    || createdAt === undefined || lastSeenAt === undefined) {
    return undefined;
  }
  const name = stringField(value["name"]);
  return { createdAt, deviceSid, lastSeenAt, mid, ...(name !== undefined ? { name } : {}), passHash };
}

/**
 * The relay protocol engine, independent of any socket type: registration, challenge/proof
 * authentication, host/controller pairing per device session id, pair-status pushes, duplicate
 * takeover, data forwarding and time-based sweeping. All timing flows through the injected clock
 * and the explicit {@link RelayCore.tick}, so tests are fully deterministic.
 *
 * Frames and registrations carry credentials (`pass_hash`, proofs, sids), so nothing here ever
 * logs a frame verbatim.
 */
export class RelayCore {
  private readonly authTimeoutMs: number;
  private readonly connections = new Map<number, CoreConnection>();
  private readonly idleTimeoutMs: number;
  private readonly maximumRegistrations: number;
  private readonly now: () => number;
  private readonly onLog: ((line: string) => void) | undefined;
  private readonly onRegistrationsChanged: (() => void) | undefined;
  private readonly registrationTtlMs: number;
  private readonly registrationsByMid = new Map<string, RelayRegistrationRecord>();
  private readonly registrationsBySid = new Map<string, RelayRegistrationRecord>();
  private readonly sessions = new Map<string, CoreSession>();

  private nextConnectionId = 1;

  constructor(options: RelayCoreOptions = {}) {
    this.authTimeoutMs = options.authTimeoutMs ?? defaultAuthTimeoutMs;
    this.idleTimeoutMs = options.idleTimeoutMs ?? defaultIdleTimeoutMs;
    this.maximumRegistrations = options.maximumRegistrations ?? defaultMaximumRegistrations;
    this.now = options.now ?? (() => Date.now());
    this.onLog = options.onLog;
    this.onRegistrationsChanged = options.onRegistrationsChanged;
    this.registrationTtlMs = options.registrationTtlMs ?? defaultRegistrationTtlMs;
  }

  /** Seeds registrations from a persisted store; invalid entries are dropped silently. */
  loadRegistrations(records: unknown[]): number {
    let loaded = 0;
    for (const value of records) {
      const record = parseRelayRegistrationRecord(value);
      if (record === undefined) continue;
      if (this.registrationsBySid.has(record.deviceSid) || this.registrationsByMid.has(record.mid)) continue;
      if (this.registrationsBySid.size >= this.maximumRegistrations) break;
      this.registrationsBySid.set(record.deviceSid, record);
      this.registrationsByMid.set(record.mid, record);
      loaded += 1;
    }
    return loaded;
  }

  /** Copy of the registration store for persistence. */
  registrationRecords(): RelayRegistrationRecord[] {
    return [...this.registrationsBySid.values()].map((record) => ({ ...record }));
  }

  snapshot(): RelayCoreSnapshot {
    let authenticated = 0;
    for (const connection of this.connections.values()) {
      if (connection.stage === "authenticated") authenticated += 1;
    }
    let paired = 0;
    for (const session of this.sessions.values()) {
      if (session.device !== undefined && session.terminal !== undefined) paired += 1;
    }
    return {
      authenticatedConnections: authenticated,
      connections: this.connections.size,
      pairedSessions: paired,
      registrations: this.registrationsBySid.size,
      sessions: this.sessions.size
    };
  }

  open(link: RelayLink): RelayConnectionHandle {
    const now = this.now();
    const connection: CoreConnection = {
      authDeadlineAt: now + this.authTimeoutMs,
      id: this.nextConnectionId,
      lastActivityAt: now,
      link,
      stage: "fresh"
    };
    this.nextConnectionId += 1;
    this.connections.set(connection.id, connection);
    this.log(`[relay] connection ${connection.id} opened (${this.connections.size} total)`);
    return { id: connection.id };
  }

  /** Any transport-level liveness signal (including ping/pong) counts against the idle timeout. */
  activity(handle: RelayConnectionHandle): void {
    const connection = this.connections.get(handle.id);
    if (connection !== undefined) connection.lastActivityAt = this.now();
  }

  message(handle: RelayConnectionHandle, text: string): void {
    const connection = this.connections.get(handle.id);
    if (connection === undefined || connection.stage === "closed") return;
    connection.lastActivityAt = this.now();

    let frame: Record<string, unknown>;
    try {
      const decoded: unknown = JSON.parse(text);
      if (!isRecord(decoded)) throw new Error("not a frame object");
      frame = decoded;
    } catch {
      this.closeConnection(connection, transportCloseCodes.policyViolation, "invalid frame");
      return;
    }
    const type = stringField(frame["type"]);
    if (type === "device_register_init") {
      this.handleRegister(connection, frame);
      return;
    }
    if (type === "auth_init") {
      this.handleAuthInit(connection, frame);
      return;
    }
    if (type === "auth_response") {
      this.handleAuthResponse(connection, frame);
      return;
    }
    if (type === "pair_status_query") {
      this.handlePairStatusQuery(connection);
      return;
    }
    if (type === "data") {
      this.handleData(connection, frame);
      return;
    }
    // Unknown frame types from an authenticated peer are tolerated for forward compatibility;
    // before authentication they are a protocol violation and end the connection.
    if (connection.stage === "authenticated") {
      this.log(`[relay] connection ${connection.id} sent unknown frame type`);
      return;
    }
    this.closeConnection(connection, transportCloseCodes.policyViolation, "unexpected frame");
  }

  closed(handle: RelayConnectionHandle): void {
    const connection = this.connections.get(handle.id);
    if (connection === undefined) return;
    this.forgetConnection(connection, true);
  }

  /** Time-based sweeping; the server calls this on an interval, tests call it directly. */
  tick(): void {
    const now = this.now();
    for (const connection of [...this.connections.values()]) {
      if (connection.stage === "fresh" || connection.stage === "challenged") {
        if (now >= connection.authDeadlineAt) {
          this.closeConnection(connection, transportCloseCodes.policyViolation, "authentication timeout");
        }
        continue;
      }
      if (connection.stage === "authenticated" && now - connection.lastActivityAt > this.idleTimeoutMs) {
        this.closeConnection(connection, transportCloseCodes.goingAway, "idle timeout");
      }
    }
    let pruned = 0;
    for (const record of [...this.registrationsBySid.values()]) {
      if (now - record.lastSeenAt <= this.registrationTtlMs) continue;
      this.dropRegistration(record, "session-expired");
      pruned += 1;
    }
    if (pruned > 0) {
      this.log(`[relay] pruned ${pruned} expired registration(s)`);
      this.onRegistrationsChanged?.();
    }
  }

  private log(line: string): void {
    this.onLog?.(line);
  }

  private send(connection: CoreConnection, frame: Record<string, unknown>): void {
    try {
      connection.link.send(JSON.stringify(frame));
    } catch {
      this.log(`[relay] send to connection ${connection.id} failed`);
    }
  }

  private closeConnection(connection: CoreConnection, code: number, reason: string): void {
    if (connection.stage === "closed") return;
    this.forgetConnection(connection, true);
    try {
      connection.link.close(code, reason);
    } catch {
      // A transport that already died still had its state cleaned up above.
    }
    this.log(`[relay] connection ${connection.id} closed (${code} ${reason})`);
  }

  private forgetConnection(connection: CoreConnection, notifyPeer: boolean): void {
    if (connection.stage === "closed") return;
    connection.stage = "closed";
    this.connections.delete(connection.id);
    this.detachFromSession(connection, notifyPeer);
  }

  private detachFromSession(connection: CoreConnection, notifyPeer: boolean): void {
    const sid = connection.deviceSid;
    if (sid === undefined) return;
    const session = this.sessions.get(sid);
    if (session === undefined) return;
    let peer: CoreConnection | undefined;
    if (session.device === connection) {
      delete session.device;
      peer = session.terminal;
    } else if (session.terminal === connection) {
      delete session.terminal;
      peer = session.device;
    } else {
      return;
    }
    if (session.device === undefined && session.terminal === undefined) {
      this.sessions.delete(sid);
      return;
    }
    if (notifyPeer && peer !== undefined) {
      this.send(peer, { type: "pair_status_ack", pair_status: "waiting", server_ts: this.now() });
    }
  }

  private dropRegistration(record: RelayRegistrationRecord, reason: "credential-rotated" | "session-expired"): void {
    this.registrationsBySid.delete(record.deviceSid);
    this.registrationsByMid.delete(record.mid);
    const session = this.sessions.get(record.deviceSid);
    if (session === undefined) return;
    for (const occupant of [session.device, session.terminal]) {
      if (occupant !== undefined) {
        this.closeConnection(occupant, relayProtocolCloseCodes.sessionExpired, reason);
      }
    }
    this.sessions.delete(record.deviceSid);
  }

  private mintDeviceSid(): string {
    for (;;) {
      const sid = randomBytes(deviceSidBytes).toString("base64url");
      if (!this.registrationsBySid.has(sid)) return sid;
    }
  }

  private handleRegister(connection: CoreConnection, frame: Record<string, unknown>): void {
    if (connection.stage !== "fresh") {
      this.closeConnection(connection, transportCloseCodes.policyViolation, "unexpected registration");
      return;
    }
    const mid = stringField(frame["device_mid"]);
    const passHash = stringField(frame["pass_hash"]);
    if (
      mid === undefined || !midPattern.test(mid)
      || passHash === undefined
      || passHash.length < minimumPassHashLength || passHash.length > maximumPassHashLength
    ) {
      this.send(connection, { type: "error", code: "REGISTRATION_INVALID", message: "invalid registration" });
      this.closeConnection(connection, transportCloseCodes.policyViolation, "invalid registration");
      return;
    }
    const existing = this.registrationsByMid.get(mid);
    if (existing === undefined && this.registrationsBySid.size >= this.maximumRegistrations) {
      this.send(connection, { type: "error", code: "REGISTRATION_LIMIT", message: "registration store is full" });
      this.closeConnection(connection, transportCloseCodes.tryAgainLater, "registration store is full");
      return;
    }
    // Re-registering a machine id rotates its credential: the old sid dies immediately, which is
    // how a leaked pairing URL is revoked.
    if (existing !== undefined) this.dropRegistration(existing, "credential-rotated");

    const meta = isRecord(frame["meta"]) ? frame["meta"] : {};
    const name = stringField(meta["name"])?.slice(0, maximumNameLength);
    const now = this.now();
    const record: RelayRegistrationRecord = {
      createdAt: existing?.createdAt ?? now,
      deviceSid: this.mintDeviceSid(),
      lastSeenAt: now,
      mid,
      ...(name !== undefined ? { name } : {}),
      passHash
    };
    this.registrationsBySid.set(record.deviceSid, record);
    this.registrationsByMid.set(mid, record);
    this.log(`[relay] connection ${connection.id} registered a device (${this.registrationsBySid.size} total)`);
    this.send(connection, { type: "device_register_ack", device_sid: record.deviceSid, server_ts: now });
    this.onRegistrationsChanged?.();
  }

  private handleAuthInit(connection: CoreConnection, frame: Record<string, unknown>): void {
    if (connection.stage !== "fresh") {
      this.closeConnection(connection, transportCloseCodes.policyViolation, "unexpected auth_init");
      return;
    }
    const role = frame["role"];
    if (!isRole(role)) {
      this.closeConnection(connection, transportCloseCodes.policyViolation, "unsupported role");
      return;
    }
    const deviceSid = stringField(frame["device_sid"]);
    if (deviceSid === undefined) {
      this.closeConnection(connection, transportCloseCodes.policyViolation, "auth_init carried no device_sid");
      return;
    }
    const registration = this.registrationsBySid.get(deviceSid);
    if (registration === undefined) {
      this.closeConnection(connection, relayProtocolCloseCodes.sessionNotFound, "session-not-found");
      return;
    }
    if (this.now() - registration.lastSeenAt > this.registrationTtlMs) {
      this.dropRegistration(registration, "session-expired");
      this.onRegistrationsChanged?.();
      this.closeConnection(connection, relayProtocolCloseCodes.sessionExpired, "session-expired");
      return;
    }
    connection.deviceSid = deviceSid;
    connection.role = role;
    connection.nonce = randomBytes(nonceBytes).toString("base64url");
    connection.stage = "challenged";
    this.send(connection, { type: "auth_challenge", nonce: connection.nonce, server_ts: this.now() });
  }

  private handleAuthResponse(connection: CoreConnection, frame: Record<string, unknown>): void {
    if (connection.stage !== "challenged"
      || connection.deviceSid === undefined
      || connection.role === undefined
      || connection.nonce === undefined) {
      this.closeConnection(connection, transportCloseCodes.policyViolation, "unexpected auth_response");
      return;
    }
    if (stringField(frame["device_sid"]) !== connection.deviceSid) {
      this.closeConnection(connection, transportCloseCodes.policyViolation, "auth_response device mismatch");
      return;
    }
    const registration = this.registrationsBySid.get(connection.deviceSid);
    if (registration === undefined) {
      this.closeConnection(connection, relayProtocolCloseCodes.sessionNotFound, "session-not-found");
      return;
    }
    const proof = stringField(frame["proof"]);
    const expected = expectedRelayProof(
      registration.passHash,
      connection.nonce,
      connection.role,
      connection.deviceSid
    );
    if (proof === undefined || !proofsMatch(expected, proof)) {
      this.log(`[relay] connection ${connection.id} failed proof verification`);
      this.closeConnection(connection, relayProtocolCloseCodes.invalidConnection, "invalid-proof");
      return;
    }
    connection.stage = "authenticated";
    connection.nonce = undefined;
    registration.lastSeenAt = this.now();
    this.onRegistrationsChanged?.();
    this.attachToSession(connection);
  }

  private attachToSession(connection: CoreConnection): void {
    const sid = connection.deviceSid!;
    const role = connection.role!;
    let session = this.sessions.get(sid);
    if (session === undefined) {
      session = {};
      this.sessions.set(sid, session);
    }
    // Duplicate connections are deterministic: the newest one wins so a restarted host or
    // controller can always take its slot back; the old one is told it was kicked, which the
    // client treats as terminal (no reconnect loop).
    const occupant = role === "device" ? session.device : session.terminal;
    if (occupant !== undefined) {
      this.send(occupant, {
        type: "error",
        code: "KICKED",
        message: `another ${role === "device" ? "host" : "controller"} connection took over this session`
      });
      // The occupant's slot is being replaced, so its departure must not push a `waiting` status.
      this.forgetConnection(occupant, false);
      try {
        occupant.link.close(relayProtocolCloseCodes.sessionConflict, "session-conflict");
      } catch {
        // The kicked transport may already be gone.
      }
      this.log(`[relay] connection ${occupant.id} kicked by newer ${role}`);
      // Detaching the occupant removes an empty session from the map; re-attach under the same
      // sid so the replacement lands in the session a later peer will find.
      session = this.sessions.get(sid);
      if (session === undefined) {
        session = {};
        this.sessions.set(sid, session);
      }
    }
    if (role === "device") session.device = connection;
    else session.terminal = connection;

    const status = this.pairStatus(session);
    this.send(connection, { type: "auth_ack", pair_status: status, server_ts: this.now() });
    const peer = role === "device" ? session.terminal : session.device;
    // The peer learns about the status change by push; its next heartbeat would be seconds away
    // and payloads queue client-side until the pairing is visible.
    if (peer !== undefined) {
      this.send(peer, { type: "pair_status_ack", pair_status: status, server_ts: this.now() });
    }
    this.log(`[relay] connection ${connection.id} authenticated as ${role} (${status})`);
  }

  private pairStatus(session: CoreSession): "matched" | "waiting" {
    return session.device !== undefined && session.terminal !== undefined ? "matched" : "waiting";
  }

  private handlePairStatusQuery(connection: CoreConnection): void {
    if (connection.stage !== "authenticated" || connection.deviceSid === undefined) {
      this.closeConnection(connection, transportCloseCodes.policyViolation, "unauthenticated pair_status_query");
      return;
    }
    const session = this.sessions.get(connection.deviceSid);
    const status = session === undefined ? "waiting" : this.pairStatus(session);
    this.send(connection, { type: "pair_status_ack", pair_status: status, server_ts: this.now() });
  }

  private handleData(connection: CoreConnection, frame: Record<string, unknown>): void {
    if (connection.stage !== "authenticated" || connection.deviceSid === undefined) {
      this.closeConnection(connection, transportCloseCodes.policyViolation, "unauthenticated data frame");
      return;
    }
    const payload = frame["payload"];
    if (!isRecord(payload)) {
      this.log(`[relay] connection ${connection.id} sent a non-object payload; dropped`);
      return;
    }
    const session = this.sessions.get(connection.deviceSid);
    const peer = connection.role === "device" ? session?.terminal : session?.device;
    if (peer === undefined) {
      // The peer just dropped; the sender's client queues once it observes the status change.
      this.log(`[relay] connection ${connection.id} sent data with no peer; dropped`);
      return;
    }
    this.send(peer, { type: "data", payload, server_ts: this.now() });
  }
}
