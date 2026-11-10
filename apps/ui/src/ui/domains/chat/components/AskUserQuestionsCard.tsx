import * as AskUser from '@mastra/playground-ui/components/ai/ask-user';
import { Badge } from '@mastra/playground-ui/components/Badge';
import { Checkbox } from '@mastra/playground-ui/components/Checkbox';
import { Input } from '@mastra/playground-ui/components/Input';
import { RadioGroup, RadioGroupItem } from '@mastra/playground-ui/components/RadioGroup';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** One question of a call that asks several, as the agent asked it. */
export interface AskUserQuestionItem {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);

/**
 * The questions of a card that asks several: a Claude Code `AskUserQuestion` call's own input, or the
 * `ask_user` payload the harness keeps them in. Undefined for a card with one question, which keeps
 * the single-question card.
 */
export function askUserQuestions(payload: unknown): AskUserQuestionItem[] | undefined {
  const list = record(payload)?.questions;
  if (!Array.isArray(list)) return undefined;
  const questions = list.flatMap((entry): AskUserQuestionItem[] => {
    const item = record(entry);
    const question = text(item?.question);
    if (!question) return [];
    const options = (Array.isArray(item?.options) ? item.options : []).flatMap(option => {
      const label = text(record(option)?.label);
      if (!label) return [];
      const description = text(record(option)?.description);
      return [{ label, ...(description ? { description } : {}) }];
    });
    const header = text(item?.header);
    return [
      {
        question,
        ...(header ? { header } : {}),
        ...(options.length ? { options } : {}),
        ...(item?.multiSelect === true ? { multiSelect: true } : {}),
      },
    ];
  });
  return questions.length > 1 ? questions : undefined;
}

/** An option the agent recommends: its label ends with "(Recommended)" or "(рекомендовано)". */
const RECOMMENDED = /\s*\((?:recommended|рекомендовано)\)\s*$/i;

export function optionLabel(label: string): { shown: string; recommended: boolean } {
  return RECOMMENDED.test(label) ? { shown: label.replace(RECOMMENDED, ''), recommended: true } : { shown: label, recommended: false };
}

interface QuestionAnswer {
  chosen: string[];
  other: string;
}

/** The value of one answered question: the chosen options and the person's own words, together. */
function answerValue(answer: QuestionAnswer): string {
  return [...answer.chosen, answer.other.trim()].filter(Boolean).join('; ');
}

/**
 * All answers as one reply, each under its question, so the agent reads which answer is whose.
 * Chosen options are sent as the agent labelled them, without the recommendation mark.
 */
export function formatQuestionAnswers(questions: readonly AskUserQuestionItem[], answers: readonly QuestionAnswer[]): string {
  return questions
    .map((item, index) => `${index + 1}. ${item.question}\n   → ${answerValue(answers[index] ?? { chosen: [], other: '' })}`)
    .join('\n');
}

function initialAnswer(item: AskUserQuestionItem): QuestionAnswer {
  const first = item.options?.[0];
  // The agent's recommendation starts chosen; "yes" is one click away.
  return { chosen: first && optionLabel(first.label).recommended ? [optionLabel(first.label).shown] : [], other: '' };
}

/**
 * A card for several questions at once, drawn with the design system's ask-user parts so it reads as
 * the single-question card does: one block per question with its options (radio or checkbox rows)
 * and an own-answer field, and one Send for all of them, enabled once every question has an answer.
 * Answered, it shows the questions and the reply that went back, read-only.
 */
