/**
 * Codex as a Factory harness module (ADR-0044): its sessions live in the Codex harness (the `codex`
 * CLI's app-server on this host), reach the Factory's tools over MCP with a token minted per run, and
 * show in the chat through the turn harnesses' session UI. Each run signs in with its owner's
 * ChatGPT sign-in (the members' `openai-codex` accounts), never with this host's `codex login`.
 * Without the CLI, or without a sign-in the person may use, the facet lists Codex as needing setup.
 */
import { join } from 'node:path';

import { CODEX_HARNESS } from '@factory/contracts';
import { CODEX_NOT_INSTALLED_REASON, CodexSession } from '@factory/harness-codex';
import type { CodexSessionMode } from '@factory/harness-codex';
import { harnessCommandAvailable } from '@factory/harness/executable';
import { withConnectionAvailability, withExecutableAvailability } from '@factory/harness/models/facet';
import { signInAccountsConnector } from '@factory/api';

import { factoryRunsNeedSharedSignIn } from '../accounts/pool.ts';
import { ClaudeStartCoordinator } from '../claude/start-coordinator.ts';
import { CODEX_EXECUTABLE, harnessExecutableFor } from '../harness-executables.ts';
import type { HarnessConfigFromEnv, TurnHarnessModule } from '../harnesses/module.ts';
import { storeParkedSessions } from '../session/usage-limit-resume.ts';
import { createCodexCredentials } from './credentials.ts';
import type { CodexCredentials } from './credentials.ts';
import { codexGeneratedImageKeeper, codexLiveWebForProductCards } from './factory-hooks.ts';
import type { AgentFileOpener } from './factory-hooks.ts';
import { createCodexFactoryHarness } from './harness.ts';
import type { CodexFactoryHarnessOptions } from './harness.ts';
import { createCodexSignInService } from './sign-in.ts';
import { createCodexHarnessUsage } from './usage.ts';
import { createCodexUserSessions } from './user-sessions.ts';

/** How this server runs Codex sessions (see `createCodexFactoryHarness`). */
export interface MastraFactoryCodexConfig
  extends Pick<
    CodexFactoryHarnessOptions,
    'store' | 'command' | 'launchArgs' | 'sessionHomeRoot' | 'supervisorWorkdirRoot' | 'spawn' | 'env' | 'skillsDir' | 'turnTimeoutMs' | 'catalog'
  > {
  /** Where session records live (and, beside them, each session's own `CODEX_HOME`); required unless `store` is given. */
  storeDir?: string;
  /** Opens a file the CLI names (a generated image) with the agent's rights, when agents run as their own user. */
  openAgentFile?: AgentFileOpener;
  /**
   * Local development: the server and the person's browser share a machine, so ChatGPT sign-in
   * (`codex login`, which opens the CLI's browser page here) is offered. Runs still use only the
   * stored accounts.
   */
  localDevelopment?: boolean;
  /** Replaces the default credentials (`createCodexCredentials`: the members' ChatGPT sign-ins). */
  credentials?: CodexCredentials;
  /** Replaces the default checkout (`createClaudeCheckoutResolver`). */
  cwdFor?: (sessionId: string) => string | Promise<string>;
  /** The origin Codex reaches this server's MCP endpoint at; `publicUrl` by default. */
  mcpOrigin?: string;
}

/**
 * The deployment's Codex: each session in its own CODEX_HOME beside the store
 * (FACTORY_CODEX_STORE_DIR), signed in only with the members' ChatGPT sign-ins (a development server
 * adds "Sign in with ChatGPT", a `codex login` in a throwaway home). The machine's own `codex login`
 * (`~/.codex`) is never read. As the agent user: its own `codex`, session homes and the Factory
 * chat's folders where it can reach them.
 */
export const codexConfigFromEnv: HarnessConfigFromEnv<MastraFactoryCodexConfig> = ({ env, home, ownMachine, agentUser }) => ({
  storeDir: env.FACTORY_CODEX_STORE_DIR?.trim() || join(home, '.mastracode', 'web', 'codex-sessions'),
  localDevelopment: ownMachine,
  ...(env.FACTORY_CODEX_COMMAND?.trim() ? { command: env.FACTORY_CODEX_COMMAND.trim() } : {}),
  ...(agentUser ? agentUser.codex() : {}),
});

