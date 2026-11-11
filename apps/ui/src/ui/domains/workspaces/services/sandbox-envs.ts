/**
 * Browser-side helpers for a Factory's sandbox environment variables. Mirrors
 * the factory's `/web/factory/projects/:id/sandbox-envs` routes. Values are
 * write-only: no response ever carries one.
 */

import { readJsonOrThrow } from './http';

export type SandboxEnvAppliesTo = 'build' | 'runtime' | 'both';
/** Production is stored but never reaches an agent sandbox. */
export type SandboxStage = 'development' | 'staging' | 'production';
export const SANDBOX_STAGES: readonly SandboxStage[] = ['development', 'staging', 'production'];
/** The stages a Factory can give its sandboxes. */
export type SandboxMaterializableStage = Exclude<SandboxStage, 'production'>;

export interface SandboxEnv {
  name: string;
  appliesTo: SandboxEnvAppliesTo;
  stage: SandboxStage;
  updatedAt: string;
  updatedBy: string;
}

export interface SandboxEnvList {
  envs: SandboxEnv[];
  /** False when the server can't encrypt values yet; every write would be refused. */
  writable: boolean;
  /** The stages this Factory's sandboxes get. */
  stages: SandboxMaterializableStage[];
  /** Whether the caller may change the stages and env files (an organization admin). */
  canManage: boolean;
}

/** An env file without its content, as lists return it. */
export interface SandboxEnvFile {
  id: string;
  projectRepositoryId: string;
  path: string;
  stage: SandboxStage;
  size: number;
  updatedAt: string;
  updatedBy: string;
}

export interface SandboxEnvFileList {
  files: SandboxEnvFile[];
  writable: boolean;
  /** Organization admins may reveal, add, edit and delete; everyone else sees paths and stages. */
  canManage: boolean;
}

function envsUrl(baseUrl: string, factoryProjectId: string, name?: string): string {
  const base = `${baseUrl}/web/factory/projects/${encodeURIComponent(factoryProjectId)}/sandbox-envs`;
  return name === undefined ? base : `${base}/${encodeURIComponent(name)}`;
}

/** Surfaces the server's message (e.g. a reserved name) instead of a bare status. */
async function throwUnlessOk(res: Response, failure: string): Promise<void> {
  if (res.ok) return;
  let message = `${failure} (${res.status})`;
  try {
    const body = (await res.json()) as { message?: string };
    if (body.message) message = body.message;
  } catch {
    // Keep the status message.
  }
  throw new Error(message);
}

export async function listSandboxEnvs(baseUrl: string, factoryProjectId: string): Promise<SandboxEnvList> {
  const res = await fetch(envsUrl(baseUrl, factoryProjectId), {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  return readJsonOrThrow<SandboxEnvList>(res, 'Failed to load environment variables');
}

export async function setSandboxEnv(
  baseUrl: string,
  factoryProjectId: string,
  input: { name: string; value: string; appliesTo: SandboxEnvAppliesTo; stage?: SandboxStage },
): Promise<void> {
  const res = await fetch(envsUrl(baseUrl, factoryProjectId, input.name), {
    method: 'PUT',
    credentials: 'include',
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      value: input.value,
      appliesTo: input.appliesTo,
      ...(input.stage ? { stage: input.stage } : {}),
    }),
  });
  await throwUnlessOk(res, 'Failed to save the variable');
}

export async function updateSandboxEnvAppliesTo(
  baseUrl: string,
  factoryProjectId: string,
  input: { name: string; appliesTo?: SandboxEnvAppliesTo; stage?: SandboxStage },
): Promise<void> {
  const res = await fetch(envsUrl(baseUrl, factoryProjectId, input.name), {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'content-type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      ...(input.appliesTo ? { appliesTo: input.appliesTo } : {}),
      ...(input.stage ? { stage: input.stage } : {}),
    }),
  });
  await throwUnlessOk(res, 'Failed to update the variable');
}

export async function deleteSandboxEnv(baseUrl: string, factoryProjectId: string, name: string): Promise<void> {
  const res = await fetch(envsUrl(baseUrl, factoryProjectId, name), {
    method: 'DELETE',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  await throwUnlessOk(res, 'Failed to delete the variable');
}

const JSON_HEADERS = { 'content-type': 'application/json', Accept: 'application/json' };

function projectUrl(baseUrl: string, factoryProjectId: string, path: string): string {
  return `${baseUrl}/web/factory/projects/${encodeURIComponent(factoryProjectId)}${path}`;
}

/** Choose the stages the Factory's sandboxes get; development always stays on. */
export async function setSandboxStages(
  baseUrl: string,
  factoryProjectId: string,
  stages: SandboxMaterializableStage[],
): Promise<void> {
  const res = await fetch(projectUrl(baseUrl, factoryProjectId, '/sandbox-stages'), {
    method: 'PUT',
    credentials: 'include',
    headers: JSON_HEADERS,
    body: JSON.stringify({ stages }),
  });
  await throwUnlessOk(res, 'Failed to save the sandbox stages');
}

function filesUrl(baseUrl: string, factoryProjectId: string, fileId?: string): string {
  return projectUrl(
    baseUrl,
    factoryProjectId,
    `/sandbox-env-files${fileId === undefined ? '' : `/${encodeURIComponent(fileId)}`}`,
  );
}

export async function listSandboxEnvFiles(baseUrl: string, factoryProjectId: string): Promise<SandboxEnvFileList> {
  const res = await fetch(filesUrl(baseUrl, factoryProjectId), {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  return readJsonOrThrow<SandboxEnvFileList>(res, 'Failed to load env files');
}

/** An env file's content; organization admins only. */
export async function revealSandboxEnvFile(
  baseUrl: string,
  factoryProjectId: string,
  fileId: string,
): Promise<SandboxEnvFile & { content: string }> {
  const res = await fetch(filesUrl(baseUrl, factoryProjectId, fileId), {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  await throwUnlessOk(res, 'Failed to load the env file');
  return ((await res.json()) as { file: SandboxEnvFile & { content: string } }).file;
}

export async function createSandboxEnvFile(
  baseUrl: string,
  factoryProjectId: string,
  input: { projectRepositoryId: string; path: string; stage: SandboxStage; content: string },
): Promise<void> {
  const res = await fetch(filesUrl(baseUrl, factoryProjectId), {
    method: 'POST',
    credentials: 'include',
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  await throwUnlessOk(res, 'Failed to add the env file');
}

export async function updateSandboxEnvFile(
  baseUrl: string,
  factoryProjectId: string,
  input: { id: string; path?: string; stage?: SandboxStage; content?: string },
): Promise<void> {
  const { id, ...patch } = input;
  const res = await fetch(filesUrl(baseUrl, factoryProjectId, id), {
    method: 'PATCH',
    credentials: 'include',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
  await throwUnlessOk(res, 'Failed to save the env file');
}

export async function deleteSandboxEnvFile(baseUrl: string, factoryProjectId: string, fileId: string): Promise<void> {
  const res = await fetch(filesUrl(baseUrl, factoryProjectId, fileId), {
    method: 'DELETE',
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  await throwUnlessOk(res, 'Failed to delete the env file');
}
