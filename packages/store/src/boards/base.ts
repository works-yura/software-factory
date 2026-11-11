import { randomUUID } from 'node:crypto';

import { FactoryStorageDomain, UniqueViolationError } from '@mastra/core/storage';
import type { FactoryStorageOps } from '@mastra/core/storage';

import { DEFAULT_ROUTE_EVENTS, routeEventsProblem } from '@factory/core';
import type { FactoryPhaseTool, IntakeTriggerRoute, RuleGroup, StatusEvent } from '@factory/core';
import type { RetiredAutomationSettings } from '../projects/base.ts';
import {
  FACTORY_BOARD_DEFINITION_VERSIONS_SCHEMA,
  FACTORY_BOARD_PHASES_SCHEMA,
  FACTORY_BOARDS_SCHEMA,
  FACTORY_INTAKE_ROUTE_LOCKS_SCHEMA,
  FACTORY_INTAKE_ROUTES_SCHEMA,
} from './schemas.ts';

/** The project a board belongs to. */
export interface StoredBoardScope {
  orgId: string;
  factoryProjectId: string;
}

export type StoredPhaseKind = 'resting' | 'working' | 'terminal';

/** Who runs a working phase. Factory runs every phase with its code agent. */
export interface StoredPhaseRunner {
  skill?: string;
  context?: string;
  instructions?: string;
  /** The objective the phase's runs pursue as a goal. */
  goal?: { objective: string; maxRuns?: number };
}

export interface StoredPhaseExitTool {
  id: string;
  autoApprove?: boolean;
  autoApproveWhen?: RuleGroup;
}

/** A phase as it is written. `key` is the stage id cards sit in. */
export interface StoredPhaseInput {
  key: string;
  name: string;
  description?: string | null;
  kind: StoredPhaseKind;
  runner?: StoredPhaseRunner | null;
  /** Unset or `null` on a resting or working phase means every other phase; `[]` means none. */
  nextPhases?: string[] | null;
  autoStart?: boolean;
  autoStartWhen?: RuleGroup | null;
  exitTool?: StoredPhaseExitTool | null;
  /** Factory tools the phase grants the session working the card there. */
  tools?: FactoryPhaseTool[] | null;
}

/** A board as it is written. Phase order is significant: the first phase is where cards start. */
export interface StoredBoardInput {
  key: string;
  name: string;
  description?: string | null;
  phases: StoredPhaseInput[];
}

export interface StoredPhaseRecord {
  key: string;
  position: number;
  name: string;
  description: string | null;
  kind: StoredPhaseKind;
  runner: StoredPhaseRunner | null;
  nextPhases: string[] | null;
  autoStart: boolean;
  autoStartWhen: RuleGroup | null;
  exitTool: StoredPhaseExitTool | null;
  tools: FactoryPhaseTool[] | null;
}

export interface StoredBoardRecord {
  id: string;
  orgId: string;
  factoryProjectId: string;
  key: string;
  name: string;
  description: string | null;
  position: number;
  revision: number;
  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
  phases: StoredPhaseRecord[];
}

/** What a board migration may know about the project besides the board it rewrites. */
export interface BoardMigrationContext {
  /** The project switches the boards replaced, as the project last stored them; null when unknown. */
  readonly retiredSettings: RetiredAutomationSettings | null;
  /** The phases of each board that cards sit in, by board key; null when the cards can't be read. */
  readonly occupiedPhases: ReadonlyMap<string, ReadonlySet<string>> | null;
  /**
   * The phases the code board under this key declares; undefined for a board only the project
   * stores. A row that drops one runs without its code rules (`mergeCodeBehaviour`).
   */
  codePhases(boardKey: string): ReadonlySet<string> | undefined;
  /** Tells the operator about a board a migration left as it is. */
  warn(message: string): void;
}

/** A one-time rewrite of a stored board, keyed so each project gets it once. */
export interface StoredBoardMigration {
  key: string;
  /** The board it rewrites; `null` rewrites every board the project stores. */
  boardKey: string | null;
  /** The board to write instead, with what changed; undefined leaves it as it is. */
  migrate(
    board: StoredBoardRecord,
    context: BoardMigrationContext,
  ): { board: Omit<StoredBoardInput, 'key'>; filled: string[] } | undefined;
}

const EMPTY_MIGRATION_CONTEXT: BoardMigrationContext = {
  retiredSettings: null,
  occupiedPhases: new Map(),
  codePhases: () => undefined,
  warn: () => {},
};

export interface AppliedBoardMigration {
  key: string;
  boardKey: string;
  filled: string[];
}

export interface StoredBoardSnapshot {
  version: string | null;
  boards: StoredBoardRecord[];
}

export interface IntakeRouteTarget {
  boardKey: string;
  /**
   * Unset lands the card in the board's first phase. On a route that joins a closed issue's
   * card, the phase that card moves to when its board allows it; unset leaves it where it is.
   */
  phaseKey?: string | null;
  /**
   * Files a pull request on the card of the issue it closes, which must be on `boardKey`, as one
   * more source instead of a card of its own. The route doesn't match any other arrival.
   */
  joinClosedIssue?: boolean;
}

/** A kind and its config, as a trigger route stores its trigger and its action. */
export interface IntakeRouteKindConfig {
  kind: string;
  config: Record<string, unknown>;
}

/**
 * What made a route, so the settings can name it in the reader's language: Factory writes routes
 * of its own (a ClickUp List's status, a migrated schedule), and a name typed on the server would
 * be in one language only. `generatedName` is the name Factory gave it; once a person renames the
 * route, its own name shows.
 */
export type IntakeRouteOrigin =
  | { kind: 'clickup-status'; listId: string; status: string; generatedName: string }
  | { kind: 'schedule'; generatedName: string }
  /** A code host repository the project reads, added when the repository was linked (or migrated from the old selection). */
  | { kind: 'repository'; integrationId: string; repository: string; generatedName: string };

/** The trigger-route part of a route: present together on a route that makes its own cards. */
export interface IntakeRouteTrigger {
  trigger: IntakeRouteKindConfig;
  action: IntakeRouteKindConfig;
  policyKind: string;
}

/** An intake route as it is written. */
export interface StoredIntakeRouteInput {
  name: string;
  enabled?: boolean;
  /** Null matches every card. */
  when?: RuleGroup | null;
  target: IntakeRouteTarget;
  /** The status events the route handles; unset handles new cards (`work_item.created`). A trigger route handles none. */
  on?: StatusEvent[];
  /** Makes the route a trigger route: it files its own cards on each fire (see `IntakeRouteTrigger`). Null clears it. */
  triggered?: IntakeRouteTrigger | null;
  origin?: IntakeRouteOrigin | null;
}