export function AskUserQuestionsCard({
  questions,
  isSubmitting = false,
  result,
  onSubmit,
}: {
  questions: readonly AskUserQuestionItem[];
  isSubmitting?: boolean;
  /** The reply that was sent, once the card is answered. */
  result?: { content: string; isError?: boolean };
  onSubmit?: (answer: string) => void;
}) {
  const { t } = useTranslation('chat');
  const id = useId();
  const [answers, setAnswers] = useState<QuestionAnswer[]>(() => questions.map(initialAnswer));
  const answered = result !== undefined;
  const complete = answers.every(answer => answerValue(answer).length > 0);
  const disabled = answered || isSubmitting || !onSubmit;

  const update = (index: number, change: (answer: QuestionAnswer) => QuestionAnswer) =>
    setAnswers(current => current.map((answer, at) => (at === index ? change(answer) : answer)));

  return (
    <AskUser.AskUserContainer
      role="group"
      aria-label={t('prompts.questionsFromAgent', { count: questions.length })}
      className="my-2"
    >
      <AskUser.AskUserLabel>{t('prompts.questionsFromAgent', { count: questions.length })}</AskUser.AskUserLabel>
      <AskUser.Body className="flex flex-col gap-0 pt-2">
        {questions.map((item, index) => {
          const answer = answers[index]!;
          const legendId = `${id}-q${index}`;
          const options = item.options ?? [];
          const rows = options.map(option => {
            const { shown, recommended } = optionLabel(option.label);
            return { key: option.label, shown, recommended, description: option.description };
          });
          const label = (shown: string, recommended: boolean) => (
            <span className="inline-flex flex-wrap items-center gap-2">
              {shown}
              {recommended && (
                <Badge size="xs" variant="neutral">
                  {t('prompts.recommended')}
                </Badge>
              )}
            </span>
          );
          return (
            <fieldset
              key={`${index}-${item.question}`}
              aria-labelledby={legendId}
              className={`m-0 flex flex-col gap-2 border-0 p-0 ${index > 0 ? 'border-border mt-4 border-t pt-4' : ''}`}
            >
              {item.header && (
                <Badge size="xs" variant="neutral" className="self-start">
                  {item.header}
                </Badge>
              )}
              <Txt id={legendId} as="p" variant="subheading" tone="ink" className="m-0 whitespace-pre-wrap">
                {item.question}
              </Txt>
              {!answered && rows.length > 0 && !item.multiSelect && (
                <RadioGroup
                  aria-labelledby={legendId}
                  disabled={disabled}
                  value={answer.chosen[0] ?? ''}
                  onValueChange={value =>
                    update(index, current => ({ ...current, chosen: typeof value === 'string' && value ? [value] : [] }))
                  }
                  className="grid gap-1"
                >
                  {rows.map(row => (
                    <AskUser.AskUserOptionRow
                      key={row.key}
                      disabled={disabled}
                      label={label(row.shown, row.recommended)}
                      description={row.description}
                      control={<RadioGroupItem className="mt-0.5" value={row.shown} disabled={disabled} />}
                    />
                  ))}
                </RadioGroup>
              )}
              {!answered && rows.length > 0 && item.multiSelect && (
                <div className="grid gap-1">
                  {rows.map(row => {
                    const selected = answer.chosen.includes(row.shown);
                    return (
                      <AskUser.AskUserOptionRow
                        key={row.key}
                        disabled={disabled}
                        label={label(row.shown, row.recommended)}
                        description={row.description}
                        control={
                          <Checkbox
                            className="mt-0.5"
                            disabled={disabled}
                            checked={selected}
                            onCheckedChange={() =>
                              update(index, current => ({
                                ...current,
                                chosen: selected
                                  ? current.chosen.filter(chosen => chosen !== row.shown)
                                  : [...current.chosen, row.shown],
                              }))
                            }
                          />
                        }
                      />
                    );
                  })}
                </div>
              )}
              {!answered && (
                <Input
                  aria-label={t('prompts.ownAnswerFor', { number: index + 1 })}
                  placeholder={rows.length ? t('prompts.ownAnswer') : t('prompts.answer')}
                  value={answer.other}
                  disabled={disabled}
                  onChange={event =>
                    update(index, current => ({
                      // Words in a single-select question replace the chosen option, as the single card's own answer does.
                      chosen: !item.multiSelect && event.target.value.trim() ? [] : current.chosen,
                      other: event.target.value,
                    }))
                  }
                />
              )}
            </fieldset>
          );
        })}
        {answered ? (
          <AskUser.Output className="mt-4" result={{ content: result.content, isError: result.isError }} />
        ) : (
          <div className="border-border mt-4 flex items-center gap-3 border-t pt-4">
            <AskUser.AskUserSubmitButton
              disabled={disabled || !complete}
              onClick={() => onSubmit?.(formatQuestionAnswers(questions, answers))}
            >
              {t('prompts.sendAnswers')}
            </AskUser.AskUserSubmitButton>
            {isSubmitting ? (
              <AskUser.Pending />
            ) : (
              !complete && (
                <Txt as="span" variant="caption" tone="muted">
                  {t('prompts.answerEveryQuestion')}
                </Txt>
              )
            )}
          </div>
        )}
      </AskUser.Body>
    </AskUser.AskUserContainer>
  );
}
