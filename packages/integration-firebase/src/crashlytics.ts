/**
 * Crashlytics reads through the Firebase Crashlytics REST API (v1alpha), the API the Firebase CLI's
 * own MCP server uses: the `topIssues` report for issues with their counts, and `events` for an
 * issue's sample crashes. It is an alpha API — a change on Google's side surfaces here as a loud
 * provider error, never as silently empty data. User ids, emails and names in events are dropped,
 * and every string is redacted before it leaves.
 *
 * Reference (checked 2026-11-11):
 *   https://firebase.google.com/docs/reference/crashlytics/rest/v1alpha/projects.apps.reports/get
 *   https://firebase.google.com/docs/reference/crashlytics/rest/v1alpha/projects.apps.events/list
 */

import {
  OBSERVABILITY_LIMITS,
  ObservabilityProviderError,
  ObservabilityQueryError,
  clampLimit,
  observabilityWindowProblem,
} from '@factory/capabilities';
import type {
  GetCrashIssueInput,
  ListCrashIssuesInput,
  ObservabilityApp,
  ObservabilityCrashEvent,
  ObservabilityCrashFrame,
  ObservabilityCrashIssue,
  ObservabilityCrashIssueDetail,
} from '@factory/capabilities';

import { CRASHLYTICS_API } from './google-api.ts';
import type { GoogleApiClient } from './google-api.ts';
import { redactAndCut, redactText } from './redact.ts';

export const CRASHLYTICS_BASE_URL = 'https://firebasecrashlytics.googleapis.com/v1alpha';

const ISSUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const VERSION = /^[A-Za-z0-9 ._()+-]{1,64}$/;

interface CrashlyticsIssue {
  id?: string;
  title?: string;
  subtitle?: string;
  errorType?: string;
  state?: string;
  firstSeenVersion?: string;
  lastSeenVersion?: string;
  lastSeenTime?: string;
  uri?: string;
}

interface CrashlyticsReport {
  groups?: Array<{ issue?: CrashlyticsIssue; metrics?: Array<{ eventsCount?: string | number; impactedUsersCount?: string | number }> }>;
}

interface CrashlyticsFrame {
  symbol?: string;
  file?: string;
  line?: string | number;
  library?: string;
  blamed?: boolean;
}

interface CrashlyticsEvent {
  name?: string;
  eventId?: string;
  eventTime?: string;
  version?: { displayVersion?: string; buildVersion?: string };
  device?: { marketingName?: string; displayName?: string; model?: string; manufacturer?: string };
  operatingSystem?: { displayName?: string; displayVersion?: string };
  blameFrame?: CrashlyticsFrame;
  exceptions?: Array<{ type?: string; title?: string; exceptionMessage?: string; blamed?: boolean; frames?: CrashlyticsFrame[] }>;
  errors?: Array<{ title?: string; subtitle?: string; blamed?: boolean; frames?: CrashlyticsFrame[] }>;
  threads?: Array<{ crashed?: boolean; blamed?: boolean; title?: string; frames?: CrashlyticsFrame[] }>;
  logs?: Array<{ message?: string }>;
  customKeys?: Record<string, string>;
}

interface CrashlyticsEventList {
  events?: CrashlyticsEvent[];
}

