import { describe, expect, test } from "bun:test";

import type { ChoiceItem } from "../packages/zcode-tui/src/choice-dialog.ts";
import { ZCodeTui } from "../packages/zcode-tui/src/index.ts";
import type { QueuedSubmission } from "../packages/zcode-tui/src/input-queue.ts";
import {
  normalizeRuntimeProjection,
  type RuntimeProjectionSnapshot
} from "../packages/zcode-tui/src/runtime-projection.ts";
import type { ToolProgressData } from "../packages/zcode-tui/src/tool-renderers.ts";
import type { TuiOptions } from "../packages/zcode-tui/src/types.ts";

interface ToolCardState {
  state: string;
  progress?: ToolProgressData;
}

interface ClientInternals {
  applyRuntimeProjection: (projection: RuntimeProjectionSnapshot | undefined) => void;
  beginTurn: (prompt?: string) => void;
  bindInput: () => void;
  onEvent: (value: unknown, turnEpoch?: number) => void;
  primaryTurnActive: boolean;
  queuedSelectionCommand?: QueuedSubmission;
  refreshRuntimeState: () => Promise<void>;
  rewindFlowActive: boolean;
  runtimeProjection?: RuntimeProjectionSnapshot;
  showChoice: (options: { items: ChoiceItem[] }) => Promise<ChoiceItem | null>;
  showConversationRewind: () => Promise<void>;
  showSelection: (selection: Record<string, unknown>) => Promise<void>;
  toolViews: Map<string, ToolCardState>;
  ui: {
    addInputListener: (listener: (data: string) => unknown) => void;
    requestRender: (force?: boolean) => void;
  };
}

// Escape, Ctrl+C and Ctrl+D as the terminal delivers them in raw mode.
const interruptKeys = ["\u001b", "\u0003", "\u0004"];

function createClient(options: Partial<TuiOptions> = {}): ClientInternals {
  const client = new ZCodeTui({
    submitPrompt: async () => ({}),
    ...options
  }) as unknown as ClientInternals;
  // Rendering needs a live terminal; every assertion reads projected state.
  client.ui.requestRender = () => {};
  return client;
}

function runningJob(taskId: string): Record<string, unknown> {
  return { taskId, status: "running" };
}

