import { describe, expect, it } from 'vitest';

import type { ObservabilityLogEntry } from '@factory/capabilities';

import { groupLogEntries, logPattern } from './log-groups.ts';

const entry = (over: Partial<ObservabilityLogEntry>): ObservabilityLogEntry => ({
  timestamp: '2026-11-11T10:00:00Z',
  severity: 'WARNING',
  resourceType: 'cloud_run_revision',
  service: 'aiagenttask',
  message: '',
  ...over,
});

describe('logPattern', () => {
  it('strips ids and numbers so the same error is one pattern', () => {
    const a = logPattern('WhatsApp delivery failed wamid.HBgMNTczMDAxMjMxNDg0FQIAEhgU code 131047 for biz Xy9aB3dE7fGh1jKl2mNo');
    const b = logPattern('WhatsApp delivery failed wamid.HBgMNTczMDA5OTk4ODc3FQIAEhgU code 131047 for biz Qq1aB3dE7fGh1jKl2mZz');
    expect(a).toBe(b);
    expect(a).toBe('WhatsApp delivery failed <id> code <n> for biz <id>');
  });

  it('keeps names that carry no digits, and only the first line', () => {
    expect(logPattern('aiAgent.replyBlockedTeamRequest\n  at handler.js:1590')).toBe('aiAgent.replyBlockedTeamRequest');
    expect(logPattern('job 3f2b8c1e-4d5a-4b6c-9d7e-1a2b3c4d5e6f took 26.4 s')).toBe('job <id> took <n> s');
  });
});

describe('groupLogEntries', () => {
  it('counts by severity, service and group, largest first, with first and last time and the newest sample', () => {
    const summary = groupLogEntries(
      [
        entry({ timestamp: '2026-11-11T12:00:00Z', message: 'timeout after 47 s', severity: 'ERROR' }),
        entry({ timestamp: '2026-11-11T09:00:00Z', message: 'timeout after 60 s' }),
        entry({ timestamp: '2026-11-11T11:00:00Z', message: 'timeout after 12 s' }),
        entry({ service: 'webhook', message: 'RetryLater: chat busy' }),
        entry({ service: null, request: 'POST 503 /api/hook', message: '' }),
      ],
      2,
    );
    expect(summary.bySeverity).toEqual({ ERROR: 1, WARNING: 4 });
    expect(summary.byService).toEqual({ aiagenttask: 3, webhook: 1, '(none)': 1 });
    expect(summary.groupsTotal).toBe(3);
    expect(summary.groups).toHaveLength(2);
    expect(summary.groups[0]).toEqual({
      service: 'aiagenttask',
      pattern: 'timeout after <n> s',
      count: 3,
      severity: 'ERROR',
      firstAt: '2026-11-11T09:00:00Z',
      lastAt: '2026-11-11T12:00:00Z',
      sample: 'timeout after 47 s',
    });
  });

  it('groups request entries by method, status and path', () => {
    const summary = groupLogEntries(
      [entry({ request: 'POST 503 /api/hook', message: '' }), entry({ request: 'POST 503 /api/hook', message: '' })],
      10,
    );
    expect(summary.groups[0]).toMatchObject({ pattern: 'POST <n> /api/hook', count: 2 });
  });
});
