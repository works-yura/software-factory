/**
 * Where Firebase's settings live.
 *
 * - **Accounts**: the org's Google Cloud service accounts, each with its own key. All keys sit in
 *   the org's one integration connection row, encrypted by the integration storage with the
 *   Factory secret key; the row's metadata holds each account's name and key summary, so lists
 *   never decrypt a key.
 * - **Bindings**: which Factory reads which Google Cloud project with which account (org settings).
 *   A Factory may have several (prod and staging, or several clients' projects).
 *
 * The first version kept one key (`{ serviceAccount }`) and one project per Factory
 * (`{ factories }`). `readFirebaseState` upgrades that shape the first time an organization is read
 * and writes the new one back: the key becomes the first account, each mapping a binding.
 */

import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { IntegrationStorageHandle } from '@factory/store';

import { serviceAccountKeySchema, serviceAccountSummary } from './service-account.ts';
import type { ServiceAccountKey, ServiceAccountSummary } from './service-account.ts';

export const FIREBASE_INTEGRATION_ID = 'firebase';

/** The settings are org-wide, but the generic settings table is keyed by `(org, user)`. */
const ORG_SETTINGS_USER = '__org__';

type Storage = Pick<IntegrationStorageHandle, 'connections' | 'settings'>;

export const firebaseAppSchema = z.object({
  /** Firebase App ID, e.g. `1:1234567890:android:0a1b2c3d4e5f`. */
  appId: z.string().regex(/^\d+:\d+:(android|ios|web):[0-9a-f]+$/, 'Firebase App ID, e.g. 1:1234567890:android:0a1b2c3d'),
  platform: z.enum(['android', 'ios', 'web']),
  label: z.string().trim().max(80).optional(),
});

export const googleCloudProjectIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, 'Google Cloud project id, e.g. syncta-prod');

/** What a binding reads: one Google Cloud project's logs, and the crashes of its apps. */
export const firebaseBindingInputSchema = z.object({
  /** A name people give the connection; absent shows the project id. */
  name: z.string().trim().min(1).max(80).optional(),
  factoryProjectId: z.string().min(1).max(128),
  accountId: z.string().min(1).max(64),
  /** Google Cloud / Firebase project id, e.g. `syncta-prod`. Logs are read from it. */
  projectId: googleCloudProjectIdSchema,
  /** Project number, shown in Firebase › Project settings; Crashlytics addresses projects by it. */
  projectNumber: z.string().regex(/^\d{6,20}$/).optional(),
  logs: z.boolean(),
  crashes: z.boolean(),
  apps: z.array(firebaseAppSchema).max(20),
  /**
   * «База»: agents read the project's Firestore through MCP Toolbox, run under the hood as an MCP
   * server the integration manages. Absent reads as off (bindings saved before it existed).
   */
  database: z
    .object({
      enabled: z.boolean(),
      /** Firestore database id; empty or absent is `(default)`. */
      databaseId: z
        .string()
        .regex(/^[a-z][a-z0-9-]{0,61}[a-z0-9]$|^\(default\)$/, 'Firestore database id, e.g. (default) or analytics')
        .optional(),
    })
    .optional(),
});
export type FirebaseBindingInput = z.infer<typeof firebaseBindingInputSchema>;

export const firebaseBindingSchema = firebaseBindingInputSchema.extend({
  id: z.string().min(1).max(64),
  /** When and by whom the binding was made; absent on bindings saved before it was recorded. */
  createdAt: z.string().optional(),
  createdBy: z.string().optional(),
});
export type FirebaseBinding = z.infer<typeof firebaseBindingSchema>;

/** One account as lists show it: never the key. */
export interface FirebaseAccount extends ServiceAccountSummary {
  id: string;
  name: string;
}

const accountMetaSchema = z.object({
  name: z.string(),
  clientEmail: z.string(),
  projectId: z.string(),
  keyId: z.string(),
});

const connectionDataSchema = z.object({
  accounts: z.record(z.string(), z.object({ serviceAccount: serviceAccountKeySchema })),
});
type ConnectionData = z.infer<typeof connectionDataSchema>;

const settingsSchema = z.object({ version: z.literal(2), bindings: z.array(firebaseBindingSchema) });
type Settings = z.infer<typeof settingsSchema>;

/** The first version's shapes, read only to upgrade them. */
const legacyMappingSchema = z.object({
  projectId: z.string(),
  projectNumber: z.string().optional(),
  logs: z.boolean(),
  crashes: z.boolean().optional(),
  apps: z.array(firebaseAppSchema),
});
const legacySettingsSchema = z.object({ factories: z.record(z.string(), legacyMappingSchema) });
const legacyConnectionSchema = z.object({ serviceAccount: serviceAccountKeySchema });

export interface FirebaseState {
  accounts: FirebaseAccount[];
  bindings: FirebaseBinding[];
}

