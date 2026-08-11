import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import type { RemoteConnectionParams } from "../src/remote/connection-params.ts";
import { createRemoteHostLink, readRemoteHostLink } from "../src/remote/host-link.ts";
import type { RemoteHostBackend, RemoteHostServiceOptions } from "../src/remote/host.ts";
import type { RelayFailure, RelayState } from "../src/remote/relay-client.ts";
import {
  remoteHostWorkspaceForPath,
  runRemoteCommand,
  type RunRemoteCommandOptions
} from "../src/remote-cli.ts";

interface CapturedOutput {
  stderr: Writable & { isTTY?: boolean };
  stderrText: () => string;
  stdout: Writable & { isTTY?: boolean };
  stdoutText: () => string;
}

function capture(): CapturedOutput {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      out.push(String(chunk));
      callback();
    }
  });
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      err.push(String(chunk));
      callback();
    }
  });
  return {
    stderr,
    stderrText: () => err.join(""),
    stdout,
    stdoutText: () => out.join("")
  };
}

async function temporaryEnv(): Promise<NodeJS.ProcessEnv> {
  const home = await mkdtemp(join(tmpdir(), "zcode-host-cli-"));
  return { HOME: home, USERPROFILE: home };
}

async function run(
  args: string[],
  env: NodeJS.ProcessEnv,
  options: Partial<RunRemoteCommandOptions> = {}
): Promise<{ code: number | undefined; output: CapturedOutput }> {
  const output = capture();
  const code = await runRemoteCommand(args, {
    env,
    stderr: output.stderr,
    stdout: output.stdout,
    registerHostLink: async (record) => record,
    ...options
  });
  return { code, output };
}

describe("zcode remote link create", () => {
  test("creates a link and prints the pairing URL once", async () => {
    const env = await temporaryEnv();
    const { code, output } = await run(["remote", "link", "create", "--name", "workstation"], env, {
      appVersion: "9.9.9"
    });
    expect(code).toBe(0);
    const text = output.stdoutText();
    expect(text).toContain("Created the remote-control link for this machine");
    expect(text).toContain("Device name: workstation");
    const record = (await readRemoteHostLink(env))!;
    expect(text).toContain(record.deviceSid);
    expect(text).toContain("app_version=9.9.9");
    expect(text).toContain("zcode remote serve");
  });

  test("writes the URL to a file instead of stdout with --url-file", async () => {
    const env = await temporaryEnv();
    const urlFile = join(env.HOME!, "link.txt");
    const { code, output } = await run(["remote", "link", "create", "--url-file", urlFile], env);
    expect(code).toBe(0);
    const record = (await readRemoteHostLink(env))!;
    expect(output.stdoutText()).not.toContain(record.deviceSid);
    expect(output.stdoutText()).toContain("Pairing URL written to");
    const written = await readFile(urlFile, "utf8");
    expect(written).toContain(record.deviceSid);
    expect(written).toContain(record.passHash);
    if (process.platform !== "win32") {
      expect((await stat(urlFile)).mode & 0o777).toBe(0o600);
    }
  });

  test("re-creating rotates the credentials", async () => {
    const env = await temporaryEnv();
    await run(["remote", "link", "create"], env);
    const first = (await readRemoteHostLink(env))!;
    const { code, output } = await run(["remote", "link", "create", "--json"], env);
    expect(code).toBe(0);
    const parsed = JSON.parse(output.stdoutText()) as Record<string, unknown>;
    expect(parsed["rotated"]).toBe(true);
    const second = (await readRemoteHostLink(env))!;
    expect(second.deviceSid).not.toBe(first.deviceSid);
    expect(second.mid).toBe(first.mid);
  });

  test("accepts a custom relay and validates it", async () => {
    const env = await temporaryEnv();
    const good = await run(["remote", "link", "create", "--relay", "https://relay.example/remote/v4"], env);
    expect(good.code).toBe(0);
    expect((await readRemoteHostLink(env))!.relayUrl).toBe("https://relay.example/remote/v4");
    const bad = await run(["remote", "link", "create", "--relay", "ftp://x"], env);
    expect(bad.code).toBe(1);
    expect(bad.output.stderrText()).toContain("http(s) or ws(s)");
  });
});

