import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDarwinUrlCallbackReceiver,
  recoverStaleDarwinOAuthHandler,
  type CommandRunner
} from "../src/darwin-oauth-callback.ts";

type FailureTarget =
  | "read_handler"
  | "compile"
  | "bundle_id"
  | "ui_element"
  | "url_types"
  | "codesign"
  | "launch_services"
  | "activate_handler"
  | "verify_handler";

interface FakeRunnerOptions {
  failure?: FailureTarget;
  initialHandler?: string;
  mismatchOnVerify?: boolean;
}

function fakeRunner(options: FakeRunnerOptions = {}): CommandRunner {
  let currentHandler = options.initialHandler ?? "com.example.previous";
  let handlerReads = 0;
  let handlerWrites = 0;

  return async (command, args) => {
    let target: FailureTarget | undefined;
    if (command === "/usr/bin/osascript") {
      const settingHandler = args.length === 6;
      if (settingHandler) {
        handlerWrites += 1;
        target = handlerWrites === 1 ? "activate_handler" : undefined;
        if (options.failure !== target) currentHandler = args.at(-1) ?? "none";
      } else {
        handlerReads += 1;
        target = handlerReads === 1
          ? "read_handler"
          : handlerReads === 2
            ? "verify_handler"
            : undefined;
      }
    } else if (command === "/usr/bin/osacompile") {
      target = "compile";
    } else if (command === "/usr/bin/plutil") {
      if (args[1] === "CFBundleIdentifier") target = "bundle_id";
      if (args[1] === "LSUIElement") target = "ui_element";
      if (args[1] === "CFBundleURLTypes") target = "url_types";
    } else if (command === "/usr/bin/codesign") {
      target = "codesign";
    } else if (command.endsWith("/lsregister") && args[0] === "-f") {
      target = "launch_services";
    }

    if (target && options.failure === target) {
      return { code: 1, stderr: `simulated ${target} failure`, stdout: "" };
    }
    if (command === "/usr/bin/osascript") {
      if (args.length === 6) return { code: 0, stderr: "", stdout: "0" };
      const handler = options.mismatchOnVerify && handlerReads === 2
        ? "com.example.stale"
        : currentHandler;
      return { code: 0, stderr: "", stdout: handler };
    }
    return { code: 0, stderr: "", stdout: "" };
  };
}