export interface StoredIntakeRouteRecord {
  id: string;
  orgId: string;
  factoryProjectId: string;
  name: string;
  enabled: boolean;
  position: number;
  when: RuleGroup | null;
  target: { boardKey: string; phaseKey: string | null; joinClosedIssue: boolean };
  on: StatusEvent[];
  /** The route's own trigger, for a trigger route; null on a route that waits for arriving cards. */
  trigger: IntakeRouteKindConfig | null;
  action: IntakeRouteKindConfig | null;
  policyKind: string | null;
  origin: IntakeRouteOrigin | null;
  revision: number;
  createdBy: string;
  createdAt: Date;
  updatedBy: string;
  updatedAt: Date;
}

/** A stored route as the trigger-route engine reads it, or null when the route has no trigger of its own. */
export function storedTriggerRoute(route: StoredIntakeRouteRecord): IntakeTriggerRoute | null {
  if (!route.trigger || !route.action || !route.policyKind) return null;
  return {
    id: route.id,
    orgId: route.orgId,
    factoryProjectId: route.factoryProjectId,
    name: route.name,
    enabled: route.enabled,
    trigger: route.trigger,
    action: route.action,
    policyKind: route.policyKind,
    target: { boardKey: route.target.boardKey, phaseKey: route.target.phaseKey },
    revision: route.revision,
    createdBy: route.createdBy,
  };
}

export type StoredBoardErrorCode =
  | 'board_exists'
  | 'board_not_found'
  | 'revision_mismatch'
  | 'intake_route_not_found'
  | 'intake_route_set_mismatch'
  | 'intake_route_limit'
  | 'invalid_intake_route';

/** A project's most intake routes; a reorder names every one of them. */
export const MAX_INTAKE_ROUTES = 100;

import { DEFAULT_INTAKE_ROUTES } from './work-routes.ts';

// Work's routes are its seed data, kept with the board they target.
export {
  DEFAULT_INTAKE_ROUTE,
  PULL_REQUEST_INTAKE_ROUTE,
  CLOSED_COMPLETED_ROUTE,
  CLOSED_CANCELED_ROUTE,
  REOPENED_ROUTE,
  PULL_REQUEST_MERGED_ROUTE,
  PULL_REQUEST_CLOSED_ROUTE,
  PULL_REQUEST_CLOSED_ISSUE_ROUTE,
  PULL_REQUEST_UPDATED_ROUTE,
  PULL_REQUEST_REVIEW_REQUESTED_ROUTE,
  CLOSES_ISSUE_INTAKE_ROUTE,
  CATCH_ALL_INTAKE_ROUTE,
  DEFAULT_INTAKE_ROUTES,
} from './work-routes.ts';

/** The defaults a project whose lock row predates `seeded_defaults` was set up with. */
const ORIGINAL_DEFAULT_KEYS = ['outside-authors'];

/** Who the default intake routes are created and last updated by. */
export const DEFAULT_INTAKE_ROUTE_ACTOR = 'factory';

export class StoredBoardError extends Error {
  override name = 'StoredBoardError';
  readonly code: StoredBoardErrorCode;
  constructor(code: StoredBoardErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

interface BoardRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  factory_project_id: string;
  board_key: string;
  name: string;
  description: string | null;
  position: number;
  revision: number;
  created_by: string;
  created_at: Date;
  updated_by: string;
  updated_at: Date;
}

interface VersionRow extends Record<string, unknown> {
  version: string;
  /** Keys of the boards Factory stored in the project; null on rows written before the list. */
  seeded_boards: string[] | null;
  /** Keys of the board migrations applied to the project; null before the first one. */
  applied_migrations: string[] | null;
}

interface PhaseRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  factory_project_id: string;
  board_key: string;
  phase_key: string;
  position: number;
  name: string;
  description: string | null;
  kind: StoredPhaseKind;
  runner: StoredPhaseRunner | null;
  next_phases: string[] | null;
  auto_start: boolean;
  auto_start_when: RuleGroup | null;
  exit_tool: StoredPhaseExitTool | null;
  tools: FactoryPhaseTool[] | null;
}

interface IntakeRouteRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  factory_project_id: string;
  name: string;
  enabled: boolean;
  position: number;
  when_condition: RuleGroup | null;
  board_key: string;
  phase_key: string | null;
  /** Null on rows written before routes named events: they place new cards. */
  on_events: StatusEvent[] | null;
  join_closed_issue: boolean | null;
  trigger_kind?: string | null;
  trigger_config?: Record<string, unknown> | string | null;
  action_kind?: string | null;
  action_config?: Record<string, unknown> | string | null;
  policy_kind?: string | null;
  origin?: IntakeRouteOrigin | string | null;
  revision: number;
  created_by: string;
  created_at: Date;
  updated_by: string;
  updated_at: Date;
}

interface IntakeRouteLockRow extends Record<string, unknown> {
  /** Keys of the `DEFAULT_INTAKE_ROUTES` added to the project; null on rows written before the list. */
  seeded_defaults: string[] | null;
}

function seededDefaults(lock: IntakeRouteLockRow): string[] {
  return lock.seeded_defaults ?? ORIGINAL_DEFAULT_KEYS;
}

function missingDefaults(lock: IntakeRouteLockRow): (typeof DEFAULT_INTAKE_ROUTES)[number][] {
  const seeded = new Set(seededDefaults(lock));
  return DEFAULT_INTAKE_ROUTES.filter(({ key }) => !seeded.has(key));
}

const BOARDS = 'factory_boards';
const PHASES = 'factory_board_phases';
const VERSIONS = 'factory_board_definition_versions';
const INTAKE_ROUTES = 'factory_intake_routes';
const INTAKE_ROUTE_LOCKS = 'factory_intake_route_locks';
const MAX_WRITE_ATTEMPTS = 3;
const MIGRATION_ACTOR = 'factory';

function scopeWhere({ orgId, factoryProjectId }: StoredBoardScope) {
  return { org_id: orgId, factory_project_id: factoryProjectId };
}

function toPhaseRecord(row: PhaseRow): StoredPhaseRecord {
  return {
    key: row.phase_key,
    position: row.position,
    name: row.name,
    description: row.description,
    kind: row.kind,
    runner: row.runner,
    nextPhases: row.next_phases,
    autoStart: row.auto_start,
    autoStartWhen: row.auto_start_when,
    exitTool: row.exit_tool,
    tools: row.tools ?? null,
  };
}

function toRecord(row: BoardRow, phases: PhaseRow[]): StoredBoardRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    factoryProjectId: row.factory_project_id,
    key: row.board_key,
    name: row.name,
    description: row.description,
    position: row.position,
    revision: row.revision,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    phases: phases.sort((left, right) => left.position - right.position).map(toPhaseRecord),
  };
}

