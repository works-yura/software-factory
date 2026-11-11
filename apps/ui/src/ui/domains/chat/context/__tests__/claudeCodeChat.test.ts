import { CLAUDE_CODE_HARNESS, MASTRA_HARNESS } from '@factory/contracts/harnesses';
import { describe, expect, it } from 'vitest';

import type { FactoryProject } from '../../../workspaces/services/github';
import type { FactoryUserSession } from '../../../workspaces/services/user-sessions';
import { chatHarnessId, claudeCodeChat } from '../ChatSessionProvider';

const claudeFactory = {
  harness: 'claude-code',
  harnessModelDefaults: { 'claude-code': { instanceId: 'claude-code', model: 'sonnet' } },
} as unknown as FactoryProject;
const claudeSession = { harness: 'claude-code' } as FactoryUserSession;
const mastraSession = {} as FactoryUserSession;

describe('chatHarnessId', () => {
  it("reads a card's or personal session's harness from the stored session", () => {
    expect(
      chatHarnessId({ supervisor: false, isUserDraft: false, storedSession: claudeSession, factory: claudeFactory }),
    ).toBe('claude-code');
    expect(
      chatHarnessId({ supervisor: false, isUserDraft: false, storedSession: mastraSession, factory: claudeFactory }),
    ).toBeUndefined();
  });

  it("runs the Factory chat and a personal draft on the Factory's harness", () => {
    expect(chatHarnessId({ supervisor: true, isUserDraft: false, storedSession: undefined, factory: claudeFactory })).toBe(
      'claude-code',
    );
    expect(chatHarnessId({ supervisor: false, isUserDraft: true, storedSession: undefined, factory: claudeFactory })).toBe(
      'claude-code',
    );
  });

  it('leaves a card session not loaded yet unknown', () => {
    expect(
      chatHarnessId({ supervisor: false, isUserDraft: false, storedSession: undefined, factory: claudeFactory }),
    ).toBeUndefined();
  });
});

describe('claudeCodeChat', () => {
  it("shows the Factory's Claude model where the harness takes its model from the Factory", () => {
    expect(claudeCodeChat(CLAUDE_CODE_HARNESS, claudeFactory)).toEqual({ model: 'sonnet' });
    expect(claudeCodeChat(CLAUDE_CODE_HARNESS, undefined)).toEqual({ model: null });
  });

  it('leaves a per-session model harness on the Mastra model picker', () => {
    expect(claudeCodeChat(MASTRA_HARNESS, claudeFactory)).toBeUndefined();
  });
});
