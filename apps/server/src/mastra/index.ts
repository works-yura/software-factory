/**
 * Platform-deployable Mastra entry for MastraCode.
 *
 * This module is the ONE place deployment env is read. It maps today's env
 * vars onto explicit `MastraFactory` config — instances for behaviors (pubsub,
 * storage, vector), plain values for config (publicUrl, origins) — so anyone
 * reading the entry sees exactly which env var feeds which slot.
 * Everything else (feature readiness, route/middleware assembly, controller
 * construction) lives in `MastraFactory` (`@mastra/factory`).
 *
 * `mastra build` requires the entry to export a `Mastra` instance named
 * `mastra` constructed by a literal `new Mastra(...)` in THIS file (validated
 * by the deployer's `checkConfigExport` Babel plugin) — which is why the
 * factory returns constructor args from `prepare()` instead of the instance.
 * The Mastra CLI consumes this entry everywhere: `mastra dev`, `mastra build`,
 * and `mastra deploy` all bundle this module and let the deployer generate
 * the server.
 */

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLFactoryStorage } from '@mastra/libsql';
import { PgVector, PgFactoryStorage } from '@mastra/pg';
import { RedisStreamsPubSub } from '@mastra/redis-streams';
import { getDatabasePath } from '@mastra/code-sdk/utils/project';
import { DEFAULT_RETENTION } from '@mastra/code-sdk/utils/storage-maintenance';
import { AgentBrowser } from '@mastra/agent-browser';
import {
  attachOnFirstRequest,
  createFactorySecretEncryption,
  LocalFactorySandbox,
  LocalFileBlobStore,
  MastraFactory,
} from '@factory/server';
import { GithubIntegration, GithubTokenIntegration, parseAuthorizedBotsEnv } from '@factory/integration-github';
import { ClickUpIntegration } from '@factory/integration-clickup';
import { FirebaseIntegration } from '@factory/integration-firebase';
import { GitLabIntegration } from '@factory/integration-gitlab';
import type { IMastraAuthProvider } from '@mastra/core/server';
// Local development: loopback sign-in, credential key, and vector store.
import { createGoogleAuth } from './google/google-auth';
import {
  createLocalDevAuth,
  createLocalVector,
  localDevAuthEnabled,
  localDevCredentialKey,
  ownMachineCredentialKey,
} from './local';

/**
 * Parse a positive-integer env knob; anything else means "use the default".
 * Fractional values are rejected rather than floored — flooring `0.5` to `0`
 * would silently disable a capacity knob or turn an idle window into
 * immediate expiry.
 */
function positiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function decodeCredentialEncryptionKey(name: string, encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, 'base64');
  if (key.byteLength !== 32) throw new Error(`${name} must contain base64-encoded 32-byte keys.`);
  return key;
}

// Outside development and tests, missing security configuration stops the boot
// instead of falling back. Each fallback has its own explicit opt-in.
const localDevelopmentMode = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';

const authSetting = process.env.FACTORY_AUTH?.trim();
if (authSetting && authSetting !== 'google') {
  throw new Error(`FACTORY_AUTH must be unset or google, got ${JSON.stringify(authSetting)}.`);
}
const googleAuthEnabled = authSetting === 'google';
/**
 * The server runs on the person's own machine: local dev auth, or a development server that signs
 * in with Google. Claude and ChatGPT sign-in (which open a browser page here), device preview and
 * the machine credential key are offered only then.
 */
const ownMachine = localDevAuthEnabled || (googleAuthEnabled && process.env.NODE_ENV === 'development');

