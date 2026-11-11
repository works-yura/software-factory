import type { MastraDBMessage } from "@mastra/core/agent-controller";
import { InMemoryStore } from "@mastra/core/storage";
import { describe, expect, it } from "vitest";

import { CONTEXT_HANDOFF_SIGNAL_TAG, type HandoffMemory } from "./memoryHistory.ts";
import { createSessionHandoffs, promptWithHandoff, SESSION_HANDOFF_METADATA_KEY } from "./sessionHandoffs.ts";

const THREAD = "session-1";
const RESOURCE = "resource-1";
let clock = Date.parse("2026-11-01T10:00:00.000Z");
const at = () => new Date((clock += 1000));

const message = (id: string, role: "user" | "assistant", text: string): MastraDBMessage => ({
  id,
  role,
  createdAt: at(),
  threadId: THREAD,
  resourceId: RESOURCE,
  content: { format: 2, parts: [{ type: "text", text }] },
});

async function setup(messages: MastraDBMessage[], tokenCap?: number) {
  const memory = (await new InMemoryStore().getStore("memory"))! as HandoffMemory & {
    saveThread: (input: { thread: never }) => Promise<unknown>;
  };
  const now = new Date();
  await memory.saveThread({
    thread: { id: THREAD, resourceId: RESOURCE, title: "", createdAt: now, updatedAt: now, metadata: {} } as never,
  });
  await memory.saveMessages({ messages });
  const labels: Record<string, string> = { mastra: "Mastra", "claude-code": "Claude Code", codex: "Codex" };
  const handoffs = createSessionHandoffs({
    memory: async () => memory,
    label: (id) => labels[id] ?? id,
    ...(tokenCap ? { tokenCap } : {}),
  });
  const markers = async () => {
    const { messages: stored } = await memory.listMessages({ threadId: THREAD, perPage: false as never });
    return stored.filter(
      (stored) => (stored.content.metadata?.signal as { tagName?: string } | undefined)?.tagName === CONTEXT_HANDOFF_SIGNAL_TAG,
    );
  };
  return { memory, handoffs, markers };
}

describe("createSessionHandoffs", () => {
  it("hands the thread's real history to the next turn once, after a pending marker", async () => {
    const { handoffs, markers } = await setup([
      message("m1", "user", "Please rename the login handler"),
      message("m2", "assistant", "Renamed it to handleSignIn in src/auth.ts."),
    ]);
    const handoff = await handoffs.prepare({
      threadId: THREAD,
      resourceId: RESOURCE,
      fromInstanceId: "claude-code",
      toInstanceId: "codex",
      reason: "switch",
    });
    expect(handoff.strategy).toBe("full_thread_summary");
    const [marker] = await markers();
    expect(marker!.content.metadata?.contextHandoff).toMatchObject({ from: "Claude Code", to: "Codex", status: "pending" });

    const turn = await handoffs.forTurn({ threadId: THREAD, userText: "Now add a test" });
    expect(turn?.context).toContain("Please rename the login handler");
    expect(turn?.context).toContain("Renamed it to handleSignIn in src/auth.ts.");
    expect(turn?.context).toContain("factory_thread_read");
    expect(promptWithHandoff(turn, "Now add a test").endsWith("User message:\nNow add a test")).toBe(true);

    await turn!.delivered();
    expect((await markers())[0]!.content.metadata?.contextHandoff).toMatchObject({ status: "delivered" });
    expect(await handoffs.forTurn({ threadId: THREAD, userText: "And another" })).toBeUndefined();
  });

  it("sends it again when the prompt never reached the provider", async () => {
    const { handoffs } = await setup([message("m1", "user", "Hello"), message("m2", "assistant", "Hi")]);
    await handoffs.prepare({ threadId: THREAD, resourceId: RESOURCE, fromInstanceId: "mastra", toInstanceId: "claude-code", reason: "switch" });
    const first = await handoffs.forTurn({ threadId: THREAD, userText: "Next" });
    await first!.unsent();
    const second = await handoffs.forTurn({ threadId: THREAD, userText: "Next" });
    expect(second?.context).toContain("Hello");
  });

  it("re-sends a delivery the provider never confirmed (a crash after it was handed over)", async () => {
    const { handoffs } = await setup([message("m1", "user", "Hello"), message("m2", "assistant", "Hi")]);
    await handoffs.prepare({ threadId: THREAD, resourceId: RESOURCE, fromInstanceId: "mastra", toInstanceId: "codex", reason: "switch" });
    await handoffs.forTurn({ threadId: THREAD, userText: "Next" });
    const again = await handoffs.forTurn({ threadId: THREAD, userText: "Next" });
    expect(again?.context).toContain("Hello");
  });

  it("names omitted items for factory_thread_read when the history does not fit, never cutting one", async () => {
    const long = "x".repeat(900);
    const history = Array.from({ length: 12 }, (_, index) =>
      message(`m${index}`, index % 2 === 0 ? "user" : "assistant", `${index}:${long}`),
    );
    const { handoffs, memory } = await setup(history, 4_000);
    const handoff = await handoffs.prepare({ threadId: THREAD, resourceId: RESOURCE, fromInstanceId: "codex", toInstanceId: "mastra", reason: "switch" });
    expect(handoff.history!.omittedItems).toBeGreaterThan(0);
    const turn = await handoffs.forTurn({ threadId: THREAD, userText: "Continue" });
    expect(turn!.context).toMatch(/omitted \d+ items/);
    for (const kept of handoff.history!.messages) expect(turn!.context).toContain(kept.text);
    const thread = await memory.getThreadById({ threadId: THREAD });
    expect(thread?.metadata?.[SESSION_HANDOFF_METADATA_KEY]).toBeDefined();
  });

  it("supersedes a pending handoff with the next one, and marks a failed move", async () => {
    const { handoffs, markers } = await setup([message("m1", "user", "Hello")]);
    const first = await handoffs.prepare({ threadId: THREAD, resourceId: RESOURCE, fromInstanceId: "mastra", toInstanceId: "codex", reason: "switch" });
    const second = await handoffs.prepare({ threadId: THREAD, resourceId: RESOURCE, fromInstanceId: "codex", toInstanceId: "claude-code", reason: "switch" });
    const state = await handoffs.state(THREAD);
    expect(state?.handoffs.find((handoff) => handoff.id === first.id)?.status).toBe("superseded");
    await handoffs.fail({ threadId: THREAD, handoffId: second.id, error: "no CLI" });
    const failed = (await markers()).find(
      (stored) => (stored.content.metadata?.contextHandoff as { handoffId?: string }).handoffId === second.id,
    );
    expect(failed?.content.metadata?.contextHandoff).toMatchObject({ status: "failed", error: "no CLI" });
    expect(await handoffs.forTurn({ threadId: THREAD, userText: "x" })).toBeUndefined();
  });
});
