import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  addRemoteDevice,
  findRemoteDevice,
  readRemoteDevices,
  recordRemoteDeviceState,
  remoteDeviceId,
  remoteDeviceParams,
  remoteDeviceStorePath,
  remoteDeviceSummary,
  removeRemoteDevice,
  writeRemoteDevices,
  type RemoteDeviceRecord
} from "../src/remote/device-store.ts";

const passHash = "PASS-HASH-SECRET";
const deviceSid = "DEVICE-SID-SECRET";
const deviceUrl = `https://zcode.z.ai/remote/v4?sid=${deviceSid}&hash=${passHash}&t=1712345678`
  + "&mid=machine-1&name=Studio&app_version=1.2.3&theme=dark";
const secondUrl = "https://zcode.z.ai/remote/v4?sid=OTHER-SID&hash=OTHER-HASH&t=2&name=Laptop";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function temporaryHome(): Promise<NodeJS.ProcessEnv> {
  const home = await mkdtemp(join(tmpdir(), "zcode-remote-store-"));
  temporaryDirectories.push(home);
  return { HOME: home, USERPROFILE: home };
}

describe("remote device store location", () => {
  test("sits next to the user config file", async () => {
    const env = await temporaryHome();
    const path = remoteDeviceStorePath(env);
    expect(path.endsWith(join(".zcode", "cli", "remote-devices.json"))).toBe(true);
  });

  test("returns an empty list when nothing has been stored yet", async () => {
    expect(await readRemoteDevices(await temporaryHome())).toEqual([]);
  });
});

describe("remote device identity", () => {
  test("derives a stable, non-reversible id from the device session id", () => {
    const id = remoteDeviceId(deviceSid);
    expect(id).toMatch(/^[0-9a-f]{12}$/u);
    expect(remoteDeviceId(deviceSid)).toBe(id);
    expect(remoteDeviceId("other")).not.toBe(id);
    expect(id).not.toContain(deviceSid.slice(0, 6));
  });
});

describe("remote device round-trip", () => {
  test("stores every non-credential field and reads it back", async () => {
    const env = await temporaryHome();
    const added = await addRemoteDevice(deviceUrl, undefined, env);
    expect(added.replaced).toBe(false);
    expect(added.record).toEqual({
      addedAt: expect.any(String),
      appVersion: "1.2.3",
      host: "zcode.z.ai",
      id: remoteDeviceId(deviceSid),
      mid: "machine-1",
      name: "Studio",
      theme: "dark",
      url: expect.any(String)
    });

    const stored = await readRemoteDevices(env);
    expect(stored).toEqual([added.record]);
    expect(remoteDeviceParams(stored[0]!).deviceSid).toBe(deviceSid);
    expect(remoteDeviceParams(stored[0]!).passHash).toBe(passHash);
  });

  test("names a device after its host when the URL carries no name", async () => {
    const env = await temporaryHome();
    const added = await addRemoteDevice("https://desk.example.com/r?sid=s1&hash=h&t=1", undefined, env);
    expect(added.record.name).toBe("desk.example.com");
  });

  test("accepts an explicit name and rejects an unsafe one", async () => {
    const env = await temporaryHome();
    expect((await addRemoteDevice(deviceUrl, "my-desktop", env)).record.name).toBe("my-desktop");
    await expect(addRemoteDevice(secondUrl, "bad name", env)).rejects.toThrow(/Invalid device name/u);
    await expect(addRemoteDevice(secondUrl, "-leading", env)).rejects.toThrow(/Invalid device name/u);
  });

  test("keeps device names unique", async () => {
    const env = await temporaryHome();
    await addRemoteDevice(deviceUrl, "shared", env);
    const second = await addRemoteDevice(secondUrl, "shared", env);
    expect(second.record.name).toBe("shared-2");
    expect((await readRemoteDevices(env)).map((record) => record.name)).toEqual(["shared", "shared-2"]);
  });

  test("rewrites a known device in place when its pairing is rotated", async () => {
    const env = await temporaryHome();
    const first = await addRemoteDevice(deviceUrl, "studio", env);
    const rotated = `https://zcode.z.ai/remote/v4?sid=${deviceSid}&hash=ROTATED-HASH&t=99&app_version=2.0.0`;
    const second = await addRemoteDevice(rotated, undefined, env);
    expect(second.replaced).toBe(true);
    expect(second.record.id).toBe(first.record.id);
    expect(second.record.name).toBe("studio");
    expect(second.record.addedAt).toBe(first.record.addedAt);
    expect(second.record.appVersion).toBe("2.0.0");
    const stored = await readRemoteDevices(env);
    expect(stored).toHaveLength(1);
    expect(remoteDeviceParams(stored[0]!).passHash).toBe("ROTATED-HASH");
  });

  test("finds a device by id, exact name and case-insensitive name", async () => {
    const env = await temporaryHome();
    const added = await addRemoteDevice(deviceUrl, "Studio", env);
    const records = await readRemoteDevices(env);
    expect(findRemoteDevice(records, added.record.id)!.name).toBe("Studio");
    expect(findRemoteDevice(records, "Studio")!.id).toBe(added.record.id);
    expect(findRemoteDevice(records, "studio")!.id).toBe(added.record.id);
    expect(findRemoteDevice(records, "  ")).toBeUndefined();
    expect(findRemoteDevice(records, "absent")).toBeUndefined();
  });

  test("removes a device by name and reports an unknown selector", async () => {
    const env = await temporaryHome();
    await addRemoteDevice(deviceUrl, "studio", env);
    await addRemoteDevice(secondUrl, "laptop", env);
    expect(await removeRemoteDevice("absent", env)).toBeUndefined();
    const removed = await removeRemoteDevice("studio", env);
    expect(removed!.record.name).toBe("studio");
    expect((await readRemoteDevices(env)).map((record) => record.name)).toEqual(["laptop"]);
  });

  test("records the outcome of the last connection attempt", async () => {
    const env = await temporaryHome();
    const added = await addRemoteDevice(deviceUrl, "studio", env);
    expect(remoteDeviceSummary(added.record).lastState).toBe("never-connected");

    const updated = await recordRemoteDeviceState(added.record.id, "paired", env);
    expect(updated!.lastState).toBe("paired");
    expect(updated!.lastConnectedAt).toEqual(expect.any(String));
    expect(await recordRemoteDeviceState("absent-id", "paired", env)).toBeUndefined();

    const reAdded = await addRemoteDevice(deviceUrl, undefined, env);
    expect(reAdded.record.lastState).toBe("paired");
  });
});

