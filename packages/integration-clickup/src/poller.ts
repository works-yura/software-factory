import {
  cardRuleFacts,
  evaluateRuleGroup,
  INTAKE_ROUTE_METADATA_KEY,
  placesNewCards,
  resolveBoardClosure,
  resolveEventRoute,
  resolveIntakePlacement,
} from '@factory/core';
import type {
  BoardRegistry,
  ExternalWorkItemSource,
  InstalledBoard,
  IntakeRoute,
  IntakeRoutesReader,
  RuleFacts,
} from '@factory/core';
import type { IssueReconcileSummary } from '@factory/integrations';
import type { FactoryProject, FactoryProjectsStorage, IntakeStorage, WorkItemRow, WorkItemsStorage } from '@factory/store';
import { arrivalSourceFacts } from '@factory/store';

import type { ClickUpTask, ClickUpTaskSource } from './api.ts';
import { isClosedTask } from './intake.ts';
import { routeNamesList } from './status-routes.ts';

export const CLICKUP_INTEGRATION_ID = 'clickup';

const DAY_MS = 24 * 60 * 60_000;
const DESCRIPTION_LIMIT = 8_000;
const ACTOR = { type: 'system', id: 'clickup-poller' } as const;
const USER_ID = 'clickup-poller';
const normalizeIdentity = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, '-');

export interface ClickUpPollerOptions {
  client: ClickUpTaskSource;
  intake: Pick<IntakeStorage, 'getConfig' | 'listBindings'>;
  projects: Pick<FactoryProjectsStorage, 'listAll'>;
  workItems: Pick<WorkItemsStorage, 'getByProjectSource' | 'commitRuleEvaluation' | 'update'>;
  boards: Pick<BoardRegistry, 'get'>;
  /**
   * The project's intake routes, which decide everything about a List's tasks: a route naming the
   * List (`source.list`) imports a new task; the first route with a condition that matches places
   * it; a route on `work_item.state_changed` moves the card when the task's status changes.
   */
  intakeRoutes: IntakeRoutesReader;
  /** A project's boards, stored ones included, which an intake route may name. Defaults to `boards`. */
  projectBoards?: { load(scope: { orgId: string; factoryProjectId: string }): Promise<BoardRegistry> };
  /** Runs once per organization before each sweep: moves the retired per-List status rules into routes. */
  beforeSweep?: (orgId: string) => Promise<void>;
  configVersion: string;
  /** How far back the first sweep looks for tasks. */
  lookbackDays?: number;
  now?: () => Date;
}

type Outcome = 'created' | 'refreshed' | 'moved' | 'closed' | 'unchanged';

function taskMetadata(task: ClickUpTask, listId: string): Record<string, string | string[] | boolean> {
  return {
    identifier: task.id,
    listId,
    description: task.description.slice(0, DESCRIPTION_LIMIT),
    state: task.status.name,
    stateType: task.status.type,
    labels: task.tags,
    assignees: task.assignees,
    ...(task.creator ? { author: task.creator } : {}),
    sourceCreatedAt: task.createdAt,
    updatedAt: task.updatedAt,
    // Nobody vouched for a ClickUp author the way repository membership does for GitHub.
    authorTrusted: false,
  };
}

function sameMetadata(current: Record<string, unknown> | null, desired: Record<string, unknown>): boolean {
  return Object.entries(desired).every(([key, value]) => JSON.stringify(current?.[key]) === JSON.stringify(value));
}

/**
 * One sweep over the Lists selected in Settings › Intake. A new task becomes a card on the board
 * its tag or its List is routed to (through the same rule decision a webhook would commit, so
 * replays never duplicate); a known card follows the task's fields; a closed task moves its card
 * where the board's `sourceClosed` says. Matches the shape `IssueReconcileWorker` runs.
 */
