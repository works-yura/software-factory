// New for Factory: the ported draft-store actions (t3code tests them through its zustand store
// and Effect schemas, which are not ported). Without localStorage the store keeps its state in memory.
import { describe, expect, it } from "vitest";

import { composerDraftActions, useComposerDraftStore } from "./composerDraftStore";

const state = () => useComposerDraftStore.getState();

describe("composer draft store", () => {
  it("keeps a thread's explicit pick until the same pick is released", () => {
    const pick = { instanceId: "claude-code", model: "claude-sonnet-5-5" };
    composerDraftActions.setModelSelection("thread-1", pick, { explicit: true, replaceOptions: true });
    expect(state().draftsByThreadKey["thread-1"]).toMatchObject({
      activeProvider: "claude-code",
      modelSelectionExplicit: true,
    });
    composerDraftActions.releaseModelSelection("thread-1", { ...pick, model: "other" });
    expect(state().draftsByThreadKey["thread-1"]).toBeDefined();
    composerDraftActions.releaseModelSelection("thread-1", pick);
    expect(state().draftsByThreadKey["thread-1"]).toBeUndefined();
  });

  it("remembers a model's options as sticky, per model", () => {
    composerDraftActions.setProviderModelOptions(
      "thread-2",
      "claude-code",
      [{ id: "effort", value: "high" }],
      { model: "claude-opus-5-5", persistSticky: true },
    );
    expect(state().stickyOptionsByModelByProvider["claude-code"]?.["claude-opus-5-5"]).toEqual([
      { id: "effort", value: "high" },
    ]);
    expect(state().stickyActiveProvider).toBe("claude-code");
    composerDraftActions.setProviderModelOptions("thread-2", "claude-code", [], {
      model: "claude-opus-5-5",
      persistSticky: true,
    });
    expect(
      state().stickyOptionsByModelByProvider["claude-code"]?.["claude-opus-5-5"],
    ).toBeUndefined();
  });

  it("keeps sticky traits when only the model changes", () => {
    composerDraftActions.setStickyModelSelection({
      instanceId: "mastra",
      model: "openai/gpt-5",
      options: [{ id: "effort", value: "low" }],
    });
    composerDraftActions.setStickyModelSelection({ instanceId: "mastra", model: "anthropic/claude" });
    expect(state().stickyModelSelectionByProvider.mastra).toEqual({
      instanceId: "mastra",
      model: "anthropic/claude",
      options: [{ id: "effort", value: "low" }],
    });
  });
});
