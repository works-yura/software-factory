import type { IntegrationStorageHandle } from '@factory/store';

export interface ClickUpSettings {
  /** Start Triage for new tasks without waiting for a person. Off unless an admin turns it on. */
  autoStart: boolean;
}

/** The setting is org-wide, but the generic settings table is keyed by `(org, user)`. */
const ORG_SETTINGS_USER = '__org__';

export async function readClickUpSettings(
  storage: Pick<IntegrationStorageHandle, 'settings'>,
  orgId: string,
): Promise<ClickUpSettings> {
  const saved = await storage.settings.get(orgId, ORG_SETTINGS_USER);
  return { autoStart: saved?.autoStart === true };
}

export async function saveClickUpSettings(
  storage: Pick<IntegrationStorageHandle, 'settings'>,
  orgId: string,
  settings: ClickUpSettings,
): Promise<void> {
  await storage.settings.save(orgId, ORG_SETTINGS_USER, { autoStart: settings.autoStart });
}
