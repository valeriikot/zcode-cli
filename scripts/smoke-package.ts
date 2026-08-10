#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { formatVersionOutput } from "../src/launcher.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface PackagedCliInvocation {
  args: string[];
  command: string;
  windowsVerbatimArguments: boolean;
}

export function packagedVersionInvocation(
  binDirectory: string,
  platform: NodeJS.Platform = process.platform
): PackagedCliInvocation {
  const path = platform === "win32" ? win32 : posix;
  if (platform !== "win32") {
    return { args: ["--version"], command: path.join(binDirectory, "zcode"), windowsVerbatimArguments: false };
  }
  // `cmd.exe /s` strips the outermost quote pair, so the shim path carries its own quotes and Bun
  // must forward the command line verbatim instead of escaping it a second time; without both the
  // invocation breaks for install prefixes containing a space.
  return {
    args: ["/d", "/s", "/c", `""${path.join(binDirectory, "zcode.cmd")}" --version"`],
    command: "cmd.exe",
    windowsVerbatimArguments: true
  };
}

async function execute(
  command: string,
  args: string[],
  cwd: string,
  windowsVerbatimArguments = false
): Promise<{ code: number; stdout: string }> {
  const child = Bun.spawn([command, ...args], {
    cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
    windowsVerbatimArguments
  });
  const [code, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text()
  ]);
  return { code, stdout };
}

export async function smokePackagedCli(tarball: string): Promise<void> {
  const absoluteTarball = isAbsolute(tarball) ? tarball : resolve(root, tarball);
  if (!existsSync(absoluteTarball)) throw new Error(`Release tarball does not exist: ${absoluteTarball}`);
  const npm = Bun.which("npm");
  if (!npm) throw new Error("npm is required to install-test the release tarball.");

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "zcode-cli-package-"));
  try {
    const install = await execute(npm, [
      "install",
      "--no-audit",
      "--no-fund",
      "--prefix",
      temporaryDirectory,
      absoluteTarball
    ], root);
    if (install.code !== 0) throw new Error(`npm install smoke test failed with status ${install.code}`);

    const packageRoot = join(temporaryDirectory, "node_modules", "zcode-app-cli");
    const packageManifest = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8")
    ) as { version?: string };
    const extraction = JSON.parse(
      await readFile(join(packageRoot, "vendor", "extraction.json"), "utf8")
    ) as { cliVersion?: string };
    const invocation = packagedVersionInvocation(join(temporaryDirectory, "node_modules", ".bin"));
    const version = await execute(
      invocation.command,
      invocation.args,
      temporaryDirectory,
      invocation.windowsVerbatimArguments
    );
    const expectedVersion = packageManifest.version && extraction.cliVersion
      ? formatVersionOutput(packageManifest.version, extraction.cliVersion)
      : undefined;
    if (version.code !== 0 || !expectedVersion || version.stdout.trim() !== expectedVersion) {
      throw new Error(`Installed zcode --version failed: ${version.stdout.trim() || `status ${version.code}`}`);
    }
    console.log(`Installed-package smoke test passed for ${expectedVersion.replace("\n", " / ")}.`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    let tarball: string | undefined = process.argv.at(2);
    if (!tarball) {
      const release = JSON.parse(await readFile(join(root, ".release", "release.json"), "utf8")) as {
        tarball?: string;
      };
      tarball = release.tarball;
    }
    if (!tarball) throw new Error("No release tarball was provided.");
    await smokePackagedCli(tarball);
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