/** A compare-and-set inside a write lost to a concurrent writer; the write is retried from fresh reads. */
class ConcurrentBoardWrite extends Error {}

/**
 * Each project's boards and their ordered phases. Every write runs in one transaction that also
 * replaces the project's row in `factory_board_definition_versions`, so caches on other
 * replicas can detect it.
 */
/** Who the intake routes moved off the retired Review board are attributed to. */
export const REVIEW_BOARD_RETIREMENT_ACTOR = 'system:review-board-retirement';

/** Who the Product board's phase renames are attributed to. */
export const PRODUCT_BOARD_UPGRADE_ACTOR = 'system:product-board-phases';

export class StoredBoardsStorage extends FactoryStorageDomain {
  constructor() {
    super('boards');
  }

  async init(): Promise<void> {
    await this.ensureCollections([
      FACTORY_BOARDS_SCHEMA,
      FACTORY_BOARD_PHASES_SCHEMA,
      FACTORY_BOARD_DEFINITION_VERSIONS_SCHEMA,
      FACTORY_INTAKE_ROUTES_SCHEMA,
      FACTORY_INTAKE_ROUTE_LOCKS_SCHEMA,
    ]);
  }

  async dangerouslyClearAll(): Promise<void> {
    await this.ops.deleteMany(PHASES, {});
    await this.ops.deleteMany(BOARDS, {});
    await this.ops.deleteMany(VERSIONS, {});
    await this.ops.deleteMany(INTAKE_ROUTES, {});
    await this.ops.deleteMany(INTAKE_ROUTE_LOCKS, {});
  }

  /** The project's current definition version; null before its first board write. */
  async readVersion(scope: StoredBoardScope): Promise<string | null> {
    return readVersion(this.ops, scope);
  }

  /** The project's boards in order. */
  async list(scope: StoredBoardScope): Promise<StoredBoardRecord[]> {
    return readBoards(this.ops, scope);
  }

  /**
   * The version and the boards, read in that order: a write landing between the two reads leaves a
   * version older than the rows, so a cache keyed on it rereads on its next check instead of
   * keeping the stale rows.
   */
  async snapshot(scope: StoredBoardScope): Promise<StoredBoardSnapshot> {
    const version = await readVersion(this.ops, scope);
    return { version, boards: await this.list(scope) };
  }

  async get(scope: StoredBoardScope, key: string): Promise<StoredBoardRecord | null> {
    const row = await this.ops.findOne<BoardRow>(BOARDS, { ...scopeWhere(scope), board_key: key });
    if (!row) return null;
    const phases = await this.ops.findMany<PhaseRow>(PHASES, { ...scopeWhere(scope), board_key: key });
    return toRecord(row, phases);
  }