function credentialEncryption() {
  // Local dev mode keeps a stable key in ~/.mastracode.
  const encodedKey =
    process.env.FACTORY_CREDENTIAL_ENCRYPTION_KEY?.trim() ||
    (localDevAuthEnabled ? localDevCredentialKey() : ownMachine ? ownMachineCredentialKey() : undefined);
  if (!encodedKey) {
    const plaintextOptIn = process.env.FACTORY_CREDENTIAL_ENCRYPTION?.trim() === 'plaintext';
    if (!localDevelopmentMode && !plaintextOptIn) {
      throw new Error(
        'FACTORY_CREDENTIAL_ENCRYPTION_KEY is required outside local development and tests. Generate a key with ' +
          '`openssl rand -base64 32`, or set FACTORY_CREDENTIAL_ENCRYPTION=plaintext to store model-provider keys, ' +
          'custom-provider API keys, and integration secrets unencrypted.',
      );
    }
    console.warn(
      '[factory] FACTORY_CREDENTIAL_ENCRYPTION_KEY is not set. Stored model-provider keys, custom-provider ' +
        'API keys, and integration secrets will be persisted as plaintext. Generate a key with ' +
        '`openssl rand -base64 32` and set FACTORY_CREDENTIAL_ENCRYPTION_KEY to encrypt them at rest.',
    );
    return undefined;
  }

  const previousKeys: Record<string, unknown> = process.env.FACTORY_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS
    ? JSON.parse(process.env.FACTORY_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS)
    : {};
  if (!previousKeys || Array.isArray(previousKeys) || typeof previousKeys !== 'object') {
    throw new Error('FACTORY_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS must be a JSON object of key ids to base64 keys.');
  }

  return createFactorySecretEncryption({
    primary: {
      id: process.env.FACTORY_CREDENTIAL_ENCRYPTION_KEY_ID?.trim() || 'v1',
      key: decodeCredentialEncryptionKey('FACTORY_CREDENTIAL_ENCRYPTION_KEY', encodedKey),
    },
    previous: Object.entries(previousKeys).map(([id, value]) => {
      if (typeof value !== 'string') {
        throw new Error('FACTORY_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS values must be base64 strings.');
      }
      return { id, key: decodeCredentialEncryptionKey('FACTORY_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS', value) };
    }),
  });
}

// Distributed pub/sub: when `REDIS_URL` is set, events (streams, workflows,
// signals) ride Redis Streams so multiple web server processes can share one
// event bus. RedisStreamsPubSub also implements LeaseProvider, so the factory
// marks it cross-process and the controller drops its file-based thread locks
// in favor of pubsub-coordinated leases. Without `REDIS_URL` (bare local dev)
// the in-process default applies.
const redisUrl = process.env.REDIS_URL;
// Backstop TTL for idle streams: every write (publish, group creation, nack
// retry) refreshes it — reads do not — so actively written topics never
// expire. Open-ended topics (per-thread streams, feed
// topics) are never clearTopic'd, and topics whose eager cleanup was missed
// (e.g. a crashed run, or a reply landing after the requester's clearTopic)
// would otherwise stay in Redis forever.
const STREAM_IDLE_TTL_MS = 24 * 60 * 60 * 1000;
const pubsub = redisUrl ? new RedisStreamsPubSub({ url: redisUrl, streamIdleTtlMs: STREAM_IDLE_TTL_MS }) : undefined;
if (redisUrl) {
  // Redact credentials before logging (REDIS_URL may embed a password).
  let redisTarget = 'redis';
  try {
    const parsed = new URL(redisUrl);
    redisTarget = `${parsed.protocol}//${parsed.host}`;
  } catch {
    // Unparseable URL — RedisStreamsPubSub will surface the real error; keep the log generic.
  }
  console.log(`[PubSub] REDIS_URL set — event bus on Redis Streams (${redisTarget}), cross-process leases enabled.`);
}

// Auth selection. There is no implicit default: with none of these set,
// `factory.prepare()` refuses to boot and names the options.
//   1. FACTORY_LOCAL_DEV_AUTH=1 — loopback-only single-user identity, checked
//      before every other option.
//   2. FACTORY_AUTH=google — Google sign-in on better-auth with organizations
//      and invitation links (see google/google-auth.ts).
//   3. MASTRACODE_AUTH_DISABLED=1 — explicit opt-out, auth off entirely.
// A deployment with its own identity provider passes it to MastraFactory's
// `auth` slot instead. Note MASTRA_PLATFORM_ACCESS_TOKEN /
// MASTRA_PLATFORM_SECRET_KEY are integration credentials (GitHub/GitLab
// slots), not identity signals.
const authDisabled = process.env.MASTRACODE_AUTH_DISABLED === '1';
let auth: IMastraAuthProvider | null | undefined;

