/**
 * The `create-card` action: a fire files one card on a board, through the same path as "New card"
 * (`createFactoryWorkItem`: the board's first phase and its entry rules, then audit), and moves it
 * on to the configured phase as the intake rule, like an intake route does. From there the board's
 * own phases take it: a phase that starts on its own (`autoStart`) runs its agent.
 */

import { renderIntakeTemplate } from '@factory/core';
import type { BoardRegistry } from '@factory/core';
import { createCardActionConfigSchema } from '@factory/contracts';
import type { CreateCardActionConfig } from '@factory/contracts';
import type { AuditRecorder, FactoryTransitionService } from '@factory/runtime';
import type { WorkItemsStorage } from '@factory/store';
import { createFactoryWorkItem } from '@factory/work-items';

import { IntakeConfigError, parseWith } from './kinds.ts';
import type { IntakeActionKind } from './kinds.ts';

export const CREATE_CARD_ACTION_KIND = 'create-card';

/** Card metadata naming the rule and fire a card came from. */
export const INTAKE_RULE_METADATA_KEY = 'intakeRule';

export interface CreateCardActionOptions {
  workItems: WorkItemsStorage;
  /** The project's boards, stored ones included. */
  boards: { load(scope: { orgId: string; factoryProjectId: string }): Promise<BoardRegistry> };
  transitionService: () => Pick<FactoryTransitionService, 'transition'> | undefined;
  auditRecorder: AuditRecorder;
}

const SYSTEM_ACTOR = 'factory-intake-rule';

/** Why `config` can't file a card on the project's boards now; `undefined` when it can. */
function targetProblem(registry: BoardRegistry, config: CreateCardActionConfig): string | undefined {
  const board = registry.get(config.boardKey);
  if (!board) return `Board "${config.boardKey}" is not installed in this Factory.`;
  if (config.phaseKey === null || config.phaseKey === board.initialPhase) return undefined;
  const kind = board.phaseKind(config.phaseKey);
  if (!kind) return `Board "${config.boardKey}" has no phase "${config.phaseKey}".`;
  if (kind === 'terminal') return `Phase "${config.phaseKey}" is terminal; new cards can't land there.`;
  if (!board.allowsTransition(board.initialPhase, config.phaseKey)) {
    return `Board "${config.boardKey}" doesn't allow moving a card from "${board.initialPhase}" to "${config.phaseKey}".`;
  }
  return undefined;
}

export function createCardAction(options: CreateCardActionOptions): IntakeActionKind<CreateCardActionConfig> {
  return {
    kind: CREATE_CARD_ACTION_KIND,
    label: { uk: 'Створити картку', en: 'Create a card' },
    parse: config => parseWith(createCardActionConfigSchema, config),
    describe: (config, locale) => {
      const where = config.phaseKey ? `${config.boardKey} › ${config.phaseKey}` : config.boardKey;
      return locale === 'uk' ? `Картка «${config.titleTemplate}» на ${where}` : `Card "${config.titleTemplate}" on ${where}`;
    },
    problems: async (scope, config) => {
      const problem = targetProblem(await options.boards.load(scope), config);
      return problem ? [problem] : [];
    },
    run: async ({ rule, config, fired, timeZone }) => {
      const scope = { orgId: rule.orgId, factoryProjectId: rule.factoryProjectId };
      const registry = await options.boards.load(scope);
      const problem = targetProblem(registry, config);
      if (problem) throw new IntakeConfigError(problem);
      const board = registry.get(config.boardKey)!;
      const transitionService = options.transitionService();
      const template = { firedAt: fired.firedAt, ruleName: rule.name, ...(timeZone ? { timeZone } : {}), ...(fired.payload ? { payload: fired.payload } : {}) };
      const description = renderIntakeTemplate(config.description, template).trim();
      const created = await createFactoryWorkItem({
        workItems: options.workItems,
        boards: registry,
        transitionService,
        audit: async input => {
          await options.auditRecorder.record({
            orgId: rule.orgId,
            actorId: `${SYSTEM_ACTOR}:${rule.id}`,
            actorType: 'system',
            ...input,
          });
        },
        orgId: rule.orgId,
        // The person who set the rule up files its cards: they are its creator and consented to its runs.
        userId: rule.createdBy,
        factoryProjectId: rule.factoryProjectId,
        input: {
          title: renderIntakeTemplate(config.titleTemplate, template).slice(0, 500) || rule.name,
          board: board.id,
          metadata: {
            ...(description ? { description } : {}),
            ...(config.repository ? { repository: config.repository } : {}),
            [INTAKE_RULE_METADATA_KEY]: { id: rule.id, name: rule.name, firedAt: fired.firedAt.toISOString() },
          },
        },
      });
      if (created.status === 'refused') throw new Error(created.message);
      if (created.status === 'rejected') throw new Error(created.reason);
      const item = created.item;
      if (config.phaseKey && config.phaseKey !== board.initialPhase) {
        if (!transitionService) throw new Error('Factory stage transitions are not available right now.');
        const moved = await transitionService.transition({
          ...scope,
          workItemId: item.id,
          board: board.id,
          stage: config.phaseKey,
          expectedRevision: item.revision,
          // The rule moves the card, as an intake route would.
          actor: { type: 'system', id: SYSTEM_ACTOR },
          ingress: { type: 'rule', identity: `intake-rule:${rule.id}:${fired.firedAt.toISOString()}:place` },
          cause: 'work_item_created',
        });
        if (moved.status === 'rejected') {
          return {
            workItemId: item.id,
            note: `The card stayed in ${board.initialPhase}: moving it to ${config.phaseKey} was refused (${moved.reason}).`,
          };
        }
      }
      return { workItemId: item.id };
    },
  };
}
