import { z } from 'zod';

import type { IntegrationStorageHandle } from '@factory/store';

/** What the factory does with a task that carries a given ClickUp status. */
export const statusRuleSchema = z.discriminatedUnion('action', [
  /** Leave the task alone: not imported, and a card already on the board stays where it is. */
  z.object({ action: z.literal('ignore') }),
  /** File the task on the board in this phase, and follow later status changes into it. */
  z.object({ action: z.literal('phase'), phase: z.string().min(1) }),
  /** The work is over: finish the card the way the board does when a source closes. */
  z.object({ action: z.literal('close') }),
]);
export type StatusRule = z.infer<typeof statusRuleSchema>;

/** Rules keyed by lower-cased status name; a status without a rule is ignored. */
export const listRulesSchema = z.object({ statuses: z.record(z.string(), statusRuleSchema) });
export type ListRules = z.infer<typeof listRulesSchema>;

export interface ClickUpSettings {
  lists: Record<string, ListRules>;
}

/** The settings are org-wide, but the generic settings table is keyed by `(org, user)`. */
const ORG_SETTINGS_USER = '__org__';

const settingsSchema = z.object({ lists: z.record(z.string(), listRulesSchema) });

export const normalizeStatus = (name: string): string => name.trim().toLowerCase();

export function ruleFor(rules: ListRules | undefined, statusName: string): StatusRule {
  return rules?.statuses[normalizeStatus(statusName)] ?? { action: 'ignore' };
}

export async function readClickUpSettings(
  storage: Pick<IntegrationStorageHandle, 'settings'>,
  orgId: string,
): Promise<ClickUpSettings> {
  const parsed = settingsSchema.safeParse(await storage.settings.get(orgId, ORG_SETTINGS_USER));
  return parsed.success ? parsed.data : { lists: {} };
}

/** Replace one List's rules; an empty rule set removes the List's entry. */
export async function saveListRules(
  storage: Pick<IntegrationStorageHandle, 'settings'>,
  orgId: string,
  listId: string,
  rules: ListRules,
): Promise<ClickUpSettings> {
  const current = await readClickUpSettings(storage, orgId);
  const statuses = Object.fromEntries(
    Object.entries(rules.statuses)
      .filter(([, rule]) => rule.action !== 'ignore')
      .map(([name, rule]) => [normalizeStatus(name), rule]),
  );
  const lists = { ...current.lists };
  if (Object.keys(statuses).length) lists[listId] = { statuses };
  else delete lists[listId];
  const next = { lists };
  await storage.settings.save(orgId, ORG_SETTINGS_USER, next);
  return next;
}
