/**
 * Claude Code as a Factory harness module (ADR-0044): its sessions live in the Claude harness, reach
 * the Factory's tools over MCP with per-turn session tokens, and show in the chat through the turn
 * harnesses' session UI. Each turn signs in with one of its owner's Claude sign-ins (the
 * organization's `anthropic` accounts), added with "Sign in with Claude".
 */
import { join } from 'node:path';

import { CLAUDE_CODE_HARNESS } from '@factory/contracts';
import { ClaudeCodeSession } from '@factory/harness-claude-code';
import { withConnectionAvailability, withExecutableAvailability } from '@factory/harness/models/facet';
import { signInAccountsConnector } from '@factory/api';

import { factoryRunsNeedSharedSignIn } from '../accounts/pool.ts';
import { CLAUDE_CODE_EXECUTABLE, harnessExecutableFor } from '../harness-executables.ts';
import type { HarnessConfigFromEnv, TurnHarnessModule } from '../harnesses/module.ts';
import { storeParkedSessions } from '../session/usage-limit-resume.ts';
import { createClaudeHarnessUsage } from './usage.ts';
import { CLAUDE_CODE_NEEDS_ACCOUNT_REASON, createClaudeCodeCredentials } from './credentials.ts';
import type { ClaudeCodeCredentialFailureHook, ClaudeCodeCredentialsHook } from './credentials.ts';
import { claudeFactorySkillDirectories, createClaudeFactoryHarness } from './harness.ts';
import type { ClaudeFactoryHarnessOptions } from './harness.ts';
import { createClaudeSignInService } from './sign-in.ts';
import { ClaudeStartCoordinator } from './start-coordinator.ts';
import { createClaudeSupervisorSessions } from './supervisor.ts';
import { createClaudeUserSessions } from './user-sessions.ts';

/** How this server runs Claude Code sessions (see `createClaudeFactoryHarness`). */
export interface MastraFactoryClaudeCodeConfig
  extends Pick<
    ClaudeFactoryHarnessOptions,
    | 'configDir'
    | 'sessionConfigRoot'
    | 'allowedTools'
    | 'approvedPermissionMode'
    | 'turnTimeoutMs'
    | 'skillsDir'
    | 'command'
    | 'spawn'
    | 'env'
    | 'tempDir'
    | 'gateNode'
    | 'supervisorWorkdirRoot'
  > {
  /** Where session records live; required unless `store` is given. */
  storeDir?: string;
  store?: ClaudeFactoryHarnessOptions['store'];
  /** Replaces the default credentials (`createClaudeCodeCredentials`: the organization's Anthropic accounts). */
  credentials?: ClaudeCodeCredentialsHook;
  /** Goes with a replaced `credentials` hook: told when a turn's account ran out of usage or was refused. */
  onCredentialFailure?: ClaudeCodeCredentialFailureHook;
  /** Replaces the default checkout (`createClaudeCheckoutResolver`). */
  cwdFor?: (sessionId: string) => string | Promise<string>;
  /** The origin the CLI reaches this server's MCP endpoint at; `publicUrl` by default. */
  mcpOrigin?: string;
  /** Secret for MCP session tokens; `stateSecret` by default, else a per-process key. */
  sessionTokenSecret?: string;
}

/**
 * The deployment's Claude Code: each session in its own config dir under the store
 * (FACTORY_CLAUDE_CODE_STORE_DIR), the CLI FACTORY_CLAUDE_CODE_COMMAND names, as the agent user when
 * one is configured (its own `claude` on its PATH, config dirs and turn files where it can read them).
 */
export const claudeCodeConfigFromEnv: HarnessConfigFromEnv<MastraFactoryClaudeCodeConfig> = ({ env, home, agentUser }) => ({
  storeDir: env.FACTORY_CLAUDE_CODE_STORE_DIR?.trim() || join(home, '.mastracode', 'web', 'claude-code-sessions'),
  ...(env.FACTORY_CLAUDE_CODE_COMMAND?.trim() ? { command: env.FACTORY_CLAUDE_CODE_COMMAND.trim() } : {}),
  ...(agentUser ? agentUser.claudeCode() : {}),
});

