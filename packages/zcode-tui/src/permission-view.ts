import {
  Box,
  Text,
  type Component
} from "@earendil-works/pi-tui";

import {
  fileDiffsForPermission,
  FileDiffView
} from "./file-diff-view.ts";
import type { ZCodeTheme } from "./theme.ts";
import { sanitizeTerminalText, truncateGraphemes } from "./terminal-text.ts";
import { normalizeToolName, recordString } from "./tool-renderers.ts";
import { isRecord } from "./types.ts";

const maxInputLines = 32;
const maxInputCharacters = 6_000;

function sanitizedJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return sanitizeTerminalText(JSON.stringify(value, (key, field) => {
      if (/api.?key|authorization|password|secret|token/iu.test(key) && typeof field === "string") return "[redacted]";
      if (typeof field === "string") return truncateGraphemes(field, maxInputCharacters);
      return field;
    }, 2), { preserveSgr: false });
  } catch {
    return sanitizeTerminalText(String(value), { preserveSgr: false });
  }
}

/**
 * Bounds the untrusted request payload by characters and by lines on every path:
 * the dialog re-materializes its content on each keystroke, so the character cap
 * is applied first and keeps that work proportional to the cap, not to the input.
 */
function limited(value: string): string {
  const capped = truncateGraphemes(value, maxInputCharacters, "");
  const lines = capped.replace(/\r/g, "").split("\n");
  const visible = lines.slice(0, maxInputLines).join("\n");
  if (capped === value && lines.length <= maxInputLines) return visible;
  const marker = capped === value ? `${lines.length - maxInputLines} more lines` : "input truncated";
  return `${visible}\n… ${marker}`;
}

export class PermissionPreview implements Component {
  private cache?: { lines: string[]; width: number };

  constructor(
    private readonly theme: ZCodeTheme,
    private readonly toolName: string,
    private readonly input: unknown,
    private readonly riskLevel?: string
  ) {}

  invalidate(): void {
    this.cache = undefined;
  }

  // The request is immutable, so the dialog's per-keystroke re-render reuses the
  // lines instead of reformatting the payload for every frame.
  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines;
    const lines = this.build(width);
    this.cache = { lines, width };
    return lines;
  }

  private build(width: number): string[] {
    const host = new Box(1, 0, this.riskBackground());
    const risk = this.riskLevel ? this.riskStyle()(`Risk: ${this.riskLevel}`) : undefined;
    if (risk) host.addChild(new Text(risk, 0, 0));

    const diffs = fileDiffsForPermission(this.toolName, this.input);
    if (diffs.length > 0) {
      host.addChild(new FileDiffView(this.theme, {
        toolName: this.toolName,
        state: "waiting_permission",
        diffs
      }));
      return host.render(width);
    }

    const normalized = normalizeToolName(this.toolName);
    if ((normalized.includes("bash") || normalized.includes("shell") || normalized === "exec") && isRecord(this.input)) {
      const command = recordString(this.input, ["command", "cmd", "script"]);
      if (command) host.addChild(new Text(this.theme.bold(limited(command)), 0, 0));
      return host.render(width);
    }

    const input = sanitizedJson(this.input);
    if (input) host.addChild(new Text(this.theme.muted(limited(input)), 0, 0));
    return host.render(width);
  }

  private riskStyle(): (text: string) => string {
    if (this.riskLevel === "critical" || this.riskLevel === "high") return this.theme.error;
    if (this.riskLevel === "medium") return this.theme.warning;
    return this.theme.muted;
  }

  private riskBackground(): ((text: string) => string) | undefined {
    if (this.riskLevel === "critical" || this.riskLevel === "high") return this.theme.toolErrorBackground;
    return this.theme.toolPendingBackground;
  }
}
