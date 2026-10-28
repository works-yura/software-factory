import { describe, expect, it } from 'vitest';

import { claudePermissionRules } from './permissions.ts';

describe('claudePermissionRules', () => {
  it('asks for every category that has no policy, as the settings page shows it', () => {
    const rules = claudePermissionRules({});
    expect(rules.allow).toEqual([]);
    expect(rules.deny).toEqual([]);
    expect(rules.ask).toEqual(expect.arrayContaining(['Read', 'Write', 'Edit', 'Bash', 'WebFetch', 'WebSearch', 'Task']));
  });

  it('maps each category to its tools: allow, ask, deny', () => {
    const rules = claudePermissionRules(
      { categories: { read: 'allow', edit: 'ask', execute: 'deny', mcp: 'deny', other: 'allow' } },
      { mcpServers: ['factory', 'factory_gate', 'linear'], trustedMcpServers: ['factory'] },
    );
    expect(rules.allow).toEqual(expect.arrayContaining(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task']));
    expect(rules.ask).toEqual(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
    expect(rules.deny).toEqual(['Bash', 'BashOutput', 'KillShell', 'Monitor', 'mcp__linear']);
  });

  it('allows everything on auto-approve', () => {
    const rules = claudePermissionRules({ yolo: true, categories: { execute: 'deny' } }, { mcpServers: ['linear'] });
    expect(rules.deny).toEqual([]);
    expect(rules.ask).toEqual([]);
    expect(rules.allow).toEqual(expect.arrayContaining(['Bash', 'Write', 'mcp__linear']));
  });

  it('moves a tool a person allowed for the session from ask to allow, never past a deny', () => {
    const rules = claudePermissionRules(
      { categories: { edit: 'ask', execute: 'deny', mcp: 'ask' } },
      { mcpServers: ['linear'], granted: ['Write', 'Bash', 'mcp__linear__create_issue'] },
    );
    expect(rules.allow).toEqual(expect.arrayContaining(['Write', 'mcp__linear__create_issue']));
    expect(rules.ask).toContain('Edit');
    expect(rules.ask).not.toContain('Write');
    // The server's ask rule would outrank the granted tool's allow rule.
    expect(rules.ask).not.toContain('mcp__linear');
    expect(rules.deny).toContain('Bash');
    expect(rules.allow).not.toContain('Bash');
  });
});
