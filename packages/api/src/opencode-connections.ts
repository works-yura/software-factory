/**
 * OpenCode in Settings › Підключення (ADR-0043, amendment): the organization's OpenCode accounts.
 * OpenCode signs in with a key from its console (opencode.ai), the same key for OpenCode Zen and,
 * with a subscription, OpenCode Go; `opencode auth login` asks for exactly that, so this is the
 * Factory's equivalent of it, kept org-wide like every connection (encrypted, provider `opencode`,
 * kind `api_key`). The key is checked against OpenCode before it is kept. With an account, OpenCode
 * runs sign in with it and its paid models show; without, they run on the free models.
 *
 * The person's own OpenCode login is never read: an account exists only when someone gives its key here.
 */
import { getTenantCredentialsStorage } from '@factory/credentials';
import type { HarnessDescriptor } from '@factory/contracts';
import type { AccountUsageLimits, HarnessUsage, UsageWindow } from '@factory/harness/usage';
import { connectionOk, connectionRefused, localize } from '@factory/integrations';
import type {
  ConnectionCopy,
  ConnectionDetailSection,
  ConnectionLanguage,
  ConnectionOutcome,
  ConnectionRequest,
  ConnectMethod,
  ConnectorConnection,
  IntegrationConnections,
} from '@factory/integrations';
import type { CredentialAccount, ModelCredentialsStorage, UsageStorage } from '@factory/store';

import { readAccountUsage } from './usage.ts';

/** The connect method: a key from OpenCode's console. */
const KEY_METHOD = 'api-key';
/** Where OpenCode's console hands out keys. */
export const OPENCODE_CONSOLE_KEYS_URL = 'https://opencode.ai/auth';

/** What checking a key told: good (with or without Go), or refused with why. */
export type OpenCodeKeyCheck = { ok: true; go: boolean } | { ok: false; message: string };

export interface OpenCodeAccountsConnectorOptions {
  harness: HarnessDescriptor;
  credentials: ModelCredentialsStorage | undefined;
  /** Checks a key with OpenCode before it is kept (its Go usage endpoint). */
  checkKey(apiKey: string): Promise<OpenCodeKeyCheck>;
  usage?: { storage: Pick<UsageStorage, 'listAccountLimits' | 'saveAccountLimits'>; facet?: HarnessUsage };
  now?: () => Date;
}

type Copy = {
  description: string;
  methodLabel: string;
  methodDescription: string;
  fields: { label: [string, string]; key: [string, string] };
  submit: string;
  provides: string;
  connected: string;
  connectedMessage: (go: boolean) => string;
  keyMissing: string;
  keyRefused: (message: string) => string;
  notFound: string;
  states: { ok: string; limited: (time: string) => string; failed: string; off: string };
  facts: { title: string; key: string; state: string; lastUsed: string; never: string; limitedUntil: string; lastError: string; added: string };
  limits: { title: string; description: string; columns: [string, string, string]; empty: string; window: (kind: UsageWindow['kind']) => string };
  removed: string;
};

