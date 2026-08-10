import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRemoteConnectionUrl } from "../src/remote/connection-params.ts";
import {
  createRemoteHostLink,
  defaultRelayPageUrl,
  readRemoteHostLink,
  remoteHostLinkParams,
  remoteHostLinkStorePath,
  remoteHostLinkSummary,
  remoteHostLinkUrl,
  removeRemoteHostLink
} from "../src/remote/host-link.ts";

async function temporaryEnv(): Promise<NodeJS.ProcessEnv> {
  const home = await mkdtemp(join(tmpdir(), "zcode-host-link-"));
  return { HOME: home, USERPROFILE: home };
}

describe("remote host link creation", () => {
  test("creates a link whose URL parses back into connection params", async () => {
    const env = await temporaryEnv();
    const result = await createRemoteHostLink({ name: "workstation" }, env);
    expect(result.rotated).toBe(false);
    expect(result.record.name).toBe("workstation");
    expect(result.record.relayUrl).toBe(defaultRelayPageUrl);

    const url = remoteHostLinkUrl(result.record, "1.2.3");
    const params = parseRemoteConnectionUrl(url);
    expect(params).toBeDefined();
    expect(params!.deviceSid).toBe(result.record.deviceSid);
    expect(params!.passHash).toBe(result.record.passHash);
    expect(params!.deviceMid).toBe(result.record.mid);
    expect(params!.deviceName).toBe("workstation");
    expect(params!.appVersion).toBe("1.2.3");
    expect(remoteHostLinkParams(result.record).deviceSid).toBe(result.record.deviceSid);
  });

  test("generates unpredictable, distinct credentials", async () => {
    const env = await temporaryEnv();
    const first = await createRemoteHostLink({}, env);
    const second = await createRemoteHostLink({}, env);
    expect(second.record.deviceSid).not.toBe(first.record.deviceSid);
    expect(second.record.passHash).not.toBe(first.record.passHash);
    expect(first.record.deviceSid.length).toBeGreaterThanOrEqual(32);
    expect(first.record.passHash.length).toBeGreaterThanOrEqual(43);
  });

  test("rotation mints new credentials but keeps the machine id and name", async () => {
    const env = await temporaryEnv();
    const first = await createRemoteHostLink({ name: "studio" }, env);
    const second = await createRemoteHostLink({}, env);
    expect(second.rotated).toBe(true);
    expect(second.record.mid).toBe(first.record.mid);
    expect(second.record.name).toBe("studio");
    expect(second.record.createdAt).toBe(first.record.createdAt);
    expect(second.record.rotatedAt).toBeDefined();
    expect(second.record.deviceSid).not.toBe(first.record.deviceSid);
  });

  test("rejects invalid names and relay URLs", async () => {
    const env = await temporaryEnv();
    await expect(createRemoteHostLink({ name: "bad name!" }, env)).rejects.toThrow("Invalid device name");
    await expect(createRemoteHostLink({ relayUrl: "not a url" }, env)).rejects.toThrow("absolute URL");
    await expect(createRemoteHostLink({ relayUrl: "ftp://relay.example" }, env)).rejects.toThrow("http(s) or ws(s)");
    await expect(createRemoteHostLink({ relayUrl: "https://relay.example/v4?x=1" }, env))
      .rejects.toThrow("query parameters");
  });

  test("accepts a custom relay page URL", async () => {
    const env = await temporaryEnv();
    const result = await createRemoteHostLink({ relayUrl: "https://relay.example/remote/v4" }, env);
    const params = parseRemoteConnectionUrl(remoteHostLinkUrl(result.record))!;
    expect(params.source.host).toBe("relay.example");
  });
});

describe("remote host link store", () => {
  test("persists with owner-only permissions and reads back", async () => {
    const env = await temporaryEnv();
    const created = await createRemoteHostLink({ name: "laptop" }, env);
    if (process.platform !== "win32") {
      const mode = (await stat(created.path)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    const read = await readRemoteHostLink(env);
    expect(read).toEqual(created.record);
    expect(created.path).toBe(remoteHostLinkStorePath(env));
  });

  test("reads undefined when no link was created", async () => {
    const env = await temporaryEnv();
    expect(await readRemoteHostLink(env)).toBeUndefined();
  });

  test("removal deletes the credential", async () => {
    const env = await temporaryEnv();
    const created = await createRemoteHostLink({}, env);
    const removed = await removeRemoteHostLink(env);
    expect(removed?.record).toEqual(created.record);
    expect(await readRemoteHostLink(env)).toBeUndefined();
    expect(await removeRemoteHostLink(env)).toBeUndefined();
  });

  test("the stored file never contains the credentials in summary form", async () => {
    const env = await temporaryEnv();
    const created = await createRemoteHostLink({ name: "studio" }, env);
    const summary = remoteHostLinkSummary(created.record);
    const printed = JSON.stringify(summary);
    expect(printed).not.toContain(created.record.deviceSid);
    expect(printed).not.toContain(created.record.passHash);
    expect(summary.redactedUrl).toContain("***");
    expect(summary.host).toBe("zcode.z.ai");
    expect(summary.name).toBe("studio");
    expect(summary.id).toHaveLength(12);

    const raw = await readFile(created.path, "utf8");
    expect(raw).toContain(created.record.deviceSid);
  });
});
