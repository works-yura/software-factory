/**
 * The behaviour every `ObservabilitySource` must have. A new provider (Sentry, Datadog…) runs the
 * same suite against its adapter with the provider's HTTP faked from the seed:
 *
 *   describeObservabilitySourceContract('SentrySource', async seed => sourceOverFakeSentry(seed));
 *
 * The seed is provider-neutral; the adapter's test turns it into the provider's wire format. It
 * carries personal data on purpose: nothing of it may come back out.
 */

import { describe, expect, it } from 'vitest';

import { OBSERVABILITY_LIMITS, ObservabilityQueryError, ObservabilityUnsupportedError } from './observability.ts';
import type { LogSeverity, ObservabilitySource } from './observability.ts';

export interface ObservabilityContractSeed {
  /** Newest first, as providers return them. */
  logs: Array<{ timestamp: string; severity: LogSeverity; service: string; message: string }>;
  apps: Array<{ appId: string; platform: 'android' | 'ios' }>;
  issues: Array<{
    id: string;
    appId: string;
    title: string;
    subtitle: string;
    errorType: 'FATAL' | 'NON_FATAL' | 'ANR';
    eventsCount: number;
    impactedUsers: number;
    events: Array<{ id: string; time: string; message: string; log: string }>;
  }>;
}

export interface ObservabilityContractOptions {
  /** What the source under test supports; the suite checks the rest throws `ObservabilityUnsupportedError`. */
  features: { logs: boolean; crashes: boolean };
}

/** Personal data the seed carries; none of it may appear in any output. */
export const CONTRACT_PII = {
  email: 'anna.koval@example.com',
  phone: '+380 67 123 45 67',
  ip: '203.0.113.42',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  bearer: 'Bearer sk_live_51HxQwErTyUiOpAsDfGhJkL',
  googleKey: 'AIzaSyD-abcdefghijklmnopqrstuvwxyz012345',
} as const;

const now = new Date('2026-11-11T12:00:00Z');
const day = 86_400_000;

function piiLine(n: number): string {
  return (
    `booking ${n} failed for ${CONTRACT_PII.email} (${CONTRACT_PII.phone}) from ${CONTRACT_PII.ip}; ` +
    `auth ${CONTRACT_PII.bearer} token=${CONTRACT_PII.jwt} key=${CONTRACT_PII.googleKey}`
  );
}

/** A seed with more logs than one page may return, PII everywhere and a very long message. */
export function observabilityContractSeed(): ObservabilityContractSeed {
  const logs = Array.from({ length: OBSERVABILITY_LIMITS.maxLogEntries + 20 }, (_, index) => ({
    timestamp: new Date(now.getTime() - (index + 1) * 60_000).toISOString(),
    severity: (index % 3 === 0 ? 'ERROR' : 'INFO') as LogSeverity,
    service: 'bookings-api',
    message: index === 0 ? `${piiLine(index)} ${'x'.repeat(OBSERVABILITY_LIMITS.maxMessageChars * 2)}` : piiLine(index),
  }));
  return {
    logs,
    apps: [{ appId: '1:1234567890:android:abc123', platform: 'android' }],
    issues: [
      {
        id: 'issue-1',
        appId: '1:1234567890:android:abc123',
        title: `NullPointerException in BookingActivity for ${CONTRACT_PII.email}`,
        subtitle: 'com.syncta.booking.BookingActivity.onCreate',
        errorType: 'FATAL',
        eventsCount: 42,
        impactedUsers: 17,
        events: Array.from({ length: OBSERVABILITY_LIMITS.maxCrashEvents + 5 }, (_, index) => ({
          id: `event-${index}`,
          time: new Date(now.getTime() - (index + 1) * 3_600_000).toISOString(),
          message: piiLine(index),
          log: piiLine(index),
        })),
      },
    ],
  };
}

function everyString(value: unknown, visit: (text: string) => void): void {
  if (typeof value === 'string') visit(value);
  else if (Array.isArray(value)) value.forEach(item => everyString(item, visit));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => everyString(item, visit));
}

function expectNoPii(value: unknown): void {
  everyString(value, text => {
    for (const secret of Object.values(CONTRACT_PII)) expect(text).not.toContain(secret);
    expect(text).not.toContain('sk_live_');
  });
}