  /** Creates a board through the API. */
  async create(scope: StoredBoardScope, input: StoredBoardInput, actor: string): Promise<StoredBoardRecord> {
    await ensureVersionRow(this.ops, scope);
    try {
      return await this.#write(scope, async ops => {
        const rows = await ops.findMany<BoardRow>(BOARDS, scopeWhere(scope));
        if (rows.some(row => row.board_key === input.key)) {
          throw new StoredBoardError('board_exists', `Board "${input.key}" already exists in this project.`);
        }
        await insertBoard(ops, scope, input, { position: nextPosition(rows), actor });
        return { result: undefined, changed: true };
      }).then(async () => (await this.get(scope, input.key))!);
    } catch (error) {
      // Only the board key's index means the board exists; a lost race on another table is not that.
      if (error instanceof UniqueViolationError && error.collection === BOARDS) {
        throw new StoredBoardError('board_exists', `Board "${input.key}" already exists in this project.`);
      }
      throw error;
    }
  }

  /** Replaces a board's name, description and phases. The board key never changes. */
  async replace(
    scope: StoredBoardScope,
    key: string,
    input: Omit<StoredBoardInput, 'key'>,
    options: { expectedRevision: number; actor: string },
  ): Promise<StoredBoardRecord> {
    await this.#write(scope, async ops => {
      const row = await findBoard(ops, scope, key);
      checkRevision(row, key, options.expectedRevision);
      await writeBoard(ops, scope, row, { key, ...input }, options.actor);
      return { result: undefined, changed: true };
    });
    return (await this.get(scope, key))!;
  }

  /**
   * Stores Factory's boards (Work, app and seed boards) in the project, each key once: a key the
   * project has had before is skipped even if its board was deleted since, and a stored board is
   * never rewritten. A project stored before the list was kept counts the boards it has as stored.
   * Reads one row when every key was stored before. Returns the keys it inserted.
   *
   * A key in `onlyIntoEmpty` is inserted only into a project that has no boards at all: one that
   * already has any board, such as one an app stored under that key, is left as it is. The key
   * is still recorded as stored, so it never goes in later, even after the project's boards are
   * deleted: that project chose its boards, and Work is never added beside or after them. The
   * `intoEmpty` boards (an app's, for every project) go first into a project with no boards, so
   * Factory's own under the same key, or in `onlyIntoEmpty`, then stay out. `actor` is recorded
   * as the inserted boards' creator.
   */
  async seedBoards(
    scope: StoredBoardScope,
    boards: readonly StoredBoardInput[],
    options: { actor?: string; onlyIntoEmpty?: readonly string[]; intoEmpty?: readonly StoredBoardInput[] } = {},
  ): Promise<string[]> {
    const marker = await this.ops.findOne<VersionRow>(VERSIONS, scopeWhere(scope));
    if (marker?.seeded_boards && boards.every(board => marker.seeded_boards!.includes(board.key))) return [];
    return this.#insertOnce(scope, boards, {
      actor: options.actor ?? DEFAULT_INTAKE_ROUTE_ACTOR,
      skipSeeded: true,
      onlyIntoEmpty: options.onlyIntoEmpty ?? [],
      intoEmpty: options.intoEmpty ?? [],
    });
  }

  /** The keys of the boards Factory stored in the project; null before it kept the list. */
  async seededBoardKeys(scope: StoredBoardScope): Promise<string[] | null> {
    return (await this.ops.findOne<VersionRow>(VERSIONS, scopeWhere(scope)))?.seeded_boards ?? null;
  }

  /**
   * Inserts a board into the project unless one is stored under its key, and records the key as
   * stored, so seeding never adds it again. Unlike seeding, it inserts a key the project deleted.
   * Returns whether it inserted the board.
   */
  async insertIfMissing(scope: StoredBoardScope, board: StoredBoardInput, actor: string): Promise<boolean> {
    return (await this.#insertOnce(scope, [board], { actor, skipSeeded: false })).length > 0;
  }

  async #insertOnce(
    scope: StoredBoardScope,
    boards: readonly StoredBoardInput[],
    options: {
      actor: string;
      skipSeeded: boolean;
      onlyIntoEmpty?: readonly string[];
      intoEmpty?: readonly StoredBoardInput[];
    },
  ): Promise<string[]> {
    await ensureVersionRow(this.ops, scope);
    return this.#transact(async ops => {
      const marker = (await ops.findOne<VersionRow>(VERSIONS, scopeWhere(scope)))!;
      const rows = await ops.findMany<BoardRow>(BOARDS, scopeWhere(scope));
      const present = new Set(rows.map(row => row.board_key));
      const seeded = new Set(marker.seeded_boards ?? present);
      // The `intoEmpty` boards go into a project with no boards, first; `onlyIntoEmpty` keys then
      // go in only when nothing is stored yet, so a project holding them gets no default beside them.
      const candidates = [...(rows.length === 0 ? (options.intoEmpty ?? []) : []), ...boards];
      let position = nextPosition(rows);
      const inserted: string[] = [];
      for (const board of candidates) {
        if (present.has(board.key) || (options.skipSeeded && seeded.has(board.key))) continue;
        if (present.size > 0 && options.onlyIntoEmpty?.includes(board.key)) continue;
        await insertBoard(ops, scope, board, { position: position++, actor: options.actor });
        present.add(board.key);
        inserted.push(board.key);
      }
      const next = [...new Set([...seeded, ...candidates.map(board => board.key)])];
      const unchanged = marker.seeded_boards !== null && next.length === marker.seeded_boards.length;
      if (inserted.length === 0 && unchanged) return inserted;
      // Compare-and-set on the version, and every marker write takes a new one: two replicas
      // recording different keys can't both match the version they read, so neither key is lost.
      const updated = await ops.updateMany(
        VERSIONS,
        { ...scopeWhere(scope), version: marker.version },
        {
          seeded_boards: next,
          version: randomUUID(),
          updated_at: new Date(),
        },
      );
      if (updated !== 1) throw new ConcurrentBoardWrite();
      return inserted;
    });
  }

  /**
   * Runs each migration the project hasn't had yet, once: the keys applied are recorded on the
   * project's version row in the same transaction as the board writes, and the compare-and-set on
   * its version makes a concurrent first load retry from fresh reads, where it finds them applied.
   * A migration whose board the project doesn't have is recorded without running, and the version
   * only changes when a board was rewritten. Reads one row
   * when every key was applied before. Returns what each migration that rewrote a board filled.
   */
  async applyBoardMigrations(
    scope: StoredBoardScope,
    migrations: readonly StoredBoardMigration[],
    /**
     * Read through the transaction's `ops`, again on every retry, and only when a migration is still
     * pending, so what it reports is as fresh as the boards the migrations rewrite.
     */
    context: (ops: FactoryStorageOps) => Promise<BoardMigrationContext> = async () => EMPTY_MIGRATION_CONTEXT,
  ): Promise<AppliedBoardMigration[]> {
    if (migrations.length === 0) return [];
    const marker = await this.ops.findOne<VersionRow>(VERSIONS, scopeWhere(scope));
    if (marker?.applied_migrations && migrations.every(({ key }) => marker.applied_migrations!.includes(key))) {
      return [];
    }
    await ensureVersionRow(this.ops, scope);
    return this.#transact(async ops => {
      const current = (await ops.findOne<VersionRow>(VERSIONS, scopeWhere(scope)))!;
      const applied = current.applied_migrations ?? [];
      const pending = migrations.filter(({ key }) => !applied.includes(key));
      if (pending.length === 0) return [];
      const project = await context(ops);
      const changed: AppliedBoardMigration[] = [];
      for (const migration of pending) {
        const rows =
          migration.boardKey === null
            ? await ops.findMany<BoardRow>(BOARDS, scopeWhere(scope))
            : await ops.findMany<BoardRow>(BOARDS, { ...scopeWhere(scope), board_key: migration.boardKey });
        for (const row of rows) {
          const phases = await ops.findMany<PhaseRow>(PHASES, { ...scopeWhere(scope), board_key: row.board_key });
          const result = migration.migrate(toRecord(row, phases), project);
          if (!result) continue;
          await writeBoard(ops, scope, row, { ...result.board, key: row.board_key }, MIGRATION_ACTOR);
          changed.push({ key: migration.key, boardKey: row.board_key, filled: result.filled });
        }
      }
      const updated = await ops.updateMany(
        VERSIONS,
        { ...scopeWhere(scope), version: current.version },
        {
          applied_migrations: [...applied, ...pending.map(({ key }) => key)],
          // Only a rewritten board is news to the other replicas' caches.
          version: changed.length > 0 ? randomUUID() : current.version,
          updated_at: new Date(),
        },
      );
      if (updated !== 1) throw new ConcurrentBoardWrite();
      return changed;
    });
  }

  /** Rewrites a board to `definition` (Factory's current one for its key), raising its revision. */
  async resetTo(
    scope: StoredBoardScope,
    key: string,
    definition: StoredBoardInput,
    options: { expectedRevision: number; actor: string },
  ): Promise<StoredBoardRecord> {
    await this.#write(scope, async ops => {
      const row = await findBoard(ops, scope, key);
      checkRevision(row, key, options.expectedRevision);
      await writeBoard(ops, scope, row, { ...definition, key }, options.actor);
      return { result: undefined, changed: true };
    });
    return (await this.get(scope, key))!;
  }

  /** Deletes a board and its phases. */
  async delete(scope: StoredBoardScope, key: string, options: { expectedRevision: number }): Promise<void> {
    await this.#write(scope, async ops => {
      const row = await findBoard(ops, scope, key);
      checkRevision(row, key, options.expectedRevision);
      if ((await ops.deleteMany(BOARDS, { id: row.id, revision: row.revision })) === 0)
        throw new ConcurrentBoardWrite();
      await ops.deleteMany(PHASES, { ...scopeWhere(scope), board_key: key });
      return { result: undefined, changed: true };
    });
  }

  /** The project's intake routes in the order they are tried; Factory's `DEFAULT_INTAKE_ROUTES` are added once each. */
  async listIntakeRoutes(scope: StoredBoardScope): Promise<StoredIntakeRouteRecord[]> {
    await this.#ensureIntakeRoutes(scope);
    return (await readIntakeRoutes(this.ops, scope)).map(toIntakeRouteRecord);
  }

  /** A route by id alone, whichever project it is in: a trigger's fire carries only the route's id. */
  async findIntakeRouteById(id: string): Promise<StoredIntakeRouteRecord | null> {
    const row = await this.ops.findOne<IntakeRouteRow>(INTAKE_ROUTES, { id });
    return row ? toIntakeRouteRecord(row) : null;
  }

  /** Every trigger route (a route with a trigger of its own) in every project, to arm their triggers at boot. */
  async listTriggerRoutes(): Promise<StoredIntakeRouteRecord[]> {
    const rows = await this.ops.findMany<IntakeRouteRow>(INTAKE_ROUTES, {});
    return rows.filter(row => Boolean(row.trigger_kind)).map(toIntakeRouteRecord);
  }

  async getIntakeRoute(scope: StoredBoardScope, id: string): Promise<StoredIntakeRouteRecord | null> {
    const row = await this.ops.findOne<IntakeRouteRow>(INTAKE_ROUTES, { ...scopeWhere(scope), id });
    return row ? toIntakeRouteRecord(row) : null;
  }

  /**
   * Adds a route after the project's last one. A route that places new cards goes just ahead of the
   * first route that takes every new card instead, since after it it would never place one.
   */
  async createIntakeRoute(
    scope: StoredBoardScope,
    input: StoredIntakeRouteInput,
    actor: string,
    options: {
      /**
       * A fixed id, for a route Factory writes itself (a migration): when a route with this id
       * already exists the call returns it and writes nothing, so a rerun, or a second replica
       * running the same migration, never adds it twice. The check runs inside the write's
       * transaction, and a replica that loses the insert race to the primary key retries
       * (`#transact`) and then finds the winner's row.
       */
      id?: string;
    } = {},
  ): Promise<StoredIntakeRouteRecord> {
    const id = options.id ?? randomUUID();
    const triggered = Boolean(input.triggered);
    checkRouteEvents(input.on ?? (triggered ? [] : DEFAULT_ROUTE_EVENTS), input.when ?? null, triggered);
    await this.#ensureIntakeRoutes(scope);
    let existing: IntakeRouteRow | null = null;
    await this.#transact(async ops => {
      if (options.id) {
        existing = await ops.findOne<IntakeRouteRow>(INTAKE_ROUTES, { id: options.id });
        if (existing) return;
      }
      const rows = await lockIntakeRoutes(ops, scope);
      if (rows.length >= MAX_INTAKE_ROUTES) {
        throw new StoredBoardError(
          'intake_route_limit',
          `A project can have at most ${MAX_INTAKE_ROUTES} intake routes; delete one first.`,
        );
      }
      const position = rows.reduce((max, row) => Math.max(max, row.position), -1) + 1;
      await insertIntakeRoute(ops, scope, { id, input, position, actor });
      const ahead =
        !triggered && (input.on ?? DEFAULT_ROUTE_EVENTS).includes('work_item.created')
          ? rows.findIndex(catchesEveryNewCard)
          : -1;
      if (ahead >= 0) {
        const added = (await readIntakeRoutes(ops, scope)).find(row => row.id === id)!;
        await placeIntakeRoutes(ops, rows.toSpliced(ahead, 0, added), actor);
      }
    });
    if (existing) return toIntakeRouteRecord(existing);
    return (await this.getIntakeRoute(scope, id))!;
  }

  /** Changes the fields `patch` names; the route keeps its place in the order. */
  async updateIntakeRoute(
    scope: StoredBoardScope,
    id: string,
    patch: Partial<StoredIntakeRouteInput>,
    options: { expectedRevision: number; actor: string },
  ): Promise<StoredIntakeRouteRecord> {
    await this.#transact(async ops => {
      const row = await findIntakeRoute(ops, scope, id);
      checkIntakeRouteRevision(row, options.expectedRevision);
      const triggered = patch.triggered !== undefined ? patch.triggered !== null : Boolean(row.trigger_kind);
      checkRouteEvents(
        patch.on ?? (triggered ? [] : row.trigger_kind ? DEFAULT_ROUTE_EVENTS : routeEvents(row)),
        patch.when !== undefined ? patch.when : row.when_condition,
        triggered,
      );
      await updateIntakeRouteRow(ops, row, {
        ...triggerColumns(patch.triggered),
        ...(patch.origin !== undefined && { origin: patch.origin }),
        ...(patch.on !== undefined && { on_events: patch.on }),
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.enabled !== undefined && { enabled: patch.enabled }),
        ...(patch.when !== undefined && { when_condition: patch.when }),
        ...(patch.target !== undefined && {
          board_key: patch.target.boardKey,
          phase_key: patch.target.phaseKey ?? null,
          join_closed_issue: patch.target.joinClosedIssue ?? false,
        }),
        updated_by: options.actor,
      });
    });
    return (await this.getIntakeRoute(scope, id))!;
  }

  /** Deletes a route; the routes after it move up one place. */
  async deleteIntakeRoute(scope: StoredBoardScope, id: string, options: { expectedRevision: number }): Promise<void> {
    await this.#ensureIntakeRoutes(scope);
    await this.#transact(async ops => {
      const rows = await lockIntakeRoutes(ops, scope);
      const row = rows.find(route => route.id === id);
      if (!row) throw intakeRouteNotFound(id);
      checkIntakeRouteRevision(row, options.expectedRevision);
      if ((await ops.deleteMany(INTAKE_ROUTES, { id: row.id, revision: row.revision })) === 0) {
        throw new ConcurrentBoardWrite();
      }
      await placeIntakeRoutes(
        ops,
        rows.filter(route => route.id !== row.id),
      );
    });
  }

  /**
   * The Review board was retired, so a route that files cards on it now files them on Work: its
   * Reviewing phase becomes Work's PR review, and any other phase (Intake, Done, Canceled, or the
   * initial phase) keeps its name. Runs across every project, once; returns the routes moved.
   */
  async moveReviewBoardRoutesToWork(actor: string): Promise<number> {
    const rows = await this.ops.findMany<IntakeRouteRow>(INTAKE_ROUTES, { board_key: 'review' });
    for (const row of rows) {
      await this.#transact(async ops => {
        const current = await ops.findOne<IntakeRouteRow>(INTAKE_ROUTES, { id: row.id });
        if (!current || current.board_key !== 'review') return;
        await updateIntakeRouteRow(ops, current, {
          board_key: 'work',
          phase_key: current.phase_key === 'review' ? 'pr-review' : current.phase_key,
          updated_by: actor,
        });
      });
    }
    return rows.length;
  }

  /**
   * A code board renamed or added phases: every project's stored copy of board `key` that still
   * names one of the old phases (`renames`' keys) is rewritten to `definition`, Factory's current
   * one, once. What a Factory set per phase carries over to the phase it became (a renamed one) or
   * kept its key: runner instructions, start rules, and plan approval rules. Intake routes that
   * file cards into an old phase move to the new one. Returns the boards rewritten.
   */
  async renameStoredBoardPhases(
    key: string,
    definition: StoredBoardInput,
    renames: Readonly<Record<string, string>>,
    actor: string,
  ): Promise<number> {
    const oldNames = Object.keys(renames);
    const rows = await this.ops.findMany<BoardRow>(BOARDS, { board_key: key });
    let rewritten = 0;
    for (const row of rows) {
      const scope = { orgId: row.org_id, factoryProjectId: row.factory_project_id };
      const changed = await this.#write(scope, async ops => {
        const current = await ops.findOne<BoardRow>(BOARDS, { id: row.id });
        if (!current) return { result: false, changed: false };
        const phases = await ops.findMany<PhaseRow>(PHASES, { ...scopeWhere(scope), board_key: key });
        if (!phases.some(phase => oldNames.includes(phase.phase_key))) return { result: false, changed: false };
        const byNewKey = new Map(phases.map(phase => [renames[phase.phase_key] ?? phase.phase_key, phase]));
        const upgraded: StoredBoardInput = {
          ...definition,
          key,
          phases: definition.phases.map(phase => {
            const previous = byNewKey.get(phase.key);
            if (!previous || previous.kind !== phase.kind) return phase;
            const instructions = previous.runner?.instructions;
            return {
              ...phase,
              ...(phase.kind === 'working' && instructions ? { runner: { ...(phase.runner ?? {}), instructions } } : {}),
              ...(previous.auto_start ? { autoStart: true } : {}),
              ...(previous.auto_start_when ? { autoStartWhen: previous.auto_start_when } : {}),
              ...(phase.exitTool && previous.exit_tool?.id === phase.exitTool.id
                ? { exitTool: { ...phase.exitTool, ...previous.exit_tool } }
                : {}),
            };
          }),
        };
        await writeBoard(ops, scope, current, upgraded, actor);
        const routes = await ops.findMany<IntakeRouteRow>(INTAKE_ROUTES, { ...scopeWhere(scope), board_key: key });
        for (const route of routes) {
          const renamed = route.phase_key ? renames[route.phase_key] : undefined;
          if (renamed) await updateIntakeRouteRow(ops, route, { phase_key: renamed, updated_by: actor });
        }
        return { result: true, changed: true };
      });
      if (changed) rewritten++;
    }
    return rewritten;
  }

  /** Puts the project's routes in the order of `ids`, which must name every route exactly once. */
  async reorderIntakeRoutes(scope: StoredBoardScope, ids: string[], actor: string): Promise<StoredIntakeRouteRecord[]> {
    await this.#ensureIntakeRoutes(scope);
    await this.#transact(async ops => {
      const rows = await lockIntakeRoutes(ops, scope);
      const byId = new Map(rows.map(row => [row.id, row]));
      if (ids.length !== rows.length || new Set(ids).size !== ids.length || ids.some(id => !byId.has(id))) {
        throw new StoredBoardError(
          'intake_route_set_mismatch',
          'The order must list every intake route of the project exactly once; reload the routes and try again.',
        );
      }
      await placeIntakeRoutes(
        ops,
        ids.map(id => byId.get(id)!),
        actor,
      );
    });
    return this.listIntakeRoutes(scope);
  }

  /**
   * Creates the project's route lock row (see `FACTORY_INTAKE_ROUTE_LOCKS_SCHEMA`) and adds each of
   * `DEFAULT_INTAKE_ROUTES` the row doesn't list as added yet, after the project's routes. The row
   * records every default it added, so a project whose admin deleted one doesn't get it back. Runs
   * before, never inside, a write's transaction: the lock taken there must always be an update.
   */
  async #ensureIntakeRoutes(scope: StoredBoardScope): Promise<void> {
    const lock = await this.ops.findOne<IntakeRouteLockRow>(INTAKE_ROUTE_LOCKS, scopeWhere(scope));
    if (lock && missingDefaults(lock).length === 0) return;
    await this.#transact(async ops => {
      if (await ops.findOne(INTAKE_ROUTE_LOCKS, scopeWhere(scope))) await lockIntakeRoutes(ops, scope);
      // A racing first read inserted the lock row first: this one fails on the unique index and
      // retries, taking the lock above.
      else
        await ops.insertOne(INTAKE_ROUTE_LOCKS, { ...scopeWhere(scope), locked_at: new Date(), seeded_defaults: [] });
      // Read under the lock: a racing seeder that committed first already added what it listed.
      const current = (await ops.findOne<IntakeRouteLockRow>(INTAKE_ROUTE_LOCKS, scopeWhere(scope)))!;
      const missing = missingDefaults(current);
      if (missing.length === 0) return;
      const rows = await readIntakeRoutes(ops, scope);
      let position = rows.reduce((max, row) => Math.max(max, row.position), -1) + 1;
      const first: string[] = [];
      for (const { route, first: leads } of missing) {
        // A project at the limit keeps its own routes; the default counts as added all the same.
        if (position >= MAX_INTAKE_ROUTES) break;
        const id = randomUUID();
        await insertIntakeRoute(ops, scope, {
          id,
          input: route,
          position: position++,
          actor: DEFAULT_INTAKE_ROUTE_ACTOR,
        });
        if (leads) first.push(id);
      }
      // A project that had routes before gets a leading default ahead of them.
      if (first.length > 0 && rows.length > 0) {
        const placed = await readIntakeRoutes(ops, scope);
        const leading = new Set(first);
        await placeIntakeRoutes(ops, [
          ...first.map(id => placed.find(row => row.id === id)!),
          ...placed.filter(row => !leading.has(row.id)),
        ]);
      }
      await ops.updateMany(INTAKE_ROUTE_LOCKS, scopeWhere(scope), {
        seeded_defaults: [...seededDefaults(current), ...missing.map(({ key }) => key)],
      });
    });
  }

  /**
   * Runs `fn` in a transaction and replaces the project's version when it changed anything.
   * Lost races (a compare-and-set miss, or a concurrent write that inserted the same board or the
   * project's first version row) retry from fresh reads.
   */
  async #write<T>(
    scope: StoredBoardScope,
    fn: (ops: FactoryStorageOps) => Promise<{ result: T; changed: boolean }>,
  ): Promise<T> {
    return this.#transact(async ops => {
      const { result, changed } = await fn(ops);
      if (changed) await bumpVersion(ops, scope);
      return result;
    });
  }

  /**
   * Runs `fn` in a transaction, retrying lost races from fresh reads. Intake route writes use it
   * directly: routes are read uncached, so they leave the board definition version alone.
   */
  async #transact<T>(fn: (ops: FactoryStorageOps) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        // Read committed is enough: every row change is a compare-and-set on `revision` and every
        // insert meets the unique index. Serializable isolation would also fail writes to
        // unrelated projects that replicas run side by side.
        return await this.storage.withTransaction(fn);
      } catch (error) {
        const retryable = error instanceof ConcurrentBoardWrite || error instanceof UniqueViolationError;
        if (!retryable || attempt >= MAX_WRITE_ATTEMPTS) throw error;
      }
    }
  }
}

