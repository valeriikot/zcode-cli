import { describe, expect, test } from "bun:test";

import { packagedVersionInvocation } from "../scripts/smoke-package.ts";

// Mirrors how `cmd.exe /s` rewrites the string after /c: the first quote and the last quote are
// removed, then the program is the leading quoted token (or everything up to the first space).
function cmdProgram(commandLine: string): string {
  const last = commandLine.lastIndexOf("\"");
  const stripped = commandLine.startsWith("\"")
    ? `${commandLine.slice(1, last)}${commandLine.slice(last + 1)}`
    : commandLine;
  return stripped.startsWith("\"")
    ? stripped.slice(1, stripped.indexOf("\"", 1))
    : stripped.split(" ")[0]!;
}

describe("packaged CLI smoke invocation", () => {
  test("runs the POSIX bin shim directly", () => {
    expect(packagedVersionInvocation("/tmp/zcode cli/node_modules/.bin", "linux")).toEqual({
      args: ["--version"],
      command: "/tmp/zcode cli/node_modules/.bin/zcode",
      windowsVerbatimArguments: false
    });
  });

  test("keeps the Windows shim path intact when the install prefix contains a space", () => {
    const invocation = packagedVersionInvocation("C:\\Users\\John Doe\\zcode\\node_modules\\.bin", "win32");

    expect(invocation.command).toBe("cmd.exe");
    expect(invocation.windowsVerbatimArguments).toBe(true);
    expect(invocation.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(cmdProgram(invocation.args[3]!)).toBe(
      "C:\\Users\\John Doe\\zcode\\node_modules\\.bin\\zcode.cmd"
    );
  });

  test("keeps the Windows shim path intact without a space", () => {
    const invocation = packagedVersionInvocation("C:\\temp\\zcode\\node_modules\\.bin", "win32");

    expect(cmdProgram(invocation.args[3]!)).toBe("C:\\temp\\zcode\\node_modules\\.bin\\zcode.cmd");
  });
});
