import type { RuleCondition, RuleGroup } from '@factory/core/rules/rule-group';
import type { FilterBarField, FilterBarOperator, FilterBarOption } from '@mastra/playground-ui/components/FilterBar';
import type { RuleBuilderProps } from '@mastra/playground-ui/components/RuleBuilder';

import { translator } from '../../../i18n/t';

const tk = translator('settings');

export type Facts = RuleBuilderProps['schema'];
type FactProperties = NonNullable<Facts['properties']>;

/** The card facts every rule can test (`CARD_RULE_FIELDS`), titled in the reader's language. */
function cardFactProperties(): FactProperties {
  return {
    item: {
      type: 'object',
      title: tk('workBoard.facts.card'),
      properties: {
        labels: { type: 'string', title: tk('workBoard.facts.labels') },
        title: { type: 'string', title: tk('workBoard.facts.title') },
        author: { type: 'string', title: tk('workBoard.facts.author') },
        key: { type: 'string', title: tk('workBoard.facts.key') },
        state: { type: 'string', title: tk('workBoard.facts.state') },
        assignees: { type: 'string', title: tk('workBoard.facts.assignees') },
        pullRequest: { type: 'number', title: tk('workBoard.facts.pullRequest') },
      },
    },
    author: {
      type: 'object',
      title: tk('workBoard.facts.author'),
      properties: { trusted: { type: 'boolean', title: tk('workBoard.facts.trusted') } },
    },
    source: {
      type: 'object',
      title: tk('workBoard.facts.source'),
      properties: {
        kind: { type: 'string', title: tk('workBoard.facts.kind') },
        integration: { type: 'string', title: tk('workBoard.facts.integration') },
        provider: { type: 'string', title: tk('workBoard.facts.provider') },
        // A GitHub repository or a GitLab project path.
        repository: { type: 'string', title: tk('workBoard.facts.repository') },
        // The ClickUp List a task lives in: a route naming one imports the List's tasks.
        list: { type: 'string', title: tk('conditions.fields.source.list') },
      },
    },
    // A GitHub Dependabot alert's advisory (`source.kind = dependabot_alert`).
    alert: {
      type: 'object',
      title: tk('conditions.groups.alert'),
      properties: {
        severity: { type: 'string', title: tk('conditions.fields.alert.severity') },
        ecosystem: { type: 'string', title: tk('conditions.fields.alert.ecosystem') },
        package: { type: 'string', title: tk('conditions.fields.alert.package') },
      },
    },
  };
}

/** The card facts a phase rule can test (`CARD_RULE_FIELDS`), as the condition editor's field tree. */
export function cardFacts(): Facts {
  return { type: 'object', properties: cardFactProperties() };
}

/**
 * The facts an intake route can test (`INTAKE_ROUTE_RULE_FIELDS`): the card's, and the issue a pull
 * request closes.
 */
function routeFactProperties(): FactProperties {
  return {
    ...cardFactProperties(),
    pullRequest: {
      type: 'object',
      title: tk('conditions.groups.pullRequest'),
      properties: { closesIssue: { type: 'boolean', title: tk('conditions.fields.pullRequest.closesIssue') } },
    },
    closedIssue: {
      type: 'object',
      title: tk('conditions.groups.closedIssue'),
      properties: {
        phase: { type: 'string', title: tk('conditions.fields.closedIssue.phase') },
        hasPullRequest: { type: 'boolean', title: tk('conditions.fields.closedIssue.hasPullRequest') },
      },
    },
  };
}

/**
 * The facts an intake route handling `on` can test. As the route API requires, event facts
 * apply only to a route handling an event besides `work_item.created`, and `event.reason` only
 * to one handling `work_item.closed`, the one event that carries a reason.
 */
export function intakeRouteFacts(on: readonly string[]): Facts {
  if (on.every(type => type === 'work_item.created')) return { type: 'object', properties: routeFactProperties() };
  const event = {
    type: { type: 'string', title: tk('conditions.fields.event.type') },
    ...(on.includes('work_item.closed') ? { reason: { type: 'string', title: tk('conditions.fields.event.reason') } } : {}),
  };
  return {
    type: 'object',
    properties: {
      ...routeFactProperties(),
      event: { type: 'object', title: tk('conditions.groups.event'), properties: event },
    },
  };
}

