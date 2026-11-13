/**
 * Agents are connections too (ADR-0036): the accounts a turn-based harness runs on (Claude Code's
 * Claude sign-ins, Codex's ChatGPT sign-ins) are one connector per harness in Settings ›
 * Підключення, served by the same registry as every integration (ADR-0035). One implementation for
 * every such harness, parameterized by its descriptor (`HarnessDescriptor.setup.accounts`), its
 * sign-in flow and its usage facet: a new harness with accounts is a new registration, never new UI.
 *
 * - Connect: the harness CLI's own sign-in (`claude auth login`, `codex login`) run by the server;
 *   its page opens in a browser on the server's machine, so the connect result is an `authorize`
 *   with only an `authId` and a `waiting` note, and `getAuthStatus` says when it ended.
 * - List: one connection per account of the organization; state says whether it runs, is out of
 *   usage until a time, needs a new sign-in, is off, or is a pasted token from before (runs nothing).
 * - Who may change what, declared as permissions the registry enforces: any member connects (signs
 *   in) their own; renaming, rotation and removing are the owner's or an organization admin's
 *   (`ownerOrAdmin`); a new sign-in to an account is only its owner's (`owner`).
 * - Detail: facts, the allowance windows (`HarnessUsage`), recent usage (owner or admin), and the
 *   rotation switch — generic sections, no harness-specific UI.
 *
 * Rotation itself (which account a turn picks, cooldowns) stays in the server's account pool; this
 * only shows and changes the accounts it picks from.
 */

import { getTenantCredentialsStorage, pickCredentialAccount } from '@factory/credentials';
import type { HarnessDescriptor } from '@factory/contracts';
import type { AccountUsageLimits, HarnessUsage, UsageWindow } from '@factory/harness/usage';
import { daysBetween, summarizeUsage, utcDay } from '@factory/harness/usage';
import { connectionOk, connectionRefused, localize } from '@factory/integrations';
import type {
  ConnectionCopy,
  ConnectionDetailSection,
  ConnectionLanguage,
  ConnectionOutcome,
  ConnectionRequest,
  ConnectMethod,
  ConnectorConnection,
  ConnectorConnectResult,
  IntegrationConnections,
  RemovalImpact,
} from '@factory/integrations';
import { isSignInCredentialKind } from '@factory/store';
import type { CredentialAccount, FactoryProjectsStorage, ModelCredentialsStorage, SignInCredentialKind, UsageStorage } from '@factory/store';

import type { AccountSignInFlows } from './credential-accounts.ts';
import { readAccountUsage } from './usage.ts';

/** The one connect method: the harness CLI's own sign-in. */
const SIGN_IN_METHOD = 'sign-in';
/** How long the UI waits on a sign-in run by the server's CLI (its own timeout is five minutes). */
const SIGN_IN_WAIT_MS = 5 * 60_000;
/** Recent usage on a connection's page: this many days, today included. */
const RECENT_USAGE_DAYS = 7;

export interface AgentAccountsConnectorOptions {
  /** The harness whose sessions run on these accounts; `setup.accounts` names provider and connector. */
  harness: HarnessDescriptor;
  /** The sign-in kind its turns run on (`claude_login`, `codex_login`). */
  kind: SignInCredentialKind;
  /** How the provider names its sign-in ("Claude", "ChatGPT"). */
  signInName: string;
  credentials: ModelCredentialsStorage | undefined;
  /** The CLI sign-in on this host; unset where its browser would open on a machine nobody sits at. */
  signIn?: AccountSignInFlows;
  /** Allowance windows and recorded turns, when the server keeps usage. */
  usage?: { storage: Pick<UsageStorage, 'listAccountLimits' | 'saveAccountLimits' | 'listTurns'>; facet?: HarnessUsage };
  /** Factories, for what removing an account stops. */
  projects?: Pick<FactoryProjectsStorage, 'list'>;
  /** A member's name, for the owner of an account; their id otherwise. */
  userName?(userId: string): Promise<string | undefined>;
  now?: () => Date;
}

