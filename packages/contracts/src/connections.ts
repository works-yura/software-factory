/**
 * Settings › Підключення on the wire (ADR-0035). The server describes every connector — how it
 * connects, what each connection is, what may be done with it and what removing it does — in the
 * request's language; the UI only renders these descriptors. Nothing here names a provider: a new
 * connector is a new server-side implementation, never a UI change.
 *
 * Every user-facing string in these shapes is final copy, already in the language the request asked
 * for (`Accept-Language`, `uk` or `en`). Keys (`id`, `icon`, `provides[].key`, `outcome`) are stable
 * identifiers the UI may map to icons, never to text.
 *
 * Follows Mastra Factory's platform-connect model (`PLATFORM_CONNECT_PROVIDERS`: a server registry
 * of providers, each method's `authKind: 'oauth' | 'apiKey'`, generic connect/reconnect routes, and
 * connection rows with `status: 'active' | 'needs_reauth'`, `accountLabel`, `displayName`), extended
 * for direct (non-Platform) connectors. Where that model has no shape, it takes Mastra's tool-provider
 * connections (`@mastra/core/tool-provider`): form inputs are its
 * `ConnectionField`, a redirect method is its `authorize → { url, authId }` with `AuthFlowStatus`,
 * a connector carries its `ToolProviderCapabilities` and `ToolProviderHealth`, and a connection is
 * named by its `label`. Factory extends them with what an organization's admin page needs: secret,
 * textarea and file fields, server-decided actions with reasons, removal impact (moves, unlinks),
 * Factory-scoped links, detail sections and copy in the request's language (ADR-0035).
 */

import type {
  AuthFlowStatus,
  ConnectionField,
  ToolProviderCapabilities,
  ToolProviderHealth,
} from '@mastra/core/tool-provider';
import { z } from 'zod';

export type { AuthFlowStatus, ConnectionField, ToolProviderCapabilities, ToolProviderHealth };

/** Languages the server writes connection copy in; anything else falls back to English. */
export const CONNECTION_LANGUAGES = ['en', 'uk'] as const;
export type ConnectionLanguage = (typeof CONNECTION_LANGUAGES)[number];

/** Why an action or a method is not available here, said to the person under the disabled item. */
export interface ConnectionBlocked {
  reason: string;
}

/**
 * One input of a connect method: Mastra's `ConnectionField` (`name`, `displayName`, `description`,
 * `required`, `default`), with Factory's input types beside its `string | number | boolean`:
 * `secret` (never shown back), `textarea`, and `file` (a picked file read into the value).
 */
export interface ConnectFormField extends Omit<ConnectionField, 'type'> {
  type: ConnectionField['type'] | 'secret' | 'textarea' | 'file' | 'select';
  /** `select`: the choices, by value. */
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  /** `file`: the picker's accept list (`application/json,.json`). */
  accept?: string;
}

/**
 * One way to connect, by Mastra Factory's `authKind`: `oauth` (an App install or OAuth: starting it
 * returns `{ url, authId }`, as Mastra's `ToolProvider.authorize`; its `fields`, if any, are asked
 * first, as `listConnectionFields`) or `apiKey` (a key or token the server checks, in `fields`).
 * `available` says why not when it cannot be used here.
 */
export interface ConnectMethod {
  id: string;
  label: string;
  description?: string;
  authKind: 'oauth' | 'apiKey';
  fields?: ConnectFormField[];
  /** The form's submit button. */
  submitLabel?: string;
  available: true | ConnectionBlocked;
  /**
   * The method is the one custom editor (ADR-0035's exception): choosing it opens that editor's page
   * (`?connection=new:<connector>:<method>`) with these params instead of a form.
   */
  editor?: { component: 'mcp-server'; params: Record<string, string> };
}

/**
 * What a connector or connection gives agents (Factory's; Mastra's `capabilities` are the provider's
 * feature flags, kept as such on {@link ConnectorView}): `key` picks the icon, `label` is the tooltip.
 */
export interface ConnectionProvidesView {
  key: string;
  label: string;
}

/** A connector's name and logo, as rows and the catalog show it. `icon` is a logo key. */
export interface ConnectorRef {
  id: string;
  name: string;
  icon: string;
}

