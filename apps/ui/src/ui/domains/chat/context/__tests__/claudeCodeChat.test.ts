import { describe, expect, it } from 'vitest';

import type { FactoryProject } from '../../../workspaces/services/github';
import type { FactoryUserSession } from '../../../workspaces/services/user-sessions';
import { claudeCodeChat } from '../ChatSessionProvider';

const claudeFactory = { harness: 'claude-code', claudeCodeModel: 'sonnet' } as FactoryProject;
const claudeSession = { harness: 'claude-code' } as FactoryUserSession;
const mastraSession = {} as FactoryUserSession;

describe('claudeCodeChat', () => {
  it("shows the Factory's Claude model on a card's Claude Code session, not only on personal chats", () => {
    expect(
      claudeCodeChat({ userScoped: false, isUserDraft: false, storedSession: claudeSession, factory: claudeFactory }),
    ).toEqual({ model: 'sonnet' });
    expect(
      claudeCodeChat({ userScoped: true, isUserDraft: false, storedSession: claudeSession, factory: claudeFactory }),
    ).toEqual({ model: 'sonnet' });
  });

  it('leaves a Mastra session, and a card session not loaded yet, on the Mastra model picker', () => {
    expect(
      claudeCodeChat({ userScoped: false, isUserDraft: false, storedSession: mastraSession, factory: claudeFactory }),
    ).toBeUndefined();
    expect(
      claudeCodeChat({ userScoped: false, isUserDraft: false, storedSession: undefined, factory: claudeFactory }),
    ).toBeUndefined();
  });

  it("runs a personal draft on its Factory's harness", () => {
    expect(
      claudeCodeChat({ userScoped: true, isUserDraft: true, storedSession: undefined, factory: claudeFactory }),
    ).toEqual({ model: 'sonnet' });
  });
});
