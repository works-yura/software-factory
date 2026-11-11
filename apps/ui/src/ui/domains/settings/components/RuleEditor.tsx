import { cardRuleGroupSchema } from '@factory/core/rules/rule-group';
import { Button } from '@mastra/playground-ui/components/Button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@mastra/playground-ui/components/Field';
import { RuleBuilder } from '@mastra/playground-ui/components/RuleBuilder';
import type { RuleBuilderProps } from '@mastra/playground-ui/components/RuleBuilder';
import { Textarea } from '@mastra/playground-ui/components/Textarea';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useId, useState } from 'react';
import type { z } from 'zod';

import { translator } from '../../../i18n/t';
import { rawRuleProblem, readRawRule, ruleProblem } from '../services/rules';

const tk = translator('settings');

type Facts = RuleBuilderProps['schema'];

/** The card facts a phase rule can test (`CARD_RULE_FIELDS`), as the rule builder's field tree. */
export function cardFacts(): Facts {
  return {
    type: 'object',
    properties: {
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
        },
      },
      intake: {
        type: 'object',
        title: tk('workBoard.facts.intake'),
        properties: {
          rule: { type: 'string', title: tk('workBoard.facts.intakeRule') },
          trigger: { type: 'string', title: tk('workBoard.facts.intakeTrigger') },
        },
      },
    },
  };
}

/**
 * A rule, edited with the rule builder or as raw JSON. Unset means "every card".
 * Reports a rule the server would refuse, so the form can hold back the save.
 * `facts` defaults to the card facts a phase rule tests (`cardFacts`). Pass `json` to keep the JSON being typed outside
 * the editor, so it outlives the editor; otherwise the editor keeps it.
 */
export function RuleEditor<Rule>({
  label,
  description,
  rule,
  disabled,
  facts,
  schema,
  json,
  onChange,
}: {
  label: string;
  description: string;
  rule: Rule | null | undefined;
  disabled: boolean;
  facts?: Facts;
  schema: z.ZodType<Rule>;
  /** The JSON being typed, unset while the rule builder shows. */
  json?: { text: string | undefined; onChange: (text: string | undefined) => void };
  onChange: (rule: Rule | null, problem: string | undefined) => void;
}) {
  const [ownRaw, setOwnRaw] = useState<string | undefined>(undefined);
  const raw = json ? json.text : ownRaw;
  const setRaw = json ? json.onChange : setOwnRaw;
  const id = useId();
  const problem = raw === undefined ? ruleProblem(schema, rule) : rawRuleProblem(schema, raw);

  const editRaw = (text: string) => {
    setRaw(text);
    const read = readRawRule(schema, text);
    if ('problem' in read) onChange(rule ?? null, read.problem);
    else onChange(read.rule, undefined);
  };

  return (
    <Field invalid={problem !== undefined}>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            if (raw === undefined) {
              setRaw(rule ? JSON.stringify(rule, null, 2) : '');
              return;
            }
            setRaw(undefined);
            // The builder edits the last valid rule, so JSON that never parsed no longer holds the save.
            onChange(rule ?? null, ruleProblem(schema, rule));
          }}
        >
          {raw === undefined ? tk('workBoard.rule.editJson') : tk('workBoard.rule.useBuilder')}
        </Button>
      </div>
      <FieldDescription>{description}</FieldDescription>
      {raw !== undefined ? (
        <Textarea
          id={id}
          aria-label={tk('workBoard.rule.jsonLabel', { label })}
          value={raw}
          disabled={disabled}
          rows={6}
          onChange={event => editRaw(event.target.value)}
        />
      ) : disabled ? (
        <Txt id={id} as="p" variant="caption" tone="muted">
          {rule ? JSON.stringify(rule) : tk('workBoard.rule.everyCard')}
        </Txt>
      ) : (
        <div id={id}>
          <RuleBuilder
            schema={facts ?? cardFacts()}
            // Factory's rule groups have the builder's shape; the server validates the depth.
            ruleGroup={(rule ?? undefined) as RuleBuilderProps['ruleGroup']}
            onChange={next => {
              const value = (next ?? null) as Rule | null;
              onChange(value, ruleProblem(schema, value));
            }}
          />
        </div>
      )}
      {problem && <FieldError>{problem}</FieldError>}
    </Field>
  );
}