describe("remote device store permissions", () => {
  test("creates the directory and file with owner-only access", async () => {
    const env = await temporaryHome();
    const path = (await addRemoteDevice(deviceUrl, undefined, env)).path;
    const file = await stat(path);
    const directory = await stat(dirname(path));
    if (process.platform !== "win32") {
      expect(file.mode & 0o777).toBe(0o600);
      expect(directory.mode & 0o777).toBe(0o700);
    }
  });

  test("tightens a store file that was left group-readable", async () => {
    const env = await temporaryHome();
    const path = (await addRemoteDevice(deviceUrl, undefined, env)).path;
    if (process.platform === "win32") return;
    await chmod(path, 0o644);
    await readRemoteDevices(env);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("rewrites the file atomically and leaves no temporary files behind", async () => {
    const env = await temporaryHome();
    const path = (await addRemoteDevice(deviceUrl, "studio", env)).path;
    await addRemoteDevice(secondUrl, "laptop", env);
    const contents = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(contents["version"]).toBe(1);
    expect((contents["devices"] as unknown[])).toHaveLength(2);
    const leftovers = await Array.fromAsync(new Bun.Glob(".remote-devices.json.*").scan(dirname(path)));
    expect(leftovers).toEqual([]);
  });
});

describe("remote device store validation", () => {
  test("refuses a URL that is not a usable remote-control URL", async () => {
    const env = await temporaryHome();
    for (const invalid of ["", "not a url", "https://zcode.z.ai/r?sid=s", "/relative?sid=s&hash=h&t=1"]) {
      await expect(addRemoteDevice(invalid, undefined, env)).rejects.toThrow(/not usable/u);
    }
    expect(await readRemoteDevices(env)).toEqual([]);
  });

  test("keeps the rejected URL out of the error message", async () => {
    const env = await temporaryHome();
    const failure: unknown = await addRemoteDevice(
      `https://zcode.z.ai/r?sid=${deviceSid}&hash=${passHash}`,
      undefined,
      env
    ).then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(passHash);
    expect((failure as Error).message).not.toContain(deviceSid);
  });

  test("reports a corrupt store instead of silently resetting it", async () => {
    const env = await temporaryHome();
    const path = remoteDeviceStorePath(env);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, "not json", { mode: 0o600 });
    await expect(readRemoteDevices(env)).rejects.toThrow(/not valid JSON/u);
    await writeFile(path, JSON.stringify({ version: 1 }), { mode: 0o600 });
    await expect(readRemoteDevices(env)).rejects.toThrow(/does not contain a device list/u);
  });

  test("skips entries that lost their required fields", async () => {
    const env = await temporaryHome();
    const path = remoteDeviceStorePath(env);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify({
      version: 1,
      devices: [
        { id: "a", name: "kept", host: "h", url: deviceUrl },
        { id: "b", name: "no-url", host: "h" },
        "text",
        null
      ]
    }), { mode: 0o600 });
    const records = await readRemoteDevices(env);
    expect(records.map((record) => record.name)).toEqual(["kept"]);
    expect(records[0]!.addedAt).toBe(new Date(0).toISOString());
  });

  test("fails a stored device whose URL is no longer parseable", () => {
    const broken: RemoteDeviceRecord = {
      addedAt: new Date(0).toISOString(),
      host: "zcode.z.ai",
      id: "abc",
      name: "broken",
      url: "not a url"
    };
    expect(() => remoteDeviceParams(broken)).toThrow(/no longer has a usable remote-control URL/u);
  });
});

describe("remote device summaries", () => {
  test("never carry the device credentials", async () => {
    const env = await temporaryHome();
    await addRemoteDevice(deviceUrl, "studio", env);
    const records = await readRemoteDevices(env);
    const rendered = JSON.stringify(records.map(remoteDeviceSummary));
    expect(rendered).not.toContain(passHash);
    expect(rendered).not.toContain(deviceSid);
    expect(rendered).toContain("hash=***");
    expect(rendered).toContain("machine-1");
  });

  test("survive a hand-written store with no optional fields", async () => {
    const env = await temporaryHome();
    await writeRemoteDevices([{
      addedAt: new Date(0).toISOString(),
      host: "zcode.z.ai",
      id: "abc",
      name: "minimal",
      url: "https://zcode.z.ai/r?sid=s&hash=h&t=1"
    }], env);
    const summary = remoteDeviceSummary((await readRemoteDevices(env))[0]!);
    expect(summary.appVersion).toBeUndefined();
    expect(summary.mid).toBeUndefined();
    expect(summary.lastState).toBe("never-connected");
    expect(summary.redactedUrl).toContain("hash=***");
  });
});
