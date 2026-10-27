import { isAuditAction } from '@factory/store/audit/actions';
import type { AuditAction } from '@factory/store/audit/actions';

import { entryTarget } from '../../../../activity';
import type { ActivityEntry } from '../../../../activity';
import { auditActionLabel } from '../../../../auditPresentation';
import { translator } from '../../../../../../i18n/t';

const ta = translator('activity');

/** Catalog keys for the verb that makes the rail read as prose; a row off the registry falls back to its own label. */
const DEED_PHRASES: Record<AuditAction, string> = {
  'factory.run.started': 'run_started',
  'factory.run.ended': 'run_ended',
  'factory.run.queued': 'run_queued',
  'factory.run.rejected': 'run_rejected',
  'factory.run.approved': 'run_approved',
  'factory.run.dismissed': 'run_dismissed',
  'factory.run.retry': 'run_retry',
  'factory.git.commit': 'git_commit',
  'factory.git.push': 'git_push',
  'factory.git.pr_opened': 'git_pr_opened',
  'factory.agent.commit': 'agent_commit',
  'factory.agent.push': 'agent_push',
  'factory.agent.pr_opened': 'agent_pr_opened',
  'factory.agent.signaled': 'agent_signaled',
  'factory.work_item.created': 'work_item_created',
  'factory.work_item.updated': 'work_item_updated',
  'factory.work_item.deleted': 'work_item_deleted',
  'factory.work_item.stage_moved': 'work_item_stage_moved',
  'factory.work_item.transition_rejected': 'work_item_transition_rejected',
  'factory.work_item.comment_created': 'work_item_comment_created',
  'factory.work_item.comment_edited': 'work_item_comment_edited',
  'factory.work_item.comment_deleted': 'work_item_comment_deleted',
  'factory.work_item.comment_mentioned': 'work_item_comment_mentioned',
  'factory.work_item.labels_reconciled': 'work_item_labels_reconciled',
  'factory.intake.config_updated': 'intake_config_updated',
  'factory.intake.binding_updated': 'intake_binding_updated',
  'factory.intake.label_route_updated': 'intake_label_route_updated',
};

/** What a sentence's verb points at: one card's title, a count of cards, or nothing at all (an intake setting has no title). */
export type DeedObject = 'title' | 'group' | 'none';

export function subjectCount(entries: ActivityEntry[]): number {
  return new Set(entries.map(entry => entryTarget(entry)?.id ?? entry.title)).size;
}

export function deedObject(entries: ActivityEntry[]): DeedObject {
  if (entries.every(entry => entry.title === '')) return 'none';
  return subjectCount(entries) > 1 ? 'group' : 'title';
}

export function namesSeveralCards(entries: ActivityEntry[]): boolean {
  return deedObject(entries) === 'group';
}

/** A comment's colon introduces its card; before a count it reads "commented on 3 cards". */
function deedPhrase(action: string, object: DeedObject): string {
  if (isAuditAction(action)) return ta(`sentence.deeds.${DEED_PHRASES[action]}.${object}`);
  const phrase = auditActionLabel(action).toLowerCase();
  if (object === 'none') return phrase.replace(/ (?:on|to|for|of)$/, '');
  if (object === 'group') return phrase.replace(/:$/, ' on');
  return phrase;
}

export function entryVerb(entries: [ActivityEntry, ...ActivityEntry[]]): string {
  const [first] = entries;
  return first.kind === 'move' ? ta('sentence.moved') : deedPhrase(first.action, deedObject(entries));
}
