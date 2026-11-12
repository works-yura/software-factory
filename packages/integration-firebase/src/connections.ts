/**
 * Google Cloud's connections facet (ADR-0035): each binding of the asking Factory — this Factory
 * reads one Google Cloud project through one of the organization's service accounts — is a
 * Factory-scoped connection. It is connected with a new key (a file) or through an account the
 * organization already has; its settings (project, logs, crashes and their apps, the Firestore
 * «База») are a settings section whose project and database choices come from what the account can
 * see; «Відв'язати» drops the binding, «Видалити підключення» deletes the account with every binding
 * that reads through it, after saying which. Everything the person reads is written here.
 */

import { connectionOk, connectionRefused, localize } from '@factory/integrations';
import type {
  ConnectionCopy,
  ConnectionDetailSection,
  ConnectionOutcome,
  ConnectionRequest,
  ConnectionSettingsValues,
  ConnectMethod,
  ConnectorConnection,
  ConnectorConnectResult,
  IntegrationConnections,
  IntegrationHooks,
  RemovalImpact,
} from '@factory/integrations';
import type { FactoryProjectsStorage, IntegrationStorageHandle } from '@factory/store';

import { DEFAULT_FIRESTORE_DATABASE, listFirestoreDatabases, listGoogleCloudProjects } from './discovery.ts';
import { checkFirebaseAccess, firestoreReader } from './routes.ts';
import type { FirebaseCheck } from './routes.ts';
import { parseServiceAccountKey, ServiceAccountKeyError } from './service-account.ts';
import type { FetchLike, ServiceAccountKey } from './service-account.ts';
import {
  bindingReads,
  deleteAccount,
  deleteBinding,
  firebaseBindingInputSchema,
  newBindingId,
  readAccountKey,
  readFirebaseState,
  readsDatabase,
  renameAccount,
  saveAccount,
  saveBinding,
} from './settings.ts';
import type { FirebaseAccount, FirebaseBinding, FirebaseBindingInput, FirebaseState } from './settings.ts';
import { FirebaseObservabilitySource } from './source.ts';

interface Copy {
  name: string;
  summary: string;
  provides: { logs: string; crashes: string; database: string };
  key: { label: string; description: string; name: string; namePlaceholder: string; file: string; fileHelp: string; project: string; projectHelp: string; submit: string; replace: string };
  account: { label: string; description: string; field: string; none: string };
  adminOnly: string;
  factoryRequired: string;
  invalidKey: (message: string) => string;
  accountMissing: string;
  connectedTitle: (project: string) => string;
  connectedMessage: string;
  replacedTitle: (account: string) => string;
  state: { configured: string; readsNothing: string; readsNothingMessage: string };
  usedBy: (count: number) => string;
  manage: string;
  notFound: string;
  invalidName: string;
  unlinked: string;
  remove: { title: (account: string) => string; body: string; itemsLabel: string; binding: (project: string, factory: string) => string; deleted: string; confirm: string; cancel: string; inUse: string; done: (count: number) => string };
  detail: {
    facts: string;
    account: string;
    email: string;
    project: string;
    check: { ok: string; failed: (check: string, target: string) => string; kinds: Record<FirebaseCheck['check'], string> };
    settings: string;
    settingsHelp: string;
    fields: { project: string; logs: string; crashes: string; apps: string; appsHelp: string; database: string; databaseHelp: string; databaseId: string };
    save: string;
    saved: string;
    denied: (message: string) => string;
    accountSection: string;
    accountName: string;
    saveAccount: string;
    accountSaved: string;
    database: string;
    databaseHelp: string;
  };
  invalidApps: (line: string) => string;
  duplicateApp: string;
}

