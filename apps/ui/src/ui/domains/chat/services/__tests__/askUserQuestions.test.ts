import { describe, expect, it } from 'vitest';

import { askUserQuestions, formatQuestionAnswers, optionLabel, toAskUserQuestionsItems } from '../askUserQuestions';

const payload = {
  question: 'flattened',
  questions: [
    { question: 'Which channels?', header: 'Channels', options: [{ label: 'Push (рекомендовано)' }, { label: 'Email' }] },
    { question: 'Who?', options: [{ label: 'Owner' }, { label: 'Admins' }], multiSelect: true },
    { question: 'Anything else?' },
  ],
};

describe('askUserQuestions', () => {
  it('reads several questions, and leaves one question to the single-question card', () => {
    expect(askUserQuestions(payload)).toHaveLength(3);
    expect(askUserQuestions({ questions: [{ question: 'Only one?' }] })).toBeUndefined();
    expect(askUserQuestions({ question: 'No list' })).toBeUndefined();
  });

  it('turns the recommendation mark into a flag', () => {
    expect(optionLabel('Push (Recommended)')).toEqual({ shown: 'Push', recommended: true });
    expect(optionLabel('Email')).toEqual({ shown: 'Email', recommended: false });
    const [first, second] = toAskUserQuestionsItems(askUserQuestions(payload)!);
    expect(first!.options![0]).toMatchObject({ label: 'Push', recommended: true });
    expect(second!.selectionMode).toBe('multi_select');
  });

  it('formats one reply, each answer under its question', () => {
    expect(formatQuestionAnswers(askUserQuestions(payload)!, ['Push', ['Owner', 'Admins'], 'No'])).toBe(
      ['1. Which channels?\n   → Push', '2. Who?\n   → Owner; Admins', '3. Anything else?\n   → No'].join('\n'),
    );
  });
});
