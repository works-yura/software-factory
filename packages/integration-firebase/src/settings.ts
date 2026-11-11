/**
 * Where Firebase's settings live. The service account key is the org's connection row (encrypted
 * by the integration storage with the Factory secret key); which Firebase project and apps each
 * Factory reads is org settings, keyed by Factory. Nothing here is ever returned with the key.
 */

import { z } from 'zod';

import type { IntegrationStorageHandle } from '@factory/store';

import { serviceAccountKeySchema, serviceAccountSummary } from './service-account.ts';
import type { ServiceAccountKey, ServiceAccountSummary } from './service-account.ts';

export const FIREBASE_INTEGRATION_ID = 'firebase';

/** The settings are org-wide, but the generic settings table is keyed by `(org, user)`. */
const ORG_SETTINGS_USER = '__org__';

export const firebaseAppSchema = z.object({
  /** Firebase App ID, e.g. `1:1234567890:android:0a1b2c3d4e5f`. */
  appId: z.string().regex(/^\d+:\d+:(android|ios|web):[0-9a-f]+$/, 'Firebase App ID, e.g. 1:1234567890:android:0a1b2c3d'),
  platform: z.enum(['android', 'ios', 'web']),
  label: z.string().trim().max(80).optional(),
});

/** One Factory's Firebase project and the apps whose crashes it reads. */
export const firebaseFactoryMappingSchema = z.object({
  /** Google Cloud / Firebase project id, e.g. `syncta-prod`. Logs are read from it. */
  projectId: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, 'Google Cloud project id, e.g. syncta-prod'),
  /** Project number, shown in Firebase › Project settings; Crashlytics addresses projects by it. */
  projectNumber: z.string().regex(/^\d{6,20}$/).optional(),
  logs: z.boolean(),
  /** Crashes of the mapped apps; absent reads as on, so mappings saved before the switch keep working. */
  crashes: z.boolean().optional(),
  apps: z.array(firebaseAppSchema).max(20),
});
export type FirebaseFactoryMapping = z.infer<typeof firebaseFactoryMappingSchema>;

const settingsSchema = z.object({ factories: z.record(z.string(), firebaseFactoryMappingSchema) });
export type FirebaseSettings = z.infer<typeof settingsSchema>;

export interface FirebaseConnectionData {
  serviceAccount: ServiceAccountKey;
}

export async function readFirebaseSettings(storage: Pick<IntegrationStorageHandle, 'settings'>, orgId: string): Promise<FirebaseSettings> {
  const stored = await storage.settings.get(orgId, ORG_SETTINGS_USER);
  if (stored === null) return { factories: {} };
  const parsed = settingsSchema.safeParse(stored);
  // Settings this code wrote and can no longer read are a bug to see, not an empty page.
  if (!parsed.success) throw new Error(`Stored Firebase settings for org ${orgId} are invalid: ${parsed.error.message}`);
  return parsed.data;
}

export async function readFactoryMapping(storage: Pick<IntegrationStorageHandle, 'settings'>, orgId: string, factoryProjectId: string): Promise<FirebaseFactoryMapping | null> {
  return (await readFirebaseSettings(storage, orgId)).factories[factoryProjectId] ?? null;
}

/** Replaces one Factory's mapping; `null` removes it. */
export async function saveFactoryMapping(
  storage: Pick<IntegrationStorageHandle, 'settings'>,
  orgId: string,
  factoryProjectId: string,
  mapping: FirebaseFactoryMapping | null,
): Promise<FirebaseSettings> {
  const current = await readFirebaseSettings(storage, orgId);
  const factories = { ...current.factories };
  if (mapping) factories[factoryProjectId] = mapping;
  else delete factories[factoryProjectId];
  const next = { factories };
  await storage.settings.save(orgId, ORG_SETTINGS_USER, next);
  return next;
}

/** The org's key, or `null` when not connected. */
export async function readServiceAccount(storage: Pick<IntegrationStorageHandle, 'connections'>, orgId: string): Promise<ServiceAccountKey | null> {
  const connection = await storage.connections.get(orgId);
  if (!connection) return null;
  const parsed = serviceAccountKeySchema.safeParse((connection.data as Partial<FirebaseConnectionData>).serviceAccount);
  if (!parsed.success) throw new Error(`Stored Firebase connection for org ${orgId} is not a service account key.`);
  return parsed.data;
}

export async function saveServiceAccount(storage: Pick<IntegrationStorageHandle, 'connections'>, orgId: string, userId: string | null, key: ServiceAccountKey): Promise<ServiceAccountSummary> {
  const summary = serviceAccountSummary(key);
  await storage.connections.upsert(orgId, {
    userId,
    data: { serviceAccount: key } satisfies FirebaseConnectionData,
    // Non-secret, so a status read needs no decryption of the key.
    metadata: { ...summary },
  });
  return summary;
}

/** The connected key's summary from the row's metadata. */
export async function readConnectionSummary(storage: Pick<IntegrationStorageHandle, 'connections'>, orgId: string): Promise<ServiceAccountSummary | null> {
  const connection = await storage.connections.get(orgId);
  if (!connection) return null;
  const { clientEmail, projectId, keyId } = connection.metadata as Partial<ServiceAccountSummary>;
  if (!clientEmail || !projectId || !keyId) throw new Error(`Stored Firebase connection for org ${orgId} has no key summary.`);
  return { clientEmail, projectId, keyId };
}

/** Whether a mapping reads crashes: switched on (or saved before the switch) and with an app to read. */
export function readsCrashes(mapping: FirebaseFactoryMapping): boolean {
  return mapping.crashes !== false && mapping.apps.length > 0;
}
