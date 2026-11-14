import { cardRuleGroupSchema } from '@factory/core/rules/rule-group';
import type { RuleGroup } from '@factory/core/rules/rule-group';
import { describe, expect, it } from 'vitest';

import { conditionFields, describeRule, factsFor, intakeRouteFacts } from '../conditionFields';
import { canNest, emptyRow, fromRule, toRule } from '../conditionTree';

// The conditions of Work's default intake routes (`DEFAULT_INTAKE_ROUTES` in @factory/store).
const DEFAULT_ROUTE_RULES: (RuleGroup | null)[] = [
  null,
  {
    operator: 'AND',
    conditions: [
      { field: 'source.integration', operator: 'equals', value: 'github' },
      { field: 'author.trusted', operator: 'equals', value: false },
    ],
  },
  { operator: 'AND', conditions: [{ field: 'event.reason', operator: 'equals', value: 'completed' }] },
  {
    operator: 'AND',
    conditions: [
      { field: 'source.kind', operator: 'equals', value: 'pull_request' },
      { field: 'pullRequest.closesIssue', operator: 'equals', value: true },
    ],
  },
];

// A Self-review start rule in use today: groups three levels deep, the most the server accepts.
const selfReviewRule: RuleGroup = {
  operator: 'AND',
  conditions: [
    {
      operator: 'OR',
      conditions: [
        { operator: 'AND', conditions: [{ field: 'author.trusted', operator: 'equals', value: true }] },
        {
          operator: 'OR',
          conditions: [
            { field: 'item.labels', operator: 'contains', value: 'effort:low' },
            { field: 'item.labels', operator: 'contains', value: 'effort:medium' },
          ],
        },
      ],
    },
    { field: 'item.pullRequest', operator: 'not_exists' },
  ],
};

describe('condition rows', () => {
  it('edit every default route condition, and a three-level start rule, without changing them', () => {
    for (const when of DEFAULT_ROUTE_RULES) {
      expect(toRule(fromRule(when))).toEqual({ rule: when, incomplete: false });
    }
    expect(cardRuleGroupSchema.safeParse(selfReviewRule).success).toBe(true);
    expect(toRule(fromRule(selfReviewRule))).toEqual({ rule: selfReviewRule, incomplete: false });
  });

  it('offer groups only as deep as the server accepts', () => {
    expect(canNest(0)).toBe(true);
    expect(canNest(1)).toBe(true);
    expect(canNest(2)).toBe(false);
  });

  it('leave out unfinished rows and empty groups, and read no rows as no rule', () => {
    expect(toRule(fromRule(null))).toEqual({ rule: null, incomplete: false });
    const root = fromRule({
      operator: 'AND',
      conditions: [{ field: 'source.kind', operator: 'equals', value: 'issue' }],
    });
    root.items.push(emptyRow(), { key: 'g', logic: 'OR', items: [] });
    expect(toRule(root)).toEqual({
      rule: { operator: 'AND', conditions: [{ field: 'source.kind', operator: 'equals', value: 'issue' }] },
      incomplete: true,
    });
  });

  it('read a rule back in words', () => {
    expect(describeRule(selfReviewRule)).toBe(
      '((author is trusted) or (labels contains effort:low or labels contains effort:medium)) and card has no open pull request',
    );
  });

  it('name stored values the way a person reads them', () => {
    const fields = conditionFields(intakeRouteFacts(['work_item.created', 'work_item.closed']));
    const label = (id: string, value: string | boolean) => {
      const suggestions = fields.find(field => field.id === id)?.suggestions;
      return Array.isArray(suggestions) ? suggestions.find(option => option.value === String(value))?.label : undefined;
    };

    expect(label('author.trusted', false)).toBe('Outside author');
    expect(label('source.kind', 'pull_request')).toBe('Pull request');
    expect(label('source.integration', 'clickup')).toBe('ClickUp');
    expect(label('event.reason', 'canceled')).toBe('Not planned');
  });

  it('offer a GitHub route the Dependabot alert kind and its severity', () => {
    const github = ['source.repository', 'source.kind', 'author.trusted', 'item.labels', 'item.title', 'item.assignees', 'alert.severity', 'alert.ecosystem', 'alert.package'];
    const fields = conditionFields(factsFor(intakeRouteFacts(['work_item.created']), github));
    const kinds = fields.find(field => field.id === 'source.kind')?.suggestions;
    expect(Array.isArray(kinds) && kinds.find(option => option.value === 'dependabot_alert')?.label).toBe('Dependabot alert');
    const severity = fields.find(field => field.id === 'alert.severity');
    expect(Array.isArray(severity?.suggestions) && severity.suggestions.map(option => option.value)).toEqual([
      'critical',
      'high',
      'medium',
      'low',
    ]);
    expect(describeRule({ operator: 'AND', conditions: [{ field: 'alert.severity', operator: 'in', value: ['critical', 'high'] }] })).toBe(
      'Alert severity is critical or high',
    );
  });

  it('offer event facts only to routes that handle an event besides new cards', () => {
    const ids = (on: string[]) => conditionFields(intakeRouteFacts(on)).map(field => field.id);

    expect(ids(['work_item.created'])).not.toContain('event.type');
    expect(ids(['work_item.reopened'])).toContain('event.type');
    expect(ids(['work_item.reopened'])).not.toContain('event.reason');
    expect(ids(['work_item.closed'])).toContain('event.reason');
  });

  it('narrow the facts to one source\'s fields, keeping the event facts every source sends', () => {
    const ids = conditionFields(factsFor(intakeRouteFacts(['work_item.state_changed']), ['source.list', 'item.state'])).map(
      field => field.id,
    );
    expect(ids).toEqual(['item.state', 'source.list', 'event.type']);
  });
});
