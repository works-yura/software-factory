import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../../../../../../e2e/ui/render';
import { askUserQuestions } from '../../services/askUserQuestions';
import { AskUserQuestionsCard } from '../AskUserQuestionsCard';
import { SuspensionCard } from '../TranscriptPromptCards';

const payload = {
  question: '1. Which channels?\n2. Who gets deposit alerts?\n3. Anything else?',
  questions: [
    {
      question: 'Which channels by default?',
      header: 'Channels',
      options: [{ label: 'Push + email (рекомендовано)', description: 'Desktop push off' }, { label: 'Push only' }],
    },
    { question: 'Who gets deposit alerts?', options: [{ label: 'Owner' }, { label: 'Admins' }], multiSelect: true },
    { question: 'Anything else for the estimate?' },
  ],
};

describe('AskUserQuestionsCard', () => {
  it('answers every question in one reply, each under its question', async () => {
    const onRespond = vi.fn();
    renderWithProviders(
      <SuspensionCard
        prompt={{ kind: 'suspension', id: 'p-1', toolCallId: 'toolu_q', toolName: 'ask_user', suspendPayload: payload } as never}
        isSubmitting={false}
        onRespond={onRespond}
      />,
    );

    expect(screen.getByRole('group', { name: "Agent's questions (3)" })).toBeInTheDocument();
    // The recommendation starts chosen, shown without its mark.
    const recommended = screen.getByRole('radio', { name: /Push \+ email/ });
    expect(recommended).toBeChecked();
    expect(screen.getByText('Recommended')).toBeInTheDocument();
    expect(screen.queryByText('Push + email (рекомендовано)')).toBeNull();

    const send = screen.getByRole('button', { name: 'Send answers' });
    expect(send).toBeDisabled();

    await userEvent.click(screen.getByRole('checkbox', { name: 'Owner' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Admins' }));
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByRole('textbox', { name: 'Your own answer to question 3' }), 'Rush: due Wednesday');
    expect(send).toBeEnabled();
    await userEvent.click(send);

    expect(onRespond).toHaveBeenCalledWith(
      'toolu_q',
      [
        '1. Which channels by default?\n   → Push + email',
        '2. Who gets deposit alerts?\n   → Owner; Admins',
        '3. Anything else for the estimate?\n   → Rush: due Wednesday',
      ].join('\n'),
      'p-1',
    );
  });

  it('makes the own answer one choice among the options, so only it is sent', async () => {
    const onRespond = vi.fn();
    renderWithProviders(
      <SuspensionCard
        prompt={{ kind: 'suspension', id: 'p-2', toolCallId: 'toolu_q2', toolName: 'ask_user', suspendPayload: payload } as never}
        isSubmitting={false}
        onRespond={onRespond}
      />,
    );

    expect(screen.getByRole('radio', { name: /Push \+ email/ })).toBeChecked();
    await userEvent.click(screen.getAllByRole('radio', { name: 'Other…' })[0]!);
    expect(screen.getByRole('radio', { name: /Push \+ email/ })).not.toBeChecked();
    await userEvent.type(screen.getByRole('textbox', { name: 'Your own answer to question 1' }), 'Only in-app');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Owner' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Your own answer to question 3' }), 'No');
    await userEvent.click(screen.getByRole('button', { name: 'Send answers' }));

    expect(onRespond.mock.calls[0]![1]).toContain('1. Which channels by default?\n   → Only in-app');
  });

  it('shows an answered card read-only with the reply that was sent', () => {
    renderWithProviders(
      <AskUserQuestionsCard questions={askUserQuestions(payload)!} result={{ content: '1. Which channels by default?\n   → Push only' }} />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Push only');
    expect(screen.queryByRole('button', { name: 'Send answers' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('keeps one question on the single-question card', () => {
    expect(askUserQuestions({ question: 'Only one?', questions: [{ question: 'Only one?' }] })).toBeUndefined();
    expect(askUserQuestions({ question: 'No list' })).toBeUndefined();
  });
});