const count = (value: string | number | undefined): number | null => {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const text = (value: string | undefined, max: number = OBSERVABILITY_LIMITS.maxMessageChars): string | null =>
  value ? redactAndCut(value, max) : null;

function toIssue(appId: string, issue: CrashlyticsIssue, metrics: { eventsCount?: string | number; impactedUsersCount?: string | number } | undefined): ObservabilityCrashIssue {
  if (!issue.id) throw new ObservabilityProviderError('Crashlytics returned an issue without an id; the API may have changed.');
  return {
    id: issue.id,
    appId,
    title: text(issue.title, 300) ?? '(untitled)',
    subtitle: text(issue.subtitle, 300),
    errorType: issue.errorType ?? 'UNKNOWN',
    state: issue.state ?? null,
    eventsCount: count(metrics?.eventsCount),
    impactedUsers: count(metrics?.impactedUsersCount),
    firstSeenVersion: issue.firstSeenVersion ?? null,
    lastSeenVersion: issue.lastSeenVersion ?? null,
    lastSeenAt: issue.lastSeenTime ?? null,
    url: issue.uri ?? null,
  };
}

function toFrame(frame: CrashlyticsFrame): ObservabilityCrashFrame {
  const line = count(frame.line);
  return {
    symbol: text(frame.symbol, 300),
    file: text(frame.file, 300),
    line,
    library: text(frame.library, 200),
    blamed: frame.blamed === true,
  };
}

/** Blamed frame first, then the crashed stack (blamed exception, error or crashed thread). */
function framesOf(event: CrashlyticsEvent): ObservabilityCrashFrame[] {
  const stack =
    event.exceptions?.find(exception => exception.blamed)?.frames ??
    event.exceptions?.[0]?.frames ??
    event.errors?.find(error => error.blamed)?.frames ??
    event.threads?.find(thread => thread.crashed || thread.blamed)?.frames ??
    [];
  const frames = [...(event.blameFrame ? [event.blameFrame] : []), ...stack].map(toFrame);
  return frames.slice(0, OBSERVABILITY_LIMITS.maxFrames);
}

export function toCrashEvent(event: CrashlyticsEvent): ObservabilityCrashEvent {
  const exception = event.exceptions?.find(item => item.blamed) ?? event.exceptions?.[0];
  const error = event.errors?.find(item => item.blamed) ?? event.errors?.[0];
  const device = event.device?.marketingName ?? event.device?.displayName ?? event.device?.model ?? null;
  const os = [event.operatingSystem?.displayName, event.operatingSystem?.displayVersion].filter(Boolean).join(' ') || null;
  return {
    id: event.eventId ?? event.name?.split('/').pop() ?? '',
    time: event.eventTime ?? null,
    version: event.version?.displayVersion ?? null,
    device: device ? redactText(device) : null,
    os,
    exception: exception
      ? { type: text(exception.type, 200), title: text(exception.title, 300), message: text(exception.exceptionMessage) }
      : error
        ? { type: null, title: text(error.title, 300), message: text(error.subtitle) }
        : null,
    frames: framesOf(event),
    logs: (event.logs ?? [])
      .slice(-OBSERVABILITY_LIMITS.maxEventLogs)
      .map(log => redactAndCut(log.message ?? '', 500)),
    customKeys: Object.fromEntries(
      Object.entries(event.customKeys ?? {})
        .slice(0, 30)
        .map(([key, value]) => [redactAndCut(key, 100), redactAndCut(String(value), 300)]),
    ),
  };
}

export class CrashlyticsReader {
  readonly #client: GoogleApiClient;
  /** The project number (or id) Crashlytics paths take. */
  readonly #project: string;
  readonly #apps: readonly ObservabilityApp[];
  readonly #now: () => Date;

  constructor(client: GoogleApiClient, project: string, apps: readonly ObservabilityApp[], now: () => Date = () => new Date()) {
    this.#client = client;
    this.#project = project;
    this.#apps = apps;
    this.#now = now;
  }

  #checkWindow(from: Date, to: Date): void {
    const problem = observabilityWindowProblem(from, to, this.#now());
    if (problem) throw new ObservabilityQueryError(problem);
    if (this.#now().getTime() - from.getTime() > 90 * 86_400_000) {
      throw new ObservabilityQueryError('Crashlytics keeps 90 days; from must be within the last 90 days.');
    }
  }

  #appsFor(appId: string | undefined): readonly ObservabilityApp[] {
    if (appId === undefined) return this.#apps;
    const app = this.#apps.find(candidate => candidate.appId === appId);
    if (!app) {
      throw new ObservabilityQueryError(
        `App ${appId} is not mapped to this Factory. Mapped: ${this.#apps.map(candidate => candidate.appId).join(', ') || 'none'}.`,
      );
    }
    return [app];
  }

  #reportUrl(appId: string, params: Record<string, string>): string {
    const query = new URLSearchParams(params).toString();
    return `${CRASHLYTICS_BASE_URL}/projects/${encodeURIComponent(this.#project)}/apps/${encodeURIComponent(appId)}/reports/topIssues?${query}`;
  }

  #interval(from: Date, to: Date): Record<string, string> {
    return { 'filter.interval.startTime': from.toISOString(), 'filter.interval.endTime': to.toISOString() };
  }

  async listIssues(input: ListCrashIssuesInput): Promise<ObservabilityCrashIssue[]> {
    this.#checkWindow(input.from, input.to);
    if (input.version !== undefined && !VERSION.test(input.version)) throw new ObservabilityQueryError('version is not a valid app version.');
    const limit = clampLimit(input.limit, OBSERVABILITY_LIMITS.maxCrashIssues);
    const apps = this.#appsFor(input.appId);
    const lists = await Promise.all(
      apps.map(async app => {
        const report = await this.#client.request<CrashlyticsReport>(
          CRASHLYTICS_API,
          this.#reportUrl(app.appId, {
            ...this.#interval(input.from, input.to),
            ...(input.version ? { 'filter.version.displayNames': input.version } : {}),
            pageSize: String(limit),
          }),
        );
        return (report.groups ?? []).filter(group => group.issue).map(group => toIssue(app.appId, group.issue!, group.metrics?.[0]));
      }),
    );
    return lists
      .flat()
      .sort((a, b) => (b.eventsCount ?? 0) - (a.eventsCount ?? 0))
      .slice(0, limit);
  }

  async getIssue(input: GetCrashIssueInput): Promise<ObservabilityCrashIssueDetail> {
    this.#checkWindow(input.from, input.to);
    if (!ISSUE_ID.test(input.issueId)) throw new ObservabilityQueryError('issueId is not a Crashlytics issue id.');
    const apps = this.#appsFor(input.appId);
    if (apps.length !== 1) {
      throw new ObservabilityQueryError(`Several apps are mapped; pass appId (one of: ${apps.map(app => app.appId).join(', ')}).`);
    }
    const appId = apps[0]!.appId;
    const interval = this.#interval(input.from, input.to);
    const report = await this.#client.request<CrashlyticsReport>(
      CRASHLYTICS_API,
      this.#reportUrl(appId, { ...interval, 'filter.issue.id': input.issueId, pageSize: '1' }),
    );
    const group = report.groups?.find(candidate => candidate.issue?.id === input.issueId);
    if (!group?.issue) throw new ObservabilityQueryError(`No crash issue ${input.issueId} in app ${appId} for that window.`);
    const eventsLimit = clampLimit(input.eventsLimit, OBSERVABILITY_LIMITS.maxCrashEvents);
    const eventsUrl =
      `${CRASHLYTICS_BASE_URL}/projects/${encodeURIComponent(this.#project)}/apps/${encodeURIComponent(appId)}/events?` +
      new URLSearchParams({ ...interval, 'filter.issue.id': input.issueId, pageSize: String(eventsLimit) }).toString();
    const events = await this.#client.request<CrashlyticsEventList>(CRASHLYTICS_API, eventsUrl);
    return {
      ...toIssue(appId, group.issue, group.metrics?.[0]),
      events: (events.events ?? []).slice(0, eventsLimit).map(toCrashEvent),
    };
  }
}
