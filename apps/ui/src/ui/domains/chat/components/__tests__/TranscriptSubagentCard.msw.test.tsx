import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '../../../../../../e2e/ui/render';
import { initialTranscript, subagentResultText, transcriptReducer } from '../../services/transcript';
import { TranscriptEntries } from '../Transcript';

type LiveEvent = Extract<Parameters<typeof transcriptReducer>[1], { type: 'event' }>['event'];

const LONG_TASK = `Read-only research. ${'Map how in-app notifications work today, with file:line references. '.repeat(10)}`;

function run(events: unknown[]) {
  return events.reduce<typeof initialTranscript>(
    (state, event) => transcriptReducer(state, { type: 'event', event: event as LiveEvent }),
    initialTranscript,
  ).entries;
}

const start = {
  type: 'subagent_start',
  toolCallId: 'toolu_agent',
  agentType: 'Explore',
  task: LONG_TASK,
  modelId: 'anthropic/claude-opus-5-5',
};

describe('SubagentCard', () => {
  it('folds a long task behind a toggle', async () => {
    renderWithProviders(<TranscriptEntries entries={run([start])} onApprove={() => {}} onRespond={() => {}} />);

    const toggle = screen.getByRole('button', { name: 'Show all' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows the subagent result and duration when it ends', () => {
    const entries = run([
      start,
      {
        type: 'subagent_end',
        toolCallId: 'toolu_agent',
        agentType: 'Explore',
        result: JSON.stringify([{ type: 'text', text: 'notificationService.js:42 writes the bell document.' }]),
        isError: false,
        durationMs: 12_400,
      },
    ]);
    renderWithProviders(<TranscriptEntries entries={entries} onApprove={() => {}} onRespond={() => {}} />);

    expect(screen.getByText('Result')).toBeInTheDocument();
    expect(screen.getByText('notificationService.js:42 writes the bell document.')).toBeInTheDocument();
    expect(screen.getByText('12 s')).toBeInTheDocument();
  });

  it('marks a failed subagent', () => {
    const entries = run([
      start,
      { type: 'subagent_end', toolCallId: 'toolu_agent', agentType: 'Explore', result: 'Interrupted', isError: true, durationMs: 0 },
    ]);
    renderWithProviders(<TranscriptEntries entries={entries} onApprove={() => {}} onRespond={() => {}} />);

    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Interrupted')).toBeInTheDocument();
  });
});

describe('subagentResultText', () => {
  it('joins Claude Code text blocks, and keeps plain text as is', () => {
    expect(
      subagentResultText(
        JSON.stringify([
          { type: 'text', text: 'one' },
          { type: 'text', text: 'two' },
        ]),
      ),
    ).toBe('one\n\ntwo');
    expect(subagentResultText('plain answer')).toBe('plain answer');
    expect(subagentResultText(undefined)).toBeUndefined();
  });
});