async function readVersion(ops: FactoryStorageOps, scope: StoredBoardScope): Promise<string | null> {
  const row = await ops.findOne<{ version: string }>(VERSIONS, scopeWhere(scope));
  return row?.version ?? null;
}

async function readBoards(ops: FactoryStorageOps, scope: StoredBoardScope): Promise<StoredBoardRecord[]> {
  const [rows, phases] = await Promise.all([
    ops.findMany<BoardRow>(BOARDS, scopeWhere(scope)),
    ops.findMany<PhaseRow>(PHASES, scopeWhere(scope)),
  ]);
  const byBoard = new Map<string, PhaseRow[]>();
  for (const phase of phases) {
    const list = byBoard.get(phase.board_key) ?? [];
    list.push(phase);
    byBoard.set(phase.board_key, list);
  }
  return rows
    .sort((left, right) => left.position - right.position || left.board_key.localeCompare(right.board_key))
    .map(row => toRecord(row, byBoard.get(row.board_key) ?? []));
}

/**
 * Inserts the project's version row if it has none. This runs outside the write transaction: on
 * Postgres, two transactions racing to insert it would leave the loser's transaction aborted, so
 * the version bump inside a write must always be an update.
 */
async function ensureVersionRow(ops: FactoryStorageOps, scope: StoredBoardScope): Promise<void> {
  if (await ops.findOne(VERSIONS, scopeWhere(scope))) return;
  try {
    await ops.insertOne(VERSIONS, { ...scopeWhere(scope), version: randomUUID(), updated_at: new Date() });
  } catch (error) {
    if (!(error instanceof UniqueViolationError)) throw error;
  }
}