if (localDevAuthEnabled && googleAuthEnabled) {
  throw new Error('Set either FACTORY_LOCAL_DEV_AUTH=1 or FACTORY_AUTH=google, not both.');
}
if (localDevAuthEnabled) {
  auth = createLocalDevAuth();
} else if (googleAuthEnabled) {
  auth = createGoogleAuth();
} else if (authDisabled) {
  auth = null;
}
const secretEncryption = auth === null ? undefined : credentialEncryption();

// Platform-backed integrations are installed by the factory only when Platform
// credentials are present — the same check it makes internally.
const platformCredentialsConfigured = Boolean(
  process.env.MASTRA_PLATFORM_ACCESS_TOKEN?.trim() || process.env.MASTRA_PLATFORM_SECRET_KEY?.trim(),
);

// Direct GitHub App fallback: when the platform-backed integration isn't in
// play (self-hosted / local deploys), a complete GITHUB_APP_* env group wires
// a GithubIntegration so the app still gets a real GitHub connection — Connect
// GitHub in onboarding, the repo picker, and webhooks. A partial group stays
// disabled so the status route can report exactly what's missing.
//
// This integration carries the deployment's GitHub event-rule overrides. When
// the group is absent the factory installs the Platform-backed integration
// instead, and `platform.github` (below) hands it the same overrides — only one
// of the two is ever installed.
const githubAppId = process.env.GITHUB_APP_ID?.trim();
const githubPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
const githubClientId = process.env.GITHUB_APP_CLIENT_ID?.trim();
const githubClientSecret = process.env.GITHUB_APP_CLIENT_SECRET?.trim();
const githubAppSlug = process.env.GITHUB_APP_SLUG?.trim();
const githubAccessToken = process.env.GITHUB_ACCESS_TOKEN?.trim();
const github =
  githubAppId && githubPrivateKey && githubClientId && githubClientSecret && githubAppSlug
    ? new GithubIntegration({
        appId: githubAppId,
        privateKey: githubPrivateKey,
        clientId: githubClientId,
        clientSecret: githubClientSecret,
        slug: githubAppSlug,
        webhookSecret: process.env.GITHUB_APP_WEBHOOK_SECRET?.trim() || undefined,
        // Extra reviewer bot logins this deployment trusts to trigger
        // review/comment notifications, on top of the built-in defaults.
        authorizedBots: parseAuthorizedBotsEnv(process.env.MASTRACODE_GITHUB_AUTHORIZED_BOTS),
      })
    : githubAccessToken
      ? // GitHub without an App: one access token reaches the repositories its
        // account can push to, and polling replaces webhooks.
        new GithubTokenIntegration({
          accessToken: githubAccessToken,
          authorizedBots: parseAuthorizedBotsEnv(process.env.MASTRACODE_GITHUB_AUTHORIZED_BOTS),
        })
      : undefined;

// Direct GitLab fallback for self-hosted / local deploys. GitLab Personal
// and Group Access Tokens use the same API/Git authentication; the explicit
// type records the credential's reach for diagnostics and setup guidance.
const gitlabAccessToken = process.env.GITLAB_ACCESS_TOKEN?.trim();
const gitlabAccessTokenType = process.env.GITLAB_ACCESS_TOKEN_TYPE?.trim();
const gitlab = gitlabAccessToken
  ? new GitLabIntegration({
      accessToken: gitlabAccessToken,
      ...(gitlabAccessTokenType === 'personal' || gitlabAccessTokenType === 'group'
        ? { accessTokenType: gitlabAccessTokenType }
        : {}),
      ...(process.env.GITLAB_BASE_URL?.trim() ? { baseUrl: process.env.GITLAB_BASE_URL.trim() } : {}),
      ...(process.env.GITLAB_WEBHOOK_SECRET?.trim() ? { webhookSecret: process.env.GITLAB_WEBHOOK_SECRET.trim() } : {}),
    })
  : undefined;

