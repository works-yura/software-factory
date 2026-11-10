// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as AskUser from './ask-user';
import type { AskUserQuestionsItem } from './ask-user';

afterEach(cleanup);

const questions: AskUserQuestionsItem[] = [
  {
    question: 'Which channels by default?',
    header: 'Channels',
    options: [{ label: 'Push + email', description: 'Desktop push off', recommended: true }, { label: 'Push only' }],
  },
  { question: 'Who gets deposit alerts?', options: [{ label: 'Owner' }, { label: 'Admins' }], selectionMode: 'multi_select' },
  { question: 'Anything else?' },
];

describe('AskUser.Questions', () => {
  it('starts on the recommended option, marked, and sends nothing until every question has an answer', async () => {
    const onSubmit = vi.fn();
    render(<AskUser.Questions questions={questions} label="Questions (3)" onSubmit={onSubmit} />);

    expect(screen.getByRole('group', { name: 'Questions (3)' })).toBeTruthy();
    expect(screen.getByText('Channels')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Push \+ email/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Recommended')).toBeTruthy();

    const send = screen.getByRole('button', { name: 'Send answers' });
    expect(send.hasAttribute('disabled') || send.getAttribute('aria-disabled') === 'true').toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Owner' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Admins' }));
    expect(send.hasAttribute('disabled') || send.getAttribute('aria-disabled') === 'true').toBe(true);
    await userEvent.type(screen.getByRole('textbox', { name: 'Your answer 3' }), 'No');
    await userEvent.click(send);

    expect(onSubmit).toHaveBeenCalledWith(['Push + email', ['Owner', 'Admins'], 'No']);
  });

  it('never submits on choosing an option: a single-select question only records it', async () => {
    const onSubmit = vi.fn();
    render(<AskUser.Questions questions={questions} onSubmit={onSubmit} />);

    await userEvent.click(screen.getByRole('radio', { name: 'Push only' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('radio', { name: 'Push only' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /Push \+ email/ }).getAttribute('aria-checked')).toBe('false');
  });

  it('makes the own answer one choice among the options, replacing a chosen one', async () => {
    const onSubmit = vi.fn();
    render(<AskUser.Questions questions={questions} onSubmit={onSubmit} />);

    await userEvent.click(screen.getAllByRole('radio', { name: 'Other…' })[0]!);
    expect(screen.getByRole('radio', { name: /Push \+ email/ }).getAttribute('aria-checked')).toBe('false');
    await userEvent.type(screen.getByRole('textbox', { name: 'Your answer 1' }), 'Only in-app');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Owner' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Your answer 3' }), 'No');
    await userEvent.click(screen.getByRole('button', { name: 'Send answers' }));

    expect(onSubmit).toHaveBeenCalledWith(['Only in-app', ['Owner'], 'No']);
  });

  it('shows the questions read-only with the reply once answered', () => {
    render(<AskUser.Questions questions={questions} onSubmit={vi.fn()} result={{ content: 'Push only' }} />);

    expect(screen.getByRole('status').textContent).toContain('Push only');
    expect(screen.getByText('Which channels by default?')).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send answers' })).toBeNull();
  });
});