/** A connector as «Додати підключення» lists it: Mastra's `ToolProviderInfo` with its methods. */
export interface ConnectorView extends ConnectorRef {
  /** One line under the connect step's title (`ToolProviderInfo.description`). */
  description?: string;
  /** Other names older links use for it (`?connection=<alias>` opens it like its id). */
  aliases?: string[];
  /**
   * The catalog's filter: tools agents call, sources that bring work and code, or agents — the
   * accounts a harness's sessions run on (Claude Code's, Codex's sign-ins).
   */
  category: 'tools' | 'sources' | 'agents';
  /** Runs as a third-party MCP server (the row and catalog show the badge). */
  mcp?: boolean;
  /** What its connections give agents. */
  provides: ConnectionProvidesView[];
  /** Mastra's provider feature flags. Deleting a connection in Factory is `actions.remove`, not `supportsRevoke`. */
  capabilities: ToolProviderCapabilities;
  /** Provider-level health (configuration, reachability), as `ToolProvider.getHealth`. */
  health?: ToolProviderHealth;
  methods: ConnectMethod[];
}

export interface ConnectionStateView {
  /** `ok` working; `warning` needs attention; `error` broken; `idle` not checked or off. */
  tone: 'ok' | 'warning' | 'error' | 'idle';
  /** One word or two for the badge and the row's mark: «Підключено», «Потребує уваги». */
  label: string;
  /** What is wrong, when something is. */
  message?: string;
}

/**
 * What can be done with a connection, decided by the server (permissions, where the credential
 * lives). An absent action does not apply to this connection; a `{ reason }` is shown disabled.
 */
export interface ConnectionActionsView {
  rename?: true | ConnectionBlocked;
  /** Reconnect through this method: `oauth` without fields starts at once; fields are filled first. */
  reconnect?: { method: ConnectMethod } | ConnectionBlocked;
  remove?: true | ConnectionBlocked;
  /** Drop this Factory's link and keep the organization's account. */
  unlink?: true | ConnectionBlocked;
  /** Manage it where it lives (GitHub's installation page, a platform's console). */
  manageExternally?: { url: string; label: string } | ConnectionBlocked;
}

export interface ConnectionView {
  /** Globally unique: `<connector id>:<the connector's own id>`. Also the `?connection=` value. */
  id: string;
  connector: ConnectorRef;
  /** Platform-connect's machine status; `state` says it in words. */
  status: 'active' | 'needs_reauth';
  /** The name the organization gave it, or null (platform-connect's `displayName`). */
  displayName: string | null;
  /** The provider account it connects (platform-connect's `accountLabel`), and a line about it. */
  accountLabel: string | null;
  accountDetail?: string;
  /** What the page calls it: `displayName`, else the account (tool-provider's `label`). */
  label: string;
  /** How it authenticates, when a connector has several ways: «GitHub App», «Токен». */
  method?: string;
  provides: ConnectionProvidesView[];
  state: ConnectionStateView;
  /** `organization`: every Factory sees it; `factory`: a link of this Factory only. */
  scope: 'organization' | 'factory';
  mcp?: boolean;
  createdAt?: string;
  /** User id of whoever made it. */
  createdBy?: string;
  /** Who depends on it, in a line («Використовують: post-airborne»). */
  dependents?: string;
  actions: ConnectionActionsView;
}

/** What removing a connection does, said before it is done. */
export interface RemovalImpact {
  title: string;
  body: string;
  /** What depends on it (Factories, routes). */
  dependents: Array<{ label: string }>;
  /** Heading over `items`. */
  itemsLabel?: string;
  items: Array<{
    label: string;
    outcome: 'moves' | 'unlinks' | 'deleted' | 'stops';
    /** What happens to it, in words («Перейде до @client-bot · токен»). */
    outcomeLabel: string;
  }>;
  confirmLabel: string;
  cancelLabel: string;
  warning?: string;
  /** Deleting needs `?confirm=1`: something depends on it. */
  requiresConfirm: boolean;
}

/**
 * A setting of a connection, shown on its page: a {@link ConnectFormField} with its current value.
 * `disabled` says why it cannot be changed here.
 */
export interface ConnectionSettingField extends ConnectFormField {
  value: string | boolean | null;
  disabled?: ConnectionBlocked;
}

