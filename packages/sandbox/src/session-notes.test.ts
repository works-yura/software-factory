import { RequestContext } from '@mastra/core/request-context';
import { afterEach, describe, expect, it } from 'vitest';

import { __clearSessionEnvironmentsForTests, FactoryEnvironmentStateProcessor } from './environment-state-processor.ts';
import {
  __clearSessionNotesForTests,
  queueSessionNote,
  readSessionNotes,
  renderSessionNotes,
  RESTORED_SANDBOX_NOTE,
  restoredRepositoryNote,
  settleSessionNotes,
} from './session-notes.ts';

afterEach(() => {
  __clearSessionNotesForTests();
  __clearSessionEnvironmentsForTests();
});

describe('sandbox notes for the agent', () => {
  it('reach the next turn once: shown notes go when the run ends, notes queued after the signals were built stay', () => {
    queueSessionNote('s-1', RESTORED_SANDBOX_NOTE);
    queueSessionNote('s-1', RESTORED_SANDBOX_NOTE);
    expect(renderSessionNotes('s-1')).toBe(`<factory-sandbox>\n${RESTORED_SANDBOX_NOTE}\n</factory-sandbox>`);
    // Setup finished mid-turn and queued more after this turn's signals.
    queueSessionNote('s-1', 'later');
    settleSessionNotes('s-1');
    expect(readSessionNotes('s-1')).toEqual(['later']);
    settleSessionNotes('s-1');
    expect(renderSessionNotes('s-1')).toBeUndefined();
  });

  it('tells the agent what is gone, and never to force-push over a diverged branch', () => {
    expect(RESTORED_SANDBOX_NOTE).toMatch(/node_modules/);
    expect(RESTORED_SANDBOX_NOTE).toMatch(/dev servers/);
    expect(RESTORED_SANDBOX_NOTE).toMatch(/setup commands ran again/);
    const diverged = restoredRepositoryNote({ slug: 'acme/api', branch: 'factory/item-1', diverged: { saved: 'a'.repeat(40), remote: 'b'.repeat(40) } });
    expect(diverged).toMatch(/never force-push/);
    expect(diverged).toMatch(/origin\/factory\/item-1/);
    expect(restoredRepositoryNote({ slug: 'acme/api', branch: 'b', tree: 'conflict' })).toMatch(/refs\/factory\/saved-changes/);
    expect(restoredRepositoryNote({ slug: 'acme/api', branch: 'b', tree: 'restored' })).toBeUndefined();
  });

  it('a Mastra run sees them in its environment signal, even without a recorded environment', async () => {
    queueSessionNote('sess-1', RESTORED_SANDBOX_NOTE);
    const context = new RequestContext();
    context.set('controller', { sessionId: 'sess-1', resourceId: 'p', threadId: 't', getState: () => ({}) });
    const signal = (await new FactoryEnvironmentStateProcessor().computeStateSignal({
      requestContext: context,
      threadId: 't',
      resourceId: 'sess-1',
      activeStateSignals: [],
      contextWindow: { hasSnapshot: false },
      deltasSinceSnapshot: [],
    } as never)) as { contents: string } | undefined;
    expect(signal?.contents).toContain('restored from saved work');
  });
});
