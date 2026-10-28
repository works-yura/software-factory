import { resolveBoardClosure } from '@factory/core';
import type { BoardRegistry } from '@factory/core';
import type { IssueReconcileSummary } from '@factory/integrations';
import type { FactoryProject, FactoryProjectsStorage, IntakeStorage, WorkItemRow, WorkItemsStorage } from '@factory/store';

import type { ClickUpTask, ClickUpTaskSource } from './api.ts';
import { isClosedTask } from './intake.ts';

export const CLICKUP_INTEGRATION_ID = 'clickup';

const DAY_MS = 24 * 60 * 60_000;
const DESCRIPTION_LIMIT = 8_000;
const ACTOR = { type: 'system', id: 'clickup-poller' } as const;
const USER_ID = 'clickup-poller';
const START_PHASE = 'triage';

export interface ClickUpPollerOptions {
  client: ClickUpTaskSource;
  intake: Pick<IntakeStorage, 'getConfig' | 'listBindings' | 'listLabelRoutes'>;
  /** Whether new tasks start Triage on their own, per organization. */
  autoStart: (orgId: string) => Promise<boolean>;
  projects: Pick<FactoryProjectsStorage, 'listAll'>;
  workItems: Pick<WorkItemsStorage, 'getByProjectSource' | 'commitRuleEvaluation' | 'update'>;
  boards: Pick<BoardRegistry, 'get'>;
  configVersion: string;
  /** How far back the first sweep looks for tasks. */
  lookbackDays?: number;
  now?: () => Date;
}

type Outcome = 'created' | 'refreshed' | 'closed' | 'unchanged';

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

  const fileTask = async (
    project: FactoryProject,
    board: string,
    autoStart: boolean,
    task: ClickUpTask,
  ): Promise<Outcome> => {
    const source = { integrationId: CLICKUP_INTEGRATION_ID, type: 'task', externalId: task.id, url: task.url };
    const existing = await options.workItems.getByProjectSource({
      orgId: project.orgId,
      factoryProjectId: project.id,
      source,
    });
    if (existing) {
      if (isClosedTask(task)) return closeCard(project, existing, task);
      const metadata = taskMetadata(task);
      if (sameMetadata(existing.metadata, metadata)) return 'unchanged';
      await options.workItems.update({
        orgId: project.orgId,
        id: existing.id,
        userId: USER_ID,
        patch: { metadata: { ...(existing.metadata ?? {}), ...metadata } },
      });
      return 'refreshed';
    }
    if (isClosedTask(task)) return 'unchanged';

    const installed = options.boards.get(board);
    if (!installed) throw new Error(`Board "${board}" is not installed.`);
    const startNow = autoStart && Date.parse(task.createdAt) > startedAt.getTime() && START_PHASE in installed.phases;
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
          stage: startNow ? START_PHASE : installed.initialPhase,
          metadata: taskMetadata(task),
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
      const autoStart = await options.autoStart(orgId);

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
            const board = routes.find(route => tags.has(route.label.toLowerCase()))?.board ?? binding.board;
            if (!board) continue;
            summary.checked += 1;
            try {
              const outcome = await fileTask(project, board, autoStart, task);
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
