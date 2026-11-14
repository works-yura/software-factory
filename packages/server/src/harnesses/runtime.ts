/**
 * The running turn harnesses as one set (ADR-0044): what `MastraFactory` asks of "whichever harness
 * holds this session" without naming one. Every answer goes through the modules' running facets in
 * the registry's order.
 */
import type { ClaudeCodeUserSessions, HarnessApiModule, HarnessStartCoordinators } from '@factory/api';
import type { ChatTranscriptSession } from '@factory/harness-claude-code-ui';
import type { HarnessExecutable } from '@factory/harness/executable';
import type { HarnessUsage } from '@factory/harness/usage';
import type { ModelSelection } from '@factory/harness/models/contracts';

import { CLAUDE_THREAD_SETTINGS } from '../claude/start-coordinator.ts';

import { combineTurnHarnessUserSessions } from '../codex/user-sessions.ts';
import type {
  HarnessBootDeps,
  PreparedTurnHarness,
  RunningTurnHarness,
  ServerHarnessModule,
  TurnHarnessHost,
  TurnHarnessModule,
  TurnHarnessSession,
} from './module.ts';
import { turnHarnessModules } from './registry.ts';

/** A turn harness module whose config is present, booted. */
export interface PreparedTurnHarnessEntry {
  readonly module: TurnHarnessModule<any, string>;
  readonly prepared: PreparedTurnHarness;
}

/**
 * Boots every turn harness the config has: its executable resolved, its usage facet built. A module
 * whose `configKey` the config lacks does not run.
 */
export function prepareTurnHarnesses(
  modules: readonly ServerHarnessModule[],
  configs: Readonly<Record<string, unknown>>,
  boot: HarnessBootDeps,
): PreparedTurnHarnessEntry[] {
  return turnHarnessModules(modules).flatMap(module => {
    const config = configs[module.configKey];
    return config === undefined ? [] : [{ module, prepared: module.prepare(config as never, boot) }];
  });
}

/** The CLIs the prepared harnesses spawn (for the boot log and `/web/config/versions`). */
export function preparedExecutables(prepared: readonly PreparedTurnHarnessEntry[]): HarnessExecutable[] {
  return prepared.flatMap(entry => (entry.prepared.executable ? [entry.prepared.executable] : []));
}

/** Their usage facets, in the registry's order. */
export function preparedUsageFacets(prepared: readonly PreparedTurnHarnessEntry[]): HarnessUsage[] {
  return prepared.flatMap(entry => (entry.prepared.usage ? [entry.prepared.usage] : []));
}

export interface TurnHarnesses {
  readonly running: readonly RunningTurnHarness[];
  /** The running harness with this id. */
  byId(harnessId: string): RunningTurnHarness | undefined;
  /** The harness holding a session and the session, among `filter`'s harnesses (all by default). */
  holding(
    sessionId: string,
    filter?: (harness: RunningTurnHarness) => boolean,
  ): Promise<{ harness: RunningTurnHarness; session: TurnHarnessSession } | undefined>;
  /** A session for the chat UI from whichever harness resolves it. */
  resolveChatSession(sessionId: string): Promise<ChatTranscriptSession | undefined>;
  /** The chat's model of a session, from its harness; null when no harness claims it. */
  modelSelection(session: ChatTranscriptSession): Promise<ModelSelection | null>;
  /** Personal sessions on every turn harness; undefined when none runs. */
  userSessions(): ClaudeCodeUserSessions | undefined;
  /** Every harness's card start path, by harness id. */
  startCoordinators(): HarnessStartCoordinators;
  /**
   * A side session of a Factory on `harness`, on that harness (the Factory's thread convention: the
   * thread is the session id); undefined when `harness` is no running turn harness.
   */
  createSideSession(input: { harness: string; sessionId: string; resourceId: string; title: string }): Promise<TurnHarnessSession | undefined>;
  /** Removes a deleted session's own CLI state, whichever harness ran it. */
  removeSessionFiles(sessionId: string): Promise<void>;
}

export function createTurnHarnesses(prepared: readonly PreparedTurnHarnessEntry[], host: TurnHarnessHost): TurnHarnesses {
  const running = prepared.map(entry => entry.prepared.create(host));
  return {
    running,
    byId: harnessId => running.find(harness => harness.descriptor.id === harnessId),
    async holding(sessionId, filter = () => true) {
      for (const harness of running) {
        if (!filter(harness)) continue;
        const session = await harness.harness.getSession(sessionId);
        if (session) return { harness, session };
      }
      return undefined;
    },
    async resolveChatSession(sessionId) {
      for (const harness of running) {
        const session = await harness.resolveChatSession(sessionId);
        if (session) return session;
      }
      return undefined;
    },
    async modelSelection(session) {
      for (const harness of running) {
        const selection = harness.modelSelection(session);
        if (selection !== undefined) return selection;
      }
      return null;
    },
    userSessions: () => combineTurnHarnessUserSessions(Object.fromEntries(running.map(harness => [harness.descriptor.id, harness.userSessions]))),
    startCoordinators: () =>
      Object.fromEntries(running.flatMap(harness => (harness.startCoordinator ? [[harness.descriptor.id, harness.startCoordinator]] : []))),
    async createSideSession({ harness: harnessId, sessionId, resourceId, title }) {
      const harness = running.find(candidate => candidate.descriptor.id === harnessId);
      if (!harness) return undefined;
      const session =
        (await harness.harness.getSession(sessionId)) ?? (await harness.harness.createSession({ sessionId, threadId: sessionId, resourceId }));
      await session.thread.setSetting({ key: CLAUDE_THREAD_SETTINGS.sessionId, value: sessionId });
      await session.thread.setSetting({ key: CLAUDE_THREAD_SETTINGS.title, value: title });
      return session;
    },
    async removeSessionFiles(sessionId) {
      await Promise.all(running.map(harness => harness.removeSessionFiles(sessionId)));
    },
  };
}

/**
 * The API's view of every harness the server knows: the base one always running, a turn harness
 * running when it is in `running`.
 */
export function harnessApiModules(modules: readonly ServerHarnessModule[], running: readonly RunningTurnHarness[]): HarnessApiModule[] {
  return modules.map(module => {
    if (module.kind === 'base') return { descriptor: module.descriptor, running: {} };
    const instance = running.find(harness => harness.descriptor.id === module.descriptor.id);
    return { descriptor: module.descriptor, featureFlags: module.featureFlags, ...(instance ? { running: instance.api } : {}) };
  });
}
