import { cardRuleFacts, INTAKE_ROUTE_METADATA_KEY, resolveBoardClosure, resolveIntakePlacement } from '@factory/core';
import type { BoardRegistry, ExternalWorkItemSource, IntakeRoutesReader } from '@factory/core';
import type { IssueReconcileSummary } from '@factory/integrations';
import type { FactoryProject, FactoryProjectsStorage, IntakeStorage, WorkItemRow, WorkItemsStorage } from '@factory/store';

import type { ClickUpTask, ClickUpTaskSource } from './api.ts';
import { isClosedTask } from './intake.ts';
import { ruleFor } from './settings.ts';
import type { ListRules } from './settings.ts';

export const CLICKUP_INTEGRATION_ID = 'clickup';

const DAY_MS = 24 * 60 * 60_000;
const DESCRIPTION_LIMIT = 8_000;
const ACTOR = { type: 'system', id: 'clickup-poller' } as const;
const USER_ID = 'clickup-poller';
const normalizeIdentity = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, '-');

export interface ClickUpPollerOptions {
  client: ClickUpTaskSource;
  intake: Pick<IntakeStorage, 'getConfig' | 'listBindings' | 'listLabelRoutes'>;
  /** Status → phase rules per List, chosen in Settings › Intake. */
  rules: (orgId: string) => Promise<Record<string, ListRules>>;
  projects: Pick<FactoryProjectsStorage, 'listAll'>;
  workItems: Pick<WorkItemsStorage, 'getByProjectSource' | 'commitRuleEvaluation' | 'update'>;
  boards: Pick<BoardRegistry, 'get'>;
  /**
   * The project's intake routes. A new task goes where the first matching route says, ahead
   * of its tag route and its List's board; without a match those place it as before.
   */
  intakeRoutes?: IntakeRoutesReader;
  /** A project's boards, stored ones included, which an intake route may name. Defaults to `boards`. */
  projectBoards?: { load(scope: { orgId: string; factoryProjectId: string }): Promise<BoardRegistry> };
  configVersion: string;
  /** How far back the first sweep looks for tasks. */
  lookbackDays?: number;
  now?: () => Date;
}

type Outcome = 'created' | 'refreshed' | 'moved' | 'closed' | 'unchanged';