const COPY: ConnectionCopy<Copy> = {
  en: {
    name: 'Google Cloud',
    summary: 'Logs, crashes and the Firestore database — read-only, through a service account.',
    provides: { logs: 'Logs', crashes: 'Crashes', database: 'Database' },
    key: {
      label: 'New service account key',
      description: 'The key of a service account with read-only roles: Logs Viewer, Firebase Crashlytics Viewer, Cloud Datastore Viewer. It is sent once and never shown again.',
      name: 'Account name',
      namePlaceholder: 'For example, Syncta',
      file: 'Key (JSON)',
      fileHelp: 'Paste the key JSON or pick the file.',
      project: 'Google Cloud project',
      projectHelp: 'Empty reads the key’s own project.',
      submit: 'Connect',
      replace: 'Replace key',
    },
    account: {
      label: 'An account of the organization',
      description: 'Read another project through a service account the organization already added.',
      field: 'Account',
      none: 'The organization has no Google Cloud account yet: add a key.',
    },
    adminOnly: 'Only organization admins change connections.',
    factoryRequired: 'Open Connections of a Factory to bind a Google Cloud project to it.',
    invalidKey: message => `This is not a service account key: ${message}`,
    accountMissing: 'Choose one of the Google Cloud accounts.',
    connectedTitle: project => `This Factory reads ${project}`,
    connectedMessage: 'Logs are on. Turn on crashes or the database in the connection’s settings.',
    replacedTitle: account => `The key of ${account} is replaced`,
    state: { configured: 'Set up', readsNothing: 'Reads nothing', readsNothingMessage: 'Turn on logs, crashes or the database in its settings.' },
    usedBy: count => `The account is used by ${count} ${count === 1 ? 'binding' : 'bindings'}`,
    manage: 'Open IAM in Google Cloud',
    notFound: 'This Google Cloud connection no longer exists.',
    invalidName: 'A name is up to 80 characters.',
    unlinked: 'Unlinked. The organization’s account stays.',
    remove: {
      title: account => `Delete the account “${account}”?`,
      body: 'The service account key is erased for the whole organization, with every binding that reads through it.',
      itemsLabel: 'Bindings deleted with it:',
      binding: (project, factory) => `${project} — Factory «${factory}»`,
      deleted: 'Deleted: the Factory stops reading this project',
      confirm: 'Delete account',
      cancel: 'Cancel',
      inUse: 'Bindings read through this account; confirm to delete them with it.',
      done: count => (count ? `Account deleted with ${count} ${count === 1 ? 'binding' : 'bindings'}.` : 'Account deleted.'),
    },
    detail: {
      facts: 'Connection',
      account: 'Account',
      email: 'Service account',
      project: 'Project',
      check: {
        ok: 'Access checked: everything turned on can be read.',
        failed: (check, target) => `${check} · ${target}`,
        kinds: { logs: 'Logs', crashes: 'Crashes', database: 'Database' },
      },
      settings: 'What it reads',
      settingsHelp: 'Agents read only what is on here, read-only.',
      fields: {
        project: 'Google Cloud project',
        logs: 'Logs (Cloud Logging)',
        crashes: 'Crashes (Crashlytics)',
        apps: 'Firebase apps',
        appsHelp: 'One Firebase App ID per line, optionally followed by a name: 1:1234567890:android:0a1b2c3d Android',
        database: 'Database (Firestore through MCP Toolbox)',
        databaseHelp: 'Agents query the project’s Firestore with read-only tools.',
        databaseId: 'Firestore database',
      },
      save: 'Save',
      saved: 'Saved',
      denied: message => `The account cannot list them: ${message}`,
      accountSection: 'Account',
      accountName: 'Account name',
      saveAccount: 'Save account',
      accountSaved: 'Account saved',
      database: 'Database tools',
      databaseHelp: 'What agents may do with the database and whether personal data is masked.',
    },
    invalidApps: line => `Not a Firebase App ID: “${line}”. Use e.g. 1:1234567890:android:0a1b2c3d.`,
    duplicateApp: 'An app is listed twice.',
  },
  uk: {
    name: 'Google Cloud',
    summary: 'Логи, креші й база Firestore — лише читання, через сервісний акаунт.',
    provides: { logs: 'Логи', crashes: 'Креші', database: 'База' },
    key: {
      label: 'Новий сервісний ключ',
      description: 'Ключ сервісного акаунта з ролями лише на читання: Logs Viewer, Firebase Crashlytics Viewer, Cloud Datastore Viewer. Надсилається один раз і більше не показується.',
      name: 'Назва акаунта',
      namePlaceholder: 'Наприклад, Syncta',
      file: 'Ключ (JSON)',
      fileHelp: 'Вставте JSON ключа або виберіть файл.',
      project: 'Проєкт Google Cloud',
      projectHelp: 'Порожньо — проєкт самого ключа.',
      submit: 'Підключити',
      replace: 'Замінити ключ',
    },
    account: {
      label: 'Акаунт організації',
      description: 'Читати ще один проєкт через сервісний акаунт, який організація вже додала.',
      field: 'Акаунт',
      none: 'В організації ще немає акаунта Google Cloud: додайте ключ.',
    },
    adminOnly: 'Змінює адміністратор організації.',
    factoryRequired: 'Відкрийте «Підключення» Factory, щоб прив’язати до неї проєкт Google Cloud.',
    invalidKey: message => `Це не ключ сервісного акаунта: ${message}`,
    accountMissing: 'Виберіть один з акаунтів Google Cloud.',
    connectedTitle: project => `Ця Factory читає ${project}`,
    connectedMessage: 'Логи ввімкнено. Креші чи базу ввімкніть у налаштуваннях підключення.',
    replacedTitle: account => `Ключ акаунта ${account} замінено`,
    state: { configured: 'Налаштовано', readsNothing: 'Нічого не читає', readsNothingMessage: 'Увімкніть логи, креші чи базу в налаштуваннях.' },
    usedBy: count => `Акаунтом користуються прив’язок: ${count}`,
    manage: 'Відкрити IAM у Google Cloud',
    notFound: 'Цього підключення Google Cloud уже немає.',
    invalidName: 'Назва — до 80 символів.',
    unlinked: 'Відв’язано. Акаунт організації лишився.',
    remove: {
      title: account => `Видалити акаунт «${account}»?`,
      body: 'Ключ сервісного акаунта стирається для всієї організації разом з усіма прив’язками, що читають через нього.',
      itemsLabel: 'Разом з ним видаляються прив’язки:',
      binding: (project, factory) => `${project} — Factory «${factory}»`,
      deleted: 'Видаляється: Factory перестане читати цей проєкт',
      confirm: 'Видалити акаунт',
      cancel: 'Скасувати',
      inUse: 'Через цей акаунт читають прив’язки; підтвердьте, щоб видалити їх разом з ним.',
      done: count => (count ? `Акаунт видалено разом із прив’язками: ${count}.` : 'Акаунт видалено.'),
    },
    detail: {
      facts: 'Підключення',
      account: 'Акаунт',
      email: 'Сервісний акаунт',
      project: 'Проєкт',
      check: {
        ok: 'Доступ перевірено: усе ввімкнене читається.',
        failed: (check, target) => `${check} · ${target}`,
        kinds: { logs: 'Логи', crashes: 'Креші', database: 'База' },
      },
      settings: 'Що читає',
      settingsHelp: 'Агенти читають лише ввімкнене, і лише читають.',
      fields: {
        project: 'Проєкт Google Cloud',
        logs: 'Логи (Cloud Logging)',
        crashes: 'Креші (Crashlytics)',
        apps: 'Застосунки Firebase',
        appsHelp: 'Один Firebase App ID на рядок, за ним можна назву: 1:1234567890:android:0a1b2c3d Android',
        database: 'База (Firestore через MCP Toolbox)',
        databaseHelp: 'Агенти читають Firestore проєкту інструментами лише на читання.',
        databaseId: 'База Firestore',
      },
      save: 'Зберегти',
      saved: 'Збережено',
      denied: message => `Акаунт не може їх перелічити: ${message}`,
      accountSection: 'Акаунт',
      accountName: 'Назва акаунта',
      saveAccount: 'Зберегти акаунт',
      accountSaved: 'Акаунт збережено',
      database: 'Інструменти бази',
      databaseHelp: 'Що агенти можуть робити з базою і чи маскувати персональні дані.',
    },
    invalidApps: line => `Це не Firebase App ID: «${line}». Наприклад, 1:1234567890:android:0a1b2c3d.`,
    duplicateApp: 'Застосунок указано двічі.',
  },
};

