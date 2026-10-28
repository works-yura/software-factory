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

  it('lets an unattended run read, and use git and gh, unless those categories are denied', () => {
    const rules = claudePermissionRules({ unattended: true }, { mcpServers: ['linear'] });
    expect(rules.allow).toEqual([...['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'], 'Bash(git:*)', 'Bash(gh:*)']);
    // An ask rule for Bash would outrank Bash(git:*); other commands reach the gate unlisted.
    expect(rules.ask).not.toContain('Bash');
    expect(rules.ask).toEqual(expect.arrayContaining(['Write', 'Edit', 'BashOutput', 'WebFetch', 'mcp__linear']));

    const denied = claudePermissionRules({ unattended: true, categories: { read: 'deny', execute: 'deny' } });
    expect(denied.allow).toEqual([]);
    expect(denied.deny).toEqual(expect.arrayContaining(['Read', 'Bash']));

    const allowed = claudePermissionRules({ unattended: true, categories: { execute: 'allow' } });
    expect(allowed.allow).toContain('Bash');
    expect(allowed.allow).not.toContain('Bash(git:*)');
  });

  it('asks about askEachTime tools on every call unless auto-approve, and lets a granted call through', () => {
    const tool = 'mcp__factory__factory_retry_decision';
    expect(claudePermissionRules({ categories: { read: 'allow' }, askEachTime: [tool] }).ask).toEqual(
      expect.arrayContaining([tool]),
    );
    expect(claudePermissionRules({ categories: { read: 'allow' }, askEachTime: ['Read'] })).toMatchObject({
      ask: expect.arrayContaining(['Read']),
      allow: expect.not.arrayContaining(['Read']),
    });
    const granted = claudePermissionRules({ askEachTime: [tool] }, { granted: [tool] });
    expect(granted.ask).not.toContain(tool);
    expect(granted.allow).toContain(tool);
    expect(claudePermissionRules({ yolo: true, askEachTime: [tool] }).ask).toEqual([]);
  });
});
