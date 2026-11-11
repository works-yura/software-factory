import { randomUUID } from 'node:crypto';

import { FactoryStorageDomain, UniqueViolationError } from '@mastra/core/storage';
import type { CollectionSchema, FactoryStorageOps } from '@mastra/core/storage';
import { createPlaintextFactorySecretEncryption } from '../secret-encryption.ts';
import type { FactorySecretEncryption } from '../secret-encryption.ts';

/** Where a sandbox environment variable applies. */
export type SandboxEnvAppliesTo = 'build' | 'runtime' | 'both';

/**
 * The deployment stage a variable or env file belongs to. A Factory chooses
 * which stages its sandboxes get (development always; staging when enabled);
 * production is stored but never reaches an agent sandbox.
 */
export type SandboxStage = 'development' | 'staging' | 'production';
export const SANDBOX_STAGES: readonly SandboxStage[] = ['development', 'staging', 'production'];
/** The stages a Factory may enable for its sandboxes. Production is never one of them. */
export type SandboxMaterializableStage = Exclude<SandboxStage, 'production'>;
export const DEFAULT_SANDBOX_STAGES: readonly SandboxMaterializableStage[] = ['development'];

/** Keeps only the stages a sandbox may get, development first; never production. */
export function normalizeSandboxStages(stages: readonly string[]): SandboxMaterializableStage[] {
  const wanted = new Set(stages);
  return (['development', 'staging'] as const).filter(stage => wanted.has(stage));
}

export const MAX_SANDBOX_ENV_FILE_PATH_LENGTH = 256;
export const MAX_SANDBOX_ENV_FILE_CONTENT_LENGTH = 64 * 1024;
const ENV_FILE_SEGMENT = /^[A-Za-z0-9._@+-]+$/;

/**
 * Why `path` can't name an env file inside a repository checkout, or
 * `undefined` when it can: relative, `/`-separated segments of letters,
 * digits and `._@+-` (so the path is safe in a shell, in `.git/info/exclude`
 * and in a gitignore pattern without escaping), no `.` or `..` segment, never
 * inside `.git`.
 */
export function sandboxEnvFilePathProblem(path: string): string | undefined {
  if (!path) return 'Enter a path.';
  if (path.length > MAX_SANDBOX_ENV_FILE_PATH_LENGTH) {
    return `Use at most ${MAX_SANDBOX_ENV_FILE_PATH_LENGTH} characters.`;
  }
  if (path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:/.test(path)) {
    return 'Use a path relative to the repository root.';
  }
  const segments = path.split('/');
  if (segments.some(segment => segment === '..')) return "The path can't leave the repository (`..`).";
  if (segments.some(segment => segment === '' || segment === '.')) return 'Remove empty or `.` path segments.';
  if (segments.some(segment => segment.toLowerCase() === '.git')) return "The path can't be inside `.git`.";
  if (!segments.every(segment => ENV_FILE_SEGMENT.test(segment))) {
    return 'Use letters, digits and . _ @ + - in file and folder names.';
  }
  return undefined;
}

