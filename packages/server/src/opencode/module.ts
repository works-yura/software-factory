/**
 * OpenCode as a Factory harness module (ADR-0043, ADR-0044): its sessions live in the OpenCode
 * harness (the `opencode` CLI's server on this host, one per run), reach the Factory's tools over MCP
 * with a token minted per run, and show in the chat through the turn harnesses' session UI. They run
 * on OpenCode's own free models with no key or login, or signed in with one of the organization's
 * OpenCode accounts (Settings → Connections → OpenCode). Without the CLI, the facet lists OpenCode as
 * needing setup.
 */
import { join } from 'node:path';

import { OPENCODE_HARNESS } from '@factory/contracts';
import { OPENCODE_NOT_INSTALLED_REASON, OpenCodeSession, readOpenCodeAccountLimits } from '@factory/harness-opencode';
import type { OpenCodeSessionMode } from '@factory/harness-opencode';
import { harnessCommandAvailable } from '@factory/harness/executable';
import { withExecutableAvailability } from '@factory/harness/models/facet';

import { ClaudeStartCoordinator } from '../claude/start-coordinator.ts';
import { OPENCODE_EXECUTABLE, harnessExecutableFor } from '../harness-executables.ts';
import type { HarnessConfigFromEnv, TurnHarnessModule } from '../harnesses/module.ts';
import { storeParkedSessions } from '../session/usage-limit-resume.ts';
import { createOpenCodeAccounts, createOpenCodeHarnessUsage } from './accounts.ts';
import { createOpenCodeAccountsConnections } from './connections.ts';
import type { OpenCodeKeyCheck } from './connections.ts';
import { createOpenCodeFactoryHarness } from './harness.ts';
import type { OpenCodeFactoryHarnessOptions } from './harness.ts';
import { createOpenCodeLocalSessions } from './local-import.ts';
import { buildOpenCodeLocalSessionRoutes } from './local-session-routes.ts';
import { createOpenCodeUserSessions } from './user-sessions.ts';

/** How this server runs OpenCode sessions (see `createOpenCodeFactoryHarness`). */
export interface MastraFactoryOpenCodeConfig
  extends Pick<
    OpenCodeFactoryHarnessOptions,
    'store' | 'command' | 'sessionHomeRoot' | 'supervisorWorkdirRoot' | 'spawn' | 'env' | 'skillsDir' | 'turnTimeoutMs' | 'catalog'
  > {
  /** Where session records live (and, beside them, each session's own OpenCode state); required unless `store` is given. */
  storeDir?: string;
  /** Replaces the default checkout (`createClaudeCheckoutResolver`). */
  cwdFor?: (sessionId: string) => string | Promise<string>;
  /** The origin OpenCode reaches this server's MCP endpoint at; `publicUrl` by default. */
  mcpOrigin?: string;
  /**
   * The server runs on the person's own machine: their own OpenCode sessions can be continued in
   * the Factory (read-only from their OpenCode database, at their request; ADR-0043).
   */
  localDevelopment?: boolean;
  /** The person's OpenCode database; where OpenCode keeps it for this server's user by default. */
  localSessionsDatabase?: string;
}

/**
 * The deployment's OpenCode: each session keeps OpenCode's state in its own folders beside the store
 * (FACTORY_OPENCODE_STORE_DIR); agents never read this machine's own OpenCode (its
 * `~/.config/opencode`, `~/.local/share/opencode`); on the person's own machine the server reads
 * their sessions read-only when they ask to continue one. As the agent user: its own `opencode`,
 * session state and the Factory chat's folders where it can reach them.
 */
export const openCodeConfigFromEnv: HarnessConfigFromEnv<MastraFactoryOpenCodeConfig> = ({ env, home, ownMachine, agentUser }) => ({
  storeDir: env.FACTORY_OPENCODE_STORE_DIR?.trim() || join(home, '.mastracode', 'web', 'opencode-sessions'),
  localDevelopment: ownMachine,
  ...(env.FACTORY_OPENCODE_COMMAND?.trim() ? { command: env.FACTORY_OPENCODE_COMMAND.trim() } : {}),
  ...(agentUser ? agentUser.opencode() : {}),
});