/** The id the upgraded first-version key gets: derived from the key, so a second upgrade agrees. */
export function legacyAccountId(key: ServiceAccountKey): string {
  return `acc-${createHash('sha256').update(key.private_key_id).digest('hex').slice(0, 12)}`;
}

export function newAccountId(): string {
  return `acc-${randomUUID().slice(0, 12)}`;
}

export function newBindingId(): string {
  return `bnd-${randomUUID().slice(0, 12)}`;
}

function accountsFromMetadata(metadata: Record<string, unknown>, orgId: string): FirebaseAccount[] {
  const raw = (metadata as { accounts?: unknown }).accounts;
  if (raw === undefined) return [];
  const parsed = z.record(z.string(), accountMetaSchema).safeParse(raw);
  if (!parsed.success) throw new Error(`Stored Firebase accounts for org ${orgId} are invalid: ${parsed.error.message}`);
  return Object.entries(parsed.data).map(([id, meta]) => ({ id, ...meta }));
}

function metadataFor(accounts: Record<string, { name: string; key: ServiceAccountKey }>): Record<string, unknown> {
  return {
    accounts: Object.fromEntries(
      Object.entries(accounts).map(([id, { name, key }]) => [id, { name, ...serviceAccountSummary(key) }]),
    ),
  };
}

/**
 * Upgrades the first version's rows of one org, once. Idempotent: a second run finds the new shape
 * and changes nothing. A legacy mapping with no key to bind keeps its project under the `unbound`
 * account id, read by nobody until a person picks an account in Settings — nothing is dropped.
 */
async function upgradeLegacy(storage: Storage, orgId: string): Promise<void> {
  const connection = await storage.connections.get(orgId);
  let accountId: string | null = null;
  if (connection) {
    const legacy = legacyConnectionSchema.safeParse(connection.data);
    if (legacy.success && !connectionDataSchema.safeParse(connection.data).success) {
      const key = legacy.data.serviceAccount;
      accountId = legacyAccountId(key);
      const accounts = { [accountId]: { name: key.project_id, key } };
      await storage.connections.upsert(orgId, {
        userId: connection.userId,
        data: { accounts: { [accountId]: { serviceAccount: key } } } satisfies ConnectionData,
        metadata: metadataFor(accounts),
      });
    } else if (connectionDataSchema.safeParse(connection.data).success) {
      const ids = accountsFromMetadata(connection.metadata, orgId).map(account => account.id);
      accountId = ids.length === 1 ? ids[0]! : null;
    }
  }
  const stored = await storage.settings.get(orgId, ORG_SETTINGS_USER);
  const legacySettings = stored === null ? null : legacySettingsSchema.safeParse(stored);
  if (legacySettings?.success && !settingsSchema.safeParse(stored).success) {
    const bindings: FirebaseBinding[] = Object.entries(legacySettings.data.factories).map(([factoryProjectId, mapping]) => ({
      id: `bnd-${factoryProjectId}`.slice(0, 64),
      factoryProjectId,
      accountId: accountId ?? UNBOUND_ACCOUNT,
      projectId: mapping.projectId,
      ...(mapping.projectNumber ? { projectNumber: mapping.projectNumber } : {}),
      logs: mapping.logs,
      // Absent read as on in the first version.
      crashes: mapping.crashes !== false,
      apps: mapping.apps,
    }));
    await storage.settings.save(orgId, ORG_SETTINGS_USER, { version: 2, bindings } satisfies Settings);
  }
}

/** The account id of a binding upgraded with no key to bind; a person picks one in Settings. */
export const UNBOUND_ACCOUNT = 'unbound';

/** The org's accounts and bindings, upgrading the first version's rows on first read. */
export async function readFirebaseState(storage: Storage, orgId: string): Promise<FirebaseState> {
  await upgradeLegacy(storage, orgId);
  const connection = await storage.connections.get(orgId);
  const accounts = connection ? accountsFromMetadata(connection.metadata, orgId) : [];
  const stored = await storage.settings.get(orgId, ORG_SETTINGS_USER);
  if (stored === null) return { accounts, bindings: [] };
  const parsed = settingsSchema.safeParse(stored);
  // Settings this code wrote and can no longer read are a bug to see, not an empty page.
  if (!parsed.success) throw new Error(`Stored Firebase settings for org ${orgId} are invalid: ${parsed.error.message}`);
  return { accounts, bindings: parsed.data.bindings };
}

async function readKeys(storage: Storage, orgId: string): Promise<Record<string, ServiceAccountKey>> {
  const connection = await storage.connections.get(orgId);
  if (!connection) return {};
  const parsed = connectionDataSchema.safeParse(connection.data);
  if (!parsed.success) throw new Error(`Stored Firebase connection for org ${orgId} is not a set of service account keys.`);
  return Object.fromEntries(Object.entries(parsed.data.accounts).map(([id, { serviceAccount }]) => [id, serviceAccount]));
}

