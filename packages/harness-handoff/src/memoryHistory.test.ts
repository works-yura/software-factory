import type { MastraDBMessage } from "@mastra/core/agent-controller";
import { createSignal } from "@mastra/core/signals";
import { InMemoryStore } from "@mastra/core/storage";
import { describe, expect, it } from "vitest";

import { isHandoffThreadNotFoundError } from "./errors.ts";
import {
  CONTEXT_HANDOFF_SIGNAL_TAG,
  createMemoryHistorySource,
  turnItemsFromMessages,
  type HandoffMemory,
} from "./memoryHistory.ts";
import { readThread, threadReadSourceFromHistory } from "./threadRead.ts";

const THREAD = "session-1";
const RESOURCE = "resource-1";
let clock = Date.parse("2026-11-01T10:00:00.000Z");
const at = () => new Date((clock += 1000));

function userMessage(id: string, text: string): MastraDBMessage {
  return {
    id,
    role: "user",
    createdAt: at(),
    threadId: THREAD,
    resourceId: RESOURCE,
    content: { format: 2, parts: [{ type: "text", text }] },
  };
}

/** A person's input as the Claude Code / Codex chat channel records it: a `user` signal. */
function userSignal(id: string, text: string): MastraDBMessage {
  return createSignal({ id, type: "user", tagName: "user", contents: text, createdAt: at() }).toDBMessage({
    threadId: THREAD,
    resourceId: RESOURCE,
  });
}

function assistant(id: string, parts: unknown[]): MastraDBMessage {
  return {
    id,
    role: "assistant",
    createdAt: at(),
    threadId: THREAD,
    resourceId: RESOURCE,
    content: { format: 2, parts: parts as MastraDBMessage["content"]["parts"] },
  };
}

const tool = (toolCallId: string, toolName: string, args: unknown, result?: unknown) => ({
  type: "tool-invocation",
  toolInvocation:
    result === undefined
      ? { state: "call", toolCallId, toolName, args }
      : { state: "result", toolCallId, toolName, args, result },
});

describe("turnItemsFromMessages", () => {
  it("maps a Mastra thread: messages, commands as command executions, other tools as dynamic tools", () => {
    const { runs, turnItems } = turnItemsFromMessages(
      [
        userMessage("m1", "Fix the login bug"),
        assistant("m2", [
          { type: "text", text: "Looking at it." },
          tool("c1", "execute_command", { command: "npm test" }, { stdout: "1 failing", exitCode: 1 }),
          tool("c2", "view", { path: "src/login.ts" }, "file body"),
          { type: "text", text: "Found it: the token check." },
        ]),
        userMessage("m3", "Ship it"),
      ],
      { threadId: THREAD, providerInstanceId: "mastra" },
    );
    expect(runs.map((run) => [run.ordinal, run.userMessageId])).toEqual([
      [1, "m1"],
      [2, "m3"],
    ]);
    expect(turnItems.map((item) => item.type)).toEqual([
      "user_message",
      "assistant_message",
      "command_execution",
      "dynamic_tool",
      "assistant_message",
      "user_message",
    ]);
    const command = turnItems[2];
    expect(command).toMatchObject({ type: "command_execution", input: "npm test", output: "1 failing", exitCode: 1, runId: "run:m1" });
    expect(turnItems[4]).toMatchObject({ text: "Found it: the token check.", runId: "run:m1" });
    expect(turnItems.at(-1)).toMatchObject({ text: "Ship it", runId: "run:m3" });
  });

  it("maps a Claude Code transcript as the chat channel stores it: user signals, Bash calls", () => {
    const { turnItems } = turnItemsFromMessages(
      [
        userSignal("in-1", "Why does CI fail?"),
        assistant("claude-run-1-1", [
          { type: "reasoning", reasoning: "Check the workflow.", details: [] },
          tool("toolu_1", "Bash", { command: "gh run view" }, "lint failed"),
          { type: "text", text: "Lint fails on src/a.ts." },
        ]),
      ],
      { threadId: THREAD, providerInstanceId: "claude-code" },
    );
    expect(turnItems.map((item) => item.type)).toEqual([
      "user_message",
      "reasoning",
      "command_execution",
      "assistant_message",
    ]);
    expect(turnItems[0]).toMatchObject({ text: "Why does CI fail?", createdBy: "user" });
    expect(turnItems[2]).toMatchObject({ input: "gh run view", output: "lint failed" });
  });

  it("maps a Codex transcript: execute_command with an argv, notifications, and skips state signals", () => {
    const state = createSignal({
      id: "env",
      type: "state",
      tagName: "factory-environment",
      contents: "repositories…",
      createdAt: at(),
    } as never).toDBMessage({ threadId: THREAD, resourceId: RESOURCE });
    const notice = createSignal({
      id: "n1",
      type: "reactive",
      tagName: "notification",
      contents: "CI passed",
      createdAt: at(),
    }).toDBMessage({ threadId: THREAD, resourceId: RESOURCE });
    const marker = createSignal({
      id: "h1",
      type: "reactive",
      tagName: CONTEXT_HANDOFF_SIGNAL_TAG,
      contents: "Context handoff: Claude Code → Codex.",
      createdAt: at(),
    }).toDBMessage({ threadId: THREAD, resourceId: RESOURCE });
    marker.content.metadata = { ...marker.content.metadata, contextHandoff: { toInstanceId: "codex", reason: "switch" } };
    const { turnItems } = turnItemsFromMessages(
      [
        state,
        userSignal("in-1", "Run the suite"),
        assistant("codex-1", [tool("i1", "execute_command", { command: ["pnpm", "test"] }, "ok")]),
        notice,
        marker,
      ],
      { threadId: THREAD, providerInstanceId: "codex" },
    );
    expect(turnItems.map((item) => item.type)).toEqual(["user_message", "command_execution", "notification", "handoff"]);
    expect(turnItems[1]).toMatchObject({ input: "pnpm test" });
    expect(turnItems[3]).toMatchObject({ toProviderInstanceId: "codex", strategy: "switch" });
  });
});

