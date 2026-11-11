import type { IntakeSourceDescriptor, IntakeSourceRegistry } from '@factory/core/boards/intake-sources';

import type { TFunction } from 'i18next';

import type { CardRuleGroup, InstalledBoardInfo, IntakeRouteInfo } from '../../../../api/types';

import { phaseTitle, boardTitle } from '../../../i18n/boardLabels';

import { readRouteConditions, readRouteWhen } from '../services/intakeRouteConditions';
import type { RouteCondition, RouteWhenModel } from '../services/intakeRouteConditions';

/** How an intake route reads in the list and the editor: its source, events, conditions and target in words. */

type T = TFunction<'settings'>;

/** What a route can name from outside the project: the sources the Factory uses and the ClickUp Lists of the connected workspace. */
export interface IntakeOrigins {
  /** The sources a route can name, from the UI's composition root. */
  sources: IntakeSourceRegistry;
  /** The ClickUp Lists, for the `source.list` condition: naming one is what makes the project read it. */
  lists: { value: string; label: string }[];
  /** Whether the Factory uses a source: «Коли» offers only these (and keeps a stored route's other source, marked). */
  available: (source: IntakeSourceDescriptor) => boolean;
}

export const originLabel = (options: IntakeOrigins['lists'], value: string) =>
  options.find(option => option.value === value)?.label ?? value;

/** The group a source's own wording is kept under: its descriptor's `wording` (GitHub and GitLab share one), else its id. */
const sourceWording = (source: IntakeSourceDescriptor) => source.wording ?? source.id;

/** A source's name in the interface language; a source added later without a translation shows its id. */
export const sourceLabel = (source: IntakeSourceDescriptor, t: T) =>
  t(`intakeRoutes.sources.${source.id}` as never, { defaultValue: source.id });

/** An event as the source calls it («нова задача» in ClickUp, «нова картка» for any source). */
export const eventLabel = (source: IntakeSourceDescriptor | undefined, event: string, t: T) =>
  t(
    [
      ...(source ? [`intakeRoutes.sourceEvents.${sourceWording(source)}.${event}`] : []),
      `intakeRoutes.events.${event}`,
    ] as never,
    { defaultValue: event },
  );

/** A condition field as the source calls it («Мітка» in GitHub, «Тег» elsewhere). */
export const fieldLabel = (source: IntakeSourceDescriptor | undefined, field: string, t: T) =>
  t(
    [
      ...(source ? [`intakeRoutes.sourceFields.${sourceWording(source)}.${field}`] : []),
      `intakeRoutes.fields.${field}`,
    ] as never,
    { defaultValue: field },
  );

function describeCondition(condition: RouteCondition, origins: IntakeOrigins, t: T, source?: IntakeSourceDescriptor): string {
  switch (condition.field) {
    case 'source.list':
      return source?.id === 'clickup'
        ? originLabel(origins.lists, condition.value)
        : t('intakeRoutes.inList', { list: originLabel(origins.lists, condition.value) });
    case 'source.integration':
      return condition.value.map(integration => t(`intakeRoutes.integrations.${integration}`)).join(t('intakeRoutes.or'));
    case 'source.kind':
      return t(`intakeRoutes.kinds.${condition.value}`);
    case 'author.trusted':
      return t(condition.value ? 'intakeRoutes.trusted' : 'intakeRoutes.untrusted');
    case 'item.labels':
      return t('intakeRoutes.hasTag', { tag: condition.value });
    case 'item.title':
      return t('intakeRoutes.titleContains', { text: condition.value });
    case 'item.state':
      return t('intakeRoutes.statusIs', { status: condition.value });
    case 'source.repository':
    case 'item.key':
    case 'item.assignees':
      return t('intakeRoutes.factIs', { field: fieldLabel(source, condition.field, t), value: condition.value });
  }
}

/** Factory's own routes keep the name it gave them; show that name in the interface language. */
const DEFAULT_ROUTE_NAMES: Readonly<Record<string, string>> = {
  'Outside authors wait in Intake': 'outsideAuthors',
  'Pull requests go to Review': 'pullRequests',
  // The name Factory gave the route before Work's PR review phase was renamed Review.
  'Pull requests go to PR review': 'pullRequests',
  'Closed issues go to Done': 'closedCompleted',
  'Issues closed as not planned go to Canceled': 'closedCanceled',
  'Reopened issues go back to Intake': 'reopened',
  'Pull requests that close a waiting issue join its card': 'closesIssue',
  'Merged pull requests go to Done': 'pullRequestMerged',
  'Pull requests closed unmerged go to Canceled': 'pullRequestClosed',
  'Issues whose pull request closed unmerged go back to Intake': 'pullRequestClosedIssue',
  'Pushes to a reviewed pull request re-review it': 'pullRequestUpdated',
  'Requested reviews go to Review': 'pullRequestReviewRequested',
  'Requested reviews go to PR review': 'pullRequestReviewRequested',
  'Everything else goes to Work › Intake': 'everythingElse',
};

