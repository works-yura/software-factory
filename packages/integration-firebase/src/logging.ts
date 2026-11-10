/**
 * Cloud Logging reads (`POST https://logging.googleapis.com/v2/entries:list`) for one Google Cloud
 * project: the logs of Cloud Functions, Cloud Run, Hosting and everything else Firebase writes there.
 * Filters are built here from typed input only; nothing a caller types is pasted into the filter
 * language unescaped.
 */

import {
  LOG_SEVERITIES,
  OBSERVABILITY_LIMITS,
  ObservabilityQueryError,
  clampLimit,
  observabilityWindowProblem,
} from '@factory/capabilities';
import type { LogSeverity, ObservabilityLogEntry, ObservabilityLogPage, QueryLogsInput } from '@factory/capabilities';

import { LOGGING_API } from './google-api.ts';
import type { GoogleApiClient } from './google-api.ts';
import { redactAndCut, redactText } from './redact.ts';

export const LOGGING_ENTRIES_URL = 'https://logging.googleapis.com/v2/entries:list';

const SERVICE_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** A Cloud Logging string literal: quotes and backslashes escaped. */
function literal(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The Logging filter for one query; throws ObservabilityQueryError on input it will not send. */
export function buildLogFilter(input: QueryLogsInput): string {
  const parts = [`timestamp>=${literal(input.from.toISOString())}`, `timestamp<${literal(input.to.toISOString())}`];
  if (input.severityAtLeast) {
    if (!(LOG_SEVERITIES as readonly string[]).includes(input.severityAtLeast)) {
      throw new ObservabilityQueryError(`Unknown severity ${input.severityAtLeast}.`);
    }
    parts.push(`severity>=${input.severityAtLeast}`);
  }
  if (input.service !== undefined) {
    if (!SERVICE_NAME.test(input.service)) {
      throw new ObservabilityQueryError('service may hold only letters, digits, dot, dash and underscore.');
    }
    const name = literal(input.service);
    parts.push(
      `(resource.labels.service_name=${name} OR resource.labels.function_name=${name} OR resource.labels.job_name=${name} OR resource.labels.module_id=${name})`,
    );
  }
  if (input.text !== undefined) {
    const text = input.text.trim();
    if (!text || text.length > 200) throw new ObservabilityQueryError('text must be 1–200 characters.');
    // A bare string literal is a global restriction: it matches the text in any field.
    parts.push(literal(text));
  }
  return parts.join(' AND ');
}

interface LoggingEntry {
  timestamp?: string;
  receiveTimestamp?: string;
  severity?: string;
  logName?: string;
  resource?: { type?: string; labels?: Record<string, string> };
  textPayload?: string;
  jsonPayload?: Record<string, unknown>;
  protoPayload?: { status?: { message?: string }; methodName?: string; resourceName?: string };
  httpRequest?: { requestMethod?: string; requestUrl?: string; status?: number; latency?: string };
  trace?: string;
}

interface LoggingListResponse {
  entries?: LoggingEntry[];
  nextPageToken?: string;
}

function severityOf(value: string | undefined): LogSeverity {
  return (LOG_SEVERITIES as readonly string[]).includes(value ?? '') ? (value as LogSeverity) : 'DEFAULT';
}

function serviceOf(resource: LoggingEntry['resource']): string | null {
  const labels = resource?.labels ?? {};
  return labels.service_name ?? labels.function_name ?? labels.job_name ?? labels.module_id ?? null;
}

function messageOf(entry: LoggingEntry): string {
  if (entry.textPayload) return entry.textPayload;
  const json = entry.jsonPayload;
  if (json) {
    for (const key of ['message', 'msg', 'error', 'textPayload']) {
      const value = json[key];
      if (typeof value === 'string' && value) return value;
    }
    return JSON.stringify(json);
  }
  if (entry.protoPayload) {
    return [entry.protoPayload.methodName, entry.protoPayload.resourceName, entry.protoPayload.status?.message]
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

/** `GET 500 /api/bookings` — the path only: query strings carry ids and tokens. */
function requestOf(http: LoggingEntry['httpRequest']): string | undefined {
  if (!http?.requestMethod) return undefined;
  let path = http.requestUrl ?? '';
  try {
    path = new URL(path).pathname;
  } catch {
    path = path.split('?')[0] ?? '';
  }
  return redactText([http.requestMethod, http.status, path].filter(value => value !== undefined && value !== '').join(' '));
}

export function toLogEntry(entry: LoggingEntry): ObservabilityLogEntry {
  const request = requestOf(entry.httpRequest);
  return {
    timestamp: entry.timestamp ?? entry.receiveTimestamp ?? '',
    severity: severityOf(entry.severity),
    resourceType: entry.resource?.type ?? null,
    service: serviceOf(entry.resource),
    message: redactAndCut(messageOf(entry), OBSERVABILITY_LIMITS.maxMessageChars),
    ...(request ? { request } : {}),
    ...(entry.trace ? { trace: entry.trace.split('/').pop() ?? entry.trace } : {}),
  };
}

export class CloudLoggingReader {
  readonly #client: GoogleApiClient;
  readonly #projectId: string;
  readonly #now: () => Date;

  constructor(client: GoogleApiClient, projectId: string, now: () => Date = () => new Date()) {
    this.#client = client;
    this.#projectId = projectId;
    this.#now = now;
  }

  async query(input: QueryLogsInput): Promise<ObservabilityLogPage> {
    const problem = observabilityWindowProblem(input.from, input.to, this.#now());
    if (problem) throw new ObservabilityQueryError(problem);
    const response = await this.#client.request<LoggingListResponse>(LOGGING_API, LOGGING_ENTRIES_URL, {
      method: 'POST',
      body: {
        resourceNames: [`projects/${this.#projectId}`],
        filter: buildLogFilter(input),
        orderBy: 'timestamp desc',
        pageSize: clampLimit(input.limit, OBSERVABILITY_LIMITS.maxLogEntries),
        ...(input.pageToken ? { pageToken: input.pageToken } : {}),
      },
    });
    return {
      entries: (response.entries ?? []).slice(0, OBSERVABILITY_LIMITS.maxLogEntries).map(toLogEntry),
      nextPageToken: response.nextPageToken ?? null,
    };
  }
}