/** An OpenCode key, checked with OpenCode before Settings › Connections keeps it. */
async function checkOpenCodeKey(apiKey: string): Promise<OpenCodeKeyCheck> {
  const limits = await readOpenCodeAccountLimits(apiKey);
  if (limits.unavailable?.reason === 'signed_out') return { ok: false, message: limits.unavailable.message ?? 'refused' };
  if (limits.unavailable?.reason === 'failed') return { ok: false, message: limits.unavailable.message ?? 'OpenCode did not answer.' };
  return { ok: true, go: limits.windows.length > 0 };
}

export const openCodeHarnessModule: TurnHarnessModule<MastraFactoryOpenCodeConfig, 'opencode'> = {
  kind: 'turn',
  descriptor: OPENCODE_HARNESS,
  configKey: 'opencode',
  featureFlags: ['opencodeLocalSessions'],
  configFromEnv: openCodeConfigFromEnv,
  prepare(config, boot) {
    const executable = harnessExecutableFor(config, OPENCODE_EXECUTABLE);
    // The organization's OpenCode accounts (Settings → Connections → OpenCode): runs sign in with one; none runs the free models.
    const accounts = createOpenCodeAccounts({ credentials: boot.credentials });
    // Asked each time: a CLI installed after boot makes OpenCode available without a restart.
    const installed = (): boolean => harnessCommandAvailable(executable ?? config.command, 'opencode', config.env ?? process.env);
    return {
      ...(executable ? { executable } : {}),
      usage: createOpenCodeHarnessUsage(accounts),
      create(host) {
        const checkout = config.cwdFor ?? host.checkout;
        const opencode = createOpenCodeFactoryHarness({
          handoffContextFor: host.handoffContextFor('opencode'),
          ...(config.store ? { store: config.store } : {}),
          ...(config.storeDir ? { storeDir: config.storeDir } : {}),
          ...((executable ?? config.command) ? { command: executable ?? config.command } : {}),
          ...(config.sessionHomeRoot ? { sessionHomeRoot: config.sessionHomeRoot } : {}),
          ...(config.supervisorWorkdirRoot ? { supervisorWorkdirRoot: config.supervisorWorkdirRoot } : {}),
          ...(config.spawn ? { spawn: config.spawn } : {}),
          ...(config.env ? { env: config.env } : {}),
          ...(config.skillsDir ? { skillsDir: config.skillsDir } : {}),
          ...(config.turnTimeoutMs ? { turnTimeoutMs: config.turnTimeoutMs } : {}),
          ...(config.catalog ? { catalog: config.catalog } : {}),
          sessions: host.sessions,
          projects: host.projects,
          cwdFor: checkout,
          // Settings → Behavior → Tool permissions, as OpenCode's permission rules.
          permissions: host.permissions(),
          cardRun: session => host.cardRun(session),
          ...(host.signals
            ? {
                phaseFor: host.signals.phaseFor(async ({ orgId, sessionId }) => {
                  const selection = (await opencode.models.getSelection(sessionId, { viewer: { userId: '', orgId } })) ?? null;
                  const effort = selection?.options?.find(option => option.id === 'effort')?.value;
                  return {
                    modelId: selection?.model ?? 'opencode/default',
                    thinkingLevel: typeof effort === 'string' ? effort : 'opencode-default',
                  };
                }),
                workItemFor: host.signals.workItemFor,
              }
            : {}),
          sessionsFor: session => host.sessionsFor(session),
          mcp: { url: host.mcpUrl(config.mcpOrigin), tokens: host.sessionTokens },
          onSession: session => host.onSession(session, 'opencode'),
          accounts,
          parkOnUsageLimit: session => host.parkOnUsageLimit(session),
        });
        // The person's own OpenCode sessions, continued here: only on their own machine (ADR-0043).
        const localSessions =
          config.localDevelopment === true
            ? createOpenCodeLocalSessions({
                harness: opencode.harness,
                ...(config.localSessionsDatabase ? { databasePath: config.localSessionsDatabase } : {}),
                flushed: sessionId => host.chatFlushed(sessionId),
                // The first turn starts a new OpenCode conversation that carries the imported history.
                handOff: ({ threadId, resourceId }) =>
                  host.prepareHandoff({ threadId, resourceId, fromInstanceId: 'opencode', toInstanceId: 'opencode', reason: 'resume_failed' }),
              })
            : undefined;
        return {
          descriptor: OPENCODE_HARNESS,
          harness: opencode.harness,
          route: opencode.route,
          // Its models in the picker, Settings and `factory_switch_session_model`, through its facet.
          models: executable ? withExecutableAvailability(opencode.models, executable) : opencode.models,
          parked: { parked: storeParkedSessions(opencode.store), get: sessionId => opencode.harness.getSession(sessionId) },
          removeSessionFiles: sessionId => opencode.removeSessionHome(sessionId),
          resolveChatSession: sessionId => opencode.resolveSession(sessionId),
          modelSelection: session => (session instanceof OpenCodeSession ? opencode.models.effectiveSelection(session) : undefined),
          checkout,
          customCheckout: config.cwdFor !== undefined,
          userSessions: createOpenCodeUserSessions({
            harness: opencode.harness,
            checkout: config.cwdFor ? { custom: true } : { custom: false, sandboxProvider: host.sandboxProvider },
            unavailable: () => executable?.unavailableReason() ?? (installed() ? undefined : OPENCODE_NOT_INSTALLED_REASON),
          }),
          ...(host.starts
            ? {
                // `owns` keeps a card that started on OpenCode there after the Factory switches harness.
                startCoordinator: Object.assign(
                  new ClaudeStartCoordinator<OpenCodeSessionMode>({
                    harness: opencode.harness,
                    storage: host.starts.storage,
                    transitionService: host.starts.transitionService,
                    sourceControl: request => host.starts!.sourceControl(request),
                    boards: host.starts.boards,
                    projects: host.projects,
                    approvedPermissionMode: 'default',
                  }),
                  { owns: opencode.route.owns },
                ),
              }
            : {}),
          available: installed,
          // Not wired to the Factory's session routing yet (worker messages, notices, wakes, the Factory chat guard).
          joinsSessionRouting: false,
          // OpenCode's mid-call asks are not wired to the hub: its «ask» tools are left out, as Codex's.
          asksMidCall: false,
          api: {
            features: { opencodeLocalSessions: localSessions !== undefined },
            // The organization's OpenCode keys, which OpenCode runs sign in with (ADR-0043, amendment).
            connectors: ({ deps }) => {
              const facet = deps.usage?.harnesses.forHarness(OPENCODE_HARNESS.id);
              return [
                {
                  id: OPENCODE_HARNESS.setup.accounts!.connector,
                  connections: createOpenCodeAccountsConnections({
                    harness: OPENCODE_HARNESS,
                    credentials: deps.domains.modelCredentials,
                    checkKey: checkOpenCodeKey,
                    ...(deps.usage ? { usage: { storage: deps.usage.usage, ...(facet ? { facet } : {}) } } : {}),
                  }),
                },
              ];
            },
            ...(localSessions
              ? {
                  routes: ({ deps, sourceControls }) =>
                    sourceControls.length > 0
                      ? buildOpenCodeLocalSessionRoutes({
                          auth: deps.auth,
                          sourceControls,
                          projects: deps.domains.projects,
                          memorySettings: deps.domains.memorySettings,
                          ...(deps.claudeCodeUserSessions ? { claudeCode: deps.claudeCodeUserSessions } : {}),
                          harnesses: deps.harnesses?.map(harness => harness.descriptor) ?? [],
                          opencodeLocalSessions: localSessions,
                        })
                      : [],
                }
              : {}),
          },
        };
      },
    };
  },
};