async function bumpVersion(ops: FactoryStorageOps, scope: StoredBoardScope): Promise<void> {
  await ops.upsertOne(VERSIONS, ['org_id', 'factory_project_id'], {
    ...scopeWhere(scope),
    version: randomUUID(),
    updated_at: new Date(),
  });
}

async function findBoard(ops: FactoryStorageOps, scope: StoredBoardScope, key: string): Promise<BoardRow> {
  const row = await ops.findOne<BoardRow>(BOARDS, { ...scopeWhere(scope), board_key: key });
  if (!row) {
    throw new StoredBoardError('board_not_found', `Board "${key}" does not exist in this project.`);
  }
  return row;
}

function checkRevision(row: BoardRow, key: string, expectedRevision: number): void {
  if (row.revision !== expectedRevision) {
    throw new StoredBoardError(
      'revision_mismatch',
      `Board "${key}" is at revision ${row.revision}, not ${expectedRevision}; reload it and try again.`,
    );
  }
}

function nextPosition(rows: BoardRow[]): number {
  return rows.reduce((max, row) => Math.max(max, row.position), -1) + 1;
}

/** Sets columns on a board row and raises its revision, unless another writer changed it first. */
async function updateRow(ops: FactoryStorageOps, row: BoardRow, set: Partial<BoardRow>): Promise<void> {
  const updated = await ops.updateMany(
    BOARDS,
    { id: row.id, revision: row.revision },
    { ...set, revision: row.revision + 1, updated_at: new Date() },
  );
  if (updated !== 1) throw new ConcurrentBoardWrite();
}

