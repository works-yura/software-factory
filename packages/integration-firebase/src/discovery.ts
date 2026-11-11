/**
 * What a Google Cloud account can see, offered as choices in forms (the MCP Toolbox Firestore
 * server, a «База» binding): its projects and a project's Firestore databases. Read-only calls with
 * the account's own key; a refusal never fails the form — the key's own project and the `(default)`
 * database are still offered, with the role to grant.
 *
 * - Projects: Cloud Resource Manager `GET /v3/projects:search` returns only projects where the caller
 *   holds `resourcemanager.projects.get` (scope `cloud-platform.read-only`).
 *   https://docs.cloud.google.com/resource-manager/reference/rest/v3/projects/search
 * - Databases: Firestore `GET /v1/projects/{project}/databases` needs `datastore.databases.list`
 *   (scope `datastore`). https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases/list
 * - Cloud Datastore Viewer (`roles/datastore.viewer`) includes `datastore.databases.list`,
 *   `resourcemanager.projects.get` and `resourcemanager.projects.list`.
 *   https://docs.cloud.google.com/firestore/docs/security/iam
 */

import { ObservabilityProviderError } from '@factory/capabilities';
import type { DiscoveryItem, DiscoveryResult } from '@factory/capabilities';

import { FIRESTORE_API, GoogleApiClient, RESOURCE_MANAGER_API } from './google-api.ts';
import { ServiceAccountTokens } from './service-account.ts';
import type { FetchLike, ServiceAccountKey } from './service-account.ts';

/** Projects listed at most; an account seeing more types the id. */
const MAX_PROJECTS = 300;
const PAGE_SIZE = 100;
export const DEFAULT_FIRESTORE_DATABASE = '(default)';

interface ProjectsPage {
  projects?: Array<{ projectId?: string; displayName?: string; state?: string }>;
  nextPageToken?: string;
}

interface DatabasesPage {
  databases?: Array<{ name?: string; type?: string; locationId?: string }>;
}

export interface DiscoveryOptions {
  fetch?: FetchLike;
  tokens?: ServiceAccountTokens;
}

function denial(error: unknown): NonNullable<DiscoveryResult['denied']> {
  if (error instanceof ObservabilityProviderError) {
    const message = error.fix ? `${error.message} ${error.fix}` : error.message;
    return { ...(error.missingRole ? { role: error.missingRole } : {}), message };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

function client(key: ServiceAccountKey, projectId: string, options: DiscoveryOptions): GoogleApiClient {
  const tokens = options.tokens ?? new ServiceAccountTokens(key, options.fetch ? { fetch: options.fetch } : {});
  return new GoogleApiClient({ tokens, projectId, ...(options.fetch ? { fetch: options.fetch } : {}) });
}

/** Active projects the account can see, its key's own project first (offered even when the search is refused). */
export async function listGoogleCloudProjects(key: ServiceAccountKey, options: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const own = key.project_id;
  const items = new Map<string, DiscoveryItem>([[own, { value: own }]]);
  const api = client(key, own, options);
  try {
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ pageSize: String(PAGE_SIZE), ...(pageToken ? { pageToken } : {}) });
      const page = await api.request<ProjectsPage>(
        RESOURCE_MANAGER_API,
        `https://cloudresourcemanager.googleapis.com/v3/projects:search?${query}`,
      );
      for (const project of page.projects ?? []) {
        if (!project.projectId || (project.state && project.state !== 'ACTIVE')) continue;
        const label = project.displayName && project.displayName !== project.projectId ? project.displayName : undefined;
        items.set(project.projectId, { value: project.projectId, ...(label ? { label } : {}) });
      }
      pageToken = page.nextPageToken;
    } while (pageToken && items.size < MAX_PROJECTS);
    return { items: [...items.values()], default: own };
  } catch (error) {
    return { items: [...items.values()], default: own, denied: denial(error) };
  }
}

/** A project's Firestore databases by id, `(default)` first; `(default)` alone when listing is refused. */
export async function listFirestoreDatabases(
  key: ServiceAccountKey,
  projectId: string,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const fallback: DiscoveryResult = { items: [{ value: DEFAULT_FIRESTORE_DATABASE }], default: DEFAULT_FIRESTORE_DATABASE };
  try {
    const page = await client(key, projectId, options).request<DatabasesPage>(
      FIRESTORE_API,
      `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases`,
    );
    const items: DiscoveryItem[] = [];
    for (const database of page.databases ?? []) {
      const id = database.name?.split('/databases/')[1];
      if (!id) continue;
      const detail = [database.type === 'DATASTORE_MODE' ? 'Datastore mode' : undefined, database.locationId].filter(Boolean).join(' · ');
      items.push({ value: id, ...(detail ? { detail } : {}) });
    }
    if (!items.length) return fallback;
    items.sort((a, b) =>
      a.value === DEFAULT_FIRESTORE_DATABASE ? -1 : b.value === DEFAULT_FIRESTORE_DATABASE ? 1 : a.value.localeCompare(b.value),
    );
    return { items, default: items[0]!.value };
  } catch (error) {
    return { ...fallback, denied: denial(error) };
  }
}
