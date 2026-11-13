import { currentLanguage } from '../../../i18n';
import { translator } from '../../../i18n/t';

/** The server's sandbox setup progress event (`@factory/sandbox` `SANDBOX_SETUP_EVENT`). */
export const SANDBOX_SETUP_EVENT = 'factory_sandbox_setup';

export type SandboxSetupPhase = 'clone' | 'checkout' | 'env-files' | 'setup';
export type SandboxSetupFailureCode = 'timeout' | 'network' | 'no_access' | 'clone_failed' | 'setup_failed' | 'unknown';

export interface SandboxSetupFailure {
  code: SandboxSetupFailureCode;
  message: string;
  phase?: SandboxSetupPhase;
  repo?: string;
}

/** A session's sandbox setup as the chat last heard it. */
export interface SandboxSetupState {
  status: 'running' | 'done' | 'failed';
  /** `Date.now()` the setup began, read back from the event's elapsed time. */
  startedAt: number;
  elapsedMs: number;
  phase?: SandboxSetupPhase;
  repo?: string;
  index?: number;
  total: number;
  receivedBytes?: number;
  percent?: number;
  failures: SandboxSetupFailure[];
}

const PHASES = new Set<string>(['clone', 'checkout', 'env-files', 'setup']);
const CODES = new Set<string>(['timeout', 'network', 'no_access', 'clone_failed', 'setup_failed', 'unknown']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);
const phaseOf = (value: unknown) => (typeof value === 'string' && PHASES.has(value) ? (value as SandboxSetupPhase) : undefined);

function readFailure(value: unknown): SandboxSetupFailure | undefined {
  if (!isRecord(value)) return undefined;
  const code = typeof value.code === 'string' && CODES.has(value.code) ? (value.code as SandboxSetupFailureCode) : 'unknown';
  const phase = phaseOf(value.phase);
  const repo = text(value.repo);
  return { code, message: text(value.message) ?? '', ...(phase ? { phase } : {}), ...(repo ? { repo } : {}) };
}

/** The setup an event reports, or `undefined` for any other event. */
export function readSandboxSetupEvent(event: { type: string }, now = Date.now()): SandboxSetupState | undefined {
  if (event.type !== SANDBOX_SETUP_EVENT) return undefined;
  const raw = event as Record<string, unknown>;
  const status = raw.status === 'done' || raw.status === 'failed' ? raw.status : 'running';
  const elapsedMs = count(raw.elapsedMs) ?? 0;
  const phase = phaseOf(raw.phase);
  const repo = text(raw.repo);
  const index = count(raw.index);
  const receivedBytes = count(raw.receivedBytes);
  const percent = count(raw.percent);
  return {
    status,
    startedAt: now - elapsedMs,
    elapsedMs,
    total: count(raw.total) ?? 1,
    failures: Array.isArray(raw.failures) ? raw.failures.flatMap(failure => readFailure(failure) ?? []) : [],
    ...(phase ? { phase } : {}),
    ...(repo ? { repo } : {}),
    ...(index !== undefined ? { index } : {}),
    ...(receivedBytes !== undefined ? { receivedBytes } : {}),
    ...(percent !== undefined ? { percent } : {}),
  };
}

/** A setup quicker than this leaves no summary behind: there was nothing to wait for. */
export const SANDBOX_SETUP_SUMMARY_MIN_MS = 5_000;

const tk = translator('chat');

/** `owner/name` reads as its name. */
function repoName(slug: string): string {
  return slug.slice(slug.lastIndexOf('/') + 1);
}

export function formatSetupTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return tk('sandboxSetup.seconds', { seconds: total });
  return tk('sandboxSetup.minutes', { minutes: Math.floor(total / 60), seconds: total % 60 });
}

function formatBytes(bytes: number): string {
  const oneDecimal = new Intl.NumberFormat(currentLanguage(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const units = [
    ['sandboxSetup.gigabytes', 1024 ** 3],
    ['sandboxSetup.megabytes', 1024 ** 2],
  ] as const;
  for (const [key, size] of units) {
    if (bytes >= size) return tk(key, { value: oneDecimal.format(bytes / size) });
  }
  return tk('sandboxSetup.kilobytes', { value: Math.max(1, Math.round(bytes / 1024)) });
}

function failureWords(failure: SandboxSetupFailure): string {
  const where = [
    failure.repo ? repoName(failure.repo) : tk('sandboxSetup.workspace'),
    ...(failure.phase ? [tk(`sandboxSetup.step.${failure.phase}`)] : []),
  ].join(' · ');
  return tk('sandboxSetup.failure', { where, reason: tk(`sandboxSetup.reason.${failure.code}`) });
}

export interface SandboxSetupWords {
  label: string;
  detail?: string;
  /** The server's own messages, for whoever wants the exact cause. */
  title?: string;
}

/** What the chat line says about a setup, `now` being the clock the line ticks on. */
export function sandboxSetupWords(setup: SandboxSetupState, now: number): SandboxSetupWords {
  const elapsed = setup.status === 'running' ? Math.max(setup.elapsedMs, now - setup.startedAt) : setup.elapsedMs;
  if (setup.status === 'failed') {
    const [first, ...rest] = setup.failures;
    if (!first) return { label: tk('sandboxSetup.failed') };
    return {
      label: tk('sandboxSetup.failed'),
      detail: [failureWords(first), ...(rest.length ? [tk('sandboxSetup.more', { count: rest.length })] : [])].join(' · '),
      title: setup.failures.map(failure => failure.message).filter(Boolean).join('\n\n') || undefined,
    };
  }
  if (setup.status === 'done') return { label: tk('sandboxSetup.done', { time: formatSetupTime(elapsed) }) };
  const parts: string[] = [];
  if (setup.phase) {
    parts.push(
      setup.repo
        ? tk(`sandboxSetup.phase.${setup.phase}`, { repo: repoName(setup.repo) })
        : tk('sandboxSetup.phase.workspaceSetup'),
    );
    if (setup.repo && setup.index !== undefined && setup.total > 1) {
      parts[0] += ` ${tk('sandboxSetup.position', { index: setup.index, total: setup.total })}`;
    }
  }
  if (setup.phase === 'clone' && setup.receivedBytes !== undefined) parts.push(formatBytes(setup.receivedBytes));
  if (setup.phase === 'clone' && setup.percent !== undefined) parts.push(`${setup.percent}%`);
  parts.push(formatSetupTime(elapsed));
  return { label: tk('sandboxSetup.running'), detail: parts.join(' · ') };
}
