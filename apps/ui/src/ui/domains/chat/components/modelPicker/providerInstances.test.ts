// New for Factory: the one adapter from `GET /web/config/models` to provider instances.
import { describe, expect, it } from "vitest";

import { findInstanceModel, instanceForHarness, toProviderInstances } from "./providerInstances";

const mastraEntry = {
  id: "anthropic/claude-sonnet-4-5",
  provider: "anthropic",
  modelName: "claude-sonnet-4-5",
  hasApiKey: true as const,
  capabilities: {
    optionDescriptors: [
      {
        id: "effort",
        type: "select" as const,
        role: "reasoning" as const,
        label: "Reasoning",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ],
      },
    ],
  },
};

describe("toProviderInstances", () => {
  it("lists Mastra's credentialed models as one instance, sub-provider per model", () => {
    const [mastra] = toProviderInstances({ models: [mastraEntry], defaultModelId: mastraEntry.id });
    expect(mastra).toMatchObject({
      instanceId: "mastra",
      driverKind: "mastra",
      isAvailable: true,
      needsSetup: false,
      defaultModel: mastraEntry.id,
    });
    expect(mastra?.models[0]).toMatchObject({
      slug: mastraEntry.id,
      name: "claude-sonnet-4-5",
      subProvider: "Anthropic",
    });
  });

  it("offers setup when no credential reaches a Mastra model", () => {
    const [mastra] = toProviderInstances({ models: [] });
    expect(mastra).toMatchObject({ isAvailable: false, needsSetup: true, status: "error" });
  });

  it("lists every harness instance the server sends, with short names", () => {
    const entries = toProviderInstances({
      models: [],
      instances: [
        {
          instanceId: "claude-code",
          harnessId: "claude-code",
          displayName: "Claude Code",
          available: true,
          needsSetup: false,
          defaultModel: "claude-opus-5-5",
          defaultSelection: { instanceId: "claude-code", model: "claude-opus-5-5" },
          factoryDefaultSelection: null,
          catalogDefaultSelection: { instanceId: "claude-code", model: "claude-opus-5-5" },
          appliesToRunningSessions: false,
          models: [
            {
              slug: "claude-opus-5-5",
              name: "Claude Opus 5.5",
              aliases: ["opus"],
              isCustom: false,
              capabilities: null,
            },
          ],
        },
      ],
    });
    const claude = instanceForHarness(entries, "claude-code");
    expect(claude).toMatchObject({ instanceId: "claude-code", displayName: "Claude Code", isAvailable: true });
    expect(claude?.models[0]?.shortName).toBe("Opus 5.5");
    expect(findInstanceModel(entries, { instanceId: "claude-code", model: "opus" })?.slug).toBe(
      "claude-opus-5-5",
    );
  });

  it("takes a harness it has never heard of as it comes", () => {
    const [codex] = toProviderInstances({
      models: [],
      instances: [
        {
          instanceId: "codex-stub",
          harnessId: "codex",
          displayName: "Codex",
          available: true,
          needsSetup: false,
          defaultModel: "gpt-5.3-codex",
          defaultSelection: null,
          factoryDefaultSelection: null,
          catalogDefaultSelection: null,
          appliesToRunningSessions: false,
          models: [{ slug: "gpt-5.3-codex", name: "GPT-5.3 Codex", isCustom: false, capabilities: { optionDescriptors: [] } }],
        },
      ],
    });
    expect(codex).toMatchObject({
      instanceId: "codex-stub",
      driverKind: "codex",
      displayName: "Codex",
      status: "ready",
      defaultModel: "gpt-5.3-codex",
      models: [{ slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" }],
    });
  });

  it("has no instances before the catalog loads", () => {
    expect(toProviderInstances(undefined)).toEqual([]);
  });
});
