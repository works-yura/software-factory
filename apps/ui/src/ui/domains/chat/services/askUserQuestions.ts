import type { AskUserAnswer, AskUserQuestionsItem } from '@mastra/playground-ui/components/ai/ask-user';

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
  return RECOMMENDED.test(label)
    ? { shown: label.replace(RECOMMENDED, ''), recommended: true }
    : { shown: label, recommended: false };
}

/** The agent's questions as the card draws them: the recommendation mark becomes a flag, not label text. */
export function toAskUserQuestionsItems(questions: readonly AskUserQuestionItem[]): AskUserQuestionsItem[] {
  return questions.map(item => ({
    question: item.question,
    header: item.header,
    selectionMode: item.multiSelect ? 'multi_select' : 'single_select',
    options: item.options?.map(option => {
      const { shown, recommended } = optionLabel(option.label);
      return { label: shown, description: option.description, recommended };
    }),
  }));
}

const answerText = (answer: AskUserAnswer | undefined) => (Array.isArray(answer) ? answer.join('; ') : (answer ?? ''));

/**
 * All answers as one reply, each under its question, so the agent reads which answer is whose.
 * Chosen options are sent as the agent labelled them, without the recommendation mark.
 */
export function formatQuestionAnswers(
  questions: readonly AskUserQuestionItem[],
  answers: readonly AskUserAnswer[],
): string {
  return questions.map((item, index) => `${index + 1}. ${item.question}\n   → ${answerText(answers[index])}`).join('\n');
}