// ClickUp by polling: only the token lives in env; Lists, routing and tag → board are set in
// Settings › Intake. No webhook, so it works on a local server.
const clickupApiToken = process.env.CLICKUP_API_TOKEN?.trim();
const clickupPollSeconds = Number(process.env.CLICKUP_POLL_INTERVAL_SECONDS);
const clickup = clickupApiToken
  ? new ClickUpIntegration({
      apiToken: clickupApiToken,
      ...(Number.isFinite(clickupPollSeconds) && clickupPollSeconds > 0 ? { intervalSeconds: clickupPollSeconds } : {}),
    })
  : undefined;

// Host env exposed to local sandboxes: an allow-list only, so app secrets
// (GITHUB_APP_PRIVATE_KEY, FACTORY_CREDENTIAL_ENCRYPTION_KEY, DATABASE_URL, …) never leak into
// commands run against untrusted repo checkouts. PATH is always added by the
// core LocalSandbox itself; the rest keeps git and TLS working normally.
const LOCAL_SANDBOX_ENV_KEYS = [
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TERM',
  'TZ',
  'GIT_EXEC_PATH',
  'GIT_TEMPLATE_DIR',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;

function localSandboxEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of LOCAL_SANDBOX_ENV_KEYS) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

// One FactoryStorage backend powers agent storage, the factory app tables,
// the distributed project lock, and better-auth. `DATABASE_URL` set →
// Postgres (the paired PgVector rides the same database for recall search).
// Unset (bare local dev) → libSQL on the same local file the SDK's default
// storage resolution uses, running the FULL app surface (auth, intake,
// audit, work-items, integrations) — no features silently off.
//
// `APP_DATABASE_URL` is the deprecated legacy name — still honored as a
// fallback so existing checkouts keep working, but new setups should use
// `DATABASE_URL` (matches the platform's managed env-var sync for attached
// databases, so `mastra deploy` populates it automatically).
const databaseUrl = process.env.DATABASE_URL?.trim() || process.env.APP_DATABASE_URL?.trim() || undefined;
if (process.env.APP_DATABASE_URL?.trim() && !process.env.DATABASE_URL?.trim()) {
  console.warn(
    '[mastracode-web] APP_DATABASE_URL is deprecated — rename it to DATABASE_URL. ' +
      'The old name is honored as a fallback for now, but new deploys should use DATABASE_URL.',
  );
}
if (!databaseUrl && !localDevelopmentMode) {
  throw new Error('DATABASE_URL is required outside local development and tests.');
}

const storage = databaseUrl
  ? new PgFactoryStorage({
      id: 'mastra-code-storage',
      connectionString: databaseUrl,
      retention: DEFAULT_RETENTION,
    })
  : new LibSQLFactoryStorage({
      id: 'mastra-code-storage',
      url: `file:${getDatabasePath()}`,
      retention: DEFAULT_RETENTION,
    });
// Without Postgres, keep semantic recall and Knowledge on a local libSQL vector file.
const vector = databaseUrl
  ? new PgVector({ id: 'mastra-code-vectors', connectionString: databaseUrl })
  : createLocalVector();

// Deployment-stable secret for OAuth `state` signing: the GitHub webhook secret.
// Unset → per-process random secret (single-process local dev only).
const stateSecret = process.env.GITHUB_APP_WEBHOOK_SECRET || undefined;

// Firebase logs and crashes for agents: nothing in env; each organization uploads its own read-only
// service account key in Settings › Logs and crashes, stored encrypted.
const firebase = new FirebaseIntegration();

