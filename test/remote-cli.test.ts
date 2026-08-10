import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { runRemoteCommand, type RemoteConnectInput, type RunRemoteCommandOptions } from "../src/remote-cli.ts";
import type { RemoteConnectionSnapshot } from "../src/remote/client.ts";
import { addRemoteDevice, readRemoteDevices, type RemoteDeviceRecord } from "../src/remote/device-store.ts";

const passHash = "PASS-HASH-SECRET";
const deviceSid = "DEVICE-SID-SECRET";
const deviceUrl = `https://zcode.z.ai/remote/v4?sid=${deviceSid}&hash=${passHash}&t=1&mid=machine-1&name=Studio`;
const secondUrl = "https://zcode.z.ai/remote/v4?sid=OTHER-SID&hash=OTHER-HASH&t=2&name=Laptop";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function temporaryHome(): Promise<NodeJS.ProcessEnv> {
  const home = await mkdtemp(join(tmpdir(), "zcode-remote-cli-"));
  temporaryDirectories.push(home);
  return { HOME: home, USERPROFILE: home };
}

function output(): { stream: Writable & { isTTY?: boolean }; text: () => string } {
  let value = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      value += String(chunk);
      callback();
    }
  }) as Writable & { isTTY?: boolean };
  return { stream, text: () => value };
}

function snapshot(overrides: Partial<RemoteConnectionSnapshot> = {}): RemoteConnectionSnapshot {
  return {
    host: "zcode.z.ai",
    paired: true,
    state: "paired",
    workspaces: [{ key: "/w/one", name: "one", path: "/w/one" }],
    ...overrides
  };
}

interface Harness {
  connects: Array<{ input: RemoteConnectInput; record: RemoteDeviceRecord }>;
  options: RunRemoteCommandOptions;
  stderr: { text: () => string };
  stdout: { text: () => string };
}

function harness(
  env: NodeJS.ProcessEnv,
  overrides: Partial<RunRemoteCommandOptions> = {}
): Harness {
  const stdout = output();
  const stderr = output();
  const connects: Array<{ input: RemoteConnectInput; record: RemoteDeviceRecord }> = [];
  return {
    connects,
    options: {
      confirm: async () => true,
      connect: async (record, input) => {
        connects.push({ input, record });
        return snapshot();
      },
      env,
      stderr: stderr.stream,
      stdout: stdout.stream,
      ...overrides
    },
    stderr,
    stdout
  };
}

describe("remote CLI routing", () => {
  test("ignores arguments that are not a managed remote command", async () => {
    const env = await temporaryHome();
    const target = harness(env);
    expect(await runRemoteCommand(["--prompt", "remote add"], target.options)).toBeUndefined();
    expect(await runRemoteCommand(["remote", "unknown-action"], target.options)).toBeUndefined();
    expect(await runRemoteCommand(["plugins", "list"], target.options)).toBeUndefined();
    expect(await runRemoteCommand([], target.options)).toBeUndefined();
  });

  test("shows usage for a bare remote command and for --help", async () => {
    const env = await temporaryHome();
    const bare = harness(env);
    expect(await runRemoteCommand(["remote"], bare.options)).toBe(0);
    expect(bare.stdout.text()).toContain("zcode remote add <url>");

    const help = harness(env);
    expect(await runRemoteCommand(["remote", "list", "--help"], help.options)).toBe(0);
    expect(help.stdout.text()).toContain("zcode remote connect");
  });

  test("skips leading global options before the subcommand", async () => {
    const env = await temporaryHome();
    const target = harness(env);
    expect(await runRemoteCommand(["--json", "remote", "list"], target.options)).toBe(0);
    expect(JSON.parse(target.stdout.text())).toEqual({
      devices: [],
      path: expect.any(String)
    });
  });

  test("rejects unknown options locally", async () => {
    const env = await temporaryHome();
    const target = harness(env);
    expect(await runRemoteCommand(["remote", "list", "--unknown"], target.options)).toBe(1);
    expect(target.stderr.text()).toContain("Unknown option");
  });

  test("rejects options the subcommand does not support", async () => {
    const env = await temporaryHome();
    const target = harness(env);
    expect(await runRemoteCommand(["remote", "list", "--name", "x"], target.options)).toBe(1);
    expect(target.stderr.text()).toContain("--name is not supported.");
  });
});