type Copy = {
  description: (harness: string, signIn: string) => string;
  methodLabel: (signIn: string) => string;
  methodDescription: (signIn: string) => string;
  signInUnavailable: (signIn: string) => string;
  provides: (harness: string) => string;
  waitingTitle: (signIn: string) => string;
  waitingMessage: string;
  ownerOnlyReconnect: string;
  manageOwnOnly: string;
  legacyReconnect: string;
  you: string;
  member: string;
  states: {
    ok: string;
    limited: string;
    limitedUntil: (time: string) => string;
    needsSignIn: string;
    needsSignInMessage: (error: string | undefined) => string;
    off: string;
    offMessage: string;
    legacy: string;
    legacyMessage: string;
  };
  facts: {
    title: string;
    owner: string;
    account: string;
    plan: string;
    state: string;
    lastUsed: string;
    never: string;
    limitedUntil: string;
    lastError: string;
    added: string;
  };
  limits: {
    title: string;
    description: string;
    columns: [string, string, string];
    empty: string;
    stale: (time: string) => string;
    unavailable: string;
    window: (kind: UsageWindow['kind'], label: string | undefined) => string;
  };
  recent: {
    title: (days: number) => string;
    columns: [string, string, string];
    empty: string;
  };
  rotation: {
    title: string;
    description: string;
    enabled: string;
    enabledDescription: string;
    legacyReason: string;
    needsSignInReason: string;
    saved: (on: boolean) => string;
  };
  factoryRuns: {
    title: string;
    description: string;
    enabled: string;
    enabledDescription: string;
    ownerOnlyReason: string;
    saved: (on: boolean) => string;
  };
  impact: {
    title: (label: string) => string;
    lastBody: (harness: string, owner: string) => string;
    otherBody: (count: number) => string;
    itemsLabel: string;
    stops: (owner: string) => string;
    confirm: string;
    cancel: string;
    warning: (harness: string) => string;
  };
  removed: (label: string) => string;
  renamed: string;
  notFound: string;
  signInFailed: (signIn: string) => string;
};

