// Ported from t3code packages/contracts/src/{model,modelSelection,server}.ts (effect/Schema → zod).
// Names stay as in t3code. Branded ids (`ProviderDriverKind`, `ProviderInstanceId`) are plain
// trimmed strings here, as in @factory/harness-handoff.
import { z } from "zod";

export const TrimmedNonEmptyString = z.string().trim().min(1);

export const ProviderDriverKind = TrimmedNonEmptyString;
export type ProviderDriverKind = z.infer<typeof ProviderDriverKind>;
export const ProviderInstanceId = TrimmedNonEmptyString;
export type ProviderInstanceId = z.infer<typeof ProviderInstanceId>;

// ---- model.ts ---------------------------------------------------------------------------------

export const ProviderOptionDescriptorType = z.enum(["select", "boolean"]);
export type ProviderOptionDescriptorType = z.infer<typeof ProviderOptionDescriptorType>;

export const ProviderOptionChoice = z.object({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString.optional(),
  isDefault: z.boolean().optional(),
});
export type ProviderOptionChoice = z.infer<typeof ProviderOptionChoice>;

const ProviderOptionDescriptorBase = {
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString.optional(),
} as const;

export const SelectProviderOptionDescriptor = z.object({
  ...ProviderOptionDescriptorBase,
  type: z.literal("select"),
  options: z.array(ProviderOptionChoice).readonly(),
  currentValue: TrimmedNonEmptyString.optional(),
  promptInjectedValues: z.array(TrimmedNonEmptyString).readonly().optional(),
  /** Marks the reasoning control when its id is an agent's own, such as an ACP `thought_level`. */
  role: z.literal("reasoning").optional(),
});
export type SelectProviderOptionDescriptor = z.infer<typeof SelectProviderOptionDescriptor>;

export const BooleanProviderOptionDescriptor = z.object({
  ...ProviderOptionDescriptorBase,
  type: z.literal("boolean"),
  currentValue: z.boolean().optional(),
});
export type BooleanProviderOptionDescriptor = z.infer<typeof BooleanProviderOptionDescriptor>;

export const ProviderOptionDescriptor = z.discriminatedUnion("type", [
  SelectProviderOptionDescriptor,
  BooleanProviderOptionDescriptor,
]);
export type ProviderOptionDescriptor = z.infer<typeof ProviderOptionDescriptor>;

export const ProviderOptionSelectionValue = z.union([TrimmedNonEmptyString, z.boolean()]);
export type ProviderOptionSelectionValue = z.infer<typeof ProviderOptionSelectionValue>;

export const ProviderOptionSelection = z.object({
  id: TrimmedNonEmptyString,
  value: ProviderOptionSelectionValue,
});
export type ProviderOptionSelection = z.infer<typeof ProviderOptionSelection>;

/** Arrays decode as is; a legacy `{ id: value }` object decodes to the array form. */
export const ProviderOptionSelections = z.preprocess(
  (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? coerceLegacyOptionsObjectToArray(value as Record<string, unknown>)
      : value,
  z.array(ProviderOptionSelection).readonly(),
);
export type ProviderOptionSelections = z.infer<typeof ProviderOptionSelections>;

function coerceLegacyOptionsObjectToArray(
  record: Record<string, unknown>,
): ReadonlyArray<ProviderOptionSelection> {
  const entries: Array<ProviderOptionSelection> = [];
  for (const [rawKey, rawValue] of Object.entries(record)) {
    const id = typeof rawKey === "string" ? rawKey.trim() : "";
    if (id.length === 0) continue;
    if (typeof rawValue === "string") {
      const trimmed = rawValue.trim();
      if (trimmed.length > 0) entries.push({ id, value: trimmed });
    } else if (typeof rawValue === "boolean") {
      entries.push({ id, value: rawValue });
    }
  }
  return entries;
}

export function canonicalSelectionsToLegacyObject(
  selections: ReadonlyArray<ProviderOptionSelection>,
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const { id, value } of selections) {
    out[id] = value;
  }
  return out;
}

export const ModelCapabilities = z.object({
  optionDescriptors: z.array(ProviderOptionDescriptor).readonly().optional(),
});
export type ModelCapabilities = z.infer<typeof ModelCapabilities>;

export const CustomModelEntry = z.object({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString.optional(),
  capabilities: ModelCapabilities.optional(),
});
export type CustomModelEntry = z.infer<typeof CustomModelEntry>;

export const CustomModelSetting = z.union([z.string(), CustomModelEntry]);
export type CustomModelSetting = z.infer<typeof CustomModelSetting>;

const CLAUDE_DRIVER_KIND: ProviderDriverKind = "claudeAgent";

/** Only the Claude entries of t3code's per-driver tables: Factory runs no other t3code driver. */
export const DEFAULT_MODEL_BY_PROVIDER: Partial<Record<ProviderDriverKind, string>> = {
  [CLAUDE_DRIVER_KIND]: "claude-opus-5-5",
};

export const DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER: Partial<
  Record<ProviderDriverKind, string>
> = {
  [CLAUDE_DRIVER_KIND]: "claude-haiku-5-5",
};

export const MODEL_SLUG_ALIASES_BY_PROVIDER: Partial<
  Record<ProviderDriverKind, Record<string, string>>
> = {
  [CLAUDE_DRIVER_KIND]: {},
};

export const PROVIDER_DISPLAY_NAMES: Partial<Record<ProviderDriverKind, string>> = {
  [CLAUDE_DRIVER_KIND]: "Claude",
};

// ---- modelSelection.ts ------------------------------------------------------------------------

const ModelSelectionWire = z.object({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: ProviderOptionSelections.optional(),
});

/** Older selections name the driver as `provider`; it decodes to `instanceId`. */
export const ModelSelection = z.preprocess((raw) => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const source = raw as { provider?: unknown; instanceId?: unknown; model?: unknown; options?: unknown };
  const instanceIdSource =
    source.instanceId !== undefined
      ? source.instanceId
      : typeof source.provider === "string"
        ? source.provider
        : undefined;
  const base: Record<string, unknown> = {
    instanceId: instanceIdSource,
    model: source.model,
  };
  if (source.options !== undefined) base.options = source.options;
  return base;
}, ModelSelectionWire);
export type ModelSelection = z.infer<typeof ModelSelection>;

// ---- server.ts --------------------------------------------------------------------------------

export const ServerProviderModel = z.object({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  shortName: TrimmedNonEmptyString.optional(),
  subProvider: TrimmedNonEmptyString.optional(),
  aliases: z.array(TrimmedNonEmptyString).readonly().optional(),
  badge: z.literal("new").optional(),
  isCustom: z.boolean(),
  isDefault: z.boolean().optional(),
  isLegacy: z.boolean().optional(),
  capabilities: ModelCapabilities.nullable(),
});
export type ServerProviderModel = z.infer<typeof ServerProviderModel>;

export const ServerProviderUpdateRequiredModel = z.object({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  badge: z.literal("new").optional(),
  minVersion: TrimmedNonEmptyString,
});
export type ServerProviderUpdateRequiredModel = z.infer<typeof ServerProviderUpdateRequiredModel>;
