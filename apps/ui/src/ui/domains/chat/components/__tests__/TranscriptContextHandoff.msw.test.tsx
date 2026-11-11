import type { MastraDBMessage } from '@mastra/core/agent-controller';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '../../../../../../e2e/ui/render';
import type { TimelineEntry } from '../../services/transcript';
import { TranscriptEntries } from '../Transcript';

const CREATED_AT = new Date('2026-11-11T10:00:00.000Z');

/** A context handoff's timeline marker, as the server stores it in the session's thread. */
function handoffEntry(marker: Record<string, unknown>, id = 'factory-context-handoff:h1'): TimelineEntry {
  const message: MastraDBMessage = {
    id,
    role: 'signal',
    createdAt: CREATED_AT,
    content: {
      format: 2,
      parts: [{ type: 'text', text: `Context handoff: ${String(marker.from)} → ${String(marker.to)}.` }],
      metadata: {
        signal: { id, type: 'reactive', tagName: 'factory-context-handoff', createdAt: CREATED_AT.toISOString() },
        contextHandoff: { handoffId: 'h1', fromInstanceId: 'claude-code', toInstanceId: 'codex', reason: 'switch', ...marker },
      },
    },
  };
  return { kind: 'message', id, message };
}

function renderEntries(entries: TimelineEntry[]) {
  return renderWithProviders(<TranscriptEntries entries={entries} onApprove={() => {}} onRespond={() => {}} />);
}

describe('TranscriptEntries context handoff divider', () => {
  it('draws the move as a divider, pending until the next message carries the context', () => {
    renderEntries([handoffEntry({ from: 'Claude Code', to: 'Codex', status: 'pending' })]);
    expect(
      screen.getByRole('separator', { name: 'Context handoff: Claude Code → Codex · carried with the next message' }),
    ).toBeInTheDocument();
    // The marker's own text is not drawn as a message.
    expect(screen.queryByText('Context handoff: Claude Code → Codex.')).not.toBeInTheDocument();
  });

  it('draws a delivered handoff plainly', () => {
    renderEntries([handoffEntry({ from: 'Claude Code', to: 'Codex', status: 'delivered' })]);
    expect(screen.getByRole('separator', { name: 'Context handoff: Claude Code → Codex' })).toBeInTheDocument();
  });

  it('marks a failed handoff and names why', () => {
    renderEntries([handoffEntry({ from: 'Mastra', to: 'Claude Code', status: 'failed', error: 'The request leaves too little context.' })]);
    expect(
      screen.getByRole('separator', {
        name: 'Context handoff: Mastra → Claude Code · failed — The request leaves too little context.',
      }),
    ).toBeInTheDocument();
  });

  it('says a lost conversation started anew on the same harness', () => {
    renderEntries([handoffEntry({ from: 'Codex', to: 'Codex', status: 'delivered', reason: 'resume_failed' })]);
    expect(screen.getByRole('separator', { name: 'Context handoff: Codex → Codex (new conversation)' })).toBeInTheDocument();
  });
});
