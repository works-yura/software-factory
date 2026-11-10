/**
 * Firebase as an `ObservabilityProvider`: the org's service account plus a Factory's mapping make
 * one `ObservabilitySource` — Cloud Logging for logs, Crashlytics for the mapped apps' crashes.
 */

import { ObservabilityUnsupportedError } from '@factory/capabilities';
import type {
  GetCrashIssueInput,
  ListCrashIssuesInput,
  ObservabilityApp,
  ObservabilityFeatures,
  ObservabilityProvider,
  ObservabilityScope,
  ObservabilitySource,
  QueryLogsInput,
} from '@factory/capabilities';
import type { IntegrationStorageHandle } from '@factory/store';

import { CrashlyticsReader } from './crashlytics.ts';
import { GoogleApiClient } from './google-api.ts';
import { CloudLoggingReader } from './logging.ts';
import { ServiceAccountTokens } from './service-account.ts';
import type { FetchLike, ServiceAccountKey } from './service-account.ts';
import { readFactoryMapping, readServiceAccount } from './settings.ts';
import type { FirebaseFactoryMapping } from './settings.ts';

export interface FirebaseSourceOptions {
  key: ServiceAccountKey;
  mapping: FirebaseFactoryMapping;
  fetch?: FetchLike;
  now?: () => Date;
  /** Reuse a token cache across sources of one key. */
  tokens?: ServiceAccountTokens;
}

export class FirebaseObservabilitySource implements ObservabilitySource {
  readonly provider = 'firebase';
  readonly features: ObservabilityFeatures;
  readonly apps: readonly ObservabilityApp[];
  readonly #logging: CloudLoggingReader;
  readonly #crashlytics: CrashlyticsReader;

  constructor({ key, mapping, fetch, now, tokens }: FirebaseSourceOptions) {
    const client = new GoogleApiClient({
      tokens: tokens ?? new ServiceAccountTokens(key, { ...(fetch ? { fetch } : {}), ...(now ? { now } : {}) }),
      projectId: mapping.projectId,
      ...(fetch ? { fetch } : {}),
    });
    this.apps = mapping.apps.map(app => ({ appId: app.appId, platform: app.platform, ...(app.label ? { label: app.label } : {}) }));
    this.features = { logs: mapping.logs, crashes: mapping.apps.length > 0 };
    this.#logging = new CloudLoggingReader(client, mapping.projectId, now);
    this.#crashlytics = new CrashlyticsReader(client, mapping.projectNumber ?? mapping.projectId, this.apps, now);
  }

  queryLogs(input: QueryLogsInput) {
    if (!this.features.logs) return Promise.reject(new ObservabilityUnsupportedError('Logs are not enabled for this Factory.'));
    return this.#logging.query(input);
  }

  listCrashIssues(input: ListCrashIssuesInput) {
    if (!this.features.crashes) return Promise.reject(new ObservabilityUnsupportedError('No app is mapped for crashes in this Factory.'));
    return this.#crashlytics.listIssues(input);
  }

  getCrashIssue(input: GetCrashIssueInput) {
    if (!this.features.crashes) return Promise.reject(new ObservabilityUnsupportedError('No app is mapped for crashes in this Factory.'));
    return this.#crashlytics.getIssue(input);
  }
}

/** Sources per Factory from the org's connection and settings; `null` when either is missing. */
export class FirebaseObservabilityProvider implements ObservabilityProvider {
  readonly provider = 'firebase';
  readonly #storage: Pick<IntegrationStorageHandle, 'connections' | 'settings'>;
  readonly #fetch: FetchLike | undefined;
  readonly #tokens = new Map<string, ServiceAccountTokens>();

  constructor(storage: Pick<IntegrationStorageHandle, 'connections' | 'settings'>, options: { fetch?: FetchLike } = {}) {
    this.#storage = storage;
    this.#fetch = options.fetch;
  }

  async sourceFor(scope: ObservabilityScope): Promise<ObservabilitySource | null> {
    const mapping = await readFactoryMapping(this.#storage, scope.orgId, scope.factoryProjectId);
    if (!mapping || (!mapping.logs && mapping.apps.length === 0)) return null;
    const key = await readServiceAccount(this.#storage, scope.orgId);
    if (!key) return null;
    // One token cache per key, so a session's several calls share a token.
    const cacheKey = `${scope.orgId}:${key.private_key_id}`;
    let tokens = this.#tokens.get(cacheKey);
    if (!tokens) {
      tokens = new ServiceAccountTokens(key, this.#fetch ? { fetch: this.#fetch } : {});
      this.#tokens.set(cacheKey, tokens);
    }
    return new FirebaseObservabilitySource({ key, mapping, tokens, ...(this.#fetch ? { fetch: this.#fetch } : {}) });
  }
}
