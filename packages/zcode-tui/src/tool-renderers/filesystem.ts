import type { SpecializedToolRenderOptions, SpecializedToolRenderResult } from "./types.ts";
import {
  booleanField,
  directText,
  formatElapsed,
  nestedRecord,
  numberField,
  recordString,
  toolSummary
} from "./helpers.ts";
import { canonicalToolName } from "./registry.ts";

export function readRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const record = nestedRecord(options.result);
  const raw = directText(options.result);
  const count = numberField(record, ["numLines", "lineCount", "count", "numPages", "pageCount"])
    ?? (raw ? raw.replace(/\r/g, "").split("\n").length : undefined);
  const type = recordString(record, ["type", "kind"]);
  const unit = type?.includes("pdf") || record?.numPages !== undefined || record?.pageCount !== undefined
    ? "pages"
    : type?.includes("image")
      ? "image"
      : "lines";
  const status = count !== undefined
    ? `Read ${count} ${count === 1 ? unit.replace(/s$/u, "") : unit}`
    : type?.includes("image")
      ? "Read image"
      : undefined;
  return {
    displayName: "Read",
    summary: toolSummary(options.name, options.input),
    body: options.expanded && raw
      ? [status && options.theme.muted(status), raw].filter(Boolean).join("\n")
      : status && options.theme.muted(status),
    consumesResult: true,
    hiddenContent: Boolean(raw) && !options.expanded
  };
}

// Each counted field carries its own noun so the reported number and the label
// always describe the same thing.
const searchCounts = [
  ["numMatches", "match", "matches"],
  ["numFiles", "file", "files"],
  ["numLines", "line", "lines"],
  ["count", "match", "matches"]
] as const;

export function searchRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  const record = nestedRecord(options.result);
  const counted = searchCounts
    .map(([key, singular, plural]) => ({ amount: numberField(record, [key]), singular, plural }))
    .find((entry) => entry.amount !== undefined);
  const duration = numberField(record, ["durationMs", "duration"]);
  const status = [
    counted ? `Found ${counted.amount} ${counted.amount === 1 ? counted.singular : counted.plural}` : undefined,
    formatElapsed(duration),
    booleanField(record, ["truncated"]) ? "truncated" : undefined
  ].filter(Boolean).join(" · ");
  const filenames = Array.isArray(record?.filenames)
    ? record.filenames.filter((item): item is string => typeof item === "string").join("\n")
    : undefined;
  const content = recordString(record, ["content", "output", "text"]) ?? filenames ?? directText(options.result);
  return {
    displayName: canonicalToolName(options.name) === "Glob" ? "Glob" : "Grep",
    summary: toolSummary(options.name, options.input),
    body: options.expanded && content
      ? [status && options.theme.muted(status), content].filter(Boolean).join("\n")
      : status && options.theme.muted(status),
    consumesResult: true,
    hiddenContent: Boolean(content) && !options.expanded
  };
}

export function mutationRender(options: SpecializedToolRenderOptions): SpecializedToolRenderResult {
  return {
    displayName: canonicalToolName(options.name),
    summary: toolSummary(options.name, options.input)
  };
}
