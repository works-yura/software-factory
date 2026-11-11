// A Factory's default model per harness instance (`harnessModelDefaults`): one selection per
// instance id, set in Settings → Models and read by that harness's facet. What a session starts on
// is, in order: its own pick, its Factory's default for the harness, the harness's catalog default.
import { z } from 'zod';

import { ModelSelection, ProviderInstanceId } from './contracts.ts';

/** `{ [instanceId]: selection }`: what the store keeps and the project payload carries. */
export const HarnessModelDefaults = z.record(ProviderInstanceId, ModelSelection);
export type HarnessModelDefaults = Readonly<Record<string, ModelSelection>>;

/**
 * The stored map as this build reads it: entries that do not parse, or whose selection names
 * another instance than its key, are dropped; anything else than an object reads as none.
 */
export function parseHarnessModelDefaults(value: unknown): Record<string, ModelSelection> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, ModelSelection> = {};
  for (const [instanceId, raw] of Object.entries(value)) {
    const parsed = ModelSelection.safeParse(raw);
    if (parsed.success && parsed.data.instanceId === instanceId) out[instanceId] = parsed.data;
  }
  return out;
}

/** The map with one instance's default set, or removed (`null`: back to the catalog default). */
export function withHarnessModelDefault(
  defaults: HarnessModelDefaults,
  instanceId: string,
  selection: ModelSelection | null,
): Record<string, ModelSelection> {
  const { [instanceId]: _previous, ...rest } = defaults;
  return selection ? { ...rest, [instanceId]: { ...selection, instanceId } } : rest;
}

/** The precedence every harness follows: the session's own pick, its Factory's default, the catalog's. */
export function resolveModelDefault(input: {
  session?: ModelSelection | null | undefined;
  factory?: ModelSelection | null | undefined;
  catalog?: ModelSelection | null | undefined;
}): ModelSelection | null {
  return input.session ?? input.factory ?? input.catalog ?? null;
}

/** Where a Factory's defaults live, as a facet's host reads them (the projects store). */
export type FactoryModelDefaultsReader = (input: {
  factoryProjectId: string;
  orgId: string;
}) => Promise<HarnessModelDefaults | null | undefined>;