/** One account's key, or `null` when the org has no such account. */
export async function readAccountKey(storage: Storage, orgId: string, accountId: string): Promise<ServiceAccountKey | null> {
  await upgradeLegacy(storage, orgId);
  return (await readKeys(storage, orgId))[accountId] ?? null;
}

async function writeAccounts(
  storage: Storage,
  orgId: string,
  userId: string | null,
  accounts: Record<string, { name: string; key: ServiceAccountKey }>,
): Promise<void> {
  if (Object.keys(accounts).length === 0) {
    await storage.connections.delete(orgId);
    return;
  }
  await storage.connections.upsert(orgId, {
    userId,
    data: {
      accounts: Object.fromEntries(Object.entries(accounts).map(([id, { key }]) => [id, { serviceAccount: key }])),
    } satisfies ConnectionData,
    // Non-secret, so a list needs no decryption of the keys.
    metadata: metadataFor(accounts),
  });
}

async function accountsWithKeys(storage: Storage, orgId: string): Promise<Record<string, { name: string; key: ServiceAccountKey }>> {
  const state = await readFirebaseState(storage, orgId);
  const keys = await readKeys(storage, orgId);
  return Object.fromEntries(
    state.accounts.flatMap(account => (keys[account.id] ? [[account.id, { name: account.name, key: keys[account.id]! }]] : [])),
  );
}

/** Adds an account, or replaces the key (and name) of `accountId`. */
export async function saveAccount(
  storage: Storage,
  orgId: string,
  userId: string | null,
  input: { accountId?: string; name: string; key: ServiceAccountKey },
): Promise<FirebaseAccount> {
  const accounts = await accountsWithKeys(storage, orgId);
  const id = input.accountId ?? newAccountId();
  accounts[id] = { name: input.name, key: input.key };
  await writeAccounts(storage, orgId, userId, accounts);
  return { id, name: input.name, ...serviceAccountSummary(input.key) };
}

/** Renames an account without touching its key. */
export async function renameAccount(storage: Storage, orgId: string, accountId: string, name: string): Promise<FirebaseAccount | null> {
  const connection = await storage.connections.get(orgId);
  const accounts = await accountsWithKeys(storage, orgId);
  const current = accounts[accountId];
  if (!current) return null;
  accounts[accountId] = { ...current, name };
  await writeAccounts(storage, orgId, connection?.userId ?? null, accounts);
  return { id: accountId, name, ...serviceAccountSummary(current.key) };
}

/** Removes an account and, with it, the bindings that read through it. */
export async function deleteAccount(storage: Storage, orgId: string, accountId: string): Promise<{ removedBindings: string[] } | null> {
  const connection = await storage.connections.get(orgId);
  const accounts = await accountsWithKeys(storage, orgId);
  if (!accounts[accountId]) return null;
  delete accounts[accountId];
  await writeAccounts(storage, orgId, connection?.userId ?? null, accounts);
  const state = await readFirebaseState(storage, orgId);
  const removed = state.bindings.filter(binding => binding.accountId === accountId);
  if (removed.length > 0) {
    await saveBindings(
      storage,
      orgId,
      state.bindings.filter(binding => binding.accountId !== accountId),
    );
  }
  return { removedBindings: removed.map(binding => binding.id) };
}

async function saveBindings(storage: Storage, orgId: string, bindings: FirebaseBinding[]): Promise<void> {
  await storage.settings.save(orgId, ORG_SETTINGS_USER, { version: 2, bindings } satisfies Settings);
}

/** Adds a binding, or replaces binding `id`. */
export async function saveBinding(storage: Storage, orgId: string, binding: FirebaseBinding): Promise<FirebaseBinding> {
  const state = await readFirebaseState(storage, orgId);
  const others = state.bindings.filter(existing => existing.id !== binding.id);
  await saveBindings(storage, orgId, [...others, binding]);
  return binding;
}

export async function deleteBinding(storage: Storage, orgId: string, bindingId: string): Promise<boolean> {
  const state = await readFirebaseState(storage, orgId);
  const next = state.bindings.filter(binding => binding.id !== bindingId);
  if (next.length === state.bindings.length) return false;
  await saveBindings(storage, orgId, next);
  return true;
}

/** Whether a binding reads crashes: switched on and with an app to read. */
export function readsCrashes(binding: Pick<FirebaseBinding, 'crashes' | 'apps'>): boolean {
  return binding.crashes && binding.apps.length > 0;
}

/** Whether a binding gives agents its project's Firestore («База»). */
export function readsDatabase(binding: Pick<FirebaseBinding, 'database'>): boolean {
  return binding.database?.enabled === true;
}

/** Whether a binding reads logs or crashes (what the observability tools serve; «База» is an MCP server). */
export function bindingReads(binding: Pick<FirebaseBinding, 'logs' | 'crashes' | 'apps'>): boolean {
  return binding.logs || readsCrashes(binding);
}