/** One block of a connection's detail page, as the server lays it out. */
export type ConnectionDetailSection =
  | {
      /** Settings saved through `PATCH /web/connections/:id/settings` with this section's id. */
      type: 'settings';
      id: string;
      title?: string;
      description?: string;
      fields: ConnectionSettingField[];
      /** The save button; absent saves each change at once (a switch). */
      saveLabel?: string;
    }
  | {
      type: 'facts';
      title?: string;
      description?: string;
      rows: Array<{ label: string; value: string; detail?: string; href?: string }>;
    }
  | {
      type: 'table';
      title?: string;
      description?: string;
      columns: string[];
      rows: Array<{ cells: string[]; href?: string }>;
      empty?: string;
    }
  | {
      /**
       * The one exception to "descriptors only" (ADR-0035): an editor too rich to describe — the MCP
       * server editor (transport, access by Factory and session kind, per-tool policy). `component`
       * names it (`mcp-server`), `params` say which (`serverId`, or `owner` + `key` for a managed one).
       */
      type: 'custom';
      component: 'mcp-server';
      title?: string;
      description?: string;
      params: Record<string, string>;
    }
  | {
      type: 'notice';
      tone: 'info' | 'warning' | 'error';
      title: string;
      message?: string;
      link?: { label: string; href: string };
    };

export interface ConnectionDetailView {
  sections: ConnectionDetailSection[];
}

export interface ConnectionsListResponse {
  connections: ConnectionView[];
  /** Connectors whose connections could not be read; the others still show. */
  failures: Array<{ connector: ConnectorRef; message: string }>;
  /** UI copy the list needs from the server: the scope note for organization-wide rows. */
  copy: { organizationWide: string };
}

export interface ConnectorsResponse {
  connectors: ConnectorView[];
}

/**
 * A provider session the browser completes itself instead of opening a URL — Mastra Factory's
 * platform-connect: a Nango connect session minted with the deploy's Platform credentials, run
 * headlessly (`@nangohq/frontend`); then `authId`'s `AuthFlowStatus` says when the account is active.
 */
export interface ConnectSession {
  provider: 'nango';
  token: string;
  integrationId: string;
  expiresAt?: string;
}

/**
 * An `authorize` that finishes somewhere the browser cannot follow (a harness CLI's own sign-in, its
 * page opened on the server's machine): no `url` or `session`, only what to tell the person while
 * the UI asks about `authId` until the flow ends or `timeoutMs` passes.
 */
export interface ConnectWaiting {
  title: string;
  message?: string;
  timeoutMs: number;
}

/**
 * A connect or reconnect: `authorize` — the URL to open (or a `session` to run) and, when the connector can be asked about
 * it, the `authId` whose `AuthFlowStatus` `/web/connections/authorizations/:authId` reports — or the
 * connection it made, with what to tell the person.
 */
export type ConnectResult =
  | { type: 'authorize'; url?: string; authId?: string; session?: ConnectSession; waiting?: ConnectWaiting }
  | { type: 'connected'; connection: ConnectionView; title: string; message?: string };

export interface AuthorizationStatusResponse {
  status: AuthFlowStatus;
  /** Why a `failed` flow failed, in the request's language, when the connector knows. */
  message?: string;
}

/** A refusal: the code, what to tell the person, and per-field messages for a form. */
export interface ConnectionErrorBody {
  error: string;
  message: string;
  fields?: Record<string, string>;
  /** A removal refused for want of confirmation carries what it would do. */
  impact?: RemovalImpact;
}

export interface ConnectionRemoved {
  removed: true;
  /** What to tell the person («Підключення видалено. Перенесено: 1, відв'язано: 1.»). */
  message: string;
}

export const connectRequestSchema = z.object({
  connector: z.string().min(1).max(64),
  method: z.string().min(1).max(64),
  input: z.record(z.string(), z.string().max(65_536)).default({}),
});
export type ConnectRequest = z.infer<typeof connectRequestSchema>;

export const reconnectRequestSchema = z.object({
  input: z.record(z.string(), z.string().max(65_536)).default({}),
});

export const renameConnectionSchema = z.object({ name: z.string().max(80) });

export const updateConnectionSettingsSchema = z.object({
  section: z.string().min(1).max(64),
  values: z.record(z.string(), z.union([z.string().max(65_536), z.boolean(), z.null()])),
});
export type ConnectionSettingsValues = z.infer<typeof updateConnectionSettingsSchema>['values'];