async function withTemporaryHome<T>(action: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "zcode-oauth-test-"));
  try {
    return await action(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function createReceiver(home: string, runCommand: CommandRunner) {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  try {
    return createDarwinUrlCallbackReceiver({
      env: { HOME: home },
      runCommand,
      scheme: "zcode"
    });
  } finally {
    if (platform) Object.defineProperty(process, "platform", platform);
  }
}

describe("native macOS OAuth callback diagnostics", () => {
  test("labels every external setup step", async () => {
    const cases: Array<[FailureTarget, string]> = [
      ["read_handler", "reading current OAuth callback handler"],
      ["compile", "compiling OAuth callback app"],
      ["bundle_id", "setting CFBundleIdentifier"],
      ["ui_element", "setting LSUIElement"],
      ["url_types", "setting CFBundleURLTypes"],
      ["codesign", "ad-hoc codesigning callback app"],
      ["launch_services", "registering callback app with LaunchServices"],
      ["activate_handler", "activating OAuth callback handler"],
      ["verify_handler", "verifying OAuth callback handler"]
    ];

    for (const [failure, step] of cases) {
      await withTemporaryHome(async (home) => {
        try {
          await createReceiver(home, fakeRunner({ failure }));
          throw new Error(`Expected ${failure} to fail.`);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toStartWith(`${step}: `);
          expect((error as Error).cause).toBeInstanceOf(Error);
        }
      });
    }
  });

  test("labels stale-handler restoration failures", async () => {
    await withTemporaryHome(async (home) => {
      const appPath = join(home, "Applications", "ZCode CLI OAuth Callback stale.app");
      const recoveryDirectory = join(home, ".zcode", "cli");
      await mkdir(recoveryDirectory, { recursive: true });
      await writeFile(join(recoveryDirectory, "oauth-handler-recovery.json"), JSON.stringify({
        appPath,
        bundleId: "dev.zcode.cli.oauth-callback.stale",
        pid: process.pid,
        previousHandler: "com.example.previous",
        scheme: "zcode"
      }));

      await expect(recoverStaleDarwinOAuthHandler({
        env: { HOME: home },
        runCommand: fakeRunner({
          failure: "activate_handler",
          initialHandler: "dev.zcode.cli.oauth-callback.stale"
        }),
        scheme: "zcode"
      })).rejects.toThrow(/^restoring stale OAuth callback handler: /);
    });
  });

  test("treats a recycled PID as stale instead of blocking login forever", async () => {
    await withTemporaryHome(async (home) => {
      const appPath = join(home, "Applications", "ZCode CLI OAuth Callback stale.app");
      const recoveryDirectory = join(home, ".zcode", "cli");
      const recordPath = join(recoveryDirectory, "oauth-handler-recovery.json");
      await mkdir(recoveryDirectory, { recursive: true });
      const record = {
        appPath,
        bundleId: "dev.zcode.cli.oauth-callback.stale",
        // A live PID this process does not own: the parent is always alive.
        pid: process.ppid,
        previousHandler: "com.example.previous",
        scheme: "zcode"
      };

      await writeFile(recordPath, JSON.stringify({ ...record, createdAt: Date.now() }));
      await expect(recoverStaleDarwinOAuthHandler({
        env: { HOME: home },
        runCommand: fakeRunner({ initialHandler: "com.example.previous" }),
        scheme: "zcode"
      })).rejects.toThrow(/Another Z.AI login is already waiting/);

      await writeFile(recordPath, JSON.stringify({
        ...record,
        createdAt: Date.now() - 7 * 60_000
      }));
      await recoverStaleDarwinOAuthHandler({
        env: { HOME: home },
        runCommand: fakeRunner({ initialHandler: "com.example.previous" }),
        scheme: "zcode"
      });
      expect(await Bun.file(recordPath).exists()).toBe(false);
    });
  });

  test("keeps the callback app recoverable when the handler restore fails", async () => {
    await withTemporaryHome(async (home) => {
      let handlerWrites = 0;
      const runCommand: CommandRunner = async (command, args) => {
        if (command === "/usr/bin/osascript" && args.length === 6) {
          handlerWrites += 1;
          // Activation succeeds; the restore during dispose fails.
          return handlerWrites === 1
            ? { code: 0, stderr: "", stdout: "0" }
            : { code: 1, stderr: "simulated restore failure", stdout: "" };
        }
        if (command === "/usr/bin/osascript") {
          return {
            code: 0,
            stderr: "",
            stdout: handlerWrites === 0 ? "com.example.previous" : lastActivatedBundleId
          };
        }
        return { code: 0, stderr: "", stdout: "" };
      };
      let lastActivatedBundleId = "";
      let unregistered = false;
      const receiver = await createReceiver(home, async (command, args) => {
        if (command === "/usr/bin/plutil" && args[1] === "CFBundleIdentifier") {
          lastActivatedBundleId = args[3] ?? "";
        }
        if (command.endsWith("/lsregister") && args[0] === "-u") unregistered = true;
        return await runCommand(command, args);
      });

      await receiver.dispose();

      // The scheme still points at our bundle, so the next login must be able to
      // finish the restore: neither the record nor the registration may be gone.
      expect(unregistered).toBe(false);
      const recordPath = join(home, ".zcode", "cli", "oauth-handler-recovery.json");
      expect(await Bun.file(recordPath).exists()).toBe(true);
      const stored = JSON.parse(await Bun.file(recordPath).text()) as { bundleId: string };
      expect(stored.bundleId).toBe(lastActivatedBundleId);
    });
  });

  test("gives actionable handler activation and timeout guidance", async () => {
    await withTemporaryHome(async (home) => {
      await expect(createReceiver(home, fakeRunner({ mismatchOnVerify: true }))).rejects.toThrow(
        /Remove stale `ZCode CLI OAuth Callback \*\.app` entries from `~\/Applications`/
      );

      const receiver = await createReceiver(home, fakeRunner());
      try {
        await expect(receiver.waitForCallback(undefined, 0)).rejects.toThrow(
          /remove it before retrying/
        );
      } finally {
        await receiver.dispose();
      }
    });
  });
});