async function insertPhases(ops: FactoryStorageOps, scope: StoredBoardScope, input: StoredBoardInput): Promise<void> {
  for (const [position, phase] of input.phases.entries()) {
    await ops.insertOne<PhaseRow>(PHASES, {
      ...scopeWhere(scope),
      board_key: input.key,
      phase_key: phase.key,
      position,
      name: phase.name,
      description: phase.description ?? null,
      kind: phase.kind,
      runner: phase.runner ?? null,
      next_phases: phase.nextPhases ?? null,
      auto_start: phase.autoStart ?? false,
      auto_start_when: phase.autoStartWhen ?? null,
      exit_tool: phase.exitTool ?? null,
      tools: phase.tools?.length ? phase.tools : null,
    });
  }
}

async function insertBoard(
  ops: FactoryStorageOps,
  scope: StoredBoardScope,
  input: StoredBoardInput,
  options: { position: number; actor: string },
): Promise<void> {
  const now = new Date();
  await ops.insertOne<BoardRow>(BOARDS, {
    ...scopeWhere(scope),
    board_key: input.key,
    name: input.name,
    description: input.description ?? null,
    position: options.position,
    revision: 1,
    created_by: options.actor,
    created_at: now,
    updated_by: options.actor,
    updated_at: now,
  });
  await insertPhases(ops, scope, input);
}

/** Replaces a board's definition and phases in place, keeping its key, position and history. */
async function writeBoard(
  ops: FactoryStorageOps,
  scope: StoredBoardScope,
  row: BoardRow,
  input: StoredBoardInput,
  actor: string,
): Promise<void> {
  await updateRow(ops, row, { name: input.name, description: input.description ?? null, updated_by: actor });
  await ops.deleteMany(PHASES, { ...scopeWhere(scope), board_key: row.board_key });
  await insertPhases(ops, scope, { ...input, key: row.board_key });
}

function routeEvents(row: IntakeRouteRow): StatusEvent[] {
  if (row.trigger_kind) return [];
  return row.on_events ?? [...DEFAULT_ROUTE_EVENTS];
}

function jsonObject(value: Record<string, unknown> | string | null | undefined): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  return typeof value === 'string' ? (JSON.parse(value) as Record<string, unknown>) : value;
}