export function describeObservabilitySourceContract(
  name: string,
  setup: (seed: ObservabilityContractSeed) => Promise<ObservabilitySource>,
  options: ObservabilityContractOptions,
): void {
  const window = { from: new Date(now.getTime() - 7 * day), to: now };

  describe(`${name} — ObservabilitySource contract`, () => {
    it('declares the features it has', async () => {
      const source = await setup(observabilityContractSeed());
      expect(source.features).toEqual(options.features);
    });

    it('names the provider project it reads, so a Factory with several can pick one', async () => {
      const source = await setup(observabilityContractSeed());
      expect(source.target.ref.length).toBeGreaterThan(0);
      expect(source.target.name.length).toBeGreaterThan(0);
    });

    it('refuses a window that is reversed or too wide, before calling the provider', async () => {
      const source = await setup(observabilityContractSeed());
      const wide = { from: new Date(now.getTime() - (OBSERVABILITY_LIMITS.maxWindowDays + 1) * day), to: now };
      if (options.features.logs) {
        await expect(source.queryLogs({ from: now, to: window.from, limit: 10 })).rejects.toBeInstanceOf(
          ObservabilityQueryError,
        );
        await expect(source.queryLogs({ ...wide, limit: 10 })).rejects.toBeInstanceOf(ObservabilityQueryError);
      }
      if (options.features.crashes) {
        await expect(source.listCrashIssues({ ...wide, limit: 10 })).rejects.toBeInstanceOf(ObservabilityQueryError);
      }
    });

    if (options.features.logs) {
      it('returns at most the page limit, newest first, redacted and cut', async () => {
        const source = await setup(observabilityContractSeed());
        const page = await source.queryLogs({ ...window, limit: 10_000 });
        expect(page.entries.length).toBeGreaterThan(0);
        expect(page.entries.length).toBeLessThanOrEqual(OBSERVABILITY_LIMITS.maxLogEntries);
        const times = page.entries.map(entry => Date.parse(entry.timestamp));
        expect([...times].sort((a, b) => b - a)).toEqual(times);
        for (const entry of page.entries) {
          expect(entry.message.length).toBeLessThanOrEqual(OBSERVABILITY_LIMITS.maxMessageChars + 1);
        }
        expectNoPii(page);
      });

      it('clamps an empty limit to at least one entry', async () => {
        const source = await setup(observabilityContractSeed());
        const page = await source.queryLogs({ ...window, limit: 0 });
        expect(page.entries.length).toBeGreaterThanOrEqual(1);
      });
    } else {
      it('throws ObservabilityUnsupportedError for logs', async () => {
        const source = await setup(observabilityContractSeed());
        await expect(source.queryLogs({ ...window, limit: 10 })).rejects.toBeInstanceOf(ObservabilityUnsupportedError);
      });
    }

    if (options.features.crashes) {
      it('lists crash issues within the limit, redacted', async () => {
        const source = await setup(observabilityContractSeed());
        const issues = await source.listCrashIssues({ ...window, limit: 10_000 });
        expect(issues.length).toBeGreaterThan(0);
        expect(issues.length).toBeLessThanOrEqual(OBSERVABILITY_LIMITS.maxCrashIssues);
        expect(issues[0]).toMatchObject({ id: 'issue-1', errorType: 'FATAL', eventsCount: 42, impactedUsers: 17 });
        expectNoPii(issues);
      });

      it('reads one issue with at most the events limit, redacted', async () => {
        const source = await setup(observabilityContractSeed());
        const issue = await source.getCrashIssue({ ...window, issueId: 'issue-1', eventsLimit: 10_000 });
        expect(issue.id).toBe('issue-1');
        expect(issue.events.length).toBeGreaterThan(0);
        expect(issue.events.length).toBeLessThanOrEqual(OBSERVABILITY_LIMITS.maxCrashEvents);
        for (const event of issue.events) {
          expect(event.frames.length).toBeLessThanOrEqual(OBSERVABILITY_LIMITS.maxFrames);
          expect(event.logs.length).toBeLessThanOrEqual(OBSERVABILITY_LIMITS.maxEventLogs);
        }
        expectNoPii(issue);
      });

      it('refuses an app that is not mapped', async () => {
        const source = await setup(observabilityContractSeed());
        await expect(source.listCrashIssues({ ...window, appId: 'not-mapped', limit: 5 })).rejects.toBeInstanceOf(
          ObservabilityQueryError,
        );
      });
    } else {
      it('throws ObservabilityUnsupportedError for crashes', async () => {
        const source = await setup(observabilityContractSeed());
        await expect(source.listCrashIssues({ ...window, limit: 5 })).rejects.toBeInstanceOf(
          ObservabilityUnsupportedError,
        );
      });
    }
  });
}

/** The fixed "now" the seed is built around; adapters under test must use it as their clock. */
export const OBSERVABILITY_CONTRACT_NOW = now;