/**
 * A route's name in the interface language: Factory's default routes and the routes it wrote (a
 * ClickUp status, a migrated schedule) carry the name it gave them, shown translated until a person
 * renames the route.
 */
export function routeName(route: IntakeRouteInfo, t: T): string {
  const key = DEFAULT_ROUTE_NAMES[route.name];
  if (key) return t(`intakeRoutes.defaults.${key}` as never);
  const origin = route.origin;
  if (origin && origin.generatedName === route.name && origin.kind === 'clickup-status') {
    return t('intakeRoutes.origins.clickupStatus', { status: origin.status });
  }
  if (origin && origin.generatedName === route.name && origin.kind === 'repository') {
    return t('intakeRoutes.origins.repository', { repository: origin.repository });
  }
  return route.name;
}

const ROUTE_EVENTS = [
  'work_item.created',
  'work_item.closed',
  'work_item.reopened',
  'work_item.state_changed',
  'pull_request.opened',
  'pull_request.synchronized',
  'pull_request.review_requested',
  'pull_request.merged',
  'pull_request.closed',
] as const;
const CLOSE_REASONS = ['completed', 'canceled'] as const;

function describeEventCondition(condition: CardRuleGroup['conditions'][number], t: T): string | undefined {
  if (!('field' in condition) || condition.operator !== 'equals') return undefined;
  if (condition.field === 'event.reason' && CLOSE_REASONS.includes(condition.value as never))
    return t(`intakeRoutes.closeReasons.${condition.value as (typeof CLOSE_REASONS)[number]}`);
  if (condition.field === 'event.type' && ROUTE_EVENTS.includes(condition.value as never))
    return t(`intakeRoutes.events.${condition.value as (typeof ROUTE_EVENTS)[number]}`);
  return undefined;
}

/**
 * A route's «Коли» in one line: its source, its conditions, then every event it handles —
 * «ClickUp · Syncta / Bugs · статус «to do» · нова задача або статус задачі змінився».
 */
export function describeWhen(route: IntakeRouteInfo, origins: IntakeOrigins, t: T): string {
  if (route.triggered) return route.triggered.trigger.summary;
  const model = readRouteWhen(origins.sources, route.when);
  if (model) {
    const { source } = model;
    const onlyNewCards = route.on.length === 1 && route.on[0] === 'work_item.created';
    if (source.id === 'any' && model.conditions.length === 0 && onlyNewCards) return t('intakeRoutes.everyCard');
    const events = route.on.map(event => eventLabel(source, event, t)).join(t('intakeRoutes.or'));
    const unused = origins.available(source) ? undefined : t('intakeRoutes.sourceNotConnected');
    return [
      ...(source.id === 'any'
        ? []
        : [[sourceLabel(source, t), unused && `(${unused})`].filter(Boolean).join(' ')]),
      ...model.conditions.map(condition => describeCondition(condition, origins, t, source)),
      model.closeReason ? `${events} · ${t(`intakeRoutes.closeReasons.${model.closeReason}`)}` : events,
    ].join(' · ');
  }
  // A condition set through the API: its events, and what of it can be read.
  const events = route.on.filter(event => event !== 'work_item.created').map(event => t(`intakeRoutes.events.${event}`));
  const eventConditions: string[] = [];
  let cardConditions = route.when;
  if (events.length > 0 && route.when?.operator === 'AND') {
    const rest = route.when.conditions.filter(condition => {
      const described = describeEventCondition(condition, t);
      if (described) eventConditions.push(described);
      return !described;
    });
    cardConditions = rest.length > 0 ? { ...route.when, conditions: rest } : null;
  }
  const conditions = readRouteConditions(cardConditions);
  const card = !conditions
    ? [t('intakeRoutes.customCondition')]
    : conditions.map(condition => describeCondition(condition, origins, t));
  if (events.length === 0) return card.length > 0 ? card.join(' · ') : t('intakeRoutes.everyCard');
  return [events.join(t('intakeRoutes.or')), ...eventConditions, ...card].join(' · ');
}

export function describeTarget(
  target: { boardKey: string; phaseKey: string | null; joinClosedIssue?: boolean },
  boards: InstalledBoardInfo[],
  t: T,
): string {
  const board = boards.find(candidate => candidate.id === target.boardKey);
  const boardName = boardTitle(target.boardKey, board?.name ?? board?.title ?? target.boardKey);
  if (!target.phaseKey) {
    return target.joinClosedIssue
      ? t('intakeRoutes.targetJoinStays', { board: boardName })
      : t('intakeRoutes.targetFirstPhase', { board: boardName });
  }
  const phase = board?.phases.find(candidate => candidate.id === target.phaseKey);
  return t(target.joinClosedIssue ? 'intakeRoutes.targetJoin' : 'intakeRoutes.target', {
    board: boardName,
    phase: phaseTitle(target.boardKey, target.phaseKey, phase?.name ?? phase?.title ?? target.phaseKey),
  });
}
