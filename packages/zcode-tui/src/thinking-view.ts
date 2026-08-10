import {
  Box,
  Markdown,
  Text
} from "@earendil-works/pi-tui";

import { BoundedToolText } from "./bounded-tool-text.ts";
import type { ZCodeTheme } from "./theme.ts";
import { sanitizeTerminalText } from "./terminal-text.ts";

export class ThinkingView extends Box {
  // Reasoning streams are bounded like tool output: the whole text is re-parsed as
  // Markdown on every dirty frame and every card keeps its text for the session.
  private readonly text = new BoundedToolText();
  private blank = true;
  private completed = false;
  private expanded = false;
  private dirty = false;

  constructor(private readonly theme: ZCodeTheme) {
    super(1, 0);
  }

  append(delta: string): void {
    if (!delta) return;
    const sanitized = sanitizeTerminalText(delta, { preserveSgr: false });
    this.text.append(sanitized);
    if (this.blank && sanitized.trim()) this.blank = false;
    this.dirty = true;
  }

  setText(text: string): void {
    const sanitized = sanitizeTerminalText(text, { preserveSgr: false });
    if (this.text.totalCharacters === sanitized.length && this.text.value() === sanitized) return;
    this.text.replace(sanitized);
    this.blank = !sanitized.trim();
    this.dirty = true;
  }

  complete(): void {
    if (this.completed) return;
    this.completed = true;
    this.dirty = true;
  }

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.dirty = true;
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  hasHiddenContent(): boolean {
    return this.completed && !this.blank && !this.expanded;
  }

  getSearchText(): string {
    return this.text.value();
  }

  override render(width: number): string[] {
    if (this.dirty) {
      this.rebuild();
      this.dirty = false;
    }
    return super.render(width);
  }

  private rebuild(): void {
    this.clear();
    const title = this.completed
      ? `${this.theme.muted("◇")} ${this.theme.bold("Thought")}${!this.blank && !this.expanded ? this.theme.muted(" · Ctrl+O to expand") : ""}`
      : `${this.theme.accent("◇")} ${this.theme.bold("Thinking")} ${this.theme.muted("· active")}`;
    this.addChild(new Text(title, 0, 0));
    if (!this.blank && (!this.completed || this.expanded)) {
      this.addChild(new Markdown(
        this.text.value(),
        1,
        0,
        this.theme.markdown,
        { color: this.theme.muted, italic: true }
      ));
    }
  }
}