const APP_ID = /^\d+:\d+:(android|ios|web):[0-9a-f]+$/;

/** `apps` as the textarea holds them: `<App ID> [name]` per line. */
function parseApps(text: string): FirebaseBinding['apps'] | { invalid: string } {
  const apps: FirebaseBinding['apps'] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const [appId = '', ...label] = line.split(/\s+/);
    const match = APP_ID.exec(appId);
    if (!match) return { invalid: line };
    apps.push({ appId, platform: match[1] as 'android' | 'ios' | 'web', ...(label.length ? { label: label.join(' ') } : {}) });
  }
  return apps;
}

const appsText = (apps: FirebaseBinding['apps']) => apps.map(app => (app.label ? `${app.appId} ${app.label}` : app.appId)).join('\n');

export interface GoogleCloudConnectionsDeps {
  storage: Pick<IntegrationStorageHandle, 'connections' | 'settings'>;
  projects: Pick<FactoryProjectsStorage, 'get'>;
  hooks?: IntegrationHooks;
  fetch?: FetchLike;
  now?: () => Date;
}

/** Google Cloud bindings of a Factory, and the organization's service accounts behind them. */
export class GoogleCloudConnections implements IntegrationConnections {
  readonly #deps: GoogleCloudConnectionsDeps;

  constructor(deps: GoogleCloudConnectionsDeps) {
    this.#deps = deps;
  }

