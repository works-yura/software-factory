import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MCP_TOOL_POLICIES,
  mcpAgentToolName,
  mcpAssignmentMatches,
  mcpServerAvailable,
  mcpServerInputSchema,
  mcpToolPolicy,
} from './model.ts';

describe('MCP server access', () => {
  const syncts = { factoryProjectId: 'syncts' };

  it('covers every session of a Factory when no board or phase is named, a chat included', () => {
    expect(mcpAssignmentMatches(syncts, { factoryProjectId: 'syncts' })).toBe(true);
    expect(mcpAssignmentMatches(syncts, { factoryProjectId: 'syncts', board: 'work', phase: 'triage' })).toBe(true);
    expect(mcpAssignmentMatches(syncts, { factoryProjectId: 'other' })).toBe(false);
  });

  it('limits to the named boards and phases; a chat (no card) never matches a limited assignment', () => {
    const audits = { factoryProjectId: 'syncts', boards: ['audits'], phases: ['analysis'] };
    expect(mcpAssignmentMatches(audits, { factoryProjectId: 'syncts', board: 'audits', phase: 'analysis' })).toBe(true);
    expect(mcpAssignmentMatches(audits, { factoryProjectId: 'syncts', board: 'audits', phase: 'intake' })).toBe(false);
    expect(mcpAssignmentMatches(audits, { factoryProjectId: 'syncts', board: 'work', phase: 'analysis' })).toBe(false);
    expect(mcpAssignmentMatches(audits, { factoryProjectId: 'syncts' })).toBe(false);
  });

  it('needs the server on and at least one matching assignment; a new server has none', () => {
    const scope = { factoryProjectId: 'syncts' };
    expect(mcpServerAvailable({ enabled: true, assignments: [] }, scope)).toBe(false);
    expect(mcpServerAvailable({ enabled: false, assignments: [syncts] }, scope)).toBe(false);
    expect(mcpServerAvailable({ enabled: true, assignments: [{ factoryProjectId: 'x' }, syncts] }, scope)).toBe(true);
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