const COPY: ConnectionCopy<Copy> = {
  en: {
    description:
      'OpenCode accounts the OpenCode harness signs in with: their paid OpenCode Zen and OpenCode Go models become available, and runs rotate to the next account when one runs out of usage. Without an account, OpenCode runs on its free models.',
    methodLabel: 'OpenCode key',
    methodDescription: `A key from OpenCode's console (${OPENCODE_CONSOLE_KEYS_URL}), the same one \`opencode auth login\` asks for. It serves OpenCode Zen and, with a subscription, OpenCode Go.`,
    fields: { label: ['Name', 'How the organization calls this account.'], key: ['Key', 'Kept encrypted; never shown again.'] },
    submit: 'Connect',
    provides: 'OpenCode runs',
    connected: 'OpenCode account connected',
    connectedMessage: go => (go ? 'OpenCode runs now sign in with it; its OpenCode Go usage shows here.' : 'OpenCode runs now sign in with it. It has no OpenCode Go subscription, so it has no usage windows.'),
    keyMissing: 'Paste the key from OpenCode’s console.',
    keyRefused: message => `OpenCode refused this key: ${message}`,
    notFound: 'This OpenCode account was not found.',
    states: { ok: 'Connected', limited: time => `Out of usage until ${time}`, failed: 'Key refused', off: 'Off' },
    facts: {
      title: 'Account',
      key: 'Key',
      state: 'State',
      lastUsed: 'Last used',
      never: 'Never',
      limitedUntil: 'Out of usage until',
      lastError: 'Last error',
      added: 'Added',
    },
    limits: {
      title: 'OpenCode Go usage',
      description: 'How much of the subscription’s allowance is used, as OpenCode reports it.',
      columns: ['Window', 'Used', 'Resets'],
      empty: 'No usage windows: this key has no OpenCode Go subscription, or OpenCode did not answer.',
      window: kind => ({ session: '5 hours', weekly: 'Week', monthly: 'Month', model: 'Model', spend: 'Spend' })[kind],
    },
    removed: 'OpenCode account removed.',
  },
  uk: {
    description:
      'Облікові записи OpenCode, з якими входить харнес OpenCode: стають доступні платні моделі OpenCode Zen і OpenCode Go, а запуски переходять на наступний обліковий запис, коли в одного скінчився ліміт. Без облікового запису OpenCode працює на безкоштовних моделях.',
    methodLabel: 'Ключ OpenCode',
    methodDescription: `Ключ із консолі OpenCode (${OPENCODE_CONSOLE_KEYS_URL}) — той самий, що просить \`opencode auth login\`. Підходить для OpenCode Zen і, з підпискою, OpenCode Go.`,
    fields: { label: ['Назва', 'Як організація називає цей обліковий запис.'], key: ['Ключ', 'Зберігається зашифрованим; більше не показується.'] },
    submit: 'Підключити',
    provides: 'Запуски OpenCode',
    connected: 'Обліковий запис OpenCode підключено',
    connectedMessage: go => (go ? 'Запуски OpenCode тепер входять із ним; використання OpenCode Go видно тут.' : 'Запуски OpenCode тепер входять із ним. Підписки OpenCode Go немає, тож вікон використання теж немає.'),
    keyMissing: 'Вставте ключ із консолі OpenCode.',
    keyRefused: message => `OpenCode відхилив цей ключ: ${message}`,
    notFound: 'Цей обліковий запис OpenCode не знайдено.',
    states: { ok: 'Підключено', limited: time => `Ліміт вичерпано до ${time}`, failed: 'Ключ відхилено', off: 'Вимкнено' },
    facts: {
      title: 'Обліковий запис',
      key: 'Ключ',
      state: 'Стан',
      lastUsed: 'Востаннє',
      never: 'Ще не використовувався',
      limitedUntil: 'Ліміт вичерпано до',
      lastError: 'Остання помилка',
      added: 'Додано',
    },
    limits: {
      title: 'Використання OpenCode Go',
      description: 'Скільки з ліміту підписки використано, за даними OpenCode.',
      columns: ['Вікно', 'Використано', 'Скидається'],
      empty: 'Вікон немає: у цього ключа немає підписки OpenCode Go, або OpenCode не відповів.',
      window: kind => ({ session: '5 годин', weekly: 'Тиждень', monthly: 'Місяць', model: 'Модель', spend: 'Витрати' })[kind],
    },
    removed: 'Обліковий запис OpenCode видалено.',
  },
};