/**
 * `facts` narrowed to the fields one intake source has (`fields`, such as a ClickUp task's List and
 * status) plus the event facts, which every source's events carry. Absent `fields` keeps them all.
 */
export function factsFor(facts: Facts, fields: readonly string[] | undefined): Facts {
  if (!fields) return facts;
  const allowed = new Set(fields);
  const properties: FactProperties = {};
  for (const [group, fact] of Object.entries(facts.properties ?? {})) {
    const kept = Object.fromEntries(
      Object.entries(fact.properties ?? {}).filter(
        ([property]) => group === 'event' || allowed.has(`${group}.${property}`),
      ),
    );
    if (Object.keys(kept).length > 0) properties[group] = { ...fact, properties: kept };
  }
  return { type: 'object', properties };
}

const OPERATOR_IDS = [
  'equals',
  'not_equals',
  'in',
  'not_in',
  'contains',
  'not_contains',
  'exists',
  'not_exists',
  'greater_than',
  'less_than',
  'greater_than_or_equal',
  'less_than_or_equal',
] as const;
const ARITY: Partial<Record<(typeof OPERATOR_IDS)[number], Pick<FilterBarOperator, 'arity' | 'freeText'>>> = {
  in: { arity: 'many' },
  not_in: { arity: 'many' },
  contains: { freeText: true },
  not_contains: { freeText: true },
  exists: { arity: 'none' },
  not_exists: { arity: 'none' },
};

/** What a value typed for a fact looks like, shown until one is typed. */
export function valuePlaceholder(fieldId: string): string | undefined {
  return fieldId === 'source.repository' ? tk('conditions.placeholders.repository') : undefined;
}

/** Rule operators in words. Ids are the rule's own operators, so rows map back to rules unchanged. */
export function conditionOperators(): FilterBarOperator[] {
  return OPERATOR_IDS.map(id => ({ id, label: tk(`conditions.operators.${id}`), ...ARITY[id] }));
}

const TEXT_OPERATORS = ['equals', 'not_equals', 'in', 'not_in', 'contains', 'not_contains', 'exists', 'not_exists'];
const CHOICE_OPERATORS = ['equals', 'not_equals', 'in', 'not_in'];
const NUMBER_OPERATORS = [
  'exists',
  'not_exists',
  'equals',
  'not_equals',
  'greater_than',
  'less_than',
  'greater_than_or_equal',
  'less_than_or_equal',
];
const BOOLEAN_OPERATORS = ['equals', 'not_equals'];
/** A list fact (labels, assignees) matches when one of its members does. */
const LIST_OPERATORS = ['equals', 'not_equals', 'in', 'not_in', 'exists', 'not_exists'];
const listOperatorLabels = (): Record<string, string> =>
  Object.fromEntries(LIST_OPERATORS.map(id => [id, tk(`conditions.listOperators.${id}`)]));

/** The integrations v4 takes cards from. */
const integrations = (): FilterBarOption[] => [
  { value: 'github', label: 'GitHub' },
  { value: 'gitlab', label: 'GitLab' },
  { value: 'clickup', label: 'ClickUp' },
];

const yesNo = (yes = tk('conditions.yes'), no = tk('conditions.no')): FilterBarOption[] => [
  { value: 'true', label: yes },
  { value: 'false', label: no },
];

type FieldShape = { label?: string; options?: FilterBarOption[]; strict?: boolean; list?: boolean };

/** Facts only tested for being there, such as a card's open pull request. */
const PRESENCE_FIELDS = new Set(['item.pullRequest']);
const PRESENCE_OPERATORS = ['exists', 'not_exists'];
const presenceLabels = (): Record<string, string> => ({
  exists: tk('conditions.presence.exists'),
  not_exists: tk('conditions.presence.not_exists'),
});

