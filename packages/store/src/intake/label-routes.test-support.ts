import type { FactoryStorageOps } from '@mastra/core/storage';

import { INTAKE_LABEL_ROUTES_SCHEMA, normalizeIntakeLabel } from './base.ts';

/**
 * Writes a label route row the way the retired label-route model stored it. Nothing in the app
 * writes these any more (intake routes replaced them); tests seed old rows to prove the boot
 * migrations move them.
 */
export async function seedLegacyLabelRoute(
  ops: FactoryStorageOps,
  route: { orgId: string; factoryProjectId: string; integrationId: string; label: string; board: string },
): Promise<void> {
  const now = new Date();
  await ops.insertOne(INTAKE_LABEL_ROUTES_SCHEMA.name, {
    org_id: route.orgId,
    factory_project_id: route.factoryProjectId,
    integration_id: route.integrationId,
    label: normalizeIntakeLabel(route.label),
    board: route.board,
    created_by_user_id: null,
    created_at: now,
    updated_at: now,
  });
}