/** A variable's metadata. Values never leave the store through this shape. */
export interface SandboxEnvMetadata {
  name: string;
  appliesTo: SandboxEnvAppliesTo;
  stage: SandboxStage;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SandboxEnvRevisions {
  /** Changes on every add, edit or delete. */
  revision: string;
  /** Changes only when a Build-applicable variable is added, edited, deleted or moved into or out of build. */
  buildRevision: string;
}

/** An env file as a sandbox writes it: one repository link, one relative path, decrypted content. */
export interface ResolvedSandboxEnvFile {
  id: string;
  projectRepositoryId: string;
  path: string;
  stage: SandboxStage;
  content: string;
}

export interface ResolvedSandboxEnvs extends SandboxEnvRevisions {
  /** Only variables of the Factory's sandbox stages; production never. */
  runtime: Record<string, string>;
  build: Record<string, string>;
  /** Env files of the Factory's sandbox stages; production never. */
  files: ResolvedSandboxEnvFile[];
  stages: SandboxMaterializableStage[];
}

export interface SetSandboxEnvInput {
  name: string;
  value: string;
  appliesTo: SandboxEnvAppliesTo;
  /** Defaults to `development` for a new variable; an existing one keeps its stage. */
  stage?: SandboxStage;
}

export interface UpdateSandboxEnvInput {
  appliesTo?: SandboxEnvAppliesTo;
  stage?: SandboxStage;
}

/** An env file's metadata. Its content leaves the store only through `getFile` and `resolve`. */
export interface SandboxEnvFileMetadata {
  id: string;
  projectRepositoryId: string;
  path: string;
  stage: SandboxStage;
  /** Content length in characters, so a viewer can tell an empty file from a filled one. */
  size: number;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SandboxEnvFile extends SandboxEnvFileMetadata {
  content: string;
}

export interface CreateSandboxEnvFileInput {
  projectRepositoryId: string;
  path: string;
  stage: SandboxStage;
  content: string;
}

export interface UpdateSandboxEnvFileInput {
  path?: string;
  stage?: SandboxStage;
  content?: string;
}

/** A second file with the same path in the same repository. */
export class SandboxEnvFilePathTakenError extends Error {
  constructor(path: string) {
    super(`An env file at ${path} already exists in this repository.`);
    this.name = 'SandboxEnvFilePathTakenError';
  }
}

/**
 * The surface routes and sandbox wiring depend on, so another backend (for
 * example a vault) can replace {@link SandboxEnvsStorage} without touching them.
 */
export interface SandboxEnvStore {
  list(orgId: string, projectId: string): Promise<SandboxEnvMetadata[]>;
  set(orgId: string, projectId: string, input: SetSandboxEnvInput, actorId: string): Promise<SandboxEnvMetadata>;
  updateAppliesTo(
    orgId: string,
    projectId: string,
    name: string,
    appliesTo: SandboxEnvAppliesTo,
    actorId: string,
  ): Promise<SandboxEnvMetadata | null>;
  update(
    orgId: string,
    projectId: string,
    name: string,
    patch: UpdateSandboxEnvInput,
    actorId: string,
  ): Promise<SandboxEnvMetadata | null>;
  delete(orgId: string, projectId: string, name: string): Promise<boolean>;
  /** The stages this Factory's sandboxes get; `development` alone until changed. */
  stages(orgId: string, projectId: string): Promise<SandboxMaterializableStage[]>;
  setStages(
    orgId: string,
    projectId: string,
    stages: readonly SandboxMaterializableStage[],
    actorId: string,
  ): Promise<SandboxMaterializableStage[]>;
  listFiles(orgId: string, projectId: string): Promise<SandboxEnvFileMetadata[]>;
  getFile(orgId: string, projectId: string, id: string): Promise<SandboxEnvFile | null>;
  createFile(
    orgId: string,
    projectId: string,
    input: CreateSandboxEnvFileInput,
    actorId: string,
  ): Promise<SandboxEnvFileMetadata>;
  updateFile(
    orgId: string,
    projectId: string,
    id: string,
    patch: UpdateSandboxEnvFileInput,
    actorId: string,
  ): Promise<SandboxEnvFileMetadata | null>;
  deleteFile(orgId: string, projectId: string, id: string): Promise<boolean>;
  revisions(orgId: string, projectId: string): Promise<SandboxEnvRevisions | null>;
  resolve(orgId: string, projectId: string): Promise<ResolvedSandboxEnvs>;
}

const ENVS = 'factory_sandbox_envs';
const REVISIONS = 'factory_sandbox_env_revisions';
const FILES = 'factory_sandbox_env_files';
const SETTINGS = 'factory_sandbox_env_settings';

export const SANDBOX_ENVS_SCHEMA: CollectionSchema = {
  name: ENVS,
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    project_id: { type: 'text' },
    name: { type: 'text' },
    value: { type: 'text' },
    applies_to: { type: 'text' },
    // Added with stages: every variable stored before then is a development variable.
    stage: { type: 'text', default: 'development' },
    created_by: { type: 'text' },
    updated_by: { type: 'text' },
    created_at: { type: 'timestamp' },
    updated_at: { type: 'timestamp' },
  },
  uniqueIndexes: [{ name: 'factory_sandbox_envs_org_project_name_key', columns: ['org_id', 'project_id', 'name'] }],
};

export const SANDBOX_ENV_REVISIONS_SCHEMA: CollectionSchema = {
  name: REVISIONS,
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    project_id: { type: 'text' },
    revision: { type: 'text' },
    build_revision: { type: 'text' },
    updated_at: { type: 'timestamp' },
  },
  uniqueIndexes: [{ name: 'factory_sandbox_env_revisions_org_project_key', columns: ['org_id', 'project_id'] }],
};