  get #discovery() {
    return this.#deps.fetch ? { fetch: this.#deps.fetch } : {};
  }

  async #state(orgId: string): Promise<FirebaseState> {
    return readFirebaseState(this.#deps.storage, orgId);
  }

  async #sync(orgId: string) {
    await this.#deps.hooks?.onManagedMcpServersChanged?.(orgId);
  }

  #keyMethod(copy: Copy, request: ConnectionRequest, replace = false): ConnectMethod {
    return {
      id: replace ? 'replace-key' : 'key',
      label: copy.key.label,
      description: copy.key.description,
      authKind: 'apiKey',
      fields: [
        ...(replace ? [] : [{ name: 'name', displayName: copy.key.name, type: 'string' as const, placeholder: copy.key.namePlaceholder, required: false }]),
        { name: 'serviceAccountJson', displayName: copy.key.file, type: 'file', accept: 'application/json,.json', placeholder: '{"type": "service_account", …}', description: copy.key.fileHelp, required: true },
        ...(replace ? [] : [{ name: 'projectId', displayName: copy.key.project, type: 'string' as const, description: copy.key.projectHelp, required: false }]),
      ],
      submitLabel: replace ? copy.key.replace : copy.key.submit,
      available: !request.admin ? { reason: copy.adminOnly } : !request.factoryProjectId ? { reason: copy.factoryRequired } : true,
    };
  }

  async describe(request: ConnectionRequest) {
    const copy = localize(COPY, request.language);
    const accounts = (await this.#state(request.orgId)).accounts;
    const account: ConnectMethod = {
      id: 'account',
      label: copy.account.label,
      description: copy.account.description,
      authKind: 'apiKey',
      fields: [
        {
          name: 'accountId',
          displayName: copy.account.field,
          type: 'select',
          options: accounts.map(candidate => ({ value: candidate.id, label: `${candidate.name} · ${candidate.clientEmail}` })),
          required: true,
        },
        { name: 'projectId', displayName: copy.key.project, type: 'string', description: copy.key.projectHelp, required: false },
      ],
      submitLabel: copy.key.submit,
      available: !request.admin
        ? { reason: copy.adminOnly }
        : !request.factoryProjectId
          ? { reason: copy.factoryRequired }
          : accounts.length === 0
            ? { reason: copy.account.none }
            : true,
    };
    return {
      name: copy.name,
      icon: 'google-cloud',
      description: copy.summary,
      aliases: ['google-cloud'],
      category: 'tools' as const,
      provides: [
        { key: 'logs', label: copy.provides.logs },
        { key: 'crashes', label: copy.provides.crashes },
        { key: 'database', label: copy.provides.database },
      ],
      capabilities: { multipleConnectionsPerToolkit: true, batchConnectionStatus: false, reauthorizeReusesConnectionId: true, supportsRevoke: false },
      methods: [this.#keyMethod(copy, request), account],
    };
  }

  #view(request: ConnectionRequest, state: FirebaseState, binding: FirebaseBinding): ConnectorConnection {
    const copy = localize(COPY, request.language);
    const account = state.accounts.find(candidate => candidate.id === binding.accountId);
    const blocked = { reason: copy.adminOnly };
    const reads = bindingReads(binding) || readsDatabase(binding);
    const shared = state.bindings.filter(other => other.accountId === binding.accountId).length;
    return {
      id: binding.id,
      status: 'active',
      displayName: binding.name ?? null,
      accountLabel: account?.name ?? null,
      ...(account ? { accountDetail: account.clientEmail } : {}),
      label: binding.name ?? binding.projectId,
      method: account?.name ?? copy.name,
      provides: [
        ...(binding.logs ? [{ key: 'logs', label: copy.provides.logs }] : []),
        ...(binding.crashes && binding.apps.length > 0 ? [{ key: 'crashes', label: copy.provides.crashes }] : []),
        ...(readsDatabase(binding) ? [{ key: 'database', label: copy.provides.database }] : []),
      ],
      state: reads
        ? { tone: 'ok', label: copy.state.configured }
        : { tone: 'warning', label: copy.state.readsNothing, message: copy.state.readsNothingMessage },
      scope: 'factory',
      ...(binding.createdAt ? { createdAt: binding.createdAt } : {}),
      ...(binding.createdBy ? { createdBy: binding.createdBy } : {}),
      ...(shared > 1 ? { dependents: copy.usedBy(shared) } : {}),
      actions: {
        rename: request.admin ? true : blocked,
        reconnect: request.admin ? { method: this.#keyMethod(copy, request, true) } : blocked,
        unlink: request.admin ? true : blocked,
        remove: request.admin ? true : blocked,
        manageExternally: { url: `https://console.cloud.google.com/iam-admin/iam?project=${encodeURIComponent(binding.projectId)}`, label: copy.manage },
      },
    };
  }

  async list(request: ConnectionRequest): Promise<ConnectorConnection[]> {
    if (!request.factoryProjectId) return [];
    const state = await this.#state(request.orgId);
    return state.bindings
      .filter(binding => binding.factoryProjectId === request.factoryProjectId)
      .map(binding => this.#view(request, state, binding));
  }

  #parseKey(copy: Copy, json: string | undefined): ServiceAccountKey | ConnectionOutcome<never> {
    try {
      return parseServiceAccountKey(json ?? '');
    } catch (error) {
      if (error instanceof ServiceAccountKeyError) {
        const message = copy.invalidKey(error.message);
        return connectionRefused(422, { error: 'invalid_key', message, fields: { serviceAccountJson: message } });
      }
      throw error;
    }
  }

  async #bind(request: ConnectionRequest, account: FirebaseAccount, projectId: string): Promise<ConnectionOutcome<ConnectorConnectResult>> {
    const copy = localize(COPY, request.language);
    const parsed = firebaseBindingInputSchema.safeParse({
      factoryProjectId: request.factoryProjectId,
      accountId: account.id,
      projectId,
      logs: true,
      crashes: false,
      apps: [],
    });
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? copy.notFound;
      return connectionRefused(422, { error: 'invalid_binding', message, fields: { projectId: message } });
    }
    const binding = await saveBinding(this.#deps.storage, request.orgId, {
      id: newBindingId(),
      ...parsed.data,
      createdAt: new Date().toISOString(),
      ...(request.userId ? { createdBy: request.userId } : {}),
    });
    request.audit('factory.observability.mapping_updated', { bindingId: binding.id, accountId: account.id, projectId }, { factoryProjectId: binding.factoryProjectId });
    await this.#sync(request.orgId);
    return connectionOk({
      type: 'connected',
      connection: this.#view(request, await this.#state(request.orgId), binding),
      title: copy.connectedTitle(binding.projectId),
      message: copy.connectedMessage,
    });
  }

  async connect(request: ConnectionRequest, methodId: string, input: Record<string, string>): Promise<ConnectionOutcome<ConnectorConnectResult>> {
    const copy = localize(COPY, request.language);
    if (!request.factoryProjectId || !(await this.#deps.projects.get({ orgId: request.orgId, id: request.factoryProjectId }))) {
      return connectionRefused(400, { error: 'factory_required', message: copy.factoryRequired });
    }
    if (methodId === 'key') {
      const key = this.#parseKey(copy, input.serviceAccountJson);
      if ('ok' in key) return key;
      const name = (input.name ?? '').trim();
      if (name.length > 80) return connectionRefused(422, { error: 'invalid_body', message: copy.invalidName, fields: { name: copy.invalidName } });
      const account = await saveAccount(this.#deps.storage, request.orgId, request.userId || null, { name: name || key.project_id, key });
      request.audit('factory.observability.connected', { accountId: account.id, name: account.name, clientEmail: account.clientEmail, projectId: account.projectId, keyId: account.keyId });
      return this.#bind(request, account, (input.projectId ?? '').trim() || key.project_id);
    }
    if (methodId === 'account') {
      const account = (await this.#state(request.orgId)).accounts.find(candidate => candidate.id === input.accountId);
      if (!account) return connectionRefused(422, { error: 'account_not_found', message: copy.accountMissing, fields: { accountId: copy.accountMissing } });
      return this.#bind(request, account, (input.projectId ?? '').trim() || account.projectId);
    }
    return connectionRefused(404, { error: 'unknown_method', message: copy.notFound });
  }

  async #binding(request: ConnectionRequest, id: string) {
    const state = await this.#state(request.orgId);
    const binding = state.bindings.find(candidate => candidate.id === id);
    return binding ? { state, binding } : null;
  }

  /** Replaces the key of the account the binding reads through; every binding on it keeps working. */
  async reconnect(request: ConnectionRequest, id: string, input: Record<string, string>): Promise<ConnectionOutcome<ConnectorConnectResult>> {
    const copy = localize(COPY, request.language);
    const found = await this.#binding(request, id);
    const account = found?.state.accounts.find(candidate => candidate.id === found.binding.accountId);
    if (!found || !account) return connectionRefused(404, { error: 'not_found', message: copy.notFound });
    const key = this.#parseKey(copy, input.serviceAccountJson);
    if ('ok' in key) return key;
    const saved = await saveAccount(this.#deps.storage, request.orgId, request.userId || null, { accountId: account.id, name: account.name, key });
    request.audit('factory.observability.connected', { accountId: account.id, name: account.name, clientEmail: saved.clientEmail, projectId: saved.projectId, keyId: saved.keyId, replacedKey: true });
    await this.#sync(request.orgId);
    return connectionOk({
      type: 'connected',
      connection: this.#view(request, await this.#state(request.orgId), found.binding),
      title: copy.replacedTitle(account.name),
    });
  }

  async rename(request: ConnectionRequest, id: string, name: string): Promise<ConnectionOutcome<{ name: string }>> {
    const copy = localize(COPY, request.language);
    if (name.length > 80) return connectionRefused(422, { error: 'invalid_body', message: copy.invalidName, fields: { name: copy.invalidName } });
    const found = await this.#binding(request, id);
    if (!found) return connectionRefused(404, { error: 'not_found', message: copy.notFound });
    const { name: _previous, ...rest } = found.binding;
    await saveBinding(this.#deps.storage, request.orgId, { ...rest, ...(name ? { name } : {}) });
    return connectionOk({ name: name || found.binding.projectId });
  }

  async unlink(request: ConnectionRequest, id: string): Promise<ConnectionOutcome<{ message: string }>> {
    const copy = localize(COPY, request.language);
    const found = await this.#binding(request, id);
    if (!found || !(await deleteBinding(this.#deps.storage, request.orgId, id))) return connectionRefused(404, { error: 'not_found', message: copy.notFound });
    request.audit('factory.observability.mapping_updated', { bindingId: id, removed: true, projectId: found.binding.projectId }, { factoryProjectId: found.binding.factoryProjectId });
    await this.#sync(request.orgId);
    return connectionOk({ message: copy.unlinked });
  }

  async #impact(request: ConnectionRequest, state: FirebaseState, account: FirebaseAccount): Promise<RemovalImpact> {
    const copy = localize(COPY, request.language);
    const bindings = state.bindings.filter(binding => binding.accountId === account.id);
    const factoryName = async (id: string) => (await this.#deps.projects.get({ orgId: request.orgId, id }).catch(() => null))?.name ?? id;
    return {
      title: copy.remove.title(account.name),
      body: copy.remove.body,
      dependents: [],
      ...(bindings.length ? { itemsLabel: copy.remove.itemsLabel } : {}),
      items: await Promise.all(
        bindings.map(async binding => ({
          label: copy.remove.binding(binding.name ?? binding.projectId, await factoryName(binding.factoryProjectId)),
          outcome: 'deleted' as const,
          outcomeLabel: copy.remove.deleted,
        })),
      ),
      confirmLabel: copy.remove.confirm,
      cancelLabel: copy.remove.cancel,
      requiresConfirm: bindings.length > 0,
    };
  }

  async removalImpact(request: ConnectionRequest, id: string): Promise<RemovalImpact | null> {
    const found = await this.#binding(request, id);
    const account = found?.state.accounts.find(candidate => candidate.id === found.binding.accountId);
    return found && account ? this.#impact(request, found.state, account) : null;
  }

  /** Deletes the account the binding reads through, with every binding on it (confirmed: they were shown). */
  async remove(request: ConnectionRequest, id: string, options: { confirm: boolean }): Promise<ConnectionOutcome<{ message: string }>> {
    const copy = localize(COPY, request.language);
    const found = await this.#binding(request, id);
    const account = found?.state.accounts.find(candidate => candidate.id === found.binding.accountId);
    if (!found || !account) return connectionRefused(404, { error: 'not_found', message: copy.notFound });
    if (!options.confirm) {
      return connectionRefused(409, { error: 'account_in_use', message: copy.remove.inUse, impact: await this.#impact(request, found.state, account) });
    }
    const removed = await deleteAccount(this.#deps.storage, request.orgId, account.id);
    if (!removed) return connectionRefused(404, { error: 'not_found', message: copy.notFound });
    request.audit('factory.observability.disconnected', { accountId: account.id, removedBindings: removed.removedBindings });
    await this.#sync(request.orgId);
    return connectionOk({ message: copy.remove.done(removed.removedBindings.length) });
  }

  async #checks(request: ConnectionRequest, binding: FirebaseBinding): Promise<ConnectionDetailSection[]> {
    const copy = localize(COPY, request.language);
    const key = await readAccountKey(this.#deps.storage, request.orgId, binding.accountId);
    if (!key || !(bindingReads(binding) || readsDatabase(binding))) return [];
    const now = this.#deps.now ?? (() => new Date());
    const source = new FirebaseObservabilitySource({ key, binding, ...this.#discovery, now });
    const checks = await checkFirebaseAccess(source, binding, now(), firestoreReader(key, this.#deps.fetch)).catch(() => []);
    if (checks.length === 0) return [];
    const failed = checks.filter(check => !check.ok);
    if (failed.length === 0) return [{ type: 'notice', tone: 'info', title: copy.detail.check.ok }];
    return failed.map(check => ({
      type: 'notice' as const,
      tone: 'error' as const,
      title: copy.detail.check.failed(copy.detail.check.kinds[check.check], check.target),
      message: [check.message, check.missingRole, check.fix].filter(Boolean).join(' '),
    }));
  }

  async detail(request: ConnectionRequest, id: string): Promise<ConnectionDetailSection[] | null> {
    const copy = localize(COPY, request.language);
    const found = await this.#binding(request, id);
    if (!found) return null;
    const { binding, state } = found;
    const account = state.accounts.find(candidate => candidate.id === binding.accountId);
    const key = await readAccountKey(this.#deps.storage, request.orgId, binding.accountId);
    const blocked = request.admin ? undefined : { reason: copy.adminOnly };
    const projects = key ? await listGoogleCloudProjects(key, this.#discovery).catch(() => undefined) : undefined;
    const databases = key && readsDatabase(binding) ? await listFirestoreDatabases(key, binding.projectId, this.#discovery).catch(() => undefined) : undefined;
    const option = (value: string, label?: string) => ({ value, label: label ?? value });
    const projectOptions = [...new Map([[binding.projectId, option(binding.projectId)], ...(projects?.items ?? []).map(item => [item.value, option(item.value, item.label)] as const)]).values()];
    const databaseId = binding.database?.databaseId || DEFAULT_FIRESTORE_DATABASE;
    const databaseOptions = [...new Map([[databaseId, option(databaseId)], ...(databases?.items ?? []).map(item => [item.value, option(item.value, item.label)] as const)]).values()];
    const sections: ConnectionDetailSection[] = [
      {
        type: 'facts',
        title: copy.detail.facts,
        rows: [
          ...(account ? [{ label: copy.detail.account, value: account.name }, { label: copy.detail.email, value: account.clientEmail }] : []),
          { label: copy.detail.project, value: binding.projectId, href: `https://console.cloud.google.com/home/dashboard?project=${encodeURIComponent(binding.projectId)}` },
        ],
      },
      ...(await this.#checks(request, binding)),
      {
        type: 'settings',
        id: 'binding',
        title: copy.detail.settings,
        description: projects?.denied ? `${copy.detail.settingsHelp} ${copy.detail.denied(projects.denied.message)}` : copy.detail.settingsHelp,
        saveLabel: copy.detail.save,
        fields: [
          { name: 'projectId', displayName: copy.detail.fields.project, type: 'select', options: projectOptions, required: true, value: binding.projectId, ...(blocked ? { disabled: blocked } : {}) },
          { name: 'logs', displayName: copy.detail.fields.logs, type: 'boolean', required: false, value: binding.logs, ...(blocked ? { disabled: blocked } : {}) },
          { name: 'crashes', displayName: copy.detail.fields.crashes, type: 'boolean', required: false, value: binding.crashes, ...(blocked ? { disabled: blocked } : {}) },
          { name: 'apps', displayName: copy.detail.fields.apps, type: 'textarea', description: copy.detail.fields.appsHelp, required: false, value: appsText(binding.apps), ...(blocked ? { disabled: blocked } : {}) },
          { name: 'database', displayName: copy.detail.fields.database, description: copy.detail.fields.databaseHelp, type: 'boolean', required: false, value: readsDatabase(binding), ...(blocked ? { disabled: blocked } : {}) },
          { name: 'databaseId', displayName: copy.detail.fields.databaseId, type: 'select', options: databaseOptions, required: false, value: databaseId, ...(blocked ? { disabled: blocked } : {}) },
        ],
      },
      ...(readsDatabase(binding)
        ? [{ type: 'custom' as const, component: 'mcp-server' as const, title: copy.detail.database, description: copy.detail.databaseHelp, params: { owner: 'firebase', key: binding.id } }]
        : []),
      ...(account
        ? [
            {
              type: 'settings' as const,
              id: 'account',
              title: copy.detail.accountSection,
              saveLabel: copy.detail.saveAccount,
              fields: [{ name: 'name', displayName: copy.detail.accountName, type: 'string' as const, required: true, value: account.name, ...(blocked ? { disabled: blocked } : {}) }],
            },
          ]
        : []),
    ];
    return sections;
  }

  async updateSettings(request: ConnectionRequest, id: string, section: string, values: ConnectionSettingsValues): Promise<ConnectionOutcome<{ message: string }>> {
    const copy = localize(COPY, request.language);
    if (!request.admin) return connectionRefused(403, { error: 'forbidden', message: copy.adminOnly });
    const found = await this.#binding(request, id);
    if (!found) return connectionRefused(404, { error: 'not_found', message: copy.notFound });
    const { binding } = found;
    if (section === 'account') {
      const name = typeof values.name === 'string' ? values.name.trim() : '';
      if (!name || name.length > 80) return connectionRefused(422, { error: 'invalid_body', message: copy.invalidName, fields: { name: copy.invalidName } });
      await renameAccount(this.#deps.storage, request.orgId, binding.accountId, name);
      return connectionOk({ message: copy.detail.accountSaved });
    }
    if (section !== 'binding') return connectionRefused(400, { error: 'invalid_body', message: copy.notFound });
    const apps = typeof values.apps === 'string' ? parseApps(values.apps) : binding.apps;
    if ('invalid' in apps) return connectionRefused(422, { error: 'invalid_binding', message: copy.invalidApps(apps.invalid), fields: { apps: copy.invalidApps(apps.invalid) } });
    const bool = (name: string, current: boolean) => (typeof values[name] === 'boolean' ? (values[name] as boolean) : current);
    const databaseId = typeof values.databaseId === 'string' && values.databaseId ? values.databaseId : binding.database?.databaseId;
    const input: FirebaseBindingInput = {
      ...(binding.name ? { name: binding.name } : {}),
      factoryProjectId: binding.factoryProjectId,
      accountId: binding.accountId,
      projectId: typeof values.projectId === 'string' && values.projectId ? values.projectId : binding.projectId,
      ...(binding.projectNumber ? { projectNumber: binding.projectNumber } : {}),
      logs: bool('logs', binding.logs),
      crashes: bool('crashes', binding.crashes),
      apps,
      database: { enabled: bool('database', readsDatabase(binding)), ...(databaseId && databaseId !== DEFAULT_FIRESTORE_DATABASE ? { databaseId } : {}) },
    };
    const appIds = apps.map(app => app.appId);
    if (new Set(appIds).size !== appIds.length) {
      const message = copy.duplicateApp;
      return connectionRefused(422, { error: 'invalid_binding', message, fields: { apps: message } });
    }
    const parsed = firebaseBindingInputSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = String(issue?.path[0] ?? 'projectId');
      const message = issue?.message ?? copy.notFound;
      return connectionRefused(422, { error: 'invalid_binding', message, fields: { [field]: message } });
    }
    const saved = await saveBinding(this.#deps.storage, request.orgId, {
      id: binding.id,
      ...parsed.data,
      ...(binding.createdAt ? { createdAt: binding.createdAt } : {}),
      ...(binding.createdBy ? { createdBy: binding.createdBy } : {}),
    });
    request.audit(
      'factory.observability.mapping_updated',
      { bindingId: saved.id, accountId: saved.accountId, projectId: saved.projectId, logs: saved.logs, crashes: saved.crashes, apps: saved.apps.map(app => app.appId), database: readsDatabase(saved) },
      { factoryProjectId: saved.factoryProjectId },
    );
    await this.#sync(request.orgId);
    return connectionOk({ message: copy.detail.saved });
  }
}
