// Ported from t3code apps/server/src/provider/ClaudeModelManifest.ts (effect/Schema → zod). The
// `decode*Adapter` functions return the value or `null` where t3code returned an `Option`.
import { z } from "zod";

import { TrimmedNonEmptyString } from "@factory/harness/models/contracts";
import { compareSemverVersions, parseSemver } from "./semver.ts";

export const ClaudeCodeProfileSchema = z.object({
  effortMap: z.record(TrimmedNonEmptyString, TrimmedNonEmptyString.nullable()).optional(),
  modelSuffixes: z
    .record(TrimmedNonEmptyString, z.record(TrimmedNonEmptyString, TrimmedNonEmptyString))
    .optional(),
  contextWindowTokens: z.record(TrimmedNonEmptyString, z.number()).optional(),
  fixedContextWindowTokens: z.number().optional(),
});

export const ClaudeProfileAdapterSchema = z.object({
  claudeCode: ClaudeCodeProfileSchema.optional(),
});

const ClaudeVersionSchema = TrimmedNonEmptyString.refine((version) => parseSemver(version) !== null, {
  message: "a supported semantic version",
});

const ClaudeCodeCompatibilitySchema = z
  .object({
    minVersion: ClaudeVersionSchema.optional(),
    maxVersionExclusive: ClaudeVersionSchema.optional(),
  })
  .refine(
    ({ minVersion, maxVersionExclusive }) =>
      minVersion === undefined ||
      maxVersionExclusive === undefined ||
      compareSemverVersions(minVersion, maxVersionExclusive) < 0,
    { message: "a minimum version below the exclusive maximum version" },
  );

export const ClaudeModelAdapterSchema = z.object({
  claudeCode: ClaudeCodeCompatibilitySchema.optional(),
});

export type ClaudeCodeProfile = z.infer<typeof ClaudeCodeProfileSchema>;
export type ClaudeCodeCompatibility = NonNullable<z.infer<typeof ClaudeModelAdapterSchema>["claudeCode"]>;

export const decodeClaudeProfileAdapter = (
  value: unknown,
): z.infer<typeof ClaudeProfileAdapterSchema> | null => {
  const decoded = ClaudeProfileAdapterSchema.safeParse(value);
  return decoded.success ? decoded.data : null;
};
export const decodeClaudeModelAdapter = (
  value: unknown,
): z.infer<typeof ClaudeModelAdapterSchema> | null => {
  const decoded = ClaudeModelAdapterSchema.safeParse(value);
  return decoded.success ? decoded.data : null;
};

interface ClaudeManifestAdapterInput {
  readonly providers?:
    | Readonly<
        Record<
          string,
          | {
              readonly profiles: Readonly<Record<string, { readonly adapter?: unknown }>>;
              readonly models: ReadonlyArray<{ readonly adapter?: unknown }>;
            }
          | undefined
        >
      >
    | undefined;
}

export function hasValidClaudeManifestAdapters(manifest: ClaudeManifestAdapterInput): boolean {
  const catalog = manifest.providers?.claudeAgent;
  if (!catalog) return true;

  return (
    Object.values(catalog.profiles).every(
      (profile) => decodeClaudeProfileAdapter(profile.adapter ?? {}) !== null,
    ) && catalog.models.every((model) => decodeClaudeModelAdapter(model.adapter ?? {}) !== null)
  );
}
