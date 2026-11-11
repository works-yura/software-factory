// The "model switch change" cases of t3code packages/client-runtime/src/handoff.test.ts (MIT, see
// vendor/t3code), against the ported `resolveModelSwitchChange`; the alias case is Factory's.
import { describe, expect, it } from "vitest";

import { readModelSwitch, resolveModelSwitchChange } from "./ModelSwitchRow";
import type { ProviderInstanceEntry } from "./providerInstances";

type ServerProvider = Pick<ProviderInstanceEntry, "instanceId" | "models">;

const from = "codex_personal";

describe("model switch change", () => {
  const selection = (model: string, options?: Record<string, string>) => ({
    instanceId: from,
    model,
    ...(options === undefined
      ? {}
      : { options: Object.entries(options).map(([id, value]) => ({ id, value })) }),
  });
  const providers = [
    {
      instanceId: from,
      models: ["gpt", "mini"].map((slug) => ({
        slug,
        capabilities: {
          optionDescriptors: [
            { id: "serviceTier", type: "select", options: [{ id: "fast", label: "Fast" }] },
            {
              id: "thought_level",
              type: "select",
              role: "reasoning",
              options: [
                { id: "medium", label: "Medium", isDefault: true },
                { id: "high", label: "High" },
              ],
            },
          ],
        },
      })),
    },
  ] as unknown as ServerProvider[];

  it("shows only what changed, reading an unset effort as the default", () => {
    expect(
      resolveModelSwitchChange(
        { from: selection("gpt"), to: selection("gpt", { thought_level: "high" }) },
        providers,
      ),
    ).toEqual({ modelChanged: false, effort: { from: "Medium", to: "High" } });
    expect(
      resolveModelSwitchChange({ from: selection("gpt"), to: selection("mini") }, providers),
    ).toEqual({ modelChanged: true, effort: null });
  });

  it("ignores changes the user cannot see", () => {
    expect(
      resolveModelSwitchChange(
        { from: selection("gpt"), to: selection("gpt", { thought_level: "medium" }) },
        providers,
      ),
    ).toBeNull();
    expect(
      resolveModelSwitchChange(
        { from: selection("gpt"), to: selection("gpt", { serviceTier: "fast" }) },
        providers,
      ),
    ).toBeNull();
    // A cataloged model without an effort control ignores stale effort options.
    expect(
      resolveModelSwitchChange(
        {
          from: selection("plain", { reasoningEffort: "low" }),
          to: selection("plain", { reasoningEffort: "high" }),
        },
        [{ instanceId: from, models: [{ slug: "plain" }] }] as unknown as ServerProvider[],
      ),
    ).toBeNull();
  });

  it("falls back to stated efforts without a catalog", () => {
    expect(
      resolveModelSwitchChange(
        {
          from: selection("gpt", { reasoningEffort: "low" }),
          to: selection("gpt", { reasoningEffort: "high" }),
        },
        [],
      ),
    ).toEqual({ modelChanged: false, effort: { from: "low", to: "high" } });
    expect(
      resolveModelSwitchChange(
        {
          from: selection("pi", { thinking: "low" }),
          to: selection("pi", { thinking: "high" }),
        },
        [],
      ),
    ).toEqual({ modelChanged: false, effort: { from: "low", to: "high" } });
    expect(
      resolveModelSwitchChange(
        { from: selection("gpt"), to: selection("gpt", { reasoningEffort: "high" }) },
        [],
      ),
    ).toBeNull();
  });

  it("reads a CLI alias as the model it names", () => {
    const claude = [
      { instanceId: from, models: [{ slug: "claude-opus-5-5", aliases: ["opus"] }] },
    ] as unknown as ServerProvider[];
    expect(
      resolveModelSwitchChange(
        { from: selection("opus"), to: selection("claude-opus-5-5") },
        claude,
      ),
    ).toBeNull();
  });
});

describe("readModelSwitch", () => {
  it("reads the marker the server stamps on a user message, and nothing else", () => {
    const marker = {
      from: { instanceId: "claude-code", model: "opus", options: [{ id: "effort", value: "high" }] },
      to: { instanceId: "claude-code", model: "sonnet" },
    };
    expect(readModelSwitch({ modelSwitch: marker })).toEqual(marker);
    expect(readModelSwitch({ modelSwitch: { from: marker.from } })).toBeNull();
    expect(readModelSwitch(undefined)).toBeNull();
  });
});