const integrations = [
  ...(github ? [github] : []),
  ...(gitlab ? [gitlab] : []),
  ...(clickup ? [clickup] : []),
  firebase,
];

export const factoryConfigVersion = 'mastracode-web-v1';

// The only sandbox runs agent commands directly on this host as the server's
// OS user, without isolation. Outside development and tests that must be an
// explicit choice: FACTORY_SANDBOX_PROVIDER=local.
const sandboxProvider = process.env.FACTORY_SANDBOX_PROVIDER?.trim() || undefined;
if (sandboxProvider !== undefined && sandboxProvider !== 'local') {
  throw new Error(
    `FACTORY_SANDBOX_PROVIDER must be unset or local, got ${JSON.stringify(sandboxProvider)}. ` +
      'Cloud sandbox providers (Mastra platform, E2B) are no longer supported.',
  );
}
if (sandboxProvider !== 'local' && !localDevelopmentMode) {
  throw new Error(
    'Agent commands run directly on this machine as the server user. Outside local development and tests, ' +
      'confirm that by setting FACTORY_SANDBOX_PROVIDER=local.',
  );
}

const sandbox = new LocalFactorySandbox({
  root: process.env.MASTRACODE_LOCAL_SANDBOX_ROOT?.trim() || join(homedir(), '.mastracode', 'web', 'sandboxes'),
  env: localSandboxEnv(),
});

/**
 * Browser automation for agent sessions, off unless FACTORY_BROWSER names a
 * provider. `agent-browser` runs headless Chromium on this server host (not
 * in the session sandbox), one isolated browser per thread.
 */
const browserProvider = process.env.FACTORY_BROWSER?.trim();
if (browserProvider && browserProvider !== 'agent-browser') {
  throw new Error(`FACTORY_BROWSER must be unset or agent-browser, got ${JSON.stringify(browserProvider)}.`);
}
const browser = browserProvider === 'agent-browser' ? new AgentBrowser({ headless: true, scope: 'thread' }) : undefined;

