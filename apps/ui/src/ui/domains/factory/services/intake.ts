import { translator } from '../../../i18n/t';

const tk = translator('board');

/**
 * Browser-side helpers for the intake source configuration (Settings › Intake).
 *
 * The config is stored per org on the server. GitHub uses
 * `sourceIds` (connected source ids). `null` id lists mean
 * "nothing selected" — nothing syncs until the user picks entries.
 */

export interface IntakeSelection {
  enabled: boolean;
  /** Source ids to sync; `null` = nothing selected. */
  sourceIds: string[] | null;
}

export interface IntakeConfig {
  github: IntakeSelection;
  gitlab: IntakeSelection;
  clickup: IntakeSelection;
}

/**
 * The server keeps intake config as a dynamic map keyed by integration id and
 * only returns the integrations registered in the running deployment, so a key
 * is absent whenever that integration isn't connected. Fill the fixed shape the
 * UI relies on so reads like `config.github.enabled` never touch `undefined`.
 * An absent key means the integration is not registered in this deployment,
 * so every synthetic placeholder stays disabled. Registered integrations are
 * returned by the server with their effective defaults, and saving the fixed
 * shape back is safe because the server ignores disabled/unselected keys for
 * unregistered integrations.
 */
function normalizeIntakeConfig(raw: Partial<Record<string, IntakeSelection>> | null | undefined): IntakeConfig {
  return {
    github: raw?.github ?? { enabled: false, sourceIds: null },
    gitlab: raw?.gitlab ?? { enabled: false, sourceIds: null },
    clickup: raw?.clickup ?? { enabled: false, sourceIds: null },
  };
}

/** Enable sync and pick `id`; returns the same object when nothing changes. */
export function selectIntakeSource(selection: IntakeSelection, id: string): IntakeSelection {
  if (selection.sourceIds === null) return { enabled: true, sourceIds: [id] };
  if (!selection.sourceIds.includes(id)) return { enabled: true, sourceIds: [...selection.sourceIds, id] };
  return selection.enabled ? selection : { ...selection, enabled: true };
}

async function requestIntakeConfig(baseUrl: string, init?: RequestInit): Promise<IntakeConfig> {
  const res = await fetch(`${baseUrl}/web/intake/config`, {
    headers: { Accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
    credentials: 'include',
    ...init,
  });
  if (!res.ok) {
    let message = tk('errors.requestFailed', { status: res.status });
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      if (body.message) message = body.message;
      else if (body.error) message = body.error;
    } catch {
      /* ignore non-JSON */
    }
    throw new Error(message);
  }
  const { config } = (await res.json()) as { config?: Partial<Record<string, IntakeSelection>> };
  return normalizeIntakeConfig(config);
}

/** Read the org's intake config (server falls back to the defaults). */
export async function fetchIntakeConfig(baseUrl: string): Promise<IntakeConfig> {
  return requestIntakeConfig(baseUrl);
}

/** Save the org's intake config; resolves to the persisted config. */
export async function saveIntakeConfig(baseUrl: string, config: IntakeConfig): Promise<IntakeConfig> {
  return requestIntakeConfig(baseUrl, { method: 'PUT', body: JSON.stringify(config) });
}

/** Routing of one intake source to the Factory project its items land in. */
export interface IntakeSourceBinding {
  integrationId: string;
  sourceId: string;
  factoryProjectId: string;
  /** Installed board the source feeds; `null` keeps the built-in routing (issues → Work, PRs → Review). */
  board: string | null;
}

async function requestIntakeBindings(baseUrl: string, init?: RequestInit): Promise<IntakeSourceBinding[]> {
  const res = await fetch(`${baseUrl}/web/intake/bindings`, {
    headers: { Accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
    credentials: 'include',
    ...init,
  });
  if (!res.ok) {
    let message = tk('errors.requestFailed', { status: res.status });
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      if (body.message) message = body.message;
      else if (body.error) message = body.error;
    } catch {
      /* ignore non-JSON */
    }
    throw new Error(message);
  }
  const { bindings } = (await res.json()) as { bindings?: IntakeSourceBinding[] };
  return bindings ?? [];
}

/** Read every intake source binding in the caller's organization. */
export async function fetchIntakeBindings(baseUrl: string): Promise<IntakeSourceBinding[]> {
  return requestIntakeBindings(baseUrl);
}

/** Route one source to a Factory project, or clear it with `factoryProjectId: null`. */
export async function saveIntakeBinding(
  baseUrl: string,
  binding: { integrationId: string; sourceId: string; factoryProjectId: string | null; board?: string | null },
): Promise<IntakeSourceBinding[]> {
  return requestIntakeBindings(baseUrl, { method: 'PUT', body: JSON.stringify(binding) });
}
