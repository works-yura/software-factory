// Ported from t3code apps/server/src/provider/ModelManifest.ts: the schemas (effect/Schema → zod),
// the bundled manifest and `resolveProviderCatalog`. The remote refresh (GitHub raw fetch, disk
// cache, TTLs, the `ModelManifest`/`ModelCatalog` Effect layers) is not ported: Factory reads the
// manifest bundled with this package, and an update is a copy of t3code's `model-manifest.json`.
import { z } from "zod";

import { ModelCapabilities, TrimmedNonEmptyString, type ProviderDriverKind } from "@factory/harness/models/contracts";
import { hasValidClaudeManifestAdapters } from "./ClaudeModelManifest.ts";
import bundledManifestJson from "./model-manifest.json" with { type: "json" };
import type * as ModelCatalog from "@factory/harness/models/ModelCatalog";

const MODEL_NEW_BADGE_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

const ManifestModelStatus = z.enum(["current", "legacy"]);

const ManifestModelProfile = z.object({
  capabilities: ModelCapabilities.optional(),
  adapter: z.unknown().optional(),
});

const ManifestProviderModel = z.object({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  shortName: TrimmedNonEmptyString.optional(),
  subProvider: TrimmedNonEmptyString.optional(),
  aliases: z.array(TrimmedNonEmptyString).optional(),
  status: ManifestModelStatus,
  /** ISO date or timestamp of the model's public release, as published by its provider. */
  releasedAt: z.string().optional(),
  profile: TrimmedNonEmptyString.optional(),
  adapter: z.unknown().optional(),
});

const ManifestProviderCatalog = z.object({
  defaults: z
    .object({
      chat: TrimmedNonEmptyString.optional(),
    })
    .optional(),
  profiles: z.record(z.string(), ManifestModelProfile),
  models: z.array(ManifestProviderModel),
});

const ModelManifestEnvelopeSchema = z.object({
  version: z.literal(1),
  /** Older disk caches must not override bundled manifests; absent dates rank below any dated bundle. */
  updatedAt: z.string().optional(),
  /** t3code's `ProviderCompatibilityPolicy` list (Codex CLI version ranges); Factory does not read it. */
  compatibility: z.array(z.unknown()).optional(),
  currentModels: z.record(z.string(), z.array(z.string())),
  providers: z.record(z.string(), ManifestProviderCatalog).optional(),
});

const hasValidProviderCatalogReferences = (
  manifest: z.infer<typeof ModelManifestEnvelopeSchema>,
): boolean =>
  Object.values(manifest.providers ?? {}).every((catalog) => {
    const slugs = new Set<string>();
    const modelsAreValid = catalog.models.every((model) => {
      if (slugs.has(model.slug)) return false;
      slugs.add(model.slug);
      return model.profile === undefined || catalog.profiles[model.profile] !== undefined;
    });
    return (
      modelsAreValid && (catalog.defaults?.chat === undefined || slugs.has(catalog.defaults.chat))
    );
  });

const ModelManifestSchema = ModelManifestEnvelopeSchema.refine(hasValidProviderCatalogReferences, {
  message: "unique model slugs and existing model and profile references",
}).refine(hasValidClaudeManifestAdapters, {
  message: "valid Claude adapter metadata",
});
export type ModelManifestData = z.infer<typeof ModelManifestSchema>;

/** `Schema.decodeUnknownEffect(ModelManifestSchema)` in t3code: `null` when the manifest is invalid. */
export function decodeManifest(json: unknown): ModelManifestData | null {
  const decoded = ModelManifestSchema.safeParse(json);
  return decoded.success ? decoded.data : null;
}

export const BUNDLED_MODEL_MANIFEST: ModelManifestData = ModelManifestSchema.parse(bundledManifestJson);

export function manifestUpdatedAtMs(manifest: ModelManifestData): number {
  if (manifest.updatedAt === undefined) return 0;
  const parsed = Date.parse(manifest.updatedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function resolveProviderCatalog(
  manifest: ModelManifestData,
  driverKind: ProviderDriverKind,
  nowMs = Date.now(),
): ModelCatalog.ProviderCatalog | null {
  const catalog = manifest.providers?.[driverKind];
  if (!catalog) return null;

  const seen = new Set<string>();
  const models: Array<ModelCatalog.ProviderCatalogModel> = [];
  for (const entry of catalog.models) {
    if (seen.has(entry.slug)) return null;
    seen.add(entry.slug);

    const profile = entry.profile ? catalog.profiles[entry.profile] : undefined;
    if (entry.profile && !profile) return null;

    const releasedAtMs = entry.releasedAt === undefined ? NaN : Date.parse(entry.releasedAt);
    const showNewBadge =
      entry.status === "current" &&
      nowMs >= releasedAtMs &&
      nowMs - releasedAtMs < MODEL_NEW_BADGE_DURATION_MS;

    models.push({
      slug: entry.slug,
      name: entry.name,
      ...(entry.shortName ? { shortName: entry.shortName } : {}),
      ...(entry.subProvider ? { subProvider: entry.subProvider } : {}),
      ...(entry.aliases ? { aliases: entry.aliases } : {}),
      ...(showNewBadge ? { badge: "new" as const } : {}),
      status: entry.status,
      capabilities: profile?.capabilities ?? null,
      adapter: entry.adapter,
      profileAdapter: profile?.adapter,
    });
  }

  if (catalog.defaults?.chat !== undefined && !seen.has(catalog.defaults.chat)) return null;

  return { models, defaultChatModel: catalog.defaults?.chat };
}
