import { describe, expect, test } from "bun:test";

import { PermissionPreview } from "../packages/zcode-tui/src/permission-view.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";

describe("TUI permission preview", () => {
  test("uses readable light-terminal emphasis and strips external SGR", () => {
    const view = new PermissionPreview(
      createTheme(true, "light"),
      "Bash",
      { command: "\x1b[47;8;7mbun test\x1b[0m" },
      "medium"
    );
    const rendered = view.render(72).join("\n");
    expect(rendered).toContain("\x1b[38;5;58;48;5;230m");
    expect(rendered).toContain("bun test");
    expect(rendered).not.toContain("\x1b[47;8;7m");
  });

  test("bounds oversized requests by characters as well as by lines", () => {
    const command = Array.from({ length: 33 }, (_, index) => `printf ${index} ${"x".repeat(50_000)}`).join("\n");
    const bash = new PermissionPreview(createTheme(false), "Bash", { command });
    const bashLines = bash.render(80);
    expect(bashLines.length).toBeLessThan(200);
    expect(bashLines.join("\n").length).toBeLessThan(20_000);
    expect(bashLines.join("\n")).toContain("printf 0");
    expect(bashLines.join("\n")).toContain("input truncated");

    const json = new PermissionPreview(createTheme(false), "UnknownTool", {
      note: Array.from({ length: 40 }, (_, index) => `note ${index} ${"y".repeat(50_000)}`).join("\n")
    });
    const jsonLines = json.render(80);
    expect(jsonLines.length).toBeLessThan(200);
    expect(jsonLines.join("\n").length).toBeLessThan(20_000);
    expect(jsonLines.join("\n")).toContain("input truncated");
  });

  test("keeps the line count exact when only the line cap applies", () => {
    const view = new PermissionPreview(
      createTheme(false),
      "Bash",
      { command: Array.from({ length: 40 }, (_, index) => `step ${index}`).join("\n") }
    );
    const rendered = view.render(80).join("\n");
    expect(rendered).toContain("step 31");
    expect(rendered).not.toContain("step 32");
    expect(rendered).toContain("… 8 more lines");
  });

  test("re-renders bounded content when the dialog width changes", () => {
    const view = new PermissionPreview(createTheme(false), "Bash", { command: `echo ${"z".repeat(400)}` });
    const wide = view.render(80);
    const narrow = view.render(40);
    expect(wide).not.toEqual(narrow);
    expect(wide.every((line) => line.length <= 80)).toBe(true);
    expect(narrow.every((line) => line.length <= 40)).toBe(true);
    expect(view.render(80)).toEqual(wide);
  });

  test("reserves the error surface for high-risk permission requests", () => {
    const view = new PermissionPreview(
      createTheme(true, "dark"),
      "Bash",
      { command: "rm -rf build" },
      "high"
    );
    expect(view.render(72).join("\n")).toContain("\x1b[38;5;252;48;5;52m");
  });
});