/** Env files written into a repository checkout; content encrypted like variable values. */
export const SANDBOX_ENV_FILES_SCHEMA: CollectionSchema = {
  name: FILES,
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    project_id: { type: 'text' },
    project_repository_id: { type: 'text' },
    path: { type: 'text' },
    stage: { type: 'text' },
    content: { type: 'text' },
    size: { type: 'integer' },
    created_by: { type: 'text' },
    updated_by: { type: 'text' },
    created_at: { type: 'timestamp' },
    updated_at: { type: 'timestamp' },
  },
  uniqueIndexes: [
    {
      name: 'factory_sandbox_env_files_org_project_repository_path_key',
      columns: ['org_id', 'project_id', 'project_repository_id', 'path'],
    },
  ],
};

/** One row per Factory: which stages its sandboxes get. No row means development only. */
export const SANDBOX_ENV_SETTINGS_SCHEMA: CollectionSchema = {
  name: SETTINGS,
  columns: {
    id: { type: 'uuid-pk' },
    org_id: { type: 'text' },
    project_id: { type: 'text' },
    stages: { type: 'json' },
    updated_by: { type: 'text' },
    updated_at: { type: 'timestamp' },
  },
  uniqueIndexes: [{ name: 'factory_sandbox_env_settings_org_project_key', columns: ['org_id', 'project_id'] }],
};

interface SandboxEnvFileDbRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  project_id: string;
  project_repository_id: string;
  path: string;
  stage: SandboxStage;
  content: string;
  size: number;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
}

interface SandboxEnvSettingsDbRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  project_id: string;
  stages: string[];
  updated_by: string;
  updated_at: Date;
}

interface SandboxEnvDbRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  project_id: string;
  name: string;
  value: string;
  applies_to: SandboxEnvAppliesTo;
  stage: SandboxStage | null;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
}

interface SandboxEnvRevisionDbRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  project_id: string;
  revision: string;
  build_revision: string;
  updated_at: Date;
}

function appliesToBuild(appliesTo: SandboxEnvAppliesTo | undefined): boolean {
  return appliesTo === 'build' || appliesTo === 'both';
}

function appliesToRuntime(appliesTo: SandboxEnvAppliesTo): boolean {
  return appliesTo === 'runtime' || appliesTo === 'both';
}

function stageOf(stage: string | null | undefined): SandboxStage {
  return stage === 'staging' || stage === 'production' ? stage : 'development';
}