const EVENT_TYPES = [
  'work_item.created',
  'work_item.state_changed',
  'work_item.closed',
  'work_item.reopened',
  'pull_request.opened',
  'pull_request.synchronized',
  'pull_request.review_requested',
  'pull_request.merged',
  'pull_request.closed',
] as const;

/** How each fact reads in the condition editor, beyond its fact title. */
function fieldShapes(): Record<string, FieldShape> {
  const label = (id: string) => tk(`conditions.fields.${id}`);
  return {
    'item.labels': { label: label('item.labels'), list: true },
    'item.title': { label: label('item.title') },
    'item.author': { label: label('item.author') },
    'item.key': { label: label('item.key') },
    'item.state': { label: label('item.state') },
    'item.assignees': { label: label('item.assignees'), list: true },
    'item.pullRequest': { label: label('item.pullRequest') },
    'author.trusted': {
      label: label('author.trusted'),
      options: yesNo(tk('conditions.values.trusted'), tk('conditions.values.untrusted')),
      strict: true,
    },
    'source.kind': {
      label: label('source.kind'),
      options: [
        { value: 'issue', label: tk('conditions.values.issue') },
        { value: 'pull_request', label: tk('conditions.values.pullRequest') },
        { value: 'task', label: tk('conditions.values.task') },
        { value: 'dependabot_alert', label: tk('conditions.values.dependabotAlert') },
      ],
    },
    'source.integration': { label: label('source.integration'), options: integrations() },
    'source.provider': { label: label('source.provider'), options: integrations() },
    // Suggested from the project's repositories, but any value can be typed: `strict: false`.
    'source.repository': { label: label('source.repository'), strict: false },
    'source.list': { label: label('source.list') },
    'alert.severity': {
      label: label('alert.severity'),
      options: (['critical', 'high', 'medium', 'low'] as const).map(value => ({
        value,
        label: tk(`conditions.values.${value}`),
      })),
    },
    'alert.ecosystem': { label: label('alert.ecosystem') },
    'alert.package': { label: label('alert.package') },
    'pullRequest.closesIssue': { label: label('pullRequest.closesIssue'), options: yesNo(), strict: true },
    'closedIssue.phase': { label: label('closedIssue.phase') },
    'closedIssue.hasPullRequest': { label: label('closedIssue.hasPullRequest'), options: yesNo(), strict: true },
    'event.type': {
      label: label('event.type'),
      strict: true,
      options: EVENT_TYPES.map(value => ({ value, label: tk(`conditions.eventTypes.${value}`) })),
    },
    'event.reason': {
      label: label('event.reason'),
      strict: true,
      options: [
        { value: 'completed', label: tk('conditions.values.completed') },
        { value: 'canceled', label: tk('conditions.values.canceled') },
      ],
    },
  };
}

/**
 * The facts a rule can test, as condition editor fields: one per leaf fact, with its values to
 * pick from when they are known. `options` adds values per field, such as a board's phases or the
 * connected workspace's ClickUp Lists.
 */
export function conditionFields(facts: Facts, options: Record<string, FilterBarOption[]> = {}): FilterBarField[] {
  const shapes = fieldShapes();
  return Object.entries(facts.properties ?? {}).flatMap(([group, groupFact]) =>
    Object.entries(groupFact.properties ?? {}).map(([property, fact]): FilterBarField => {
      const id = `${group}.${property}`;
      const shape = shapes[id] ?? {};
      const label = shape.label ?? `${groupFact.title ?? group} ${(fact.title ?? property).toLowerCase()}`;
      const suggestions = options[id] ?? shape.options;
      if (fact.type === 'boolean') {
        return { id, label, type: 'boolean', operators: BOOLEAN_OPERATORS, suggestions, strict: true };
      }
      if (PRESENCE_FIELDS.has(id)) {
        return { id, label, operators: PRESENCE_OPERATORS, operatorLabels: presenceLabels() };
      }
      if (fact.type === 'number') return { id, label, type: 'number', operators: NUMBER_OPERATORS };
      if (shape.list) {
        return { id, label, operators: LIST_OPERATORS, operatorLabels: listOperatorLabels(), suggestions };
      }
      return {
        id,
        label,
        operators: suggestions && shape.strict !== false ? CHOICE_OPERATORS : TEXT_OPERATORS,
        suggestions,
        strict: shape.strict,
      };
    }),
  );
}