function settled(promise: Promise<unknown>, timeoutMs = 250): Promise<unknown> {
  return Promise.race([
    promise.catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}

describe("TUI client tool cards", () => {
  test("keeps subagent metadata on a Task card after the result event", () => {
    const client = createClient();
    client.beginTurn("investigate");
    client.onEvent({
      type: "tool_call_started",
      payload: { toolCallId: "call_agent", toolName: "Task" }
    });
    client.onEvent({
      type: "subagent_spawned",
      payload: {
        parentToolCallId: "call_agent",
        agentId: "agent_1",
        agentType: "explore",
        childSessionId: "session_child"
      }
    });
    client.onEvent({
      type: "part.upserted",
      payload: {
        part: { type: "tool", partId: "part_agent", toolCallId: "call_agent", toolName: "Task", status: "running" }
      }
    });
    client.onEvent({
      type: "tool_call_result",
      payload: { toolCallId: "call_agent", totalToolUseCount: 4, result: { success: true } }
    });
    client.onEvent({ type: "tool_call_closed", payload: { toolCallId: "call_agent" } });

    expect(client.toolViews.get("call_agent")?.progress).toMatchObject({
      agentId: "agent_1",
      agentType: "explore",
      childSessionId: "session_child",
      totalToolUseCount: 4
    });
  });

  test("keeps Bash progress details after the tool closes", () => {
    const client = createClient();
    client.beginTurn("run tests");
    client.onEvent({
      type: "tool_call_progress",
      payload: {
        toolCallId: "call_bash",
        toolName: "Bash",
        pid: 4_242,
        description: "bun test",
        stdoutTail: "1 pass"
      }
    });
    client.onEvent({
      type: "tool_call_result",
      payload: { toolCallId: "call_bash", result: { success: true } }
    });

    expect(client.toolViews.get("call_bash")?.progress).toMatchObject({
      pid: 4_242,
      description: "bun test",
      stdoutTail: "1 pass"
    });
  });

  test("never revives a settled card when a removed part shrinks the registry", () => {
    const client = createClient();
    client.beginTurn("inspect");
    client.onEvent({
      type: "part.upserted",
      payload: {
        part: { type: "tool", partId: "part_read", toolCallId: "call_read", toolName: "Read", status: "running" }
      }
    });
    client.onEvent({ type: "tool_call_started", payload: { toolName: "Bash" } });
    client.onEvent({ type: "tool_call_result", payload: { toolName: "Bash", result: { success: true } } });

    const bashId = [...client.toolViews.keys()].find((id) => id.startsWith("Bash"));
    const completedBash = bashId ? client.toolViews.get(bashId) : undefined;
    expect(completedBash?.state).toBe("complete");

    client.onEvent({ type: "part.removed", payload: { partId: "part_read" } });
    client.onEvent({ type: "tool_call_started", payload: { toolName: "Bash" } });

    expect(completedBash?.state).toBe("complete");
    expect(client.toolViews.size).toBe(2);
  });

  test("fails unresolved tool cards for either turn-failed spelling", () => {
    for (const type of ["turn_failed", "turn.failed"]) {
      const client = createClient();
      client.beginTurn("run");
      client.onEvent({
        type: "tool_call_started",
        payload: { toolCallId: "call_1", toolName: "Bash" }
      });
      client.onEvent({ type, payload: { message: "Runtime failed." } });

      expect(client.toolViews.get("call_1")?.state).toBe("failed");
    }
  });
});

describe("TUI client runtime polling", () => {
  test("discards a poll result that a newer projection already superseded", async () => {
    let resolveProjection!: (value: unknown) => void;
    const client = createClient({
      readRuntimeProjection: () => new Promise((resolve) => {
        resolveProjection = resolve;
      })
    });

    const refresh = client.refreshRuntimeState();
    client.applyRuntimeProjection(normalizeRuntimeProjection({
      sessionId: "session_1",
      backgroundJobs: [runningJob("task_1"), runningJob("task_2")]
    }));
    resolveProjection({ sessionId: "session_1", backgroundJobs: [runningJob("task_1")] });
    await refresh;

    expect(client.runtimeProjection?.backgroundJobs).toHaveLength(2);
  });

  test("applies a poll result taken after the last projection", async () => {
    const client = createClient({
      readRuntimeProjection: async () => ({
        sessionId: "session_1",
        backgroundJobs: [runningJob("task_1")]
      })
    });

    await client.refreshRuntimeState();

    expect(client.runtimeProjection?.backgroundJobs).toHaveLength(1);
  });
});

describe("TUI client selection commands", () => {
  test("submits a selection made without an active primary turn", async () => {
    const submitted: unknown[] = [];
    const client = createClient({
      submitPrompt: async (input) => {
        submitted.push(input);
        return {};
      }
    });
    client.showChoice = async (options) => options.items[0] ?? null;

    await client.showSelection({
      title: "Configure model access",
      prompt: "Select a provider.",
      items: [{ command: "/login bigmodel-coding-plan", primary: "BigModel Coding Plan" }]
    });

    expect(submitted).toEqual(["/login bigmodel-coding-plan"]);
    expect(client.queuedSelectionCommand).toBeUndefined();
  });

  test("queues a selection made during a primary turn", async () => {
    const submitted: unknown[] = [];
    const client = createClient({
      submitPrompt: async (input) => {
        submitted.push(input);
        return {};
      }
    });
    client.showChoice = async (options) => options.items[0] ?? null;
    client.primaryTurnActive = true;

    await client.showSelection({
      title: "Configure model access",
      prompt: "Select a provider.",
      items: [{ command: "/login bigmodel-coding-plan", primary: "BigModel Coding Plan" }]
    });

    expect(submitted).toEqual([]);
    expect(client.queuedSelectionCommand?.input).toBe("/login bigmodel-coding-plan");
  });
});

describe("TUI client conversation rewind", () => {
  test("cancels a pending rewind from the keyboard", async () => {
    for (const key of interruptKeys) {
      let listener: ((data: string) => unknown) | undefined;
      const client = createClient({
        loadSessionTranscript: () => new Promise(() => {})
      });
      client.ui.addInputListener = (candidate) => {
        listener = candidate;
      };
      client.bindInput();

      const flow = client.showConversationRewind();
      expect(client.rewindFlowActive).toBeTrue();
      expect(listener?.(key)).toEqual({ consume: true });
      await settled(flow);

      expect(client.rewindFlowActive).toBeFalse();
    }
  });
});
