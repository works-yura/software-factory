import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MCP_TOOL_POLICIES,
  mcpAgentToolName,
  mcpAssignmentKinds,
  mcpAssignmentMatches,
  mcpServerAvailable,
  mcpServerInputSchema,
  mcpToolHidden,
  mcpToolPolicy,
  mcpToolRisk,
  mcpToolsToQuarantine,
} from './model.ts';

describe('MCP server access', () => {
  const syncts = { factoryProjectId: 'syncts' };
  const chat = { factoryProjectId: 'syncts', kind: 'chat' as const };
  const personal = { factoryProjectId: 'syncts', kind: 'personal' as const };
  const card = (board?: string, phase?: string) => ({
    factoryProjectId: 'syncts',
    kind: 'card' as const,
    ...(board ? { board } : {}),
    ...(phase ? { phase } : {}),
  });

  it('reads a row without session kinds as it meant: no boards or phases = chat, personal sessions and cards', () => {
    expect(mcpAssignmentKinds(syncts)).toEqual(['chat', 'personal', 'cards']);
    expect(mcpAssignmentKinds({ factoryProjectId: 'syncts', boards: ['audits'] })).toEqual(['cards']);
    expect(mcpAssignmentMatches(syncts, chat)).toBe(true);
    expect(mcpAssignmentMatches(syncts, personal)).toBe(true);
    expect(mcpAssignmentMatches(syncts, card('work', 'triage'))).toBe(true);
    expect(mcpAssignmentMatches(syncts, { ...chat, factoryProjectId: 'other' })).toBe(false);
  });

  it('gives each session kind only when named: the Factory chat, members’ own sessions, cards', () => {
    const chatOnly = { factoryProjectId: 'syncts', sessions: ['chat' as const] };
    expect(mcpAssignmentMatches(chatOnly, chat)).toBe(true);
    expect(mcpAssignmentMatches(chatOnly, personal)).toBe(false);
    expect(mcpAssignmentMatches(chatOnly, card('work'))).toBe(false);
    const personalOnly = { factoryProjectId: 'syncts', sessions: ['personal' as const] };
    expect(mcpAssignmentMatches(personalOnly, personal)).toBe(true);
    expect(mcpAssignmentMatches(personalOnly, chat)).toBe(false);
  });

  it('limits cards to the named boards and phases; chat and personal sessions ignore those limits', () => {
    const audits = { factoryProjectId: 'syncts', sessions: ['cards' as const, 'chat' as const], boards: ['audits'], phases: ['analysis'] };
    expect(mcpAssignmentMatches(audits, card('audits', 'analysis'))).toBe(true);
    expect(mcpAssignmentMatches(audits, card('audits', 'intake'))).toBe(false);
    expect(mcpAssignmentMatches(audits, card('work', 'analysis'))).toBe(false);
    expect(mcpAssignmentMatches(audits, card())).toBe(false);
    expect(mcpAssignmentMatches(audits, chat)).toBe(true);
    expect(mcpAssignmentMatches(audits, personal)).toBe(false);
  });

  it('needs the server on and at least one matching assignment; a new server has none', () => {
    expect(mcpServerAvailable({ enabled: true, assignments: [] }, chat)).toBe(false);
    expect(mcpServerAvailable({ enabled: false, assignments: [syncts] }, chat)).toBe(false);
    expect(mcpServerAvailable({ enabled: true, assignments: [{ factoryProjectId: 'x' }, syncts] }, chat)).toBe(true);
  });
});

describe('MCP tool risk and quarantine', () => {
  it('reads the risk from annotations', () => {
    expect(mcpToolRisk(undefined)).toBe('unknown');
    expect(mcpToolRisk({ readOnlyHint: true })).toBe('read');
    expect(mcpToolRisk({ readOnlyHint: false, destructiveHint: true })).toBe('destructive');
    expect(mcpToolRisk({ readOnlyHint: false })).toBe('write');
    expect(mcpToolRisk({ title: 'x' })).toBe('unknown');
  });

  it('quarantines only new writing or destroying tools without a policy, and nothing on a first check', () => {
    const previous = [{ name: 'list', description: '' }];
    const current = [
      { name: 'list', description: '' },
      { name: 'read_more', description: '', annotations: { readOnlyHint: true } },
      { name: 'drop', description: '', annotations: { destructiveHint: true } },
      { name: 'add', description: '', annotations: { readOnlyHint: false } },
      { name: 'mystery', description: '' },
      { name: 'already_set', description: '', annotations: { readOnlyHint: false } },
    ];
    const policies = { default: 'allow' as const, tools: { already_set: 'allow' as const } };
    expect(mcpToolsToQuarantine(previous, current, policies)).toEqual(['drop', 'add']);
    expect(mcpToolsToQuarantine(undefined, current, policies)).toEqual([]);
  });

  it('hides denied and quarantined tools', () => {
    expect(mcpToolHidden('deny')).toBe(true);
    expect(mcpToolHidden('review')).toBe(true);
    expect(mcpToolHidden('ask')).toBe(false);
  });
});

describe('MCP tool policy', () => {
  it('allows everything by default and lets a tool override its server', () => {
    expect(mcpToolPolicy(DEFAULT_MCP_TOOL_POLICIES, 'firestore-query')).toBe('allow');
    const policies = { default: 'allow' as const, tools: { 'firestore-delete': 'deny' as const, 'firestore-add': 'ask' as const } };
    expect(mcpToolPolicy(policies, 'firestore-delete')).toBe('deny');
    expect(mcpToolPolicy(policies, 'firestore-add')).toBe('ask');
    expect(mcpToolPolicy({ default: 'ask', tools: {} }, 'anything')).toBe('ask');
  });

  it("names a tool as upstream Mastra does: server_tool", () => {
    expect(mcpAgentToolName('syncta-db', 'firestore-query')).toBe('syncta-db_firestore-query');
  });
});

describe('MCP server input', () => {
  it('defaults: no assignments, everything allowed, personal data masked, on', () => {
    const parsed = mcpServerInputSchema.parse({
      name: 'syncta-db',
      label: 'Syncta Firestore',
      launch: { transport: 'stdio', preset: 'toolbox-firestore' },
    });
    expect(parsed).toMatchObject({
      assignments: [],
      toolPolicies: { default: 'allow', tools: {} },
      maskPersonalData: true,
      enabled: true,
      launch: { transport: 'stdio', args: [], env: {} },
    });
  });

  it('refuses a name an agent tool name could not carry', () => {
    expect(() =>
      mcpServerInputSchema.parse({ name: 'Syncta DB', label: 'x', launch: { transport: 'http', url: 'https://x.test' } }),
    ).toThrow();
  });
});
