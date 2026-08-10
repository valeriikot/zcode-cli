import { describe, expect, test } from "bun:test";

import {
  contextRemainingPercent,
  mergeMetrics,
  projectionMetrics,
  sessionIdFromUsage,
  usageMetrics
} from "../packages/zcode-tui/src/session-status.ts";

describe("TUI session status", () => {
  test("normalizes projection and detailed usage snapshots", () => {
    expect(projectionMetrics({
      contextUsed: 32_000,
      contextWindow: 128_000,
      totalTokenCount: 18_400,
      turnCount: 4
    })).toEqual({
      contextUsed: 32_000,
      contextWindow: 128_000,
      totalTokens: 18_400,
      turnCount: 4
    });
    expect(usageMetrics({
      totalTokens: 18_500,
      inputTokens: 14_000,
      outputTokens: 4_000,
      reasoningTokens: 500,
      cacheReadTokens: 9_000
    })).toMatchObject({ totalTokens: 18_500, inputTokens: 14_000, cacheReadTokens: 9_000 });
  });

  test("merges authoritative updates and computes bounded context remaining", () => {
    const metrics = mergeMetrics(
      { contextUsed: 32_000, contextWindow: 128_000, totalTokens: 18_400 },
      { totalTokens: 18_500, inputTokens: 14_000 }
    );
    expect(metrics.totalTokens).toBe(18_500);
    expect(metrics.contextUsed).toBe(32_000);
    expect(contextRemainingPercent(metrics)).toBe(75);
    expect(contextRemainingPercent({ contextUsed: 200, contextWindow: 100 })).toBe(0);
  });

  test("keeps known metrics when a snapshot omits them", () => {
    expect(projectionMetrics({ turnCount: 5 })).toStrictEqual({ turnCount: 5 });
    expect(usageMetrics({ inputTokens: 12 })).toStrictEqual({ inputTokens: 12 });

    const metrics = mergeMetrics(
      { contextUsed: 32_000, contextWindow: 128_000, totalTokens: 18_400 },
      projectionMetrics({ turnCount: 5 })
    );
    expect(metrics.totalTokens).toBe(18_400);
    expect(contextRemainingPercent(metrics)).toBe(75);
    expect(mergeMetrics({ totalTokens: 10 }, { totalTokens: undefined, inputTokens: 4 }))
      .toStrictEqual({ totalTokens: 10, inputTokens: 4 });
  });

  test("extracts the official session identifier from usage snapshots", () => {
    expect(sessionIdFromUsage({ sessionId: "sess_protocol" })).toBe("sess_protocol");
    expect(sessionIdFromUsage({ sessionID: "sess_store" })).toBe("sess_store");
    expect(sessionIdFromUsage({ totalTokens: 10 })).toBeUndefined();
  });
});
