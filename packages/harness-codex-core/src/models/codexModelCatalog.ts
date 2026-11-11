// Codex's model catalog: what `model/list` reports, classified against the bundled manifest's `codex`
// section (legacy models, the catalog default, models a newer CLI would offer), and that section on
// its own when the CLI cannot be asked.
import type { ServerProviderModel, ServerProviderUpdateRequiredModel } from '@factory/harness/models/contracts';
import * as ModelCatalog from '@factory/harness/models/ModelCatalog';
import { BUNDLED_MODEL_MANIFEST, resolveProviderCatalog, type ModelManifestData } from '@factory/harness-claude-code/models/ModelManifest';
import { compareSemverVersions, parseSemver } from '@factory/harness-claude-code/models/semver';

import type { ModelListResponse } from '../protocol/schema.ts';
import {
  codexEffortDescriptor,
  codexModelFamily,
  codexServiceTierDescriptor,
  formatCodexModelName,
  mapCodexModelCapabilities,
} from './codexModelOptions.ts';

/** The manifest's driver key for Codex. */
export const CODEX_DRIVER_KIND = 'codex';

const CODEX_MATCHING: ModelCatalog.CatalogMatching = { family: codexModelFamily };

function minVersionOf(adapter: unknown): string | undefined {
  if (!adapter || typeof adapter !== 'object') return undefined;
  const codex = (adapter as { codex?: unknown }).codex;
  if (!codex || typeof codex !== 'object') return undefined;
  const minVersion = (codex as { minVersion?: unknown }).minVersion;
  return typeof minVersion === 'string' && minVersion.trim() ? minVersion.trim() : undefined;
}

/** Codex catalogs omit models released after the installed CLI. */
function codexUpdateRequiredModels(
  catalog: ModelCatalog.ProviderCatalog | undefined,
  draft: ModelCatalog.ServerProviderDraft & { readonly version?: string },
): ReadonlyArray<ServerProviderUpdateRequiredModel> {
  const version = draft.version?.replace(/^v/, '');
  if (!catalog || !version || parseSemver(version) === null) return [];
  const discovered = new Set(draft.models.map(model => codexModelFamily(model.slug)));
  return catalog.models.flatMap(entry => {
    if (entry.status !== 'current' || discovered.has(codexModelFamily(entry.slug))) return [];
    const minVersion = minVersionOf(entry.adapter);
    if (!minVersion || parseSemver(minVersion) === null) return [];
    if (compareSemverVersions(version, minVersion) >= 0) return [];
    return [{ slug: entry.slug, name: entry.name, ...(entry.badge ? { badge: entry.badge } : {}), minVersion }];
  });
}

export interface CodexCatalogDraft extends ModelCatalog.ServerProviderDraft {
  readonly version?: string;
  readonly updateRequiredModels?: ReadonlyArray<ServerProviderUpdateRequiredModel>;
}

export function applyCodexModelCatalog(
  draft: CodexCatalogDraft,
  catalog: ModelCatalog.ProviderCatalog | undefined,
): CodexCatalogDraft {
  const updateRequiredModels = codexUpdateRequiredModels(catalog, draft);
  return {
    models: ModelCatalog.applyModelCatalog(draft, catalog, CODEX_MATCHING).models,
    ...(draft.version ? { version: draft.version } : {}),
    ...(updateRequiredModels.length > 0 ? { updateRequiredModels } : {}),
  };
}

/** `model/list`'s models, hidden ones left out. */
export function parseCodexModelListResponse(response: ModelListResponse): ServerProviderModel[] {
  return response.data
    .filter(model => !model.hidden)
    .map(model => ({
      slug: model.model,
      name: formatCodexModelName(model.displayName),
      isCustom: false,
      ...(model.isDefault ? { isDefault: true } : {}),
      capabilities: mapCodexModelCapabilities(model),
    }));
}

/** Makes the first model of `preferred` the default, when the list has one. */
export function applyPreferredCodexDefaultModel(
  models: ReadonlyArray<ServerProviderModel>,
  preferred: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  const preferredSlug = preferred.flatMap(slug => models.filter(model => !model.isCustom && codexModelFamily(model.slug) === slug))[0]?.slug;
  if (!preferredSlug) return models;
  return models.map(model => {
    if (model.slug === preferredSlug) return model.isDefault ? model : { ...model, isDefault: true };
    if (!model.isDefault) return model;
    const { isDefault: _isDefault, ...rest } = model;
    return rest;
  });
}

export function resolveCodexProviderCatalog(manifest: ModelManifestData = BUNDLED_MODEL_MANIFEST): ModelCatalog.ProviderCatalog | undefined {
  return resolveProviderCatalog(manifest, CODEX_DRIVER_KIND) ?? undefined;
}

/** What a model the CLI did not describe offers: the efforts and the Fast tier every current Codex model has. */
const FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const FALLBACK_SERVICE_TIERS = [{ id: 'priority', name: 'Fast', description: '' }];

/**
 * The bundled manifest's Codex models, for when the CLI cannot list its own: current models first
 * (the first one the default), legacy ones flagged, each with the usual reasoning and tier options.
 */
export function bundledCodexModels(manifest: ModelManifestData = BUNDLED_MODEL_MANIFEST): ServerProviderModel[] {
  const catalog = resolveCodexProviderCatalog(manifest);
  if (!catalog) return [];
  const capabilities = {
    optionDescriptors: [
      codexEffortDescriptor(FALLBACK_EFFORTS, 'medium')!,
      codexServiceTierDescriptor(FALLBACK_SERVICE_TIERS, null)!,
    ],
  };
  const current = catalog.models.filter(entry => entry.status === 'current');
  const legacy = catalog.models.filter(entry => entry.status === 'legacy');
  const defaultSlug = catalog.defaultChatModel ?? current[0]?.slug;
  return [...current, ...legacy].map(entry => ({
    ...ModelCatalog.catalogServerModel(catalog, entry),
    ...(entry.slug === defaultSlug ? { isDefault: true } : {}),
    capabilities: entry.capabilities ?? capabilities,
  }));
}

/** The manifest's preferred default order for Codex (`currentModels.codex`). */
export function preferredCodexModels(manifest: ModelManifestData = BUNDLED_MODEL_MANIFEST): ReadonlyArray<string> {
  return manifest.currentModels[CODEX_DRIVER_KIND] ?? [];
}

/** A listed catalog as the picker shows it: classified against the manifest, current models first. */
export function codexCatalogModels(
  draft: CodexCatalogDraft,
  manifest: ModelManifestData = BUNDLED_MODEL_MANIFEST,
): CodexCatalogDraft {
  const applied = applyCodexModelCatalog(draft, resolveCodexProviderCatalog(manifest));
  const models = [...applied.models.filter(model => !model.isLegacy), ...applied.models.filter(model => model.isLegacy)];
  return { ...applied, models };
}