export const codexHarnessModule: TurnHarnessModule<MastraFactoryCodexConfig, 'codex'> = {
  kind: 'turn',
  descriptor: CODEX_HARNESS,
  configKey: 'codex',
  featureFlags: ['codex', 'codexSignIn'],
  configFromEnv: codexConfigFromEnv,
  prepare(config, boot) {
    const executable = harnessExecutableFor(config, CODEX_EXECUTABLE);
    const credentials = config.credentials ?? createCodexCredentials({ credentials: boot.credentials });
    // Asked each time: a CLI installed after boot makes Codex available without a restart.
    const installed = (): boolean => harnessCommandAvailable(executable ?? config.command, 'codex', config.env ?? process.env);
    const readSignIn = createCodexCredentials({ credentials: boot.credentials }).signIn;
    return {
      ...(executable ? { executable } : {}),
      // Its ChatGPT sign-ins' allowances, read from the ChatGPT backend with each sign-in's own token.
      ...(readSignIn ? { usage: createCodexHarnessUsage({ signIn: readSignIn }) } : {}),
      create(host) {
        const checkout = config.cwdFor ?? host.checkout;
        const codex = createCodexFactoryHarness({
          handoffContextFor: host.handoffContextFor('codex'),
          ...(config.store ? { store: config.store } : {}),
          ...(config.storeDir ? { storeDir: config.storeDir } : {}),
          ...((executable ?? config.command) ? { command: executable ?? config.command } : {}),
          ...(config.launchArgs ? { launchArgs: config.launchArgs } : {}),
          ...(config.sessionHomeRoot ? { sessionHomeRoot: config.sessionHomeRoot } : {}),
          ...(config.supervisorWorkdirRoot ? { supervisorWorkdirRoot: config.supervisorWorkdirRoot } : {}),
          credentials,
          ...(config.spawn ? { spawn: config.spawn } : {}),
          ...(config.env ? { env: config.env } : {}),
          ...(config.skillsDir ? { skillsDir: config.skillsDir } : {}),
          ...(config.turnTimeoutMs ? { turnTimeoutMs: config.turnTimeoutMs } : {}),
          ...(config.catalog ? { catalog: config.catalog } : {}),
          sessions: host.sessions,
          projects: host.projects,
          cwdFor: checkout,
          // Settings → Behavior → Tool permissions, as Codex's sandbox and approval policy.
          permissions: host.permissions(),
          cardRun: session => host.cardRun(session),
          // A Product card reads the web live, as a Claude Code session there runs `WebFetch`/`WebSearch` unasked;
          // images Codex generates are kept as the card's (or the session's) attachments.
          ...(host.workItems ? { liveWebFor: codexLiveWebForProductCards(host.workItems) } : {}),
          ...(host.attachments
            ? {
                keepGeneratedImage: codexGeneratedImageKeeper({
                  attachments: host.attachments,
                  ...(host.workItems ? { workItems: host.workItems } : {}),
                  ...(config.openAgentFile ? { open: config.openAgentFile } : {}),
                }),
              }
            : {}),
          ...(host.signals
            ? {
                phaseFor: host.signals.phaseFor(async ({ orgId, sessionId }) => {
                  const selection = (await codex.models.getSelection(sessionId, { viewer: { userId: '', orgId } })) ?? null;
                  const effort = selection?.options?.find(option => option.id === 'effort')?.value;
                  return {
                    modelId: `codex/${selection?.model ?? 'default'}`,
                    thinkingLevel: typeof effort === 'string' ? effort : 'codex-default',
                  };
                }),
                workItemFor: host.signals.workItemFor,
              }
            : {}),
          sessionsFor: session => host.sessionsFor(session),
          mcp: { url: host.mcpUrl(config.mcpOrigin), tokens: host.sessionTokens },
          onSession: session => host.onSession(session, 'codex'),
          parkOnUsageLimit: session => host.parkOnUsageLimit(session),
        });
        const signIn =
          config.localDevelopment === true
            ? createCodexSignInService({
                credentials: boot.credentials,
                ...((executable ?? config.command) ? { command: executable ?? config.command } : {}),
                ...(config.env ? { env: config.env } : {}),
              })
            : undefined;
        return {
          descriptor: CODEX_HARNESS,
          harness: codex.harness,
          route: codex.route,
          // `model/list` of the installed CLI; its next turn's `turn/start` carries the pick (model, effort, service tier).
          // Its facet already asks for a ChatGPT sign-in of the viewer's; the connector names where to add one (ADR-0036).
          models: withConnectionAvailability(executable ? withExecutableAvailability(codex.models, executable) : codex.models, {
            connector: CODEX_HARNESS.setup.accounts!.connector,
          }),
          parked: { parked: storeParkedSessions(codex.store), get: sessionId => codex.harness.getSession(sessionId) },
          removeSessionFiles: sessionId => codex.removeSessionHome(sessionId),
          // Its Factory chat is a Codex session too, created when the chat first reaches it.
          resolveChatSession: sessionId => codex.resolveSession(sessionId),
          modelSelection: session => (session instanceof CodexSession ? codex.models.effectiveSelection(session) : undefined),
          checkout,
          customCheckout: config.cwdFor !== undefined,
          userSessions: createCodexUserSessions({
            harness: codex.harness,
            checkout: config.cwdFor ? { custom: true } : { custom: false, sandboxProvider: host.sandboxProvider },
            unavailable: () => executable?.unavailableReason() ?? (installed() ? undefined : CODEX_NOT_INSTALLED_REASON),
          }),
          ...(host.starts
            ? {
                // `owns` keeps a card that started on Codex there after the Factory switches harness.
                startCoordinator: Object.assign(
                  new ClaudeStartCoordinator<CodexSessionMode>({
                    harness: codex.harness,
                    storage: host.starts.storage,
                    transitionService: host.starts.transitionService,
                    sourceControl: request => host.starts!.sourceControl(request),
                    boards: host.starts.boards,
                    projects: host.projects,
                    approvedPermissionMode: 'default',
                  }),
                  { owns: codex.route.owns },
                ),
              }
            : {}),
          available: installed,
          factoryRunAccounts: async tenant => ((await credentials.usable(tenant)) ? undefined : factoryRunsNeedSharedSignIn('Codex')),
          joinsSessionRouting: true,
          // Codex has no way to ask a person mid-turn: its «ask» tools are left out rather than run unasked.
          asksMidCall: false,
          api: {
            features: { codex: true, codexSignIn: signIn !== undefined },
            connectors: context => signInAccountsConnector(context, { harness: CODEX_HARNESS, ...(signIn ? { signIn } : {}) }),
          },
        };
      },
    };
  },
};
