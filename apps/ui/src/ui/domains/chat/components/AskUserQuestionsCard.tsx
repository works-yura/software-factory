import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { Input } from '@mastra/playground-ui/components/Input';
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
 * A card for several questions at once: one block per question with its options and an own-answer
 * field, and one Send for all of them, enabled once every question has an answer. Answered, it
 * shows the questions and the reply that went back, read-only.
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
    <section
      role="group"
      aria-label={t('prompts.questionsFromAgent', { count: questions.length })}
      className="border-border bg-surface2 my-2 flex w-full max-w-full flex-col gap-3 rounded-lg border p-3"
    >
      {questions.map((item, index) => {
        const answer = answers[index]!;
        const legendId = `${id}-q${index}`;
        return (
          <fieldset key={`${index}-${item.question}`} className="m-0 flex flex-col gap-1.5 border-0 p-0" aria-labelledby={legendId}>
            <div className="flex flex-wrap items-center gap-2">
              <Txt as="span" variant="meta" tone="muted">
                {index + 1}.
              </Txt>
              {item.header && <Badge variant="neutral">{item.header}</Badge>}
            </div>
            <Txt id={legendId} as="p" variant="body" tone="ink" className="m-0 whitespace-pre-wrap">
              {item.question}
            </Txt>
            {!answered && item.options && item.options.length > 0 && (
              <div className="flex flex-col gap-1">
                {item.options.map(option => {
                  const { shown, recommended } = optionLabel(option.label);
                  const selected = answer.chosen.includes(shown);
                  return (
                    <Button
                      key={option.label}
                      variant={selected ? 'primary' : 'default'}
                      size="sm"
                      className="h-auto justify-start py-1.5 text-left whitespace-normal"
                      aria-pressed={selected}
                      disabled={disabled}
                      onClick={() =>
                        update(index, current => ({
                          ...current,
                          chosen: item.multiSelect
                            ? selected
                              ? current.chosen.filter(label => label !== shown)
                              : [...current.chosen, shown]
                            : selected
                              ? []
                              : [shown],
                        }))
                      }
                    >
                      <span className="flex flex-col items-start gap-0.5">
                        <span className="flex items-center gap-2">
                          {shown}
                          {recommended && <Badge variant="info">{t('prompts.recommended')}</Badge>}
                        </span>
                        {option.description && (
                          <Txt as="span" variant="meta" tone="muted">
                            {option.description}
                          </Txt>
                        )}
                      </span>
                    </Button>
                  );
                })}
              </div>
            )}
            {!answered && (
            <Input
              size="sm"
              aria-label={t('prompts.ownAnswerFor', { number: index + 1 })}
              placeholder={item.options?.length ? t('prompts.ownAnswer') : t('prompts.answer')}
              value={answer.other}
              disabled={disabled}
              onChange={event => update(index, current => ({ ...current, other: event.target.value }))}
            />
            )}
          </fieldset>
        );
      })}
      {answered ? (
        <div className="border-border border-t pt-2">
          <Txt as="p" variant="meta" tone="muted" className="m-0">
            {result.isError ? t('prompts.questionsNotAnswered') : t('prompts.yourAnswers')}
          </Txt>
          <Txt as="p" variant="caption" className="m-0 whitespace-pre-wrap">
            {result.content}
          </Txt>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={disabled || !complete}
            onClick={() => onSubmit?.(formatQuestionAnswers(questions, answers))}
          >
            {t('prompts.sendAnswers')}
          </Button>
          {!complete && (
            <Txt as="span" variant="meta" tone="muted">
              {t('prompts.answerEveryQuestion')}
            </Txt>
          )}
        </div>
      )}
    </section>
  );
}