describe("zcode remote link show", () => {
  test("prints a redacted summary by default", async () => {
    const env = await temporaryEnv();
    await createRemoteHostLink({ name: "studio" }, env);
    const record = (await readRemoteHostLink(env))!;
    const { code, output } = await run(["remote", "link"], env);
    expect(code).toBe(0);
    const text = output.stdoutText();
    expect(text).toContain("studio");
    expect(text).not.toContain(record.passHash);
    expect(text).not.toContain(record.deviceSid);
    expect(text).toContain("--reveal");
  });

  test("--reveal prints the full URL", async () => {
    const env = await temporaryEnv();
    await createRemoteHostLink({}, env);
    const record = (await readRemoteHostLink(env))!;
    const { code, output } = await run(["remote", "link", "show", "--reveal"], env);
    expect(code).toBe(0);
    expect(output.stdoutText()).toContain(record.deviceSid);
    expect(output.stdoutText()).toContain(record.passHash);
  });

  test("fails helpfully when no link exists", async () => {
    const env = await temporaryEnv();
    const { code, output } = await run(["remote", "link"], env);
    expect(code).toBe(1);
    expect(output.stderrText()).toContain("zcode remote link create");
  });
});

describe("zcode remote link revoke", () => {
  test("deletes the stored link with --yes", async () => {
    const env = await temporaryEnv();
    await createRemoteHostLink({}, env);
    const { code, output } = await run(["remote", "link", "revoke", "--yes"], env);
    expect(code).toBe(0);
    expect(output.stdoutText()).toContain("Revoked the remote-control link");
    expect(await readRemoteHostLink(env)).toBeUndefined();
  });

  test("requires confirmation without --yes", async () => {
    const env = await temporaryEnv();
    await createRemoteHostLink({}, env);
    const { code } = await run(["remote", "link", "revoke"], env, {
      confirm: async () => false
    });
    expect(code).toBe(1);
    expect(await readRemoteHostLink(env)).toBeDefined();
  });

  test("fails when nothing is stored", async () => {
    const env = await temporaryEnv();
    const { code, output } = await run(["remote", "link", "revoke", "--yes"], env);
    expect(code).toBe(1);
    expect(output.stderrText()).toContain("Nothing to revoke");
  });
});

interface FakeHost {
  backend: RemoteHostBackend;
  disposed: boolean;
  emitFailure: (failure: RelayFailure) => void;
  emitState: (state: RelayState) => void;
  hostOptions: RemoteHostServiceOptions;
  params: RemoteConnectionParams;
  started: boolean;
}

function fakeHostFactory(hosts: FakeHost[]): NonNullable<RunRemoteCommandOptions["createHost"]> {
  return (params, backend, hostOptions) => {
    const stateListeners = new Set<(state: RelayState) => void>();
    const failureListeners = new Set<(failure: RelayFailure) => void>();
    const host: FakeHost = {
      backend,
      disposed: false,
      emitFailure: (failure) => {
        for (const listener of [...failureListeners]) listener(failure);
      },
      emitState: (state) => {
        for (const listener of [...stateListeners]) listener(state);
      },
      hostOptions,
      params,
      started: false
    };
    hosts.push(host);
    return {
      dispose: () => {
        host.disposed = true;
      },
      onFailure: (listener) => {
        failureListeners.add(listener);
        return () => failureListeners.delete(listener);
      },
      onState: (listener) => {
        stateListeners.add(listener);
        return () => stateListeners.delete(listener);
      },
      start: () => {
        host.started = true;
      }
    };
  };
}

