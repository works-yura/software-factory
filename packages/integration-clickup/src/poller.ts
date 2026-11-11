import { cardRuleFacts, intakeTarget, resolveBoardClosure, resolveEventRoute, routeSubscribesSource } from '@factory/core';
import type { BoardRegistry, ExternalWorkItemSource, IntakeRoute, IntakeRoutesReader, RuleFacts } from '@factory/core';
import type { IssueReconcileSummary } from '@factory/integrations';
import type { FactoryProject, FactoryProjectsStorage, IntakeStorage, WorkItemRow, WorkItemsStorage } from '@factory/store';
import { arrivalSourceFacts } from '@factory/store';

import type { ClickUpTask, ClickUpTaskSource } from './api.ts';
import { isClosedTask } from './intake.ts';
import { CLICKUP_INTEGRATION_ID, routedClickUpLists } from './lists.ts';

export { CLICKUP_INTEGRATION_ID } from './lists.ts';

const DAY_MS = 24 * 60 * 60_000;
const DESCRIPTION_LIMIT = 8_000;
const ACTOR = { type: 'system', id: 'clickup-poller' } as const;
const USER_ID = 'clickup-poller';
const normalizeIdentity = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, '-');

export interface ClickUpPollerOptions {
  client: ClickUpTaskSource;
  intake: Pick<IntakeStorage, 'getConfig'>;
  projects: Pick<FactoryProjectsStorage, 'listAll'>;
  workItems: Pick<WorkItemsStorage, 'getByProjectSource' | 'commitRuleEvaluation' | 'update'>;
  /**
   * The project's intake routes, which decide everything about a List's tasks: a route naming the
   * List (`source.list`) is what makes the project read it and import a new task; the first route
   * that matches places it; a route on `work_item.state_changed` or `work_item.closed` moves the
   * card later (the dispatcher applies those, as for every provider).
   */
  intakeRoutes: IntakeRoutesReader;
  /** A project's boards, stored ones included: where a card's board and phases are read. */
  projectBoards: { load(scope: { orgId: string; factoryProjectId: string }): Promise<BoardRegistry> };
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
 * One sweep over the Lists the Factories' intake routes name. A new task a route subscribes to
 * becomes a card where the routes place it (through the same rule commit a webhook would make, so
 * replays never duplicate). A known card follows the task's fields; a status change or a close is
 * handed to the dispatcher as a status event (`work_item.state_changed`, `work_item.closed`), which
 * applies the project's routes like for any provider: it waits for a run in flight, records the
 * route in the card's history, and falls back to the board's own close when no route handles it.
 * Matches the shape `IssueReconcileWorker` runs.
 */
export function createClickUpPoller(options: ClickUpPollerOptions): () => Promise<IssueReconcileSummary> {
  const now = options.now ?? (() => new Date());
  const startedAt = now();
  const lookbackMs = (options.lookbackDays ?? 7) * DAY_MS;
  const cursors = new Map<string, Date>();

  const sourceOf = (task: ClickUpTask): ExternalWorkItemSource => ({
    integrationId: CLICKUP_INTEGRATION_ID,
    type: 'task',
    externalId: task.id,
    url: task.url,
  });

  const taskFacts = (task: ClickUpTask, source: ExternalWorkItemSource, metadata: Record<string, unknown>) => {
    const workItem = arrivalSourceFacts(source, metadata);
    return cardRuleFacts({
      title: task.name || `ClickUp task ${task.id}`,
      metadata,
      externalSource: source,
      ...(workItem ? { workItem } : {}),
    });
  };

  /** Commits a status event on an existing card; the dispatcher's routes decide where it goes. */
  const commitEvent = async (
    project: FactoryProject,
    item: WorkItemRow,
    identity: string,
    triggerType: string,
    decision: Parameters<ClickUpPollerOptions['workItems']['commitRuleEvaluation']>[0]['decisions'][number],
  ) => {
    const result = await options.workItems.commitRuleEvaluation({
      orgId: project.orgId,
      factoryProjectId: project.id,
      workItemId: item.id,
      ingress: { identity, triggerType },
      configVersion: options.configVersion,
      expectedRevision: item.revision,
      actor: ACTOR,
      outcome: { status: 'accepted' },
      decisions: [decision],
      causalChain: [],
      now: now(),
    });
    if (result.status === 'stale') throw new Error(`Card ${item.id} changed while filing a ClickUp event; retrying next sweep.`);
  };

  /** A closed task: `work_item.closed`, with the board's own close as the move when no route handles it. */
  const closeCard = async (project: FactoryProject, item: WorkItemRow, task: ClickUpTask, registry: BoardRegistry) => {
    const board = item.board ? registry.get(item.board) : undefined;
    if (!board || item.stages.some(stage => board.isTerminal(stage))) return false;
    const identity = `clickup:task:${task.id}:closed:${task.updatedAt}`;
    const closure = resolveBoardClosure(registry, item);
    const event = { type: 'work_item.closed' as const, reason: 'completed' as const };
    await commitEvent(
      project,
      item,
      identity,
      'clickup.task.closed',
      closure
        ? {
            type: 'transition',
            idempotencyKey: `${identity}:transition`,
            board: board.id,
            stage: closure.completed.phase,
            message: {
              text: `ClickUp task ${task.id} was closed; this ${closure.boardTitle} card was moved to ${closure.completed.title}.`,
            },
            event,
          }
        : { type: 'routeEvent', idempotencyKey: `${identity}:route`, event },
    );
    return true;
  };

  /**
   * A status change on a task a route placed: a person or an agent that moved the card since owns
   * it, so only a card still where its previous status put it gets the event.
   */
  const stillWhereStatusPutIt = (item: WorkItemRow, routes: readonly IntakeRoute[], registry: BoardRegistry, facts: RuleFacts) => {
    const board = item.board ? registry.get(item.board) : undefined;
    if (!board) return false;
    const previous = typeof item.workItem?.metadata?.state === 'string' ? item.workItem.metadata.state : undefined;
    if (previous === undefined) return false;
    const before = resolveEventRoute(routes, { type: 'work_item.state_changed' }, { ...facts, 'item.state': previous }, board);
    const placed = before && !board.isTerminal(before.phase) ? before.phase : board.initialPhase;
    return item.stages.includes(placed);
  };

  const fileTask = async (project: FactoryProject, listId: string, task: ClickUpTask): Promise<Outcome> => {
    const source = sourceOf(task);
    const scope = { orgId: project.orgId, factoryProjectId: project.id };
    const existing = await options.workItems.getByProjectSource({ ...scope, source });
    const routes = await options.intakeRoutes.listIntakeRoutes(scope);
    const registry = await options.projectBoards.load(scope);
    const metadata = taskMetadata(task, listId);
    const facts = taskFacts(task, source, metadata);
    if (existing) {
      const previous = typeof existing.workItem?.metadata?.state === 'string' ? existing.workItem.metadata.state : undefined;
      const statusChanged = previous !== undefined && previous !== task.status.name;
      const board = existing.board ? registry.get(existing.board) : undefined;
      const routed = board ? resolveEventRoute(routes, { type: 'work_item.state_changed' }, facts, board) : undefined;
      // A status whose route finishes the card always goes (a close is never someone's work in
      // progress); any other move only while the card is still where the previous status put it.
      const finishing =
        board !== undefined &&
        routed !== undefined &&
        board.isTerminal(routed.phase) &&
        !existing.stages.some(stage => board.isTerminal(stage));
      const owned =
        !isClosedTask(task) && (finishing || (statusChanged && stillWhereStatusPutIt(existing, routes, registry, facts)));
      // Provider facts live on the work item, Factory's stamps on the board item; compare both.
      const current = { ...existing.workItem?.metadata, ...existing.metadata };
      let item = existing;
      let refreshed = false;
      if (!sameMetadata(current, metadata)) {
        await options.workItems.update({
          orgId: project.orgId,
          id: existing.id,
          userId: USER_ID,
          patch: { metadata: { ...current, ...metadata } },
        });
        // The event reads the card as it is now: with the task's new status.
        item = (await options.workItems.getByProjectSource({ ...scope, source })) ?? existing;
        refreshed = true;
      }
      if (isClosedTask(task)) return (await closeCard(project, item, task, registry)) ? 'closed' : refreshed ? 'refreshed' : 'unchanged';
      if (owned) {
        const identity = `clickup:task:${task.id}:status:${normalizeIdentity(task.status.name)}:${task.updatedAt}`;
        await commitEvent(project, item, identity, 'clickup.task.status', {
          type: 'routeEvent',
          idempotencyKey: `${identity}:route`,
          event: { type: 'work_item.state_changed' },
        });
        return 'moved';
      }
      return refreshed ? 'refreshed' : 'unchanged';
    }
    if (isClosedTask(task)) return 'unchanged';
    // A route naming the task's List subscribes the project to it. Where the card lands is the
    // dispatcher's call, as for every arrival: the first route with a condition that takes it.
    if (!routeSubscribesSource(routes, facts)) return 'unchanged';
    const landing = intakeTarget(registry);
    if (!landing) throw new Error(`Project ${project.id} has no board that takes new cards.`);
    // Tasks that already existed when the server started never start work on their own: the first
    // sweep would otherwise launch an agent for every open task in the List.
    const fresh = Date.parse(task.createdAt) > startedAt.getTime();
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
          // Where it lands until the dispatcher's routes place it.
          board: landing.board,
          source: 'clickup-task',
          sourceKey: task.id,
          title: task.name || `ClickUp task ${task.id}`,
          url: task.url || null,
          stage: landing.initialPhase,
          routing: { skipCatchAll: true, ...(fresh ? {} : { holdAtInitialPhase: true }) },
          metadata,
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
    const touched = new Set<string>();
    for (const { project, listId } of await routedClickUpLists(options)) {
      touched.add(project.id);
      const cursorKey = `${project.id}:${listId}`;
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
    summary.projects = touched.size;
    return summary;
  };
}
