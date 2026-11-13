import type { RuleGroup } from '@factory/core/rules/rule-group';
import { Button } from '@mastra/playground-ui/components/Button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@mastra/playground-ui/components/Field';
import type { FilterBarOption } from '@mastra/playground-ui/components/FilterBar';
import { Textarea } from '@mastra/playground-ui/components/Textarea';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useId, useState } from 'react';
import type { z } from 'zod';

import { translator } from '../../../i18n/t';
import { rawRuleProblem, readRawRule, ruleProblem } from '../services/rules';
import { ConditionRows } from './ConditionRows';
import { cardFacts, describeRule } from './conditionFields';
import type { Facts } from './conditionFields';

const tk = translator('settings');

/**
 * A rule, edited as condition rows or as raw JSON. Unset means "every card".
 * Reports a rule the server would refuse, so the form can hold back the save.
 * `facts` defaults to the card facts a phase rule tests (`cardFacts`). Pass `json` to keep the JSON being typed outside
 * the editor, so it outlives the editor; otherwise the editor keeps it.
 */
export function RuleEditor({
  label,
  description,
  rule,
  disabled,
  facts = cardFacts(),
  options,
  schema,
  json,
  onChange,
  onUnfinished,
}: {
  label: string;
  description: string;
  rule: RuleGroup | null | undefined;
  disabled: boolean;
  facts?: Facts;
  /** Values to pick from per field, such as a board's phases. */
  options?: Record<string, FilterBarOption[]>;
  schema: z.ZodType<RuleGroup>;
  /** The JSON being typed, unset while the conditions show. */
  json?: { text: string | undefined; onChange: (text: string | undefined) => void };
  onChange: (rule: RuleGroup | null, problem: string | undefined) => void;
  /** Whether a condition row is half filled in, which the form should treat as a problem until it isn't. */
  onUnfinished?: (unfinished: boolean) => void;
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
            // The rows edit the last valid rule, so JSON that never parsed no longer holds the save.
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
          {describeRule(rule, options)}
        </Txt>
      ) : (
        <div id={id}>
          <ConditionRows
            label={label}
            rule={rule}
            facts={facts}
            options={options}
            onChange={(next, incomplete) => {
              onUnfinished?.(incomplete);
              // A half-filled row keeps the last whole rule, so saving never quietly drops a condition.
              if (incomplete) onChange(rule ?? null, tk('conditions.unfinished'));
              else onChange(next, ruleProblem(schema, next));
            }}
          />
        </div>
      )}
      {problem && <FieldError>{problem}</FieldError>}
    </Field>
  );
}