describe("zcode remote add", () => {
  test("stores a device and reports it without the credential", async () => {
    const env = await temporaryHome();
    const target = harness(env);
    expect(await runRemoteCommand(["remote", "add", deviceUrl], target.options)).toBe(0);
    const text = target.stdout.text();
    expect(text).toContain("Added remote device Studio");
    expect(text).toContain("Host: zcode.z.ai");
    expect(text).toContain("owner-only permissions");
    expect(text).not.toContain(passHash);
    expect(text).not.toContain(deviceSid);
    expect((await readRemoteDevices(env)).map((record) => record.name)).toEqual(["Studio"]);
  });

  test("reads the credential from a file so it stays out of the argument list", async () => {
    const env = await temporaryHome();
    const file = join(env.HOME!, "device.txt");
    await writeFile(file, `\n# desktop pairing exported from ZCode\n${deviceUrl}\n`);
    const target = harness(env);
    expect(await runRemoteCommand(
      ["remote", "add", "--url-file", file, "--name", "studio"],
      target.options
    )).toBe(0);
    expect(target.stdout.text()).toContain("Added remote device studio");
    expect(target.stdout.text()).not.toContain(passHash);
  });

  test("emits a credential-free JSON document", async () => {
    const env = await temporaryHome();
    const target = harness(env);
    expect(await runRemoteCommand(["remote", "add", deviceUrl, "--json"], target.options)).toBe(0);
    const parsed = JSON.parse(target.stdout.text()) as Record<string, unknown>;
    expect(parsed["replaced"]).toBe(false);
    expect(target.stdout.text()).not.toContain(passHash);
    expect(target.stdout.text()).not.toContain(deviceSid);
    expect((parsed["device"] as Record<string, unknown>)["redactedUrl"]).toContain("hash=***");
  });

  test("reports an updated device when the pairing is re-added", async () => {
    const env = await temporaryHome();
    await addRemoteDevice(deviceUrl, "studio", env);
    const target = harness(env);
    expect(await runRemoteCommand(["remote", "add", deviceUrl], target.options)).toBe(0);
    expect(target.stdout.text()).toContain("Updated remote device studio");
  });

  test("requires exactly one URL source", async () => {
    const env = await temporaryHome();
    const missing = harness(env);
    expect(await runRemoteCommand(["remote", "add"], missing.options)).toBe(1);
    expect(missing.stderr.text()).toContain("Usage: zcode remote add");

    const both = harness(env);
    expect(await runRemoteCommand(
      ["remote", "add", deviceUrl, "--url-file", "/nowhere"],
      both.options
    )).toBe(1);
    expect(both.stderr.text()).toContain("Usage: zcode remote add");
  });

  test("keeps a rejected URL out of the failure message", async () => {
    const env = await temporaryHome();
    const target = harness(env);
    const broken = `https://zcode.z.ai/remote/v4?sid=${deviceSid}&hash=${passHash}`;
    expect(await runRemoteCommand(["remote", "add", broken], target.options)).toBe(1);
    const text = `${target.stdout.text()}${target.stderr.text()}`;
    expect(text).toContain("not usable");
    expect(text).not.toContain(passHash);
    expect(text).not.toContain(deviceSid);
  });

  test("reports an empty URL file", async () => {
    const env = await temporaryHome();
    const file = join(env.HOME!, "empty.txt");
    await writeFile(file, "\n\n");
    const target = harness(env);
    expect(await runRemoteCommand(["remote", "add", "--url-file", file], target.options)).toBe(1);
    expect(target.stderr.text()).toContain("No remote-control URL was found");
  });
});