export const claudeCodeHarnessModule: TurnHarnessModule<MastraFactoryClaudeCodeConfig, 'claudeCode'> = {
  kind: 'turn',
  descriptor: CLAUDE_CODE_HARNESS,
  configKey: 'claudeCode',
  featureFlags: ['claudeCode', 'claudeSignIn'],
  configFromEnv: claudeCodeConfigFromEnv,
  prepare(config, boot) {
    // The CLI, resolved once for the server (configured command, PATH, then where the CLI installs; ADR-0038).
    const executable = harnessExecutableFor(config, CLAUDE_CODE_EXECUTABLE);
    const credentials = config.credentials
      ? { credentials: config.credentials, ...(config.onCredentialFailure ? { onCredentialFailure: config.onCredentialFailure } : {}) }
      : createClaudeCodeCredentials({ credentials: boot.credentials });
    const usable = 'usable' in credentials ? credentials.usable : undefined;
    const readSignIn = createClaudeCodeCredentials({ credentials: boot.credentials }).signIn;
    return {
      ...(executable ? { executable } : {}),
      ...(config.sessionTokenSecret ? { sessionTokenSecret: config.sessionTokenSecret } : {}),
      // Its Claude sign-ins' allowances, read from the provider with each sign-in's own token.
      ...(readSignIn ? { usage: createClaudeHarnessUsage({ signIn: readSignIn }) } : {}),
      create(host) {
        const checkout = config.cwdFor ?? host.checkout;
        const claudeCode = createClaudeFactoryHarness({
          ...config,
          ...(executable ? { command: executable } : {}),
          handoffContextFor: host.handoffContextFor('claude-code'),
          sessions: host.sessions,
          projects: host.projects,
          // Settings → Behavior → Tool permissions: the Factory's own session keeps them.
          permissions: host.permissions(),
          // External MCP tools set to «ask» (Settings › MCP-сервери) wait for a person on Claude Code too.
          mcpAskToolsFor: session => host.mcpAskToolsFor(session),
          // A session that ever ran a card's role is a card run: nobody is there to answer a permission prompt.
          cardRun: session => host.cardRun(session),
          // The factory-phase signal a bound Mastra run gets, so the skills read the same stage and revision.
          ...(host.signals
            ? {
                // A Product card's Brief reads providers' pricing pages: reading the web needs no person.
                allowToolsFor: host.signals.productWebTools,
                // What the session's next turn runs on: its own pick, else its Factory's Claude Code default.
                phaseFor: host.signals.phaseFor(async ({ orgId, sessionId }) => {
                  const selection = (await claudeCode.models?.getSelection(sessionId, { viewer: { userId: '', orgId } })) ?? null;
                  const effort = selection?.options?.find(option => option.id === 'effort')?.value;
                  return {
                    modelId: `claude-code/${selection?.model ?? 'default'}`,
                    thinkingLevel: typeof effort === 'string' ? effort : 'claude-code-default',
                  };
                }),
                workItemFor: host.signals.workItemFor,
              }
            : {}),
          // The factory-sessions signal a Mastra run gets, read as the session's own tools see it.
          sessionsFor: session => host.sessionsFor(session),
          ...credentials,
          cwdFor: checkout,
          mcp: { url: host.mcpUrl(config.mcpOrigin), tokens: host.sessionTokens },
          onSession: session => host.onSession(session, 'claude-code'),
          parkOnUsageLimit: session => host.parkOnUsageLimit(session),
        });
        // The chat's model picker and the agent's `factory_switch_session_model` reach a session's model through
        // its facet; its next turn passes the pick to the CLI (`--model`, `--effort`, `--settings`).
        const models = claudeCode.models;
        if (!models) throw new Error('The Claude Code harness has no model facet: it needs the Factories (`projects`).');
        // The Factory chat (supervisor) of a Claude Code Factory is a Claude session too, created when the chat first reaches it.
        const supervisorSessions = createClaudeSupervisorSessions({ harness: claudeCode.harness, projects: { getById: args => host.projectById(args) } });
        // Finished in the person's own browser (they paste the page's code back), so offered wherever the server runs.
        const signIn = createClaudeSignInService({
          credentials: boot.credentials,
          ...((executable ?? config.command) ? { command: executable ?? config.command } : {}),
        });
        return {
          descriptor: CLAUDE_CODE_HARNESS,
          harness: claudeCode.harness,
          route: claudeCode.route,
          // Offered only to whoever has a Claude sign-in to run on (ADR-0036), and to nobody without its CLI (ADR-0038).
          models: withConnectionAvailability(executable ? withExecutableAvailability(models, executable) : models, {
            connector: CLAUDE_CODE_HARNESS.setup.accounts!.connector,
            ...(usable
              ? { missing: async ctx => ((await usable({ orgId: ctx.viewer.orgId, userId: ctx.viewer.userId })) ? undefined : CLAUDE_CODE_NEEDS_ACCOUNT_REASON) }
              : {}),
          }),
          parked: { parked: storeParkedSessions(claudeCode.store), get: sessionId => claudeCode.harness.getSession(sessionId) },
          removeSessionFiles: sessionId => claudeCode.removeSessionConfig(sessionId),
          resolveChatSession: sessionId => supervisorSessions.resolve(sessionId),
          modelSelection: session => (session instanceof ClaudeCodeSession ? models.effectiveSelection(session) : undefined),
          checkout,
          customCheckout: config.cwdFor !== undefined,
          // New chats of a Claude Code Factory are Claude Code sessions, checked out like a card's.
          userSessions: createClaudeUserSessions({
            harness: claudeCode.harness,
            checkout: config.cwdFor ? { custom: true } : { custom: false, sandboxProvider: host.sandboxProvider },
          }),
          ...(host.starts
            ? {
                // `owns` keeps a card that started on Claude Code there after the Factory switches to Mastra.
                startCoordinator: Object.assign(
                  new ClaudeStartCoordinator({
                    harness: claudeCode.harness,
                    storage: host.starts.storage,
                    transitionService: host.starts.transitionService,
                    sourceControl: request => host.starts!.sourceControl(request),
                    boards: host.starts.boards,
                    projects: host.projects,
                    ...(config.approvedPermissionMode ? { approvedPermissionMode: config.approvedPermissionMode } : {}),
                  }),
                  { owns: claudeCode.route.owns },
                ),
              }
            : {}),
          available: () => executable?.unavailableReason() === undefined,
          // A card's run belongs to the Factory: it runs only on the sign-ins their owners shared with its card runs.
          factoryRunAccounts: async tenant => (usable && !(await usable(tenant)) ? factoryRunsNeedSharedSignIn('Claude') : undefined),
          joinsSessionRouting: true,
          asksMidCall: true,
          mcpSessionTools: { skillDirectories: claudeFactorySkillDirectories(config.skillsDir) },
          api: {
            features: { claudeCode: true, claudeSignIn: true },
            connectors: context => signInAccountsConnector(context, { harness: CLAUDE_CODE_HARNESS, signIn }),
          },
        };
      },
    };
  },
};