/** Yes/no facts read as a phrase, since "Author trust is trusted" says less than "author is trusted". */
const BOOLEAN_PHRASES = new Set(['author.trusted', 'pullRequest.closesIssue', 'closedIssue.hasPullRequest']);

/** Values named after a product, a List or a phase keep their capitals mid-sentence. */
const PROPER_VALUES = new Set(['source.integration', 'source.provider', 'source.list', 'closedIssue.phase']);

function everyFact(): Facts {
  return intakeRouteFacts(['work_item.created', 'work_item.closed']);
}

function describeMember(member: RuleCondition | RuleGroup, fields: ReadonlyMap<string, FilterBarField>): string {
  if ('conditions' in member) return `(${describeMembers(member, fields)})`;
  if (BOOLEAN_PHRASES.has(member.field) && typeof member.value === 'boolean') {
    const yes = (member.operator === 'equals') === member.value;
    if (member.operator === 'equals' || member.operator === 'not_equals') {
      return tk(`conditions.phrases.${member.field}.${yes ? 'yes' : 'no'}`);
    }
  }
  if (PRESENCE_FIELDS.has(member.field) && (member.operator === 'exists' || member.operator === 'not_exists')) {
    return tk(`conditions.phrases.${member.field}.${member.operator === 'exists' ? 'yes' : 'no'}`);
  }
  const field = fields.get(member.field);
  const fact = field ? field.label.charAt(0).toLowerCase() + field.label.slice(1) : member.field;
  const operator =
    field?.operatorLabels?.[member.operator] ??
    conditionOperators().find(candidate => candidate.id === member.operator)?.label ??
    member.operator;
  if (member.value === undefined) return tk('conditions.phrase.valueless', { fact, operator });
  const options = Array.isArray(field?.suggestions) ? field.suggestions : [];
  const values = (Array.isArray(member.value) ? member.value : [member.value]).map(value => {
    const text = options.find(option => option.value === String(value))?.label ?? String(value);
    if (PROPER_VALUES.has(member.field) || text.charAt(1) !== text.charAt(1).toLowerCase()) return text;
    return text.charAt(0).toLowerCase() + text.slice(1);
  });
  if (member.operator === 'in') {
    return tk('conditions.phrase.value', {
      fact,
      operator: field?.operatorLabels?.equals ?? tk('conditions.operators.equals'),
      values: values.join(tk('conditions.or')),
    });
  }
  return tk('conditions.phrase.value', { fact, operator, values: values.join(', ') });
}

function describeMembers(group: RuleGroup, fields: ReadonlyMap<string, FilterBarField>): string {
  return group.conditions
    .map(member => describeMember(member, fields))
    .join(group.operator === 'AND' ? tk('conditions.and') : tk('conditions.or'));
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A rule's top-level conditions, one phrase each, and how they combine; `null` when it matches every card. */
export function describeConditions(
  rule: RuleGroup | null | undefined,
  options: Record<string, FilterBarOption[]> = {},
): { join: 'and' | 'or'; parts: string[] } | null {
  if (!rule || rule.conditions.length === 0) return null;
  const fields = new Map(conditionFields(everyFact(), options).map(field => [field.id, field]));
  return {
    join: rule.operator === 'AND' ? 'and' : 'or',
    parts: rule.conditions.map(member => capitalize(describeMember(member, fields))),
  };
}

/**
 * A rule in words, naming facts, operators and values as the condition rows do; no rule matches
 * every card. `options` names values per field, such as a board's phases.
 */
export function describeRule(rule: RuleGroup | null | undefined, options: Record<string, FilterBarOption[]> = {}): string {
  if (!rule || rule.conditions.length === 0) return tk('workBoard.rule.everyCard');
  const fields = new Map(conditionFields(everyFact(), options).map(field => [field.id, field]));
  return capitalize(describeMembers(rule, fields));
}