describe("zcode remote list", () => {
  test("reports an empty store with a hint", async () => {
    const env = await temporaryHome();
    const target = harness(env);
    expect(await runRemoteCommand(["remote", "list"], target.options)).toBe(0);
    expect(target.stdout.text()).toContain("  (none)");
    expect(target.stdout.text()).toContain("zcode remote add <url>");
  });

  test("lists configured devices with their last connection state", async () => {
    const env = await temporaryHome();
    const added = await addRemoteDevice(deviceUrl, "studio", env);
    await addRemoteDevice(secondUrl, "laptop", env);
    const connected = harness(env);
    await runRemoteCommand(["remote", "connect", "studio"], connected.options);

    const target = harness(env);
    expect(await runRemoteCommand(["remote", "list"], target.options)).toBe(0);
    const text = target.stdout.text();
    expect(text).toContain(`studio (${added.record.id}) zcode.z.ai [paired] last `);
    expect(text).toContain("[never-connected]");
    expect(text).not.toContain(passHash);
    expect(text).not.toContain(deviceSid);
  });

  test("rejects a positional argument", async () => {
    const env = await temporaryHome();
    const target = harness(env);
    expect(await runRemoteCommand(["remote", "list", "extra"], target.options)).toBe(1);
    expect(target.stderr.text()).toContain("Usage: zcode remote list");
  });
});

describe("zcode remote remove", () => {
  test("removes a device after confirmation", async () => {
    const env = await temporaryHome();
    await addRemoteDevice(deviceUrl, "studio", env);
    const target = harness(env);
    expect(await runRemoteCommand(["remote", "remove", "studio"], target.options)).toBe(0);
    expect(target.stdout.text()).toContain("Removed remote device studio");
    expect(target.stdout.text()).toContain("regenerate it there to revoke");
    expect(await readRemoteDevices(env)).toEqual([]);
  });

  test("removes a device by id without confirmation when --yes is given", async () => {
    const env = await temporaryHome();
    const added = await addRemoteDevice(deviceUrl, "studio", env);
    let asked = false;
    const target = harness(env, {
      confirm: async () => {
        asked = true;
        return true;
      }
    });
    expect(await runRemoteCommand(["remote", "remove", added.record.id, "--yes"], target.options)).toBe(0);
    expect(asked).toBe(false);
    expect(await readRemoteDevices(env)).toEqual([]);
  });

  test("keeps the device when the confirmation is declined", async () => {
    const env = await temporaryHome();
    await addRemoteDevice(deviceUrl, "studio", env);
    const target = harness(env, { confirm: async () => false });
    expect(await runRemoteCommand(["remote", "remove", "studio"], target.options)).toBe(1);
    expect(target.stderr.text()).toContain("cancelled");
    expect(await readRemoteDevices(env)).toHaveLength(1);
  });

  test("reports an unknown selector and a missing argument", async () => {
    const env = await temporaryHome();
    const unknown = harness(env);
    expect(await runRemoteCommand(["remote", "remove", "absent", "--yes"], unknown.options)).toBe(1);
    expect(unknown.stderr.text()).toContain("No remote device matches absent");

    const missing = harness(env);
    expect(await runRemoteCommand(["remote", "remove"], missing.options)).toBe(1);
    expect(missing.stderr.text()).toContain("Usage: zcode remote remove");
  });
});

