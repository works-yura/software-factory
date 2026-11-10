import { useState } from 'react';
import type { ComponentProps } from 'react';
import { AskUserCustomAnswer, AskUserOptionItem, AskUserOptions, AskUserTextAnswer } from './ask-user-controls';
import {
  AskUserBody,
  AskUserContainer,
  AskUserLabel,
  AskUserOutput,
  AskUserPending,
  AskUserQuestion,
  AskUserSubmitButton,
} from './ask-user-layout';
import { AskUserProvider } from './ask-user-root';
import type { AskUserAnswer, AskUserOption, AskUserResult, AskUserSelectionMode } from './ask-user-types';
import { Badge } from '@/ds/components/Badge';
import { Txt } from '@/ds/components/Txt';
import { cn } from '@/lib/utils';
import { libText } from '@/lib/lib-text';

export interface AskUserQuestionsOption extends AskUserOption {
  /** The asker's recommended answer: marked, and chosen until the person picks another. */
  recommended?: boolean;
}

export interface AskUserQuestionsItem {
  question: string;
  /** A short name for the decision, shown above the question. */
  header?: string;
  options?: AskUserQuestionsOption[];
  selectionMode?: AskUserSelectionMode;
}

export interface AskUserQuestionsProps
  extends Omit<ComponentProps<typeof AskUserContainer>, 'children' | 'onSubmit'> {
  questions: readonly AskUserQuestionsItem[];
  /** One answer per question, in order; called once every question has one. */
  onSubmit: (answers: AskUserAnswer[]) => void;
  /** The reply that was sent: the card is then read-only. */
  result?: AskUserResult;
  isSubmitting?: boolean;
  /** The card's caption, e.g. "Questions (3)". */
  label?: string;
  submitLabel?: string;
  /** The label of the own-answer choice among the options. */
  customAnswerLabel?: string;
  /** The accessible name of question `index`'s free-text field. */
  answerLabel?: (index: number) => string;
}

function questionOptions(item: AskUserQuestionsItem): AskUserQuestionsOption[] {
  return item.options?.filter(option => Boolean(option?.label)) ?? [];
}

function QuestionHeading({ item }: { item: AskUserQuestionsItem }) {
  return (
    <>
      {item.header ? (
        <Badge size="xs" variant="neutral" className="mb-2 self-start">
          {item.header}
        </Badge>
      ) : null}
      <AskUserQuestion className="whitespace-pre-wrap">{item.question}</AskUserQuestion>
    </>
  );
}

interface QuestionAnswerControlsProps {
  item: AskUserQuestionsItem;
  disabled: boolean;
  customAnswerLabel?: string;
  answerLabel: string;
  onAnswerChange: (answer: AskUserAnswer | undefined) => void;
}

/** One question of the form: the card's own option and own-answer controls, with no submit of its own. */
function QuestionAnswerControls({
  item,
  disabled,
  customAnswerLabel,
  answerLabel,
  onAnswerChange,
}: QuestionAnswerControlsProps) {
  const options = questionOptions(item);
  const multiSelect = options.length > 0 && item.selectionMode === 'multi_select';
  const recommended = options.filter(option => option.recommended).map(option => option.label);
  return (
    <AskUserProvider
      selectionMode={multiSelect ? 'multi_select' : 'single_select'}
      disabled={disabled}
      defaultSelectedOptionLabels={multiSelect ? recommended : recommended.slice(0, 1)}
      onAnswerChange={onAnswerChange}
    >
      <QuestionHeading item={item} />
      {options.length > 0 ? (
        <AskUserOptions>
          {options.map(option => (
            <AskUserOptionItem
              key={option.label}
              value={option.label}
              description={option.description}
              recommended={option.recommended}
            >
              {option.label}
            </AskUserOptionItem>
          ))}
          <AskUserCustomAnswer label={customAnswerLabel} inputLabel={answerLabel} />
        </AskUserOptions>
      ) : (
        <AskUserTextAnswer aria-label={answerLabel} />
      )}
    </AskUserProvider>
  );
}

/**
 * Several questions in one card, built from the single-question card's parts: each question keeps its
 * options and own-answer choice, and one button sends every answer once each question has one.
 */
export function AskUserQuestions({
  questions,
  onSubmit,
  result,
  isSubmitting = false,
  label = libText('Questions'),
  submitLabel = libText('Send answers'),
  customAnswerLabel,
  answerLabel = index => `${libText('Your answer')} ${index + 1}`,
  className,
  ...props
}: AskUserQuestionsProps) {
  const [answers, setAnswers] = useState<(AskUserAnswer | undefined)[]>(() => questions.map(() => undefined));
  const complete = questions.length > 0 && answers.every(answer => answer !== undefined);
  const answered = result !== undefined;

  const setAnswer = (index: number, answer: AskUserAnswer | undefined) =>
    setAnswers(current => current.map((value, at) => (at === index ? answer : value)));

  return (
    <AskUserContainer role="group" aria-label={label} className={className} {...props}>
      <AskUserLabel>{label}</AskUserLabel>
      <AskUserBody className="flex flex-col pt-2">
        {questions.map((item, index) => (
          <div
            key={`${index}-${item.question}`}
            className={cn('flex flex-col', index > 0 && 'mt-4 border-t border-border pt-4')}
          >
            {answered ? (
              <QuestionHeading item={item} />
            ) : (
              <QuestionAnswerControls
                item={item}
                disabled={isSubmitting}
                customAnswerLabel={customAnswerLabel}
                answerLabel={answerLabel(index)}
                onAnswerChange={answer => setAnswer(index, answer)}
              />
            )}
          </div>
        ))}
        {answered ? (
          <AskUserOutput className="mt-4" result={result} />
        ) : (
          <div className="mt-4 flex items-center gap-3 border-t border-border pt-4">
            <AskUserSubmitButton
              disabled={isSubmitting || !complete}
              onClick={() => {
                if (complete) onSubmit(answers.filter((answer): answer is AskUserAnswer => answer !== undefined));
              }}
            >
              {submitLabel}
            </AskUserSubmitButton>
            {isSubmitting ? (
              <AskUserPending />
            ) : !complete ? (
              <Txt as="span" variant="caption" tone="muted">
                {libText('Answer every question')}
              </Txt>
            ) : null}
          </div>
        )}
      </AskUserBody>
    </AskUserContainer>
  );
}