function parseOrigin(value: IntakeRouteOrigin | string | null | undefined): IntakeRouteOrigin | null {
  if (value === null || value === undefined) return null;
  const origin = (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
  if (typeof origin.generatedName !== 'string') return null;
  if (origin.kind === 'clickup-status' && typeof origin.listId === 'string' && typeof origin.status === 'string') {
    return { kind: 'clickup-status', listId: origin.listId, status: origin.status, generatedName: origin.generatedName };
  }
  if (origin.kind === 'schedule') return { kind: 'schedule', generatedName: origin.generatedName };
  if (origin.kind === 'repository' && typeof origin.integrationId === 'string' && typeof origin.repository === 'string') {
    return {
      kind: 'repository',
      integrationId: origin.integrationId,
      repository: origin.repository,
      generatedName: origin.generatedName,
    };
  }
  return null;
}

/**
 * A route waiting for arriving cards names the events it handles; a trigger route handles none
 * (its own trigger makes its cards) and must not name any, nor a condition: nothing arrives to test.
 */
function checkRouteEvents(on: readonly string[], when: RuleGroup | null, triggered = false): void {
  if (triggered) {
    if (on.length > 0) {
      throw new StoredBoardError('invalid_intake_route', 'A route with a trigger of its own handles no status events.');
    }
    if (when) throw new StoredBoardError('invalid_intake_route', 'A route with a trigger of its own takes no condition.');
    return;
  }
  const problem = routeEventsProblem(on, when);
  if (problem) throw new StoredBoardError('invalid_intake_route', problem);
}

function triggerColumns(triggered: IntakeRouteTrigger | null | undefined): Partial<IntakeRouteRow> {
  if (triggered === undefined) return {};
  if (triggered === null) {
    return { trigger_kind: null, trigger_config: null, action_kind: null, action_config: null, policy_kind: null };
  }
  return {
    trigger_kind: triggered.trigger.kind,
    trigger_config: triggered.trigger.config,
    action_kind: triggered.action.kind,
    action_config: triggered.action.config,
    policy_kind: triggered.policyKind,
    // A trigger route handles no events.
    on_events: [],
  };
}

function toIntakeRouteRecord(row: IntakeRouteRow): StoredIntakeRouteRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    factoryProjectId: row.factory_project_id,
    name: row.name,
    enabled: row.enabled,
    position: row.position,
    when: row.when_condition,
    target: { boardKey: row.board_key, phaseKey: row.phase_key, joinClosedIssue: row.join_closed_issue === true },
    on: routeEvents(row),
    trigger: row.trigger_kind ? { kind: row.trigger_kind, config: jsonObject(row.trigger_config) } : null,
    action: row.trigger_kind && row.action_kind ? { kind: row.action_kind, config: jsonObject(row.action_config) } : null,
    policyKind: row.trigger_kind ? (row.policy_kind ?? null) : null,
    origin: parseOrigin(row.origin),
    revision: row.revision,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

/** Whether `row` places every new card that reaches it, as the seeded "Everything else" route does. */
function catchesEveryNewCard(row: IntakeRouteRow): boolean {
  return (
    row.enabled &&
    row.when_condition === null &&
    (row.on_events ?? DEFAULT_ROUTE_EVENTS).includes('work_item.created') &&
    !row.join_closed_issue
  );
}

async function readIntakeRoutes(ops: FactoryStorageOps, scope: StoredBoardScope): Promise<IntakeRouteRow[]> {
  const rows = await ops.findMany<IntakeRouteRow>(INTAKE_ROUTES, scopeWhere(scope));
  return rows.sort((left, right) => left.position - right.position);
}

async function findIntakeRoute(ops: FactoryStorageOps, scope: StoredBoardScope, id: string): Promise<IntakeRouteRow> {
  const row = await ops.findOne<IntakeRouteRow>(INTAKE_ROUTES, { ...scopeWhere(scope), id });
  if (!row) throw intakeRouteNotFound(id);
  return row;
}

function intakeRouteNotFound(id: string): StoredBoardError {
  return new StoredBoardError('intake_route_not_found', `Intake route "${id}" does not exist in this project.`);
}

function checkIntakeRouteRevision(row: IntakeRouteRow, expectedRevision: number): void {
  if (row.revision !== expectedRevision) {
    throw new StoredBoardError(
      'revision_mismatch',
      `Intake route "${row.name}" is at revision ${row.revision}, not ${expectedRevision}; reload it and try again.`,
    );
  }
}

/** Sets columns on a route row and raises its revision, unless another writer changed it first. */
async function updateIntakeRouteRow(
  ops: FactoryStorageOps,
  row: IntakeRouteRow,
  set: Partial<IntakeRouteRow>,
): Promise<number> {
  const revision = row.revision + 1;
  const updated = await ops.updateMany(
    INTAKE_ROUTES,
    { id: row.id, revision: row.revision },
    { ...set, revision, updated_at: new Date() },
  );
  if (updated !== 1) throw new ConcurrentBoardWrite();
  return revision;
}

async function insertIntakeRoute(
  ops: FactoryStorageOps,
  scope: StoredBoardScope,
  route: { id: string; input: StoredIntakeRouteInput; position: number; actor: string },
): Promise<void> {
  const now = new Date();
  await ops.insertOne<IntakeRouteRow>(INTAKE_ROUTES, {
    id: route.id,
    ...scopeWhere(scope),
    name: route.input.name,
    enabled: route.input.enabled ?? true,
    position: route.position,
    when_condition: route.input.when ?? null,
    board_key: route.input.target.boardKey,
    phase_key: route.input.target.phaseKey ?? null,
    on_events: route.input.on ?? null,
    join_closed_issue: route.input.target.joinClosedIssue ?? false,
    ...triggerColumns(route.input.triggered),
    origin: route.input.origin ?? null,
    revision: 1,
    created_by: route.actor,
    created_at: now,
    updated_by: route.actor,
    updated_at: now,
  });
}

/**
 * Takes the project's route lock and reads the routes. Writes that add, delete or move routes
 * call this first, so they run one after another and each reads what the one before committed.
 */
async function lockIntakeRoutes(ops: FactoryStorageOps, scope: StoredBoardScope): Promise<IntakeRouteRow[]> {
  if ((await ops.updateMany(INTAKE_ROUTE_LOCKS, scopeWhere(scope), { locked_at: new Date() })) !== 1) {
    throw new ConcurrentBoardWrite();
  }
  return readIntakeRoutes(ops, scope);
}

/** Moves routes, read under the project's route lock, to the positions of their order in `rows`. */
async function placeIntakeRoutes(ops: FactoryStorageOps, rows: IntakeRouteRow[], actor?: string): Promise<void> {
  const moving = rows.flatMap((row, position) => (row.position === position ? [] : [{ row, position }]));
  const parked = [];
  for (const [index, { row, position }] of moving.entries()) {
    const revision = await updateIntakeRouteRow(ops, row, {
      position: -(index + 1),
      ...(actor !== undefined && { updated_by: actor }),
    });
    parked.push({ id: row.id, revision, position });
  }
  for (const { id, revision, position } of parked) {
    if ((await ops.updateMany(INTAKE_ROUTES, { id, revision }, { position })) !== 1) throw new ConcurrentBoardWrite();
  }
}