const COPY: ConnectionCopy<Copy> = {
  en: {
    description: (harness, signIn) => `The ${signIn} accounts ${harness} sessions run on. Each member signs in with their own; sessions rotate to the next when one runs out of usage.`,
    methodLabel: signIn => `Sign in with ${signIn}`,
    methodDescription: signIn => `Opens the ${signIn} sign-in page in a browser on the server's machine.`,
    signInUnavailable: signIn => `Signing in to ${signIn} here works only where the Factory server runs on your own machine.`,
    provides: harness => `Runs ${harness} sessions`,
    waitingTitle: signIn => `Finish signing in to ${signIn} in the browser that opened`,
    waitingMessage: 'The page opened on the machine the Factory server runs on. This updates once you are signed in.',
    ownerOnlyReconnect: 'Only its owner can sign in to this account again.',
    manageOwnOnly: 'Only its owner or an organization admin can change this account.',
    legacyReconnect: 'A pasted token from before sign-ins cannot be renewed; remove it and sign in instead.',
    you: 'Yours',
    member: "A member's",
    states: {
      ok: 'Connected',
      limited: 'Out of usage',
      limitedUntil: time => `Out of usage until ${time}`,
      needsSignIn: 'Needs sign-in',
      needsSignInMessage: error => (error ? `The sign-in was refused: ${error}` : 'The sign-in was refused; sign in again.'),
      off: 'Off',
      offMessage: 'Turned off: no session runs on it.',
      legacy: 'Old token',
      legacyMessage: 'A pasted token from before sign-ins: no session uses it any more.',
    },
    facts: {
      title: 'Account',
      owner: 'Owner',
      account: 'Signed in as',
      plan: 'Plan',
      state: 'State',
      lastUsed: 'Last used',
      never: 'Not yet',
      limitedUntil: 'Back in rotation',
      lastError: 'Last error',
      added: 'Added',
    },
    limits: {
      title: 'Usage limits',
      description: 'How much of each allowance window is used, as the provider last said.',
      columns: ['Window', 'Used', 'Resets'],
      empty: 'No reading yet: it shows after the first session on this account.',
      stale: time => `As of ${time}.`,
      unavailable: 'The provider has no allowance windows for this account.',
      window: (kind, label) =>
        label ?? { session: '5-hour', weekly: 'Weekly', monthly: 'Monthly', model: 'Model', spend: 'Extra usage' }[kind],
    },
    recent: {
      title: days => `Last ${days} days`,
      columns: ['Day', 'Turns', 'Tokens'],
      empty: 'No session ran on this account in these days.',
    },
    rotation: {
      title: 'Rotation',
      description: 'Sessions take the first account that has usage left; one that runs out sits out until it resets.',
      enabled: 'In rotation',
      enabledDescription: 'Off: no session runs on this account until it is turned back on.',
      legacyReason: 'A pasted token runs nothing; remove it.',
      needsSignInReason: 'Sign in again to put it back in rotation.',
      saved: on => (on ? 'The account is back in rotation.' : 'The account is out of rotation.'),
    },
    factoryRuns: {
      title: 'Factory cards',
      description:
        "A card's phases run as the Factory, not as the person who moved it, so they use only the sign-ins their owners share here.",
      enabled: 'Runs Factory cards',
      enabledDescription: "On: the organization's card runs may use this sign-in and its usage.",
      ownerOnlyReason: 'Only the person who signed in can share their sign-in with Factory cards.',
      saved: on => (on ? 'Factory cards may run on this account.' : 'Factory cards no longer run on this account.'),
    },
    impact: {
      title: label => `Remove ${label}?`,
      lastBody: (harness, owner) => `This is ${owner} only ${harness} account: their sessions on these Factories stop until they sign in again.`,
      otherBody: count => `Sessions go on with the other ${count === 1 ? 'account' : `${count} accounts`} in rotation.`,
      itemsLabel: 'Factories',
      stops: owner => `${owner} sessions stop`,
      confirm: 'Remove account',
      cancel: 'Cancel',
      warning: harness => `Without an account, ${harness} is not offered to this member until they sign in again.`,
    },
    removed: label => `${label} was removed.`,
    renamed: 'Renamed.',
    notFound: 'This account no longer exists.',
    signInFailed: signIn => `${signIn} sign-in failed.`,
  },
  uk: {
    description: (harness, signIn) => `Акаунти ${signIn}, на яких працюють сесії ${harness}. Кожен учасник входить у свій; коли в одного закінчується ліміт, сесії переходять на наступний.`,
    methodLabel: signIn => `Увійти через ${signIn}`,
    methodDescription: signIn => `Відкриває сторінку входу ${signIn} у браузері на машині сервера.`,
    signInUnavailable: signIn => `Увійти в ${signIn} звідси можна лише там, де сервер Factory працює на вашій машині.`,
    provides: harness => `Запускає сесії ${harness}`,
    waitingTitle: signIn => `Завершіть вхід у ${signIn} у браузері, що відкрився`,
    waitingMessage: 'Сторінка відкрилась на машині, де працює сервер Factory. Тут оновиться, щойно ви ввійдете.',
    ownerOnlyReconnect: 'Увійти в цей акаунт знову може лише його власник.',
    manageOwnOnly: 'Змінювати цей акаунт можуть лише його власник або адміністратор організації.',
    legacyReconnect: 'Вставлений колись токен не оновити: видаліть його й увійдіть.',
    you: 'Ваш',
    member: 'Учасника',
    states: {
      ok: 'Підключено',
      limited: 'Ліміт вичерпано',
      limitedUntil: time => `Ліміт вичерпано до ${time}`,
      needsSignIn: 'Потрібен вхід',
      needsSignInMessage: error => (error ? `Вхід відхилено: ${error}` : 'Вхід відхилено; увійдіть знову.'),
      off: 'Вимкнено',
      offMessage: 'Вимкнено: жодна сесія на ньому не працює.',
      legacy: 'Старий токен',
      legacyMessage: 'Токен, вставлений до входу через акаунт: жодна сесія його вже не використовує.',
    },
    facts: {
      title: 'Акаунт',
      owner: 'Власник',
      account: 'Вхід як',
      plan: 'План',
      state: 'Стан',
      lastUsed: 'Востаннє використано',
      never: 'Ще ні',
      limitedUntil: 'Повернеться в ротацію',
      lastError: 'Остання помилка',
      added: 'Додано',
    },
    limits: {
      title: 'Ліміти використання',
      description: 'Скільки використано в кожному вікні ліміту, як востаннє сказав провайдер.',
      columns: ['Вікно', 'Використано', 'Скидається'],
      empty: 'Ще немає даних: з’являться після першої сесії на цьому акаунті.',
      stale: time => `Станом на ${time}.`,
      unavailable: 'У провайдера немає вікон ліміту для цього акаунта.',
      window: (kind, label) =>
        label ?? { session: '5 годин', weekly: 'Тиждень', monthly: 'Місяць', model: 'Модель', spend: 'Додаткове використання' }[kind],
    },
    recent: {
      title: days => `Останні ${days} днів`,
      columns: ['День', 'Ходи', 'Токени'],
      empty: 'За ці дні на цьому акаунті не працювала жодна сесія.',
    },
    rotation: {
      title: 'Ротація',
      description: 'Сесії беруть перший акаунт, у якого лишився ліміт; вичерпаний чекає, доки ліміт скинеться.',
      enabled: 'У ротації',
      enabledDescription: 'Вимкнений: жодна сесія не працює на цьому акаунті, доки його не ввімкнуть.',
      legacyReason: 'Вставлений токен нічого не запускає; видаліть його.',
      needsSignInReason: 'Увійдіть знову, щоб повернути його в ротацію.',
      saved: on => (on ? 'Акаунт знову в ротації.' : 'Акаунт вийшов з ротації.'),
    },
    factoryRuns: {
      title: 'Картки Factory',
      description:
        'Фази картки працюють від імені Factory, а не людини, яка її перемістила, тож беруть лише ті входи, якими власники поділились тут.',
      enabled: 'Запускає картки Factory',
      enabledDescription: 'Увімкнено: запуски карток організації можуть брати цей вхід і його ліміти.',
      ownerOnlyReason: 'Поділитися входом з картками Factory може лише той, хто ввійшов.',
      saved: on => (on ? 'Картки Factory можуть працювати на цьому акаунті.' : 'Картки Factory більше не працюють на цьому акаунті.'),
    },
    impact: {
      title: label => `Видалити ${label}?`,
      lastBody: (harness, owner) => `Це єдиний акаунт ${harness} (${owner}): сесії на цих Factory зупиняться, доки власник не ввійде знову.`,
      otherBody: count => `Сесії продовжать на інших акаунтах у ротації: ${count}.`,
      itemsLabel: 'Factory',
      stops: owner => `Сесії (${owner}) зупиняться`,
      confirm: 'Видалити акаунт',
      cancel: 'Скасувати',
      warning: harness => `Без акаунта ${harness} не пропонуватиметься цьому учаснику, доки він не ввійде знову.`,
    },
    removed: label => `${label} видалено.`,
    renamed: 'Перейменовано.',
    notFound: 'Цього акаунта вже немає.',
    signInFailed: signIn => `Не вдалося увійти в ${signIn}.`,
  },
};

