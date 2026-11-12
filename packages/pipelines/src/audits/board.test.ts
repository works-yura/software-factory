import { describe, expect, it } from 'vitest';

import { createDefaultBoardRegistry, defaultBoards } from '../defaults.ts';
import { AUDIT_CONTEXT, AUDIT_SKILL, auditsBoard } from './board.ts';
import { AUDIT_PROFILES, auditProfile, isUrgentFinding } from './profiles.ts';

describe('Audits board', () => {
  it('is installed by default after Work and Product', () => {
    expect(defaultBoards.map(board => board.id)).toEqual(['work', 'product', 'audits']);
    expect(createDefaultBoardRegistry().get('audits')).toBe(auditsBoard);
  });

  it('starts in Intake like every board and runs the audit in one session on its own', () => {
    const kinds = Object.fromEntries(Object.entries(auditsBoard.phases).map(([id, phase]) => [id, phase.kind]));
    expect(auditsBoard.initialPhase).toBe('intake');
    expect(kinds).toEqual({
      intake: 'resting',
      analysis: 'working',
      done: 'terminal',
      canceled: 'terminal',
    });
    const analysis = auditsBoard.phases.analysis;
    if (analysis.kind !== 'working') throw new Error('analysis should be working');
    expect(analysis.runner).toMatchObject({ context: AUDIT_CONTEXT, skill: AUDIT_SKILL });
    expect(auditsBoard.startsAutomatically('analysis')).toBe(true);
    for (const phase of ['intake', 'done', 'canceled']) {
      expect(auditsBoard.startsAutomatically(phase)).toBe(false);
    }
  });

  it('lets an intake rule file a card straight into Analysis, which ends in Done with the report', () => {
    const allowed = (from: string, to: string) => auditsBoard.allowsTransition(from as never, to as never);
    expect(allowed('intake', 'analysis')).toBe(true);
    expect(allowed('analysis', 'done')).toBe(true);
    expect(allowed('done', 'analysis')).toBe(true);
    expect(allowed('canceled', 'intake')).toBe(true);
    expect(allowed('intake', 'done')).toBe(false);
  });
});

describe('audit profiles', () => {
  it('are data: one kind, reference and urgency rule each, with unique kinds and topics', () => {
    const kinds = AUDIT_PROFILES.map(profile => profile.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(new Set(AUDIT_PROFILES.map(profile => profile.topic)).size).toBe(kinds.length);
    for (const profile of AUDIT_PROFILES) expect(profile.reference).toMatch(/^references\/[a-z-]+\.md$/);
  });

  it('call a finding urgent at or above the profile’s threshold', () => {
    const security = auditProfile('security')!;
    expect(isUrgentFinding(security, 'critical')).toBe(true);
    expect(isUrgentFinding(security, 'high')).toBe(true);
    expect(isUrgentFinding(security, 'medium')).toBe(false);
    expect(isUrgentFinding(auditProfile('dependencies')!, 'high')).toBe(false);
  });

  it('raise a prod-chats P0 or P1 (critical, high) to a person, and keep a P2 (medium) in the report', () => {
    const prodChats = auditProfile('prod-chats')!;
    expect(prodChats).toMatchObject({ topic: 'prod-chats', reference: 'references/prod-chats.md' });
    expect(isUrgentFinding(prodChats, 'critical')).toBe(true);
    expect(isUrgentFinding(prodChats, 'high')).toBe(true);
    expect(isUrgentFinding(prodChats, 'medium')).toBe(false);
  });
});
