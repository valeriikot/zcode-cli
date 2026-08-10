import type { Component } from "@earendil-works/pi-tui";

import { RichMarkdown } from "./rich-markdown.ts";
import type { ZCodeTheme } from "./theme.ts";

interface AssistantBlockOptions {
  id?: string;
  messageId?: string;
  kind?: string;
}

interface AssistantSegment {
  view: RichMarkdown;
  text: string;
  messageId?: string;
}

export class AssistantStream {
  private current?: AssistantSegment;
  private currentPartId?: string;
  private displayedText = "";
  private readonly segments: AssistantSegment[] = [];
  private readonly partSegments = new Map<string, AssistantSegment>();

  constructor(
    private readonly theme: ZCodeTheme,
    private readonly addBlock: (component: Component, options?: AssistantBlockOptions) => void
  ) {}

  beginTurn(): void {
    for (const segment of this.segments) segment.view.finishText();
    this.segments.length = 0;
    this.partSegments.clear();
    this.current = undefined;
    this.currentPartId = undefined;
    this.displayedText = "";
  }

  clear(): void {
    this.beginTurn();
  }

  breakSegment(): void {
    this.current?.view.finishText();
    this.current = undefined;
    this.currentPartId = undefined;
  }

  append(delta: string, partId?: string, messageId?: string): string {
    if (!delta) return this.displayedText;
    const segment = partId
      ? this.ensurePartSegment(partId, messageId)
      : this.ensureAnonymousSegment(messageId);
    segment.text += delta;
    segment.view.appendText(delta);
    this.current = segment;
    this.currentPartId = partId;
    if (segment === this.segments.at(-1)) this.displayedText += delta;
    else this.rebuildDisplayedText();
    return this.displayedText;
  }

  upsert(text: string, partId: string, messageId?: string): string {
    const segment = this.ensurePartSegment(partId, messageId);
    const previous = segment.text;
    segment.text = text;
    segment.view.setText(text);
    this.current = segment;
    this.currentPartId = partId;

    // A rewrite of anything but the last segment's tail moves earlier text, so
    // only a rebuild keeps the accumulator equal to what the transcript shows.
    if (segment === this.segments.at(-1) && text.startsWith(previous)) {
      this.displayedText += text.slice(previous.length);
    } else {
      this.rebuildDisplayedText();
    }
    return this.displayedText;
  }

  removePart(partId: string): void {
    const segment = this.partSegments.get(partId);
    if (!segment) return;
    segment.view.finishText();
    this.partSegments.delete(partId);
    const index = this.segments.indexOf(segment);
    if (index >= 0) this.segments.splice(index, 1);
    this.rebuildDisplayedText();
    if (this.currentPartId === partId) this.breakSegment();
  }

  reconcile(response: string): string {
    if (!this.displayedText) {
      this.append(response);
      return response;
    }

    if (response.startsWith(this.displayedText)) {
      this.append(response.slice(this.displayedText.length));
    } else if (!this.displayedText.endsWith(response)) {
      // Some runtimes return only the final assistant message after streaming
      // commentary around tools. Keep that authoritative response at the end.
      this.breakSegment();
      this.append(response);
    }
    return response;
  }

  private rebuildDisplayedText(): void {
    this.displayedText = this.segments.map((segment) => segment.text).join("");
  }

  private ensureAnonymousSegment(messageId?: string): AssistantSegment {
    const current = this.current;
    if (current && !this.currentPartId) return current;
    const view = new RichMarkdown("", 1, this.theme);
    const segment = { view, text: "", messageId };
    this.segments.push(segment);
    this.addBlock(view, { kind: "assistant", messageId });
    return segment;
  }

  private ensurePartSegment(partId: string, messageId?: string): AssistantSegment {
    const existing = this.partSegments.get(partId);
    if (existing) return existing;
    const view = new RichMarkdown("", 1, this.theme);
    const segment = { view, text: "", messageId };
    this.partSegments.set(partId, segment);
    this.segments.push(segment);
    this.addBlock(view, { id: partId, kind: "assistant", messageId });
    return segment;
  }
}
