import * as AskUser from '@mastra/playground-ui/components/ai/ask-user';
import { useTranslation } from 'react-i18next';

import { formatQuestionAnswers, toAskUserQuestionsItems } from '../services/askUserQuestions';
import type { AskUserQuestionItem } from '../services/askUserQuestions';

/**
 * The agent's several questions in one card: the design system's `AskUser.Questions`, with the agent's
 * recommendation marks turned into flags and the answers sent back as one reply, each under its question.
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
  return (
    <AskUser.Questions
      className="my-2"
      questions={toAskUserQuestionsItems(questions)}
      label={t('prompts.questionsFromAgent', { count: questions.length })}
      submitLabel={t('prompts.sendAnswers')}
      customAnswerLabel={t('prompts.ownAnswer')}
      answerLabel={index => t('prompts.ownAnswerFor', { number: index + 1 })}
      isSubmitting={isSubmitting}
      {...(result ? { result } : {})}
      onSubmit={answers => onSubmit?.(formatQuestionAnswers(questions, answers))}
    />
  );
}