export const factory = new MastraFactory({
  auth,
  secretEncryption,
  integrations,
  configVersion: factoryConfigVersion,
  // Providers every signed-in account may run on this server's own credentials,
  // e.g. `amazon-bedrock` with AWS credentials + AWS_REGION in the environment.
  deploymentModelProviders: process.env.FACTORY_DEPLOYMENT_MODEL_PROVIDERS?.split(','),
  // Local dev auth signs in every loopback caller, so MCP clients on this
  // machine (Claude Code, Cursor) connect without an OAuth server.
  ...(localDevAuthEnabled ? { mcp: { tokenless: true } } : {}),
  sandbox,
  // Factories created with `harness: 'claude-code'` run their agents on the
  // `claude` CLI, each session in its own config dir, signed in only with the
  // organization's Claude accounts (local dev auth adds "Sign in with Claude").
  claudeCode: {
    storeDir:
      process.env.FACTORY_CLAUDE_CODE_STORE_DIR?.trim() || join(homedir(), '.mastracode', 'web', 'claude-code-sessions'),
    localDevelopment: ownMachine,
    ...(process.env.FACTORY_CLAUDE_CODE_COMMAND?.trim() ? { command: process.env.FACTORY_CLAUDE_CODE_COMMAND.trim() } : {}),
  },
  // Factories created with `harness: 'codex'` run their agents on this machine's `codex` CLI (its
  // app-server), each session in its own CODEX_HOME beside the store, signed in only with the
  // members' ChatGPT sign-ins (Settings → Models → Codex accounts; local dev auth adds "Sign in with
  // ChatGPT", a `codex login` in a throwaway home). The machine's own `codex login`
  // (`~/.codex`) is never read: there is no setting for a shared home any more (FACTORY_CODEX_HOME
  // is gone), so no deployment runs every Factory on one person's login. Without the CLI, Settings
  // lists Codex as needing setup.
  codex: {
    storeDir: process.env.FACTORY_CODEX_STORE_DIR?.trim() || join(homedir(), '.mastracode', 'web', 'codex-sessions'),
    localDevelopment: ownMachine,
    ...(process.env.FACTORY_CODEX_COMMAND?.trim() ? { command: process.env.FACTORY_CODEX_COMMAND.trim() } : {}),
  },
  ...(browser ? { browser } : {}),
  // Device preview drives simulators and emulators on this machine, so only a local development
  // server (the person's own machine) offers it. State and the device tools sit next to the database.
  ...(ownMachine
    ? {
        device: {
          stateDir: process.env.FACTORY_DEVICE_STATE_DIR?.trim() || join(dirname(getDatabasePath()), 'factory-device'),
        },
      }
    : {}),
  // Card and session attachments (chat/comment uploads, later ClickUp/GitHub files): bytes on this
  // host's disk, next to the local database unless FACTORY_ATTACHMENTS_DIR names another directory.
  // A multi-replica deployment needs a shared store here (an S3 `AttachmentBlobStore`).
  attachments: {
    store: new LocalFileBlobStore({
      root: process.env.FACTORY_ATTACHMENTS_DIR?.trim() || join(dirname(getDatabasePath()), 'factory-attachments'),
    }),
    maxBytes: positiveInt(process.env.FACTORY_ATTACHMENTS_MAX_BYTES),
  },
  // Per-replica cap on concurrent Factory background dispatches. Unset means
  // the dispatcher default; invalid and non-positive values are ignored.
  dispatcher: {
    maxInFlight: positiveInt(process.env.MASTRACODE_DISPATCH_MAX_IN_FLIGHT),
  },
  // Agent state (threads, messages, memory, OM, recall vectors) lives in the
  // single app Postgres alongside the github/app tables — one shared DB (and
  // pg pool) for all users, separated by `resourceId` scoping. Unset (bare
  // local dev) → default storage resolution applies (local libSQL file).
  storage,
  vector,
  pubsub,
  platform: {
    // The deployment's own self-hosted App slug, when one is configured. It is
    // NOT Platform's identity: Platform posts as its own App, which names
    // itself. Reusing this value for that purpose left self-recognition
    // comparing against `undefined[bot]` on every Platform deployment, where
    // this is legitimately unset.
    githubAppSlug,
  },
  // Browser-facing origin. On the platform the SPA is hosted separately, so
  // this MUST be set to the public API origin.
  publicUrl: process.env.MASTRACODE_PUBLIC_URL,
  // Allowed cross-origin SPA origins (comma-separated). The SPA is served from
  // a separate static host, so credentialed requests must be explicitly allowed.
  allowedOrigins: (process.env.MASTRACODE_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean),
  // Deployment-stable secret for OAuth `state` signing (GitHub/GitLab connect
  // flows). See `stateSecret` above.
  stateSecret,
});

const preparedArgs = await factory.prepare();

// Construct the server-owned Mastra HERE so the `new Mastra(...)` literal lives
// in the entry file (see module docs). `prepare()` returns the constructor args
// carrying the controller (via `agentControllers`), storage, and the assembled
// `server` config (middleware + apiRoutes + cors). Keep the worker-relevant
// properties explicit so deploy builds can statically detect the worker topology.
export const mastra = new Mastra({
  ...preparedArgs,
  storage: preparedArgs.storage,
  pubsub: preparedArgs.pubsub,
  workers: preparedArgs.workers,
  workflows: preparedArgs.workflows,
  // Local dev auth trusts loopback only, so bind the server there too.
  ...(localDevAuthEnabled ? { server: { ...preparedArgs.server, host: '127.0.0.1' } } : {}),
});

// Post-construct boot: initialize the controller (which now inherits this
// instance's storage) and start its workers. Runs at module load via top-level
// await, so the deployer imports a fully-booted instance.
await factory.finalize();

// The deployer creates the HTTP server itself; device preview's hub sockets attach to it on its
// first request (the page and its API load before any device socket opens).
if (ownMachine) attachOnFirstRequest(server => factory.attachDevice(server));