describe("createMemoryHistorySource", () => {
  async function memoryWith(messages: MastraDBMessage[]): Promise<HandoffMemory> {
    const memory = (await new InMemoryStore().getStore("memory"))!;
    const now = new Date();
    await memory.saveThread({ thread: { id: THREAD, resourceId: RESOURCE, title: "Login bug", createdAt: now, updatedAt: now, metadata: {} } });
    await memory.saveMessages({ messages });
    return memory;
  }

  it("reads the thread's records, and leaves out what was stored from `before` on", async () => {
    const first = userMessage("m1", "First");
    const reply = assistant("m2", [{ type: "text", text: "Reply" }]);
    const late = userMessage("m3", "The turn being sent");
    const memory = await memoryWith([first, reply, late]);
    const source = createMemoryHistorySource({
      memory: async () => memory,
      resolve: async () => ({ resourceId: RESOURCE, providerInstanceId: "mastra", before: late.createdAt }),
    });
    const records = await source.getThreadRecords(THREAD, ["runs", "turnItems"]);
    expect(records.thread).toMatchObject({ id: THREAD, title: "Login bug", providerInstanceId: "mastra" });
    expect(records.turnItems.map((item) => item.id)).toEqual(["m1", "m2:0"]);
  });

  it("hides a thread its resolver refuses, or one under another resource", async () => {
    const memory = await memoryWith([userMessage("m1", "x")]);
    const refused = createMemoryHistorySource({ memory: async () => memory, resolve: async () => null });
    await expect(refused.getThreadRecords(THREAD, [])).rejects.toSatisfy(isHandoffThreadNotFoundError);
    const other = createMemoryHistorySource({ memory: async () => memory, resolve: async () => ({ resourceId: "someone-else" }) });
    await expect(other.getThreadRecords(THREAD, [])).rejects.toSatisfy(isHandoffThreadNotFoundError);
  });

  it("pages the timeline for factory_thread_read", async () => {
    const memory = await memoryWith([
      userMessage("m1", "One"),
      assistant("m2", [{ type: "text", text: "Two" }]),
      userMessage("m3", "Three"),
    ]);
    const source = threadReadSourceFromHistory(createMemoryHistorySource({ memory: async () => memory }));
    const page = await readThread(source, { threadId: THREAD, limit: 2 });
    expect(page.items.map((item) => item.text)).toEqual(["One", "Two"]);
    expect(page.hasMore).toBe(true);
    const rest = await readThread(source, { threadId: THREAD, afterPosition: page.nextPosition! });
    expect(rest.items.map((item) => item.text)).toEqual(["Three"]);
  });
});