function taskMetadata(task: ClickUpTask): Record<string, string | string[] | boolean> {
  return {
    identifier: task.id,
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

  const closeCard = async (project: FactoryProject, item: WorkItemRow, task: ClickUpTask): Promise<Outcome> => {
    const closure = resolveBoardClosure(options.boards, item);
    if (!closure || closure.itemTerminal) return 'unchanged';
    const identity = `clickup:task:${task.id}:closed:${task.updatedAt}`;
    const commit = await options.workItems.commitRuleEvaluation({
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
          stage: closure.completed.phase,
          message: {
            text: `ClickUp task ${task.id} was closed; this ${closure.boardTitle} card was moved to ${closure.completed.title}.`,
          },
        },
      ],
      causalChain: [],
      now: now(),
    });
    if (commit.status === 'stale') throw new Error(`Card ${item.id} changed while closing; retrying next sweep.`);
    return 'closed';
  };

  const moveCard = async (
    project: FactoryProject,
    item: WorkItemRow,
    task: ClickUpTask,
    phase: string,
    rules: ListRules | undefined,
  ): Promise<boolean> => {
    const board = item.board ? options.boards.get(item.board) : undefined;
    if (!board || !(phase in board.phases) || item.stages.includes(phase)) return false;
    const previous = typeof item.metadata?.state === 'string' ? item.metadata.state : undefined;
    // Only a status change we have not filed yet moves a card, and only while the card is still
    // where the previous status put it: a person or an agent that moved it owns it from then on.
    if (previous === undefined || previous === task.status.name) return false;
    const previousRule = ruleFor(rules, previous);
    const placed = previousRule.action === 'phase' ? previousRule.phase : board.initialPhase;
    if (!item.stages.includes(placed)) return false;
    const identity = `clickup:task:${task.id}:status:${normalizeIdentity(task.status.name)}:${task.updatedAt}`;
    const commit = await options.workItems.commitRuleEvaluation({
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
    if (commit.status === 'stale') throw new Error(`Card ${item.id} changed while moving; retrying next sweep.`);
    return true;
  };

  /** Where an intake route sends a new task, if one matches; the route wins over tag routes and the List's board. */
  const routePlacement = async (project: FactoryProject, task: ClickUpTask, source: ExternalWorkItemSource) => {
    if (!options.intakeRoutes) return undefined;
    const scope = { orgId: project.orgId, factoryProjectId: project.id };
    const routes = await options.intakeRoutes.listIntakeRoutes(scope);
    if (routes.length === 0) return undefined;
    const registry = options.projectBoards ? await options.projectBoards.load(scope) : (options.boards as BoardRegistry);
    const facts = cardRuleFacts({
      title: task.name || `ClickUp task ${task.id}`,
      metadata: taskMetadata(task),
      externalSource: source,
    });
    const placement = resolveIntakePlacement(routes, facts, registry);
    return placement && { ...placement, initialPhase: registry.get(placement.board)!.initialPhase };
  };

  const fileTask = async (
    project: FactoryProject,
    /** The tag route's or the List's board; null when neither names one. */
    fallbackBoard: string | null,
    rules: ListRules | undefined,
    task: ClickUpTask,
  ): Promise<Outcome> => {
    const source = { integrationId: CLICKUP_INTEGRATION_ID, type: 'task', externalId: task.id, url: task.url };
    const existing = await options.workItems.getByProjectSource({
      orgId: project.orgId,
      factoryProjectId: project.id,
      source,
    });
    const rule = ruleFor(rules, task.status.name);
    const closing = isClosedTask(task) || rule.action === 'close';
    if (existing) {
      if (closing) return closeCard(project, existing, task);
      const moved = rule.action === 'phase' ? await moveCard(project, existing, task, rule.phase, rules) : false;
      const metadata = taskMetadata(task);
      if (sameMetadata(existing.metadata, metadata)) return moved ? 'moved' : 'unchanged';
      await options.workItems.update({
        orgId: project.orgId,
        id: existing.id,
        userId: USER_ID,
        patch: { metadata: { ...(existing.metadata ?? {}), ...metadata } },
      });
      return moved ? 'moved' : 'refreshed';
    }
    // The List's status rules decide which tasks are imported at all; a route only decides where.
    if (closing || rule.action !== 'phase') return 'unchanged';

    // Tasks that already existed when the server started never start work on their own: the first
    // sweep would otherwise launch an agent for every open task in the List.
    const fresh = Date.parse(task.createdAt) > startedAt.getTime();
    const routed = await routePlacement(project, task, source);
    let board: string;
    let stage: string;
    if (routed) {
      board = routed.board;
      stage = fresh ? routed.phase : routed.initialPhase;
    } else {
      if (!fallbackBoard) return 'unchanged';
      board = fallbackBoard;
      const installed = options.boards.get(board);
      if (!installed) throw new Error(`Board "${board}" is not installed.`);
      if (!(rule.phase in installed.phases)) {
        throw new Error(`Board "${board}" has no phase "${rule.phase}" for status "${task.status.name}".`);
      }
      stage = fresh ? rule.phase : installed.initialPhase;
    }
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
          board,
          source: 'clickup-task',
          sourceKey: task.id,
          title: task.name || `ClickUp task ${task.id}`,
          url: task.url || null,
          stage,
          // Naming the route tells the dispatcher the routes were applied: it keeps this placement.
          metadata: routed ? { ...taskMetadata(task), [INTAKE_ROUTE_METADATA_KEY]: routed.routeId } : taskMetadata(task),
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
      const bindings = await options.intake.listBindings({ orgId, integrationId: CLICKUP_INTEGRATION_ID });
      const rules = await options.rules(orgId);

      for (const listId of selection.sourceIds) {
        const binding = bindings.find(candidate => candidate.sourceId === listId);
        const project = binding ? projectsById.get(binding.factoryProjectId) : undefined;
        // A List must be routed to a Factory before its tasks mean anything.
        if (!binding || !project || project.orgId !== orgId) continue;
        touched.add(project.id);

        const routes = await options.intake.listLabelRoutes({
          orgId,
          factoryProjectId: project.id,
          integrationId: CLICKUP_INTEGRATION_ID,
        });
        const cursorKey = `${orgId}:${listId}`;
        const since = cursors.get(cursorKey) ?? new Date(startedAt.getTime() - lookbackMs);
        let newest = since;
        let failed = false;
        try {
          const tasks = await options.client.listTasks({ listId, updatedAfter: since, includeClosed: true });
          for (const task of tasks) {
            const tags = new Set(task.tags.map(tag => tag.toLowerCase()));
            const board = routes.find(route => tags.has(route.label.toLowerCase()))?.board ?? binding.board ?? null;
            // Without a board of its own a task can still be placed by an intake route.
            if (!board && !options.intakeRoutes) continue;
            summary.checked += 1;
            try {
              const outcome = await fileTask(project, board, rules[listId], task);
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