describe("zcode remote connect", () => {
  test("connects to the only configured device and reports the desktop", async () => {
    const env = await temporaryHome();
    await addRemoteDevice(deviceUrl, "studio", env);
    const target = harness(env);
    expect(await runRemoteCommand(["remote", "connect"], target.options)).toBe(0);
    const text = target.stdout.text();
    expect(text).toContain("Paired with studio (zcode.z.ai).");
    expect(text).toContain("Relay state: paired");
    expect(text).toContain("Workspaces: 1");
    expect(text).toContain("  - one");
    expect(target.connects).toHaveLength(1);
    expect(target.connects[0]!.input.pairingTimeoutMs).toBe(60_000);
    expect((await readRemoteDevices(env))[0]!.lastState).toBe("paired");
  });

  test("passes the selected workspace and timeout through", async () => {
    const env = await temporaryHome();
    await addRemoteDevice(deviceUrl, "studio", env);
    const target = harness(env);
    expect(await runRemoteCommand(
      ["remote", "connect", "studio", "--workspace", "/w/two", "--timeout", "15"],
      target.options
    )).toBe(0);
    expect(target.connects[0]!.input).toEqual({
      pairingTimeoutMs: 15_000,
      workspaceKey: "/w/two"
    });
  });

  test("validates the timeout", async () => {
    const env = await temporaryHome();
    await addRemoteDevice(deviceUrl, "studio", env);
    for (const value of ["0", "1", "abc", "9999"]) {
      const target = harness(env);
      expect(await runRemoteCommand(["remote", "connect", "--timeout", value], target.options)).toBe(1);
      expect(target.stderr.text()).toContain("--timeout");
    }
  });

  test("requires a device name when several are configured", async () => {
    const env = await temporaryHome();
    await addRemoteDevice(deviceUrl, "studio", env);
    await addRemoteDevice(secondUrl, "laptop", env);
    const target = harness(env);
    expect(await runRemoteCommand(["remote", "connect"], target.options)).toBe(1);
    expect(target.stderr.text()).toContain("Several remote devices are configured");
  });

  test("reports an empty store and an unknown selector", async () => {
    const env = await temporaryHome();
    const empty = harness(env);
    expect(await runRemoteCommand(["remote", "connect"], empty.options)).toBe(1);
    expect(empty.stderr.text()).toContain("No remote devices are configured");

    await addRemoteDevice(deviceUrl, "studio", env);
    const unknown = harness(env);
    expect(await runRemoteCommand(["remote", "connect", "absent"], unknown.options)).toBe(1);
    expect(unknown.stderr.text()).toContain("No remote device matches absent");
  });

  test("exits non-zero when the desktop was reached but never paired", async () => {
    const env = await temporaryHome();
    await addRemoteDevice(deviceUrl, "studio", env);
    const target = harness(env, {
      connect: async () => snapshot({ paired: false, state: "waiting", workspaces: [] })
    });
    expect(await runRemoteCommand(["remote", "connect"], target.options)).toBe(1);
    expect(target.stdout.text()).toContain("Reached studio");
    expect((await readRemoteDevices(env))[0]!.lastState).toBe("waiting");
  });

  test("records an unreachable device when connecting throws", async () => {
    const env = await temporaryHome();
    await addRemoteDevice(deviceUrl, "studio", env);
    const target = harness(env, {
      connect: async () => {
        throw new Error(`relay refused ${passHash}`);
      }
    });
    expect(await runRemoteCommand(["remote", "connect"], target.options)).toBe(1);
    expect((await readRemoteDevices(env))[0]!.lastState).toBe("unreachable");
  });

  test("returns the cancellation exit code when aborted", async () => {
    const env = await temporaryHome();
    await addRemoteDevice(deviceUrl, "studio", env);
    const target = harness(env, {
      connect: async () => {
        const error = new Error("Remote request cancelled.");
        error.name = "AbortError";
        throw error;
      }
    });
    expect(await runRemoteCommand(["remote", "connect"], target.options)).toBe(130);
  });

  test("emits a credential-free JSON document", async () => {
    const env = await temporaryHome();
    await addRemoteDevice(deviceUrl, "studio", env);
    const target = harness(env);
    expect(await runRemoteCommand(["remote", "connect", "--json"], target.options)).toBe(0);
    const parsed = JSON.parse(target.stdout.text()) as Record<string, unknown>;
    expect((parsed["connection"] as Record<string, unknown>)["state"]).toBe("paired");
    expect(target.stdout.text()).not.toContain(passHash);
    expect(target.stdout.text()).not.toContain(deviceSid);
  });
});

describe("remote CLI output hygiene", () => {
  test("strips control characters from rendered values", async () => {
    const env = await temporaryHome();
    const target = harness(env);
    expect(await runRemoteCommand(
      ["remote", "remove", "dev[31mice", "--yes"],
      target.options
    )).toBe(1);
    expect(target.stderr.text()).not.toContain("");
    expect(target.stderr.text()).toContain("dev?[31mice");
  });
});