export function createClickUpPoller(options: ClickUpPollerOptions): () => Promise<IssueReconcileSummary> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const lookbackMs = (options.lookbackDays ?? 7) * DAY_MS;
  const cursors = new Map<string, Date>();

  /** Moves an unfinished card into a terminal phase: the board's own close, or a route's target. */
  const finishCard = async (
    project: FactoryProject,
    item: WorkItemRow,
    task: ClickUpTask,
    target: { phase: string; title: string; boardTitle: string } | undefined,
  ): Promise<Outcome> => {
    const board = item.board ? options.boards.get(item.board) : undefined;
    if (!target || !board || item.stages.some(stage => board.isTerminal(stage))) return 'unchanged';
    const identity = `clickup:task:${task.id}:closed:${task.updatedAt}`;
    const result = await options.workItems.commitRuleEvaluation({
      orgId: project.orgId,
      factoryProjectId: project.id,
      workItemId: item.id,
      ingress: { identity, triggerType: 'clickup.task.closed' },
      configVersion: options.configVersion,
      expectedRevision: item.revision,
      actor: ACTOR,
      outcome: { status: 'accepted' },
      decisions: [
        {
          type: 'transition',
          idempotencyKey: `${identity}:transition`,
          board: item.board,
          stage: target.phase,
          message: {
            text: `ClickUp task ${task.id} was closed; this ${target.boardTitle} card was moved to ${target.title}.`,
          },
        },
      ],
      causalChain: [],
      now: now(),
    });
    if (result.status === 'stale') throw new Error(`Card ${item.id} changed while closing; retrying next sweep.`);
    return 'closed';
  };

  const closeCard = (project: FactoryProject, item: WorkItemRow, task: ClickUpTask): Promise<Outcome> => {
    const closure = resolveBoardClosure(options.boards, item);
    return finishCard(
      project,
      item,
      task,
      closure && { phase: closure.completed.phase, title: closure.completed.title, boardTitle: closure.boardTitle },
    );
  };

  /**
   * Where a status change takes an existing card: the first enabled route on its board that handles
   * `work_item.state_changed` and whose condition matches the task with that status.
   */
  const stateRoute = (routes: readonly IntakeRoute[], board: InstalledBoard, facts: RuleFacts) =>
    resolveEventRoute(routes, { type: 'work_item.state_changed' }, facts, board);

  const moveCard = async (
    project: FactoryProject,
    item: WorkItemRow,
    task: ClickUpTask,
    phase: string,
    routes: readonly IntakeRoute[],
    board: InstalledBoard,
    facts: RuleFacts,
  ): Promise<boolean> => {
    if (!(phase in board.phases) || item.stages.includes(phase)) return false;
    const state = item.workItem.metadata?.state;
    const previous = typeof state === 'string' ? state : undefined;
    // Only a status change we have not filed yet moves a card, and only while the card is still
    // where the previous status put it: a person or an agent that moved it owns it from then on.
    if (previous === undefined || previous === task.status.name) return false;
    const before = stateRoute(routes, board, { ...facts, 'item.state': previous });
    const placed = before && !board.isTerminal(before.phase) ? before.phase : board.initialPhase;
    if (!item.stages.includes(placed)) return false;
    const identity = `clickup:task:${task.id}:status:${normalizeIdentity(task.status.name)}:${task.updatedAt}`;
    const result = await options.workItems.commitRuleEvaluation({
      orgId: project.orgId,
      factoryProjectId: project.id,
      workItemId: item.id,
      ingress: { identity, triggerType: 'clickup.task.status' },
      configVersion: options.configVersion,
      expectedRevision: item.revision,
      actor: ACTOR,
      outcome: { status: 'accepted' },
      decisions: [
        {
          type: 'transition',
          idempotencyKey: `${identity}:transition`,
          board: item.board,
          stage: phase,
          message: { text: `ClickUp status changed to "${task.status.name}"; moved to ${phase}.` },
        },
      ],
      causalChain: [],
      now: now(),
    });
    if (result.status === 'stale') throw new Error(`Card ${item.id} changed while moving; retrying next sweep.`);
    return true;
  };

  const taskFacts = (task: ClickUpTask, source: ExternalWorkItemSource, metadata: Record<string, unknown>) => {
    const workItem = arrivalSourceFacts(source, metadata);
    return cardRuleFacts({
      title: task.name || `ClickUp task ${task.id}`,
      metadata,
      externalSource: source,
      ...(workItem ? { workItem } : {}),
    });
  };

  const fileTask = async (project: FactoryProject, listId: string, task: ClickUpTask): Promise<Outcome> => {
    const source = { integrationId: CLICKUP_INTEGRATION_ID, type: 'task', externalId: task.id, url: task.url };
    const scope = { orgId: project.orgId, factoryProjectId: project.id };
    const existing = await options.workItems.getByProjectSource({ ...scope, source });
    const routes = await options.intakeRoutes.listIntakeRoutes(scope);
    const metadata = taskMetadata(task, listId);
    const facts = taskFacts(task, source, metadata);
    if (existing) {
      if (isClosedTask(task)) return closeCard(project, existing, task);
      const board = existing.board ? (options.boards.get(existing.board) as InstalledBoard | undefined) : undefined;
      const routed = board ? stateRoute(routes, board, facts) : undefined;
      let moved = false;
      if (board && routed) {
        if (board.isTerminal(routed.phase)) {
          return finishCard(project, existing, task, {
            phase: routed.phase,
            title: board.phases[routed.phase]?.name ?? routed.phase,
            boardTitle: board.name,
          });
        }
        moved = await moveCard(project, existing, task, routed.phase, routes, board, facts);
      }
      // Provider facts live on the work item, Factory's stamps on the board item; compare both.
      const current = { ...existing.workItem.metadata, ...existing.metadata };
      if (sameMetadata(current, metadata)) return moved ? 'moved' : 'unchanged';
      await options.workItems.update({
        orgId: project.orgId,
        id: existing.id,
        userId: USER_ID,
        patch: { metadata: { ...current, ...metadata } },
      });
      return moved ? 'moved' : 'refreshed';
    }
    if (isClosedTask(task)) return 'unchanged';
    // A route naming the task's List decides whether it is imported at all (what the List's status
    // rules used to); the first route with a condition that matches decides where it lands.
    const imported = routes.some(
      route =>
        route.enabled && placesNewCards(route) && routeNamesList(route.when) && evaluateRuleGroup(route.when, facts),
    );
    if (!imported) return 'unchanged';
    const registry = options.projectBoards ? await options.projectBoards.load(scope) : (options.boards as BoardRegistry);
    const placement = resolveIntakePlacement(routes, facts, registry, { skipCatchAll: true });
    if (!placement) {
      throw new Error(`No intake route can take ClickUp task ${task.id}: check the target board and phase of its route.`);
    }
    // Tasks that already existed when the server started never start work on their own: the first
    // sweep would otherwise launch an agent for every open task in the List.
    const fresh = Date.parse(task.createdAt) > startedAt.getTime();
    const stage = fresh ? placement.phase : registry.get(placement.board)!.initialPhase;
    const identity = `clickup:task:${task.id}:created`;
    await options.workItems.commitRuleEvaluation({
      orgId: project.orgId,
      factoryProjectId: project.id,
      workItemId: null,
      ingress: { identity, triggerType: 'clickup.task.created' },
      configVersion: options.configVersion,
      expectedRevision: null,
      actor: ACTOR,
      outcome: { status: 'accepted' },
      decisions: [
        {
          type: 'upsertLinkedWorkItem',
          idempotencyKey: `${identity}:intake`,
          board: placement.board,
          source: 'clickup-task',
          sourceKey: task.id,
          title: task.name || `ClickUp task ${task.id}`,
          url: task.url || null,
          stage,
          // The poller applied the routes itself: the dispatcher keeps this placement.
          routesApplied: true,
          metadata: { ...metadata, [INTAKE_ROUTE_METADATA_KEY]: placement.routeId },
        },
      ],
      causalChain: [],
      now: now(),
    });
    return 'created';
  };

  return async () => {
    const summary: IssueReconcileSummary = {
      projects: 0,
      checked: 0,
      updated: 0,
      closed: 0,
      missing: 0,
      failed: 0,
      errors: [],
    };
    const projects = await options.projects.listAll();
    const projectsById = new Map(projects.map(project => [project.id, project]));
    const touched = new Set<string>();

    for (const orgId of new Set(projects.map(project => project.orgId))) {
      const selection = (await options.intake.getConfig({ orgId, integrationIds: [CLICKUP_INTEGRATION_ID] }))[
        CLICKUP_INTEGRATION_ID
      ];
      if (!selection?.enabled || !selection.sourceIds?.length) continue;
      await options.beforeSweep?.(orgId);
      const bindings = await options.intake.listBindings({ orgId, integrationId: CLICKUP_INTEGRATION_ID });

      for (const listId of selection.sourceIds) {
        const binding = bindings.find(candidate => candidate.sourceId === listId);
        const project = binding ? projectsById.get(binding.factoryProjectId) : undefined;
        // A List must belong to a Factory before its tasks mean anything; that Factory's intake
        // routes decide which tasks it imports and where they go.
        if (!binding || !project || project.orgId !== orgId) continue;
        touched.add(project.id);

        const cursorKey = `${orgId}:${listId}`;
        const since = cursors.get(cursorKey) ?? new Date(startedAt.getTime() - lookbackMs);
        let newest = since;
        let failed = false;
        try {
          const tasks = await options.client.listTasks({ listId, updatedAfter: since, includeClosed: true });
          for (const task of tasks) {
            summary.checked += 1;
            try {
              const outcome = await fileTask(project, listId, task);
              if (outcome === 'closed') summary.closed += 1;
              else if (outcome !== 'unchanged') summary.updated += 1;
              const updated = new Date(task.updatedAt);
              if (updated > newest) newest = updated;
            } catch (error) {
              failed = true;
              summary.failed += 1;
              summary.errors.push({
                projectId: project.id,
                workItemId: task.id,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        } catch (error) {
          failed = true;
          summary.failed += 1;
          summary.errors.push({ projectId: project.id, error: error instanceof Error ? error.message : String(error) });
        }
        // A failed task keeps the window open, so the next sweep retries it.
        if (!failed) cursors.set(cursorKey, newest);
      }
    }
    summary.projects = touched.size;
    return summary;
  };
}