describe("zcode remote serve", () => {
  test("fails when no link exists", async () => {
    const env = await temporaryEnv();
    const { code, output } = await run(["remote", "serve"], env);
    expect(code).toBe(1);
    expect(output.stderrText()).toContain("zcode remote link create");
  });

  test("serves until the signal aborts, reporting state transitions", async () => {
    const env = await temporaryEnv();
    await createRemoteHostLink({ name: "studio" }, env);
    const hosts: FakeHost[] = [];
    const controller = new AbortController();
    const pending = run(["remote", "serve", "--workspace", "/home/dev/project"], env, {
      appVersion: "9.9.9",
      createHost: fakeHostFactory(hosts),
      cwd: "/home/dev",
      signal: controller.signal
    });
    await Bun.sleep(20);
    const host = hosts[0]!;
    expect(host.started).toBe(true);
    expect(host.hostOptions.deviceName).toBe("studio");
    expect(host.params.appVersion).toBe("9.9.9");
    host.emitState("waiting");
    host.emitState("paired");
    controller.abort();
    const { code, output } = await pending;
    expect(code).toBe(0);
    const text = output.stdoutText();
    expect(text).toContain("Serving workspace project");
    expect(text).toContain("Waiting for a controller");
    expect(text).toContain("Controller connected.");
    expect(text).toContain("Stopped serving.");
    expect(host.disposed).toBe(true);
  });

  test("routes backend calls to the app-server with the workspace directory", async () => {
    const env = await temporaryEnv();
    await createRemoteHostLink({}, env);
    const hosts: FakeHost[] = [];
    const controller = new AbortController();
    const requests: Record<string, unknown>[] = [];
    const pending = run(["remote", "serve", "--workspace", "/home/dev/project"], env, {
      appServerRequest: async ({ method, params, workingDirectory }) => {
        requests.push({ method, params, workingDirectory });
        return { ok: true };
      },
      createHost: fakeHostFactory(hosts),
      cwd: "/home/dev",
      signal: controller.signal
    });
    await Bun.sleep(20);
    const host = hosts[0]!;
    const abort = new AbortController();
    const result = await host.backend.call({
      args: [{ filter: "all" }],
      channel: "plugins",
      name: "overview",
      signal: abort.signal,
      workspaceKey: "ws-x"
    });
    expect(result).toEqual({ ok: true });
    expect(requests).toEqual([{
      method: "plugins/overview",
      params: { filter: "all" },
      workingDirectory: "/home/dev/project"
    }]);
    expect(await host.backend.listWorkspaces()).toEqual([remoteHostWorkspaceForPath("/home/dev/project")]);
    controller.abort();
    expect((await pending).code).toBe(0);
  });

  test("exits non-zero when the relay reports a failure", async () => {
    const env = await temporaryEnv();
    await createRemoteHostLink({}, env);
    const hosts: FakeHost[] = [];
    const pending = run(["remote", "serve"], env, {
      createHost: fakeHostFactory(hosts),
      cwd: "/home/dev"
    });
    await Bun.sleep(20);
    hosts[0]!.emitFailure({ reason: "kicked", message: "another desktop took over" });
    const { code, output } = await pending;
    expect(code).toBe(1);
    expect(output.stderrText()).toContain("kicked");
    expect(hosts[0]!.disposed).toBe(true);
  });

  test("rejects options that belong to other actions", async () => {
    const env = await temporaryEnv();
    await createRemoteHostLink({}, env);
    const { code, output } = await run(["remote", "serve", "--timeout", "30"], env);
    expect(code).toBe(1);
    expect(output.stderrText()).toContain("--timeout");
  });
});

describe("remote usage text", () => {
  test("mentions the new link and serve commands", async () => {
    const env = await temporaryEnv();
    const { code, output } = await run(["remote", "help"], env);
    expect(code).toBe(0);
    expect(output.stdoutText()).toContain("zcode remote link create");
    expect(output.stdoutText()).toContain("zcode remote serve");
  });
});