function toFileMetadata(row: SandboxEnvFileDbRow): SandboxEnvFileMetadata {
  return {
    id: row.id,
    projectRepositoryId: row.project_repository_id,
    path: row.path,
    stage: stageOf(row.stage),
    size: Number(row.size),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertFilePath(path: string): void {
  const problem = sandboxEnvFilePathProblem(path);
  if (problem) throw new Error(`Invalid env file path ${JSON.stringify(path)}: ${problem}`);
}

function toMetadata(row: SandboxEnvDbRow): SandboxEnvMetadata {
  return {
    name: row.name,
    appliesTo: row.applies_to,
    stage: stageOf(row.stage),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Factory-wide sandbox environment variables, values encrypted with
 * {@link FactorySecretEncryption}. Every write lands the variable row first
 * and the revision row second (there is no transaction primitive), so a
 * reader that sees a new revision always sees the rows behind it. Revisions
 * are random ids, never derived from values.
 */
export class SandboxEnvsStorage extends FactoryStorageDomain implements SandboxEnvStore {
  private readonly encryption: FactorySecretEncryption;

  constructor(encryption: FactorySecretEncryption = createPlaintextFactorySecretEncryption()) {
    super('sandbox-envs');
    this.encryption = encryption;
  }

  async init(): Promise<void> {
    await this.ensureCollections([
      SANDBOX_ENVS_SCHEMA,
      SANDBOX_ENV_REVISIONS_SCHEMA,
      SANDBOX_ENV_FILES_SCHEMA,
      SANDBOX_ENV_SETTINGS_SCHEMA,
    ]);
    // Re-encrypt values saved as plaintext or under a retired key, like the other secret domains.
    const rows = await this.#db.findMany<SandboxEnvDbRow>(ENVS, {});
    await Promise.all(
      rows.map(({ id }) =>
        this.#db.updateAtomic<SandboxEnvDbRow>(ENVS, { id }, async row => {
          const decrypted = await this.encryption.decrypt<string>(row.value);
          return decrypted.needsReencryption ? { value: await this.encryption.encrypt(decrypted.value) } : null;
        }),
      ),
    );
    const files = await this.#db.findMany<SandboxEnvFileDbRow>(FILES, {});
    await Promise.all(
      files.map(({ id }) =>
        this.#db.updateAtomic<SandboxEnvFileDbRow>(FILES, { id }, async row => {
          const decrypted = await this.encryption.decrypt<string>(row.content);
          return decrypted.needsReencryption ? { content: await this.encryption.encrypt(decrypted.value) } : null;
        }),
      ),
    );
  }

  async dangerouslyClearAll(): Promise<void> {
    await this.ops.deleteMany(ENVS, {});
    await this.ops.deleteMany(REVISIONS, {});
    await this.ops.deleteMany(FILES, {});
    await this.ops.deleteMany(SETTINGS, {});
  }

  get #db(): FactoryStorageOps {
    return this.ops;
  }

  async list(orgId: string, projectId: string): Promise<SandboxEnvMetadata[]> {
    const rows = await this.#db.findMany<SandboxEnvDbRow>(
      ENVS,
      { org_id: orgId, project_id: projectId },
      { orderBy: [['name', 'asc']] },
    );
    return rows.map(toMetadata);
  }

  /** Create or replace a variable. Bumps the build revision whenever the old or new row applies to build. */
  async set(orgId: string, projectId: string, input: SetSandboxEnvInput, actorId: string): Promise<SandboxEnvMetadata> {
    const now = new Date();
    const value = await this.encryption.encrypt(input.value);
    const where = { org_id: orgId, project_id: projectId, name: input.name };
    let previous: SandboxEnvAppliesTo | undefined;
    const update = () =>
      this.#db.updateAtomic<SandboxEnvDbRow>(ENVS, where, row => {
        previous = row.applies_to;
        return {
          value,
          applies_to: input.appliesTo,
          ...(input.stage ? { stage: input.stage } : {}),
          updated_by: actorId,
          updated_at: now,
        };
      });

    let row = await update();
    if (!row) {
      try {
        row = await this.#db.insertOne<SandboxEnvDbRow>(ENVS, {
          ...where,
          value,
          applies_to: input.appliesTo,
          stage: input.stage ?? 'development',
          created_by: actorId,
          updated_by: actorId,
          created_at: now,
          updated_at: now,
        });
      } catch (error) {
        if (!(error instanceof UniqueViolationError)) throw error;
        // Lost the insert race: apply this write to the winning row.
        row = await update();
        if (!row) throw error;
      }
    }
    await this.#bump(orgId, projectId, appliesToBuild(previous) || appliesToBuild(input.appliesTo), now);
    return toMetadata(row);
  }

  async updateAppliesTo(
    orgId: string,
    projectId: string,
    name: string,
    appliesTo: SandboxEnvAppliesTo,
    actorId: string,
  ): Promise<SandboxEnvMetadata | null> {
    return this.update(orgId, projectId, name, { appliesTo }, actorId);
  }

  /** Change where a variable applies and/or its stage; revisions move only when something changed. */
  async update(
    orgId: string,
    projectId: string,
    name: string,
    patch: UpdateSandboxEnvInput,
    actorId: string,
  ): Promise<SandboxEnvMetadata | null> {
    const now = new Date();
    let previous: { appliesTo: SandboxEnvAppliesTo; stage: SandboxStage } | undefined;
    const row = await this.#db.updateAtomic<SandboxEnvDbRow>(
      ENVS,
      { org_id: orgId, project_id: projectId, name },
      current => {
        previous = { appliesTo: current.applies_to, stage: stageOf(current.stage) };
        return {
          ...(patch.appliesTo ? { applies_to: patch.appliesTo } : {}),
          ...(patch.stage ? { stage: patch.stage } : {}),
          updated_by: actorId,
          updated_at: now,
        };
      },
    );
    if (!row || !previous) return null;
    const appliesTo = patch.appliesTo ?? previous.appliesTo;
    const stage = patch.stage ?? previous.stage;
    if (previous.appliesTo !== appliesTo || previous.stage !== stage) {
      const build =
        appliesToBuild(previous.appliesTo) !== appliesToBuild(appliesTo) ||
        (appliesToBuild(appliesTo) && previous.stage !== stage);
      await this.#bump(orgId, projectId, build, now);
    }
    return toMetadata(row);
  }

  async delete(orgId: string, projectId: string, name: string): Promise<boolean> {
    const where = { org_id: orgId, project_id: projectId, name };
    const existing = await this.#db.findOne<SandboxEnvDbRow>(ENVS, where);
    if (!existing) return false;
    const deleted = (await this.#db.deleteMany(ENVS, where)) > 0;
    if (deleted) await this.#bump(orgId, projectId, appliesToBuild(existing.applies_to), new Date());
    return deleted;
  }

  async revisions(orgId: string, projectId: string): Promise<SandboxEnvRevisions | null> {
    const row = await this.#db.findOne<SandboxEnvRevisionDbRow>(REVISIONS, { org_id: orgId, project_id: projectId });
    return row ? { revision: row.revision, buildRevision: row.build_revision } : null;
  }

  /**
   * Decrypted values split by where they apply, plus the revisions read
   * before them: if a write lands in between, the caller holds an older
   * revision than the values it got and simply reloads on its next check.
   */
  async resolve(orgId: string, projectId: string): Promise<ResolvedSandboxEnvs> {
    const revisions = (await this.revisions(orgId, projectId)) ?? { revision: '', buildRevision: '' };
    const stages = await this.stages(orgId, projectId);
    const enabled = new Set<SandboxStage>(stages);
    const scope = { org_id: orgId, project_id: projectId };
    const rows = await this.#db.findMany<SandboxEnvDbRow>(ENVS, scope);
    const runtime: Record<string, string> = {};
    const build: Record<string, string> = {};
    for (const row of rows) {
      if (!enabled.has(stageOf(row.stage))) continue;
      const { value } = await this.encryption.decrypt<string>(row.value);
      if (appliesToRuntime(row.applies_to)) runtime[row.name] = value;
      if (appliesToBuild(row.applies_to)) build[row.name] = value;
    }
    const files: ResolvedSandboxEnvFile[] = [];
    const fileRows = await this.#db.findMany<SandboxEnvFileDbRow>(FILES, scope, { orderBy: [['path', 'asc']] });
    for (const row of fileRows) {
      const stage = stageOf(row.stage);
      // Production content is never decrypted for a sandbox.
      if (!enabled.has(stage)) continue;
      const { value } = await this.encryption.decrypt<string>(row.content);
      files.push({ id: row.id, projectRepositoryId: row.project_repository_id, path: row.path, stage, content: value });
    }
    return { ...revisions, runtime, build, files, stages };
  }

  async stages(orgId: string, projectId: string): Promise<SandboxMaterializableStage[]> {
    const row = await this.#db.findOne<SandboxEnvSettingsDbRow>(SETTINGS, { org_id: orgId, project_id: projectId });
    if (!row) return [...DEFAULT_SANDBOX_STAGES];
    const stages = normalizeSandboxStages(Array.isArray(row.stages) ? row.stages : []);
    return stages;
  }

  /**
   * Choose which stages the Factory's sandboxes get. Production is dropped
   * whatever the caller sends. Bumps the revision when the set changed, and the
   * build revision when a Build variable of a toggled stage exists.
   */
  async setStages(
    orgId: string,
    projectId: string,
    stages: readonly SandboxMaterializableStage[],
    actorId: string,
  ): Promise<SandboxMaterializableStage[]> {
    const next = normalizeSandboxStages(stages);
    const previous = await this.stages(orgId, projectId);
    const now = new Date();
    const where = { org_id: orgId, project_id: projectId };
    const write = () =>
      this.#db.updateAtomic<SandboxEnvSettingsDbRow>(SETTINGS, where, () => ({
        stages: next,
        updated_by: actorId,
        updated_at: now,
      }));
    if (!(await write())) {
      try {
        await this.#db.insertOne<SandboxEnvSettingsDbRow>(SETTINGS, {
          ...where,
          stages: next,
          updated_by: actorId,
          updated_at: now,
        });
      } catch (error) {
        if (!(error instanceof UniqueViolationError) || !(await write())) throw error;
      }
    }
    const toggled = new Set<SandboxStage>([
      ...previous.filter(stage => !next.includes(stage)),
      ...next.filter(stage => !previous.includes(stage)),
    ]);
    if (toggled.size > 0) {
      const rows = await this.#db.findMany<SandboxEnvDbRow>(ENVS, where);
      const build = rows.some(row => appliesToBuild(row.applies_to) && toggled.has(stageOf(row.stage)));
      await this.#bump(orgId, projectId, build, now);
    }
    return next;
  }

  async listFiles(orgId: string, projectId: string): Promise<SandboxEnvFileMetadata[]> {
    const rows = await this.#db.findMany<SandboxEnvFileDbRow>(
      FILES,
      { org_id: orgId, project_id: projectId },
      { orderBy: [['path', 'asc']] },
    );
    return rows.map(toFileMetadata);
  }

  async getFile(orgId: string, projectId: string, id: string): Promise<SandboxEnvFile | null> {
    const row = await this.#db.findOne<SandboxEnvFileDbRow>(FILES, { org_id: orgId, project_id: projectId, id });
    if (!row) return null;
    const { value } = await this.encryption.decrypt<string>(row.content);
    return { ...toFileMetadata(row), content: value };
  }

  async createFile(
    orgId: string,
    projectId: string,
    input: CreateSandboxEnvFileInput,
    actorId: string,
  ): Promise<SandboxEnvFileMetadata> {
    assertFilePath(input.path);
    const now = new Date();
    let row: SandboxEnvFileDbRow;
    try {
      row = await this.#db.insertOne<SandboxEnvFileDbRow>(FILES, {
        org_id: orgId,
        project_id: projectId,
        project_repository_id: input.projectRepositoryId,
        path: input.path,
        stage: input.stage,
        content: await this.encryption.encrypt(input.content),
        size: input.content.length,
        created_by: actorId,
        updated_by: actorId,
        created_at: now,
        updated_at: now,
      });
    } catch (error) {
      if (error instanceof UniqueViolationError) throw new SandboxEnvFilePathTakenError(input.path);
      throw error;
    }
    await this.#bump(orgId, projectId, false, now);
    return toFileMetadata(row);
  }

  async updateFile(
    orgId: string,
    projectId: string,
    id: string,
    patch: UpdateSandboxEnvFileInput,
    actorId: string,
  ): Promise<SandboxEnvFileMetadata | null> {
    if (patch.path !== undefined) assertFilePath(patch.path);
    const now = new Date();
    const content = patch.content === undefined ? undefined : await this.encryption.encrypt(patch.content);
    let row: SandboxEnvFileDbRow | null;
    try {
      row = await this.#db.updateAtomic<SandboxEnvFileDbRow>(
        FILES,
        { org_id: orgId, project_id: projectId, id },
        () => ({
          ...(patch.path !== undefined ? { path: patch.path } : {}),
          ...(patch.stage ? { stage: patch.stage } : {}),
          ...(content !== undefined ? { content, size: patch.content!.length } : {}),
          updated_by: actorId,
          updated_at: now,
        }),
      );
    } catch (error) {
      if (error instanceof UniqueViolationError) throw new SandboxEnvFilePathTakenError(patch.path ?? '');
      throw error;
    }
    if (!row) return null;
    await this.#bump(orgId, projectId, false, now);
    return toFileMetadata(row);
  }

  async deleteFile(orgId: string, projectId: string, id: string): Promise<boolean> {
    const deleted = (await this.#db.deleteMany(FILES, { org_id: orgId, project_id: projectId, id })) > 0;
    if (deleted) await this.#bump(orgId, projectId, false, new Date());
    return deleted;
  }

  async #bump(orgId: string, projectId: string, build: boolean, now: Date): Promise<void> {
    const where = { org_id: orgId, project_id: projectId };
    const revision = randomUUID();
    const bump = () =>
      this.#db.updateAtomic<SandboxEnvRevisionDbRow>(REVISIONS, where, () => ({
        revision,
        ...(build ? { build_revision: randomUUID() } : {}),
        updated_at: now,
      }));
    if (await bump()) return;
    try {
      await this.#db.insertOne<SandboxEnvRevisionDbRow>(REVISIONS, {
        ...where,
        revision,
        // Empty until a Build-applicable variable exists, so a runtime-only
        // first write doesn't look like a build change.
        build_revision: build ? randomUUID() : '',
        updated_at: now,
      });
    } catch (error) {
      if (!(error instanceof UniqueViolationError) || !(await bump())) throw error;
    }
  }
}
