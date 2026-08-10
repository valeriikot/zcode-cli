import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { MAX_ACTIVE_TOOL_TEXT_CHARACTERS } from "../packages/zcode-tui/src/bounded-tool-text.ts";
import { ThinkingView } from "../packages/zcode-tui/src/thinking-view.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";

describe("TUI thinking view", () => {
  test("streams reasoning into one card and settles without duplicating text", () => {
    const view = new ThinkingView(createTheme(false));

    expect(view.render(52)).toEqual([]);
    view.append("Inspecting ");
    view.append("the repository.");

    const active = view.render(52).map((line) => line.trimEnd()).join("\n");
    expect(active).toContain("◇ Thinking · active");
    expect(active).toContain("Inspecting the repository.");
    expect(active.match(/Inspecting the repository\./g)).toHaveLength(1);

    view.complete();
    const complete = view.render(52).map((line) => line.trimEnd()).join("\n");
    expect(complete).toContain("◇ Thought");
    expect(complete).not.toContain("· active");
    expect(complete).toContain("Ctrl+O to expand");
    expect(complete).not.toContain("Inspecting the repository.");

    view.setExpanded(true);
    const expanded = view.render(52).map((line) => line.trimEnd()).join("\n");
    expect(expanded.match(/Inspecting the repository\./g)).toHaveLength(1);
  });

  test("wraps Markdown and CJK reasoning within narrow terminals", () => {
    const view = new ThinkingView(createTheme(false));
    view.append("**检查结果**：需要继续分析工具调用与终端布局，确保所有内容保持可读。 ");
    view.append("`reasoning_delta` remains structured.");

    const lines = view.render(30);
    expect(lines.join("\n")).toContain("检查结果");
    expect(lines.join("\n")).toContain("reasoning_delta");
    expect(lines.every((line) => visibleWidth(line) <= 30)).toBe(true);
  });

  test("bounds retained reasoning text like an active tool stream", () => {
    const view = new ThinkingView(createTheme(false));
    view.append("REASONING-HEAD ");
    for (let index = 0; index < 400; index += 1) view.append(`${"considering options ".repeat(50)}\n`);
    view.append(" REASONING-TAIL");

    const retained = view.getSearchText();
    expect(retained.length).toBeLessThanOrEqual(MAX_ACTIVE_TOOL_TEXT_CHARACTERS);
    expect(retained).toContain("REASONING-HEAD");
    expect(retained).toContain("REASONING-TAIL");
    expect(retained).toContain("characters omitted");

    const rendered = view.render(80).join("\n");
    expect(rendered).toContain("◇ Thinking · active");
    expect(rendered).toContain("REASONING-TAIL");
    view.complete();
    expect(view.hasHiddenContent()).toBe(true);
  });

  test("replaces bounded text without leaving the previous stream behind", () => {
    const view = new ThinkingView(createTheme(false));
    view.setText("first reasoning");
    view.setText("second reasoning");
    expect(view.getSearchText()).toBe("second reasoning");
    expect(view.render(40).join("\n")).not.toContain("first");

    view.setText("   ");
    view.complete();
    expect(view.hasHiddenContent()).toBe(false);
    expect(view.render(40).join("\n")).not.toContain("Ctrl+O to expand");
  });

  test("keeps routine thinking content free of full-width backgrounds", () => {
    const view = new ThinkingView(createTheme(true, "light"));
    view.append("Inspecting the runtime.");
    expect(view.render(60).join("\n")).not.toContain("\x1b[48;5;");
  });
});
