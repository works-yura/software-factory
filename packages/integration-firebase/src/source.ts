/**
 * Firebase as an `ObservabilityProvider`: each binding of a Factory (an account's key plus one
 * Google Cloud project) makes one `ObservabilitySource` — Cloud Logging for logs, Crashlytics for the
 * bound apps' crashes.
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
  ObservabilityTarget,
  QueryLogsInput,
} from '@factory/capabilities';
import type { IntegrationStorageHandle } from '@factory/store';

import { CrashlyticsReader } from './crashlytics.ts';
import { GoogleApiClient } from './google-api.ts';
import { CloudLoggingReader } from './logging.ts';
import { ServiceAccountTokens } from './service-account.ts';
import type { FetchLike, ServiceAccountKey } from './service-account.ts';
import { bindingReads, readAccountKey, readFirebaseState, readsCrashes } from './settings.ts';
import type { FirebaseBinding } from './settings.ts';

/** What one source reads: a binding's project, features and apps. */
export type FirebaseSourceBinding = Pick<FirebaseBinding, 'projectId' | 'projectNumber' | 'logs' | 'crashes' | 'apps'> &
  Partial<Pick<FirebaseBinding, 'id'>>;

export interface FirebaseSourceOptions {
  key: ServiceAccountKey;
  binding: FirebaseSourceBinding;
  fetch?: FetchLike;
  now?: () => Date;
  /** Reuse a token cache across sources of one key. */
  tokens?: ServiceAccountTokens;
}

export class FirebaseObservabilitySource implements ObservabilitySource {
  readonly provider = 'firebase';
  readonly target: ObservabilityTarget;
  readonly features: ObservabilityFeatures;
  readonly apps: readonly ObservabilityApp[];
  readonly #logging: CloudLoggingReader;
  readonly #crashlytics: CrashlyticsReader;

  constructor({ key, binding, fetch, now, tokens }: FirebaseSourceOptions) {
    const client = new GoogleApiClient({
      tokens: tokens ?? new ServiceAccountTokens(key, fetch ? { fetch } : {}),
      projectId: binding.projectId,
      ...(fetch ? { fetch } : {}),
    });
    this.target = { ref: binding.id ?? binding.projectId, name: binding.projectId };
    this.apps = binding.apps.map(app => ({ appId: app.appId, platform: app.platform, ...(app.label ? { label: app.label } : {}) }));
    this.features = { logs: binding.logs, crashes: readsCrashes(binding) };
    this.#logging = new CloudLoggingReader(client, binding.projectId, now);
    this.#crashlytics = new CrashlyticsReader(client, binding.projectNumber ?? binding.projectId, this.apps, now);
  }

  queryLogs(input: QueryLogsInput) {
    if (!this.features.logs) {
      return Promise.reject(new ObservabilityUnsupportedError(`Logs are not enabled for Google Cloud project ${this.target.name}.`));
    }
    return this.#logging.query(input);
  }

  listCrashIssues(input: ListCrashIssuesInput) {
    if (!this.features.crashes) return Promise.reject(this.#noCrashes());
    return this.#crashlytics.listIssues(input);
  }

  getCrashIssue(input: GetCrashIssueInput) {
    if (!this.features.crashes) return Promise.reject(this.#noCrashes());
    return this.#crashlytics.getIssue(input);
  }

  #noCrashes() {
    return new ObservabilityUnsupportedError(
      `No app is bound for crashes in Google Cloud project ${this.target.name}, or crashes are switched off.`,
    );
  }
}

/** A Factory's sources, one per binding that reads anything and whose account still has a key. */
export class FirebaseObservabilityProvider implements ObservabilityProvider {
  readonly provider = 'firebase';
  readonly #storage: Pick<IntegrationStorageHandle, 'connections' | 'settings'>;
  readonly #fetch: FetchLike | undefined;
  readonly #tokens = new Map<string, ServiceAccountTokens>();

  constructor(storage: Pick<IntegrationStorageHandle, 'connections' | 'settings'>, options: { fetch?: FetchLike } = {}) {
    this.#storage = storage;
    this.#fetch = options.fetch;
  }

  /** One token cache per key, so a session's several calls share a token. */
  tokensFor(orgId: string, key: ServiceAccountKey): ServiceAccountTokens {
    const cacheKey = `${orgId}:${key.client_email}:${key.private_key_id}`;
    let tokens = this.#tokens.get(cacheKey);
    if (!tokens) {
      tokens = new ServiceAccountTokens(key, this.#fetch ? { fetch: this.#fetch } : {});
      this.#tokens.set(cacheKey, tokens);
    }
    return tokens;
  }

  async sourcesFor(scope: ObservabilityScope): Promise<ObservabilitySource[]> {
    const { bindings } = await readFirebaseState(this.#storage, scope.orgId);
    const sources: ObservabilitySource[] = [];
    for (const binding of bindings) {
      if (binding.factoryProjectId !== scope.factoryProjectId || !bindingReads(binding)) continue;
      const key = await readAccountKey(this.#storage, scope.orgId, binding.accountId);
      if (!key) continue;
      sources.push(
        new FirebaseObservabilitySource({
          key,
          binding,
          tokens: this.tokensFor(scope.orgId, key),
          ...(this.#fetch ? { fetch: this.#fetch } : {}),
        }),
      );
    }
    return sources;
  }
}