function formatTime(value: Date | string, language: ConnectionLanguage): string {
  return new Date(value).toLocaleString(language === 'uk' ? 'uk-UA' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

/** The organization's OpenCode accounts as one connector (`harness.setup.accounts.connector`). */
export function createOpenCodeAccountsConnections(options: OpenCodeAccountsConnectorOptions): IntegrationConnections {
  const { harness } = options;
  const accounts = harness.setup.accounts;
  if (!accounts) throw new Error('OpenCode has no accounts connector in its descriptor.');
  const provider = accounts.provider;
  const now = options.now ?? (() => new Date());
  const storage = () => getTenantCredentialsStorage(options.credentials);

  const method = (copy: Copy): ConnectMethod => ({
    id: KEY_METHOD,
    label: copy.methodLabel,
    description: copy.methodDescription,
    authKind: 'apiKey',
    fields: [
      { name: 'label', displayName: copy.fields.label[0], description: copy.fields.label[1], type: 'string', required: false, placeholder: 'OpenCode' },
      { name: 'key', displayName: copy.fields.key[0], description: copy.fields.key[1], type: 'secret', required: true },
    ],
    submitLabel: copy.submit,
    available: options.credentials ? true : { reason: 'This server keeps no credentials.' },
  });

  const view = (account: CredentialAccount, request: ConnectionRequest): ConnectorConnection => {
    const copy = localize(COPY, request.language);
    const limited = account.limitedUntil && account.limitedUntil.getTime() > now().getTime() ? account.limitedUntil : undefined;
    const state = account.disabled
      ? account.lastError
        ? { tone: 'error' as const, label: copy.states.failed, message: account.lastError }
        : { tone: 'idle' as const, label: copy.states.off }
      : limited
        ? { tone: 'warning' as const, label: copy.states.limited(formatTime(limited, request.language)), ...(account.lastError ? { message: account.lastError } : {}) }
        : { tone: 'ok' as const, label: copy.states.ok };
    return {
      id: account.id,
      status: account.disabled && account.lastError ? 'needs_reauth' : 'active',
      displayName: account.label,
      accountLabel: account.hint ? `…${account.hint}` : null,
      label: account.label,
      method: copy.methodLabel,
      provides: [{ key: 'agent', label: copy.provides }],
      state,
      scope: 'organization',
      createdAt: account.createdAt.toISOString(),
      createdBy: account.createdBy,
      actions: { rename: true, reconnect: { method: method(copy) }, remove: true },
    };
  };

  const find = async (request: ConnectionRequest, id: string) => {
    const store = await storage();
    const account = store ? await store.getAccount(request.orgId, id) : undefined;
    return store && account && account.provider === provider ? { store, account } : undefined;
  };

  const notFound = (language: ConnectionLanguage) => connectionRefused(404, { error: 'not_found', message: localize(COPY, language).notFound });

  /** The key from the form, checked with OpenCode; a refusal says why. */
  const checkedKey = async (
    request: ConnectionRequest,
    input: Record<string, string>,
  ): Promise<{ refused: ConnectionOutcome<never> } | { key: string; go: boolean }> => {
    const copy = localize(COPY, request.language);
    const key = input.key?.trim();
    if (!key) return { refused: connectionRefused(422, { error: 'key_required', message: copy.keyMissing }) };
    const check = await options.checkKey(key);
    if (!check.ok) return { refused: connectionRefused(422, { error: 'key_refused', message: copy.keyRefused(check.message) }) };
    return { key, go: check.go };
  };

  const limitsSection = async (account: CredentialAccount, request: ConnectionRequest): Promise<ConnectionDetailSection | undefined> => {
    const usage = options.usage;
    if (!usage?.facet) return undefined;
    const copy = localize(COPY, request.language);
    const known: AccountUsageLimits | undefined = (await usage.storage.listAccountLimits(request.orgId, [account.id])).get(account.id);
    const read = await readAccountUsage({ usage: usage.storage, facet: usage.facet, orgId: request.orgId, account, known, refresh: true, now: now() }).catch(() => known);
    const windows = read?.windows ?? [];
    return {
      type: 'table',
      title: copy.limits.title,
      description: [copy.limits.description, read?.unavailable?.message].filter(Boolean).join(' '),
      columns: [...copy.limits.columns],
      rows: windows.map(window => ({
        cells: [copy.limits.window(window.kind), `${Math.round(window.usedPercent)}%`, window.resetsAt ? formatTime(window.resetsAt, request.language) : '—'],
      })),
      empty: copy.limits.empty,
    };
  };

  return {
    // An organization's connection: any member adds an account; changing one is its maker's or an admin's.
    permissions: {
      connect: 'member',
      reconnect: { policy: 'ownerOrAdmin' },
      rename: { policy: 'ownerOrAdmin' },
      remove: { policy: 'ownerOrAdmin' },
    },
    policies: {
      ownerOrAdmin: async (request, localId) => {
        const found = localId ? await find(request, localId) : undefined;
        return !found || found.account.createdBy === request.userId || request.admin
          ? true
          : { reason: request.language === 'uk' ? 'Змінювати обліковий запис може той, хто його додав, або адміністратор.' : 'Only whoever added it or an admin may change this account.' };
      },
    },

    describe(request) {
      const copy = localize(COPY, request.language);
      return {
        name: harness.label,
        icon: harness.icon,
        description: copy.description,
        category: 'agents',
        provides: [{ key: 'agent', label: copy.provides }],
        capabilities: { multipleConnectionsPerToolkit: true, batchConnectionStatus: false, reauthorizeReusesConnectionId: true, supportsRevoke: false },
        methods: [method(copy)],
      };
    },

    async list(request) {
      const store = await storage();
      if (!store) return [];
      return (await store.listAccounts(request.orgId, provider)).filter(account => account.kind === 'api_key').map(account => view(account, request));
    },

    async connect(request, methodId, input) {
      if (methodId !== KEY_METHOD) return notFound(request.language);
      const store = await storage();
      if (!store) return connectionRefused(409, { error: 'unavailable', message: 'This server keeps no credentials.' });
      const checked = await checkedKey(request, input);
      if ('refused' in checked) return checked.refused;
      const copy = localize(COPY, request.language);
      const account = await store.addAccount({
        orgId: request.orgId,
        provider,
        label: input.label?.trim() || (checked.go ? 'OpenCode Go' : 'OpenCode'),
        kind: 'api_key',
        secret: checked.key,
        createdBy: request.userId,
      });
      request.audit('token_connected', { connector: accounts.connector, accountId: account.id });
      return connectionOk({ type: 'connected', connection: view(account, request), title: copy.connected, message: copy.connectedMessage(checked.go) });
    },

    async reconnect(request, id, input) {
      const found = await find(request, id);
      if (!found) return notFound(request.language);
      const checked = await checkedKey(request, input);
      if ('refused' in checked) return checked.refused;
      const copy = localize(COPY, request.language);
      // A new key puts it back in rotation.
      await found.store.updateAccount(request.orgId, id, { secret: checked.key, disabled: false, ...(input.label?.trim() ? { label: input.label.trim() } : {}) });
      const account = (await found.store.getAccount(request.orgId, id)) ?? found.account;
      request.audit('token_connected', { connector: accounts.connector, accountId: id });
      return connectionOk({ type: 'connected', connection: view(account, request), title: copy.connected, message: copy.connectedMessage(checked.go) });
    },

    async rename(request, id, name) {
      const found = await find(request, id);
      if (!found) return notFound(request.language);
      const label = name.trim() || found.account.label;
      await found.store.updateAccount(request.orgId, id, { label });
      return connectionOk({ name: label });
    },

    async removalImpact(request, id) {
      const found = await find(request, id);
      if (!found) return null;
      const uk = request.language === 'uk';
      return {
        title: uk ? `Видалити «${found.account.label}»?` : `Remove "${found.account.label}"?`,
        body: uk
          ? 'Запуски OpenCode більше не входитимуть із цим ключем. Без інших облікових записів вони працюватимуть лише на безкоштовних моделях. У самому OpenCode ключ не відкликається.'
          : 'OpenCode runs stop signing in with this key. Without other accounts they run on the free models alone. The key is not revoked at OpenCode.',
        dependents: [],
        items: [],
        confirmLabel: uk ? 'Видалити' : 'Remove',
        cancelLabel: uk ? 'Скасувати' : 'Cancel',
        requiresConfirm: false,
      };
    },

    async remove(request, id) {
      const found = await find(request, id);
      if (!found) return notFound(request.language);
      await found.store.removeAccount(request.orgId, id);
      request.audit('connection_removed', { connector: accounts.connector, accountId: id });
      return connectionOk({ message: localize(COPY, request.language).removed });
    },

    async detail(request, id) {
      const found = await find(request, id);
      if (!found) return null;
      const copy = localize(COPY, request.language);
      const { account } = found;
      const facts: ConnectionDetailSection = {
        type: 'facts',
        title: copy.facts.title,
        rows: [
          { label: copy.facts.key, value: account.hint ? `…${account.hint}` : '—' },
          { label: copy.facts.state, value: view(account, request).state.label },
          { label: copy.facts.lastUsed, value: account.lastUsedAt ? formatTime(account.lastUsedAt, request.language) : copy.facts.never },
          ...(account.limitedUntil && account.limitedUntil.getTime() > now().getTime()
            ? [{ label: copy.facts.limitedUntil, value: formatTime(account.limitedUntil, request.language) }]
            : []),
          ...(account.lastError ? [{ label: copy.facts.lastError, value: account.lastError }] : []),
          { label: copy.facts.added, value: formatTime(account.createdAt, request.language) },
        ],
      };
      const limits = await limitsSection(account, request);
      return [facts, ...(limits ? [limits] : [])];
    },
  };
}
