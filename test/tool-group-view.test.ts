import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { createTheme } from "../packages/zcode-tui/src/theme.ts";
import { ToolGroupView } from "../packages/zcode-tui/src/tool-group-view.ts";
import { ToolExecutionView } from "../packages/zcode-tui/src/tool-view.ts";

function readTool(path: string, state = "complete"): ToolExecutionView {
  return new ToolExecutionView(createTheme(false), {
    name: "Read",
    state,
    input: { file_path: path },
    result: { output: "source text", success: true }
  });
}

describe("TUI tool group view", () => {
  test("keeps a collapsed group on exactly one line at any width", () => {
    const group = new ToolGroupView(createTheme(false));
    group.addTool(readTool("/workspace/packages/zcode-tui/src/renderers/deeply/nested/module-name.ts"));

    for (const width of [8, 20, 40, 60, 80, 120]) {
      const lines = group.render(width);
      expect(lines).toHaveLength(1);
      expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(width);
    }
    expect(group.render(60)[0]).toContain("Read 1 file");
  });

  test("renders every tool once the group is expanded", () => {
    const group = new ToolGroupView(createTheme(false));
    group.addTool(readTool("/workspace/first.ts"));
    group.addTool(readTool("/workspace/second.ts"));
    group.setExpanded(true);

    const rendered = group.render(60).join("\n");
    expect(rendered).toContain("/workspace/first.ts");
    expect(rendered).toContain("/workspace/second.ts");
    expect(group.render(60).length).toBeGreaterThan(1);
  });
});