const formatTime = (value: Date | string, language: ConnectionLanguage) =>
  new Intl.DateTimeFormat(language === 'uk' ? 'uk-UA' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

const formatNumber = (value: number, language: ConnectionLanguage) => new Intl.NumberFormat(language === 'uk' ? 'uk-UA' : 'en-GB').format(value);

/** Where an account stands, as its row and the pool see it. */
type AccountCondition = 'ok' | 'limited' | 'needs_sign_in' | 'off' | 'legacy';

/**
 * The agent accounts connector of one harness. Its id is `harness.setup.accounts.connector`; the
 * registry prefixes the account ids with it.
 */
export function createAgentAccountsConnections(options: AgentAccountsConnectorOptions): IntegrationConnections {
  const { harness, kind, signInName } = options;
  const accounts = harness.setup.accounts;
  if (!accounts) throw new Error(`${harness.label} runs on no accounts; it has no agent connector.`);
  const provider = accounts.provider;
  const now = options.now ?? (() => new Date());

  const storage = async (): Promise<ModelCredentialsStorage | undefined> => getTenantCredentialsStorage(options.credentials);

  const conditionOf = (account: CredentialAccount): AccountCondition => {
    if (account.kind !== kind) return 'legacy';
    if (account.disabled) return isSignInCredentialKind(account.kind) && account.lastError !== undefined ? 'needs_sign_in' : 'off';
    if (account.limitedUntil && account.limitedUntil.getTime() > now().getTime()) return 'limited';
    return 'ok';
  };

  const canManage = (account: CredentialAccount, request: ConnectionRequest) => account.ownerUserId === request.userId || request.admin;

  const ownerLabel = async (account: CredentialAccount, request: ConnectionRequest, copy: Copy): Promise<string> => {
    if (!account.ownerUserId) return copy.member;
    if (account.ownerUserId === request.userId) return copy.you;
    return (await options.userName?.(account.ownerUserId).catch(() => undefined)) ?? account.ownerUserId;
  };

  const method = (copy: Copy): ConnectMethod => ({
    id: SIGN_IN_METHOD,
    label: copy.methodLabel(signInName),
    description: copy.methodDescription(signInName),
    authKind: 'oauth',
    available: options.signIn ? true : { reason: copy.signInUnavailable(signInName) },
  });

  const view = async (store: ModelCredentialsStorage, account: CredentialAccount, request: ConnectionRequest): Promise<ConnectorConnection> => {
    const copy = localize(COPY, request.language);
    const condition = conditionOf(account);
    const oauth = condition === 'legacy' ? undefined : await store.getAccountOAuth(request.orgId, account.id).catch(() => undefined);
    const email = oauth?.email ?? null;
    const owner = await ownerLabel(account, request, copy);
    const state = {
      ok: { tone: 'ok' as const, label: copy.states.ok },
      limited: {
        tone: 'warning' as const,
        label: account.limitedUntil ? copy.states.limitedUntil(formatTime(account.limitedUntil, request.language)) : copy.states.limited,
        ...(account.lastError ? { message: account.lastError } : {}),
      },
      needs_sign_in: { tone: 'error' as const, label: copy.states.needsSignIn, message: copy.states.needsSignInMessage(account.lastError) },
      off: { tone: 'idle' as const, label: copy.states.off, message: copy.states.offMessage },
      legacy: { tone: 'idle' as const, label: copy.states.legacy, message: copy.states.legacyMessage },
    }[condition];
    const reconnect =
      condition === 'legacy'
        ? { reason: copy.legacyReconnect }
        : options.signIn
          ? { method: method(copy) }
          : { reason: copy.signInUnavailable(signInName) };
    return {
      id: account.id,
      status: condition === 'needs_sign_in' ? 'needs_reauth' : 'active',
      displayName: email && account.label !== email ? account.label : null,
      accountLabel: email ?? (condition === 'legacy' ? null : account.label),
      accountDetail: [owner, oauth?.subscriptionType].filter(Boolean).join(' · '),
      label: account.label,
      method: copy.methodLabel(signInName),
      provides: [{ key: 'agent', label: copy.provides(harness.label) }],
      state,
      scope: 'organization',
      createdAt: account.createdAt.toISOString(),
      createdBy: account.createdBy,
      actions: {
        rename: true,
        reconnect,
        remove: true,
      },
    };
  };

  const find = async (request: ConnectionRequest, id: string) => {
    const store = await storage();
    const account = store ? await store.getAccount(request.orgId, id) : undefined;
    return store && account && account.provider === provider ? { store, account } : undefined;
  };

  const notFound = (language: ConnectionLanguage) => connectionRefused(404, { error: 'not_found', message: localize(COPY, language).notFound });

  const startSignIn = (request: ConnectionRequest): ConnectionOutcome<ConnectorConnectResult> => {
    const copy = localize(COPY, request.language);
    if (!options.signIn) return connectionRefused(409, { error: 'sign_in_unavailable', message: copy.signInUnavailable(signInName) });
    const flow = options.signIn.start({ orgId: request.orgId, userId: request.userId });
    return connectionOk({
      type: 'authorize',
      authId: flow.id,
      waiting: { title: copy.waitingTitle(signInName), message: copy.waitingMessage, timeoutMs: SIGN_IN_WAIT_MS },
    });
  };

  /** What removing `account` stops: its owner's sessions on the harness's Factories, when it is their last. */
  const impactOf = async (store: ModelCredentialsStorage, account: CredentialAccount, request: ConnectionRequest): Promise<RemovalImpact> => {
    const copy = localize(COPY, request.language);
    const owner = await ownerLabel(account, request, copy);
    const all = (await store.listAccounts(request.orgId, provider)).filter(candidate => candidate.kind === kind);
    const others = all.filter(candidate => candidate.id !== account.id);
    // What the pool could still pick for the owner without this account (now or after a reset).
    const left = account.ownerUserId ? pickCredentialAccount(others, { userId: account.ownerUserId, now: now() }) : undefined;
    const ownerLeft = left !== undefined && (left.account !== undefined || left.resetsAt !== undefined);
    const last = conditionOf(account) !== 'legacy' && account.ownerUserId !== undefined && !ownerLeft;
    const factories = last ? ((await options.projects?.list({ orgId: request.orgId })) ?? []).filter(project => project.harness === harness.id) : [];
    const usableOthers = others.filter(candidate => !candidate.disabled && candidate.ownerUserId === account.ownerUserId).length;
    return {
      title: copy.impact.title(account.label),
      body: last ? copy.impact.lastBody(harness.label, owner) : copy.impact.otherBody(usableOthers),
      dependents: factories.map(project => ({ label: project.name })),
      ...(factories.length > 0 ? { itemsLabel: copy.impact.itemsLabel } : {}),
      items: factories.map(project => ({ label: project.name, outcome: 'stops' as const, outcomeLabel: copy.impact.stops(owner) })),
      confirmLabel: copy.impact.confirm,
      cancelLabel: copy.impact.cancel,
      ...(last ? { warning: copy.impact.warning(harness.label) } : {}),
      requiresConfirm: factories.length > 0,
    };
  };

  const limitsSection = async (account: CredentialAccount, request: ConnectionRequest): Promise<ConnectionDetailSection | undefined> => {
    const usage = options.usage;
    if (!usage?.facet || conditionOf(account) === 'legacy') return undefined;
    const copy = localize(COPY, request.language);
    const known: AccountUsageLimits | undefined = (await usage.storage.listAccountLimits(request.orgId, [account.id])).get(account.id);
    const read = await readAccountUsage({ usage: usage.storage, facet: usage.facet, orgId: request.orgId, account, known, refresh: true, now: now() }).catch(
      () => known,
    );
    const windows = read?.windows ?? [];
    return {
      type: 'table',
      title: copy.limits.title,
      description: [
        copy.limits.description,
        read ? copy.limits.stale(formatTime(read.checkedAt, request.language)) : undefined,
        read?.unavailable && windows.length === 0 ? (read.unavailable.message ?? copy.limits.unavailable) : undefined,
      ]
        .filter(Boolean)
        .join(' '),
      columns: [...copy.limits.columns],
      rows: windows.map(window => ({
        cells: [
          copy.limits.window(window.kind, window.label),
          `${Math.round(window.usedPercent)}%`,
          window.resetsAt ? formatTime(window.resetsAt, request.language) : '—',
        ],
      })),
      empty: copy.limits.empty,
    };
  };

  const recentSection = async (account: CredentialAccount, request: ConnectionRequest): Promise<ConnectionDetailSection | undefined> => {
    // Turns are a member's work: what ran on an account is shown to its owner and to admins.
    if (!options.usage || !canManage(account, request) || conditionOf(account) === 'legacy') return undefined;
    const copy = localize(COPY, request.language);
    const period = { from: utcDay(now().getTime() - (RECENT_USAGE_DAYS - 1) * 86_400_000), to: utcDay(now()) };
    const turns = await options.usage.storage.listTurns({ orgId: request.orgId, days: daysBetween(period.from, period.to), accountId: account.id });
    const rows = summarizeUsage(turns, period)
      .byDay.filter(day => day.turns > 0)
      .reverse()
      .map(day => ({ cells: [day.day, formatNumber(day.turns, request.language), formatNumber(day.totalTokens, request.language)] }));
    return { type: 'table', title: copy.recent.title(RECENT_USAGE_DAYS), columns: [...copy.recent.columns], rows, empty: copy.recent.empty };
  };

  /** The account `localId` and whether the request is its owner; a missing account is left to the call (404). */
  const ownership = async (request: ConnectionRequest, localId: string | undefined) => {
    const found = localId ? await find(request, localId) : undefined;
    return { found, owner: found?.account.ownerUserId === request.userId };
  };

  return {
    // Any member signs in with their own account; the rest is the owner's (or an admin's), enforced by the registry.
    permissions: {
      connect: 'member',
      reconnect: { policy: 'owner' },
      rename: { policy: 'ownerOrAdmin' },
      remove: { policy: 'ownerOrAdmin' },
      settings: { policy: 'ownerOrAdmin' },
    },
    policies: {
      // A sign-in files under the person signing in; it replaces this account only when it is theirs.
      owner: async (request, localId) => {
        const { found, owner } = await ownership(request, localId);
        return !found || owner ? true : { reason: localize(COPY, request.language).ownerOnlyReconnect };
      },
      ownerOrAdmin: async (request, localId) => {
        const { found, owner } = await ownership(request, localId);
        return !found || owner || request.admin ? true : { reason: localize(COPY, request.language).manageOwnOnly };
      },
    },

    describe(request) {
      const copy = localize(COPY, request.language);
      return {
        name: harness.label,
        icon: harness.icon,
        description: copy.description(harness.label, signInName),
        category: 'agents',
        provides: [{ key: 'agent', label: copy.provides(harness.label) }],
        // Many sign-ins per harness; a new sign-in to the same account refreshes it in place; removing forgets it here, nothing is revoked.
        capabilities: {
          multipleConnectionsPerToolkit: true,
          batchConnectionStatus: false,
          reauthorizeReusesConnectionId: true,
          supportsRevoke: false,
        },
        methods: [method(copy)],
      };
    },

    async list(request) {
      const store = await storage();
      if (!store) return [];
      const listed = await store.listAccounts(request.orgId, provider);
      return Promise.all(listed.map(account => view(store, account, request)));
    },

    async connect(request, methodId) {
      if (methodId !== SIGN_IN_METHOD) return notFound(request.language);
      return startSignIn(request);
    },

    async getAuthStatus(request, authId) {
      const flow = options.signIn?.get(authId);
      // Another person's sign-in is not there for this caller.
      if (!flow || flow.orgId !== request.orgId || flow.userId !== request.userId) return null;
      if (flow.status === 'pending') return 'pending';
      if (flow.status === 'done') return 'completed';
      return { status: 'failed', message: flow.error ?? localize(COPY, request.language).signInFailed(signInName) };
    },

    async reconnect(request, id) {
      const found = await find(request, id);
      if (!found) return notFound(request.language);
      const copy = localize(COPY, request.language);
      if (found.account.kind !== kind) return connectionRefused(409, { error: 'legacy', message: copy.legacyReconnect });
      return startSignIn(request);
    },

    async rename(request, id, name) {
      const found = await find(request, id);
      if (!found) return notFound(request.language);
      // An empty name goes back to who signed in.
      const label =
        name.trim() || (await found.store.getAccountOAuth(request.orgId, id).catch(() => undefined))?.email || `${signInName} · ${harness.label}`;
      await found.store.updateAccount(request.orgId, id, { label: label.slice(0, 100) });
      return connectionOk({ name: label });
    },

    async removalImpact(request, id) {
      const found = await find(request, id);
      return found ? impactOf(found.store, found.account, request) : null;
    },

    async remove(request, id, { confirm }) {
      const found = await find(request, id);
      if (!found) return notFound(request.language);
      const impact = await impactOf(found.store, found.account, request);
      if (impact.requiresConfirm && !confirm) {
        return connectionRefused(409, { error: 'confirmation_required', message: impact.body, impact });
      }
      await found.store.removeAccount(request.orgId, id);
      request.audit('connection_removed', { connector: accounts.connector, accountId: id, provider });
      return connectionOk({ message: localize(COPY, request.language).removed(found.account.label) });
    },

    async updateSettings(request, id, section, values) {
      const found = await find(request, id);
      if (!found) return notFound(request.language);
      const copy = localize(COPY, request.language);
      if (section === 'factoryRuns' && typeof values.enabled === 'boolean') {
        if (found.account.kind !== kind) return connectionRefused(409, { error: 'legacy', message: copy.rotation.legacyReason });
        // Sharing spends a person's own subscription on the organization's cards: only they decide to.
        if (values.enabled && found.account.ownerUserId !== request.userId) {
          return connectionRefused(403, { error: 'owner_only', message: copy.factoryRuns.ownerOnlyReason });
        }
        await found.store.updateAccount(request.orgId, id, { factoryRuns: values.enabled });
        return connectionOk({ message: copy.factoryRuns.saved(values.enabled) });
      }
      if (section !== 'rotation' || typeof values.enabled !== 'boolean') {
        return connectionRefused(400, { error: 'invalid_settings', message: copy.notFound });
      }
      const condition = conditionOf(found.account);
      if (condition === 'legacy') return connectionRefused(409, { error: 'legacy', message: copy.rotation.legacyReason });
      if (condition === 'needs_sign_in' && values.enabled) {
        return connectionRefused(409, { error: 'needs_sign_in', message: copy.rotation.needsSignInReason });
      }
      await found.store.updateAccount(request.orgId, id, { disabled: !values.enabled });
      return connectionOk({ message: copy.rotation.saved(values.enabled) });
    },

    async detail(request, id) {
      const found = await find(request, id);
      if (!found) return null;
      const { store, account } = found;
      const copy = localize(COPY, request.language);
      const row = await view(store, account, request);
      const condition = conditionOf(account);
      const facts: ConnectionDetailSection = {
        type: 'facts',
        title: copy.facts.title,
        rows: [
          { label: copy.facts.owner, value: await ownerLabel(account, request, copy) },
          ...(row.accountLabel ? [{ label: copy.facts.account, value: row.accountLabel }] : []),
          ...(row.accountDetail?.includes(' · ') ? [{ label: copy.facts.plan, value: row.accountDetail.split(' · ').slice(1).join(' · ') }] : []),
          { label: copy.facts.state, value: row.state.label, ...(row.state.message ? { detail: row.state.message } : {}) },
          {
            label: copy.facts.lastUsed,
            value: account.lastUsedAt ? formatTime(account.lastUsedAt, request.language) : copy.facts.never,
          },
          ...(condition === 'limited' && account.limitedUntil
            ? [{ label: copy.facts.limitedUntil, value: formatTime(account.limitedUntil, request.language) }]
            : []),
          ...(account.lastError && condition !== 'limited' ? [{ label: copy.facts.lastError, value: account.lastError }] : []),
          { label: copy.facts.added, value: formatTime(account.createdAt, request.language) },
        ],
      };
      const blocked =
        condition === 'legacy'
          ? copy.rotation.legacyReason
          : condition === 'needs_sign_in'
            ? copy.rotation.needsSignInReason
            : undefined;
      const rotation: ConnectionDetailSection = {
        type: 'settings',
        id: 'rotation',
        title: copy.rotation.title,
        description: copy.rotation.description,
        fields: [
          {
            name: 'enabled',
            displayName: copy.rotation.enabled,
            description: copy.rotation.enabledDescription,
            type: 'boolean',
            required: false,
            value: !account.disabled,
            ...(blocked ? { disabled: { reason: blocked } } : {}),
          },
        ],
      };
      const factoryRuns: ConnectionDetailSection = {
        type: 'settings',
        id: 'factoryRuns',
        title: copy.factoryRuns.title,
        description: copy.factoryRuns.description,
        fields: [
          {
            name: 'enabled',
            displayName: copy.factoryRuns.enabled,
            description: copy.factoryRuns.enabledDescription,
            type: 'boolean',
            required: false,
            value: account.factoryRuns,
            ...(condition === 'legacy'
              ? { disabled: { reason: copy.rotation.legacyReason } }
              : !account.factoryRuns && account.ownerUserId !== request.userId
                ? { disabled: { reason: copy.factoryRuns.ownerOnlyReason } }
                : {}),
          },
        ],
      };
      const [limits, recent] = await Promise.all([limitsSection(account, request), recentSection(account, request)]);
      return [facts, ...(limits ? [limits] : []), rotation, factoryRuns, ...(recent ? [recent] : [])];
    },
  };
}
