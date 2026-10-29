import { describe, expect, it } from 'vitest';

import {
  CLAUDE_TOOL_ALIASES,
  CLAUDE_TOOL_CATEGORY_TOOLS,
  CLAUDE_UNGOVERNED_TOOLS,
  claudePermissionRules,
} from './permissions.ts';

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

  it('grants a tool under its old name too, so an ask rule for the alias does not keep asking', () => {
    // The CLI matches `Task` rules against `Agent` calls: a lone grant for `Agent` kept asking.
    const rules = claudePermissionRules({}, { granted: ['Agent'] });
    expect(rules.allow).toEqual(expect.arrayContaining(['Agent', 'Task']));
    expect(rules.ask).not.toContain('Agent');
    expect(rules.ask).not.toContain('Task');
    expect(rules.ask).toContain('WebFetch');
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

  it('never lets askEachTime undo a deny, nor ask twice for one tool', () => {
    const rules = claudePermissionRules({ categories: { read: 'deny', edit: 'ask' }, askEachTime: ['Read', 'Write'] });
    expect(rules.deny).toContain('Read');
    expect(rules.ask.filter(rule => rule === 'Read')).toEqual([]);
    expect(rules.ask.filter(rule => rule === 'Write')).toEqual(['Write']);
  });

  it('keeps the other allowed tools when askEachTime takes one of them back', () => {
    const rules = claudePermissionRules({ categories: { edit: 'allow' }, askEachTime: ['Write'] });
    expect(rules.allow).toEqual(['Edit', 'MultiEdit', 'NotebookEdit']);
    expect(rules.ask).toContain('Write');
  });

  it('grants an askEachTime tool once without asking for it, and only it', () => {
    const rules = claudePermissionRules({ askEachTime: ['Write', 'Edit'] }, { granted: ['Write'] });
    expect(rules.allow.filter(rule => rule === 'Write')).toEqual(['Write']);
    expect(rules.ask).toContain('Edit');
    expect(rules.ask).not.toContain('Write');
  });

  it('grants the subagent tool under either name', () => {
    for (const name of ['Agent', 'Task']) {
      const rules = claudePermissionRules({}, { granted: [name] });
      expect([...rules.allow].sort()).toEqual(['Agent', 'Task']);
      expect(rules.ask).not.toEqual(expect.arrayContaining(['Agent']));
      expect(rules.ask).not.toEqual(expect.arrayContaining(['Task']));
    }
  });

  it('leaves an MCP server asked when only a built-in tool was granted', () => {
    const rules = claudePermissionRules({}, { mcpServers: ['linear'], granted: ['Write'] });
    expect(rules.ask).toContain('mcp__linear');
    // A grant for another server's tool does not unlock this one.
    const other = claudePermissionRules({}, { mcpServers: ['linear', 'jira'], granted: ['mcp__jira__create'] });
    expect(other.ask).toContain('mcp__linear');
    expect(other.ask).not.toContain('mcp__jira');
  });

  it('governs exactly these built-in tools per category', () => {
    expect(CLAUDE_TOOL_CATEGORY_TOOLS).toEqual({
      read: ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'],
      edit: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
      execute: ['Bash', 'BashOutput', 'KillShell', 'Monitor'],
      other: [
        'WebFetch',
        'WebSearch',
        'Task',
        'Agent',
        'Skill',
        'SlashCommand',
        'Workflow',
        'CronCreate',
        'CronDelete',
        'CronList',
        'ScheduleWakeup',
        'RemoteTrigger',
        'SendMessage',
        'ListAgents',
        'PushNotification',
        'EnterWorktree',
        'ExitWorktree',
      ],
    });
    expect(CLAUDE_TOOL_ALIASES).toEqual({ Agent: ['Task'], Task: ['Agent'] });
    expect(CLAUDE_UNGOVERNED_TOOLS).toEqual(['TodoWrite', 'ToolSearch', 'TaskStop', 'ReportFindings']);
  });
});
