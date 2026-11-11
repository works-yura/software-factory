import { describe, expect, it } from 'vitest';

import { formatModelSelectionEffort } from '@factory/harness/models/threadExecution';
import { modelSwitchBetween } from '@factory/harness/models/selection';

import { SYNTHETIC_CLAUDE_CAPABLE_MODEL, SYNTHETIC_CLAUDE_MODEL_CATALOG } from './ClaudeModelCatalog.testFixtures.ts';
import {
  CLAUDE_CODE_INSTANCE_ID,
  checkClaudeCodeModelSelection,
  claudeCodeCatalogDefault,
  claudeCodeModels,
  claudeEffortForThinkingLevel,
  compileClaudeCodeTurn,
} from './claude-code.ts';

const factoryDefault = (model: string, effort?: string) => ({
  instanceId: CLAUDE_CODE_INSTANCE_ID,
  model,
  ...(effort ? { options: [{ id: "effort", value: effort }] } : {}),
});

describe("compileClaudeCodeTurn", () => {
  it("keeps a CLI alias on the command line and resolves its effort from the catalog", () => {
    expect(compileClaudeCodeTurn({ factoryDefault: factoryDefault("opus", "high") })).toEqual({
      selection: { instanceId: CLAUDE_CODE_INSTANCE_ID, model: "opus", options: [{ id: "effort", value: "high" }] },
      model: "opus",
      effort: "high",
      settings: { fastMode: false },
    });
  });

  it("lets the session's selection win over the Factory's default, whole", () => {
    const turn = compileClaudeCodeTurn({
      selection: {
        instanceId: CLAUDE_CODE_INSTANCE_ID,
        model: "claude-opus-4-6",
        options: [
          { id: "effort", value: "max" },
          { id: "contextWindow", value: "1m" },
          { id: "fastMode", value: true },
        ],
      },
      factoryDefault: factoryDefault("haiku", "low"),
    });
    expect(turn).toMatchObject({ model: "claude-opus-4-6[1m]", effort: "max", settings: { fastMode: true } });
    // A session pick without an effort runs its model's own default, not the Factory's.
    expect(
      compileClaudeCodeTurn({
        selection: { instanceId: CLAUDE_CODE_INSTANCE_ID, model: "claude-opus-4-6" },
        factoryDefault: factoryDefault("claude-opus-4-6", "low"),
      }).effort,
    ).toBe("high");
  });

  it("maps the default's effort onto the model's choices and Ultrathink onto the prompt", () => {
    // Opus 4.6 has no Extra High: an unknown choice falls back to the model's default.
    expect(compileClaudeCodeTurn({ factoryDefault: factoryDefault("claude-opus-4-6", "xhigh") }).effort).toBe("high");
    // Opus 4.7 runs its Extra High as the CLI's max (its effortMap).
    expect(compileClaudeCodeTurn({ factoryDefault: factoryDefault("claude-opus-4-7", "xhigh") }).effort).toBe("max");
    expect(
      compileClaudeCodeTurn({
        selection: { instanceId: CLAUDE_CODE_INSTANCE_ID, model: "sonnet", options: [{ id: "effort", value: "ultrathink" }] },
      }),
    ).toMatchObject({ model: "sonnet", effort: "high", promptEffort: "ultrathink" });
  });

  it("leaves the CLI its own defaults when nothing names a model", () => {
    expect(compileClaudeCodeTurn({})).toEqual({ selection: null });
    expect(compileClaudeCodeTurn({ selection: null, factoryDefault: null })).toEqual({ selection: null });
  });

  it("compiles against another catalog", () => {
    expect(
      compileClaudeCodeTurn({ factoryDefault: factoryDefault(SYNTHETIC_CLAUDE_CAPABLE_MODEL) }, SYNTHETIC_CLAUDE_MODEL_CATALOG),
    ).toMatchObject({ model: `${SYNTHETIC_CLAUDE_CAPABLE_MODEL}[expanded]`, effort: "high" });
  });

  it("names the catalog's default model", () => {
    expect(claudeCodeCatalogDefault()).toEqual({ instanceId: CLAUDE_CODE_INSTANCE_ID, model: "claude-opus-5-5" });
  });
});

describe("checkClaudeCodeModelSelection", () => {
  it("accepts catalog models and their options, keeping CLI aliases", () => {
    expect(checkClaudeCodeModelSelection({ model: "opus", options: [{ id: "effort", value: "max" }] })).toEqual({
      ok: true,
      selection: { instanceId: CLAUDE_CODE_INSTANCE_ID, model: "opus", options: [{ id: "effort", value: "max" }] },
    });
    expect(checkClaudeCodeModelSelection({ model: "opus-4.6" })).toEqual({
      ok: true,
      selection: { instanceId: CLAUDE_CODE_INSTANCE_ID, model: "claude-opus-4-6" },
    });
  });

  it("reads the old Ultracode effort as Extra High with the toggle", () => {
    expect(checkClaudeCodeModelSelection({ model: "claude-opus-5-5", options: [{ id: "effort", value: "ultracode" }] })).toMatchObject({
      ok: true,
      selection: {
        options: [
          { id: "effort", value: "xhigh" },
          { id: "ultracode", value: true },
        ],
      },
    });
  });

  it("refuses unknown models, options and values", () => {
    expect(checkClaudeCodeModelSelection({ model: "gpt-5" })).toMatchObject({ ok: false, error: expect.stringMatching(/Unknown Claude Code model gpt-5/) });
    expect(checkClaudeCodeModelSelection({ model: "haiku", options: [{ id: "fastMode", value: true }] })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/has no option fastMode/),
    });
    expect(checkClaudeCodeModelSelection({ model: "opus", options: [{ id: "effort", value: "extreme" }] })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/has no effort "extreme"/),
    });
  });
});

describe("claudeCodeModels", () => {
  it("lists current models first, with the catalog default", () => {
    const models = claudeCodeModels();
    expect(models[0]).toMatchObject({ slug: "claude-opus-5-5", isDefault: true });
    const firstLegacy = models.findIndex((model) => model.isLegacy);
    expect(models.slice(firstLegacy).every((model) => model.isLegacy)).toBe(true);
    expect(claudeEffortForThinkingLevel("medium")).toBe("medium");
    expect(claudeEffortForThinkingLevel("bogus")).toBeUndefined();
  });
});

describe("Claude Code switch divider", () => {
  it("labels both sides with the catalog's effort", () => {
    const models = claudeCodeModels();
    const from = { instanceId: CLAUDE_CODE_INSTANCE_ID, model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] };
    const to = { instanceId: CLAUDE_CODE_INSTANCE_ID, model: "claude-sonnet-5-5", options: [{ id: "effort", value: "medium" }] };
    expect(formatModelSelectionEffort(from, models)).toBe("High");
    expect(formatModelSelectionEffort(to, models)).toBe("Medium");
    expect(modelSwitchBetween(from, to)).toEqual({ modelSwitch: { from, to } });
    expect(modelSwitchBetween(undefined, to)).toEqual({});
  });
});
