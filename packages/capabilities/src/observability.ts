/**
 * Observability: what a running product reports about itself — server logs and app crashes — read
 * by agents (bug triage, the stability audit). Read-only by contract: a source never changes the
 * provider's state (no issue closing, no log deletion).
 *
 * A provider (Firebase today; Sentry, Datadog later) implements `ObservabilityProvider`; the agent
 * tools are written once against `ObservabilitySource`, so a new provider is one adapter. Every
 * string a source returns has already been redacted (emails, phone numbers, tokens, IPs) and cut to
 * the limits below: nothing raw leaves an adapter.
 */

/** Cloud Logging's severities, lowest first; providers map theirs onto these. */
export const LOG_SEVERITIES = [
  'DEFAULT',
  'DEBUG',
  'INFO',
  'NOTICE',
  'WARNING',
  'ERROR',
  'CRITICAL',
  'ALERT',
  'EMERGENCY',
] as const;
export type LogSeverity = (typeof LOG_SEVERITIES)[number];

/** Hard limits every source keeps, whatever a caller asks for. */
export const OBSERVABILITY_LIMITS = {
  /** Log entries per page. */
  maxLogEntries: 100,
  /** Crash issues per list. */
  maxCrashIssues: 50,
  /** Sample events per crash issue. */
  maxCrashEvents: 10,
  /** Characters of one log message, exception message or log line. */
  maxMessageChars: 2000,
  /** Stack frames per event (blamed frame first). */
  maxFrames: 15,
  /** Breadcrumb log lines per event. */
  maxEventLogs: 20,
  /** Widest time window one query may span, in days. */
  maxWindowDays: 31,
} as const;

/** Which Factory a read is for: the source answers only for the provider project mapped to it. */
export interface ObservabilityScope {
  orgId: string;
  factoryProjectId: string;
}

/** What a provider can read for this Factory. */
export interface ObservabilityFeatures {
  logs: boolean;
  crashes: boolean;
}

/** A mapped app (crashes are per app), as the tools list it. */
export interface ObservabilityApp {
  appId: string;
  platform: 'android' | 'ios' | 'web';
  label?: string;
}

export interface QueryLogsInput {
  from: Date;
  to: Date;
  /** Only entries at this severity or above. */
  severityAtLeast?: LogSeverity;
  /** A service, function or job name (Cloud Run service, Cloud Function, …). */
  service?: string;
  /** Free text the entry must contain. */
  text?: string;
  limit: number;
  pageToken?: string;
}

export interface ObservabilityLogEntry {
  timestamp: string;
  severity: LogSeverity;
  /** The provider's resource kind, e.g. `cloud_run_revision`, `cloud_function`. */
  resourceType: string | null;
  service: string | null;
  message: string;
  /** `GET 500 /api/bookings` for a request log; absent otherwise. */
  request?: string;
  trace?: string;
}

export interface ObservabilityLogPage {
  entries: ObservabilityLogEntry[];
  nextPageToken: string | null;
}

export interface ListCrashIssuesInput {
  /** One mapped app; all mapped apps when absent. */
  appId?: string;
  from: Date;
  to: Date;
  /** Only events from this app version (display version, e.g. `2.4.1`). */
  version?: string;
  limit: number;
}

export interface ObservabilityCrashIssue {
  id: string;
  appId: string;
  title: string;
  subtitle: string | null;
  /** `FATAL`, `NON_FATAL`, `ANR` as the provider names them. */
  errorType: string;
  state: string | null;
  eventsCount: number | null;
  impactedUsers: number | null;
  firstSeenVersion: string | null;
  lastSeenVersion: string | null;
  lastSeenAt: string | null;
  /** The issue in the provider's console, for a person to open. */
  url: string | null;
}

export interface ObservabilityCrashFrame {
  symbol: string | null;
  file: string | null;
  line: number | null;
  library: string | null;
  blamed: boolean;
}

export interface ObservabilityCrashEvent {
  id: string;
  time: string | null;
  version: string | null;
  device: string | null;
  os: string | null;
  exception: { type: string | null; title: string | null; message: string | null } | null;
  /** Blamed frame first, then the crashed stack, cut to `maxFrames`. */
  frames: ObservabilityCrashFrame[];
  /** The last breadcrumb log lines before the crash. */
  logs: string[];
  customKeys: Record<string, string>;
}

export interface GetCrashIssueInput {
  issueId: string;
  /** Required when more than one app is mapped. */
  appId?: string;
  from: Date;
  to: Date;
  eventsLimit: number;
}

export interface ObservabilityCrashIssueDetail extends ObservabilityCrashIssue {
  events: ObservabilityCrashEvent[];
}

/** One Factory's readable logs and crashes. A method for a feature the source lacks throws `ObservabilityUnsupportedError`. */
export interface ObservabilitySource {
  /** Stable provider id, e.g. `firebase`. */
  readonly provider: string;
  readonly features: ObservabilityFeatures;
  readonly apps: readonly ObservabilityApp[];
  queryLogs(input: QueryLogsInput): Promise<ObservabilityLogPage>;
  listCrashIssues(input: ListCrashIssuesInput): Promise<ObservabilityCrashIssue[]>;
  getCrashIssue(input: GetCrashIssueInput): Promise<ObservabilityCrashIssueDetail>;
}

/** Hands out the source for a Factory, or `null` when the org is not connected or the Factory is not mapped. */
export interface ObservabilityProvider {
  readonly provider: string;
  sourceFor(scope: ObservabilityScope): Promise<ObservabilitySource | null>;
}

/** The source has no such feature for this Factory (e.g. crashes with no app mapped). */
export class ObservabilityUnsupportedError extends Error {
  override name = 'ObservabilityUnsupportedError';
}

/** A query a source refuses before calling the provider (window too wide, unknown app, bad text). */
export class ObservabilityQueryError extends Error {
  override name = 'ObservabilityQueryError';
}

/**
 * The provider refused or failed. `missingRole` names the IAM role to grant when the refusal is a
 * permission one; `fix` is a one-line next step for a person (enable an API, re-upload a key).
 */
export class ObservabilityProviderError extends Error {
  override name = 'ObservabilityProviderError';
  readonly status: number | null;
  readonly missingRole: string | null;
  readonly fix: string | null;

  constructor(message: string, options: { status?: number | null; missingRole?: string | null; fix?: string | null } = {}) {
    super(message);
    this.status = options.status ?? null;
    this.missingRole = options.missingRole ?? null;
    this.fix = options.fix ?? null;
  }
}

/** Checks a time window against the limits; returns the error message, or `null` when it is fine. */
export function observabilityWindowProblem(from: Date, to: Date, now = new Date()): string | null {
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 'from and to must be valid ISO timestamps.';
  if (from >= to) return 'from must be before to.';
  if (to.getTime() > now.getTime() + 60_000) return 'to must not be in the future.';
  const days = (to.getTime() - from.getTime()) / 86_400_000;
  if (days > OBSERVABILITY_LIMITS.maxWindowDays) {
    return `The window may span at most ${OBSERVABILITY_LIMITS.maxWindowDays} days; narrow from/to.`;
  }
  return null;
}

/** `limit` clamped to 1..max. */
export function clampLimit(limit: number, max: number): number {
  if (!Number.isFinite(limit)) return max;
  return Math.max(1, Math.min(max, Math.floor(limit)));
}
