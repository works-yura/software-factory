import { http, HttpResponse } from 'msw';
import type { RequestHandler } from 'msw';

import { DEFAULT_CONNECTION_PERMISSIONS } from '@factory/contracts/connections';
import type { ConnectionView, ConnectorView } from '@factory/contracts';

import { customProvidersResponse } from '../../../src/hooks/__tests__/fixtures/custom-providers';
import { omResponse } from '../../../src/hooks/__tests__/fixtures/om';
import { environmentPayload } from '../../../src/ui/domains/settings/components/__tests__/fixtures/environment';
import { listedRepository } from '../../ui/factory-projects';

/**
 * Settings data with the long strings real organizations have: names, emails, join-link names,
 * domains, IPv6 addresses and user agents that do not fit a phone row.
 */
const IN_A_WEEK = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const NOW = new Date().toISOString();

export const ADMIN_PERMISSIONS = [
  'board.read',
  'self.write',
  'card.write',
  'comment.write',
  'run.start',
  'session.write',
  'factory.configure',
  'factory.manage',
  'connections.manage',
  'org.manage',
  'members.manage',
  'join-links.manage',
  'content.moderate',
];

export const LONG_EMAIL = 'oleksandra.konstantynivna.shevchenko-zaporozhets@very-long-company-domain.example.com';
export const LONG_ORG = 'Acme Incorporated International Holdings Limited';

const organization = {
  id: 'org-acme',
  name: LONG_ORG,
  slug: 'acme',
  logo: null,
  members: [
    { id: 'm-ada', userId: 'ada', role: 'owner', user: { id: 'ada', name: 'Ада Лавлейс-Байрон', email: 'ada@example.com' } },
    {
      id: 'm-ole',
      userId: 'ole',
      role: 'member',
      user: { id: 'ole', name: 'Олександра Костянтинівна Шевченко-Запорожець', email: LONG_EMAIL },
    },
    { id: 'm-vera', userId: 'vera', role: 'viewer', user: { id: 'vera', name: 'Vera', email: 'vera@example.com' } },
  ],
  invitations: [
    { id: 'inv-eve', email: LONG_EMAIL, role: 'admin', status: 'pending', expiresAt: IN_A_WEEK, organizationId: 'org-acme' },
  ],
};

const joinLinks = [
  {
    id: 'jl-1',
    organizationId: 'org-acme',
    name: 'Engineering onboarding for the whole platform team',
    token: 'tok-1',
    role: 'member',
    allowedDomains: ['acme.com', 'research.acme.com', 'very-long-subsidiary-domain.example.org'],
    expiresAt: IN_A_WEEK,
    maxUses: 25,
    uses: 3,
    createdBy: 'ada',
    createdAt: NOW,
    revokedAt: null,
    status: 'active',
  },
  {
    id: 'jl-2',
    organizationId: 'org-acme',
    name: 'Old contractors',
    token: 'tok-2',
    role: 'viewer',
    allowedDomains: [],
    expiresAt: null,
    maxUses: null,
    uses: 12,
    createdBy: 'ada',
    createdAt: NOW,
    revokedAt: NOW,
    status: 'revoked',
  },
];

const sessions = [
  {
    id: 's-1',
    token: 't-1',
    userId: 'ada',
    ipAddress: '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    updatedAt: NOW,
    expiresAt: IN_A_WEEK,
  },
  {
    id: 's-2',
    token: 't-2',
    userId: 'ada',
    ipAddress: '100.101.102.103',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
    createdAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    updatedAt: NOW,
    expiresAt: IN_A_WEEK,
  },
];


const githubConnector: ConnectorView = {
  id: 'github',
  name: 'GitHub',
  icon: 'github',
  description: 'Repositories, issues and pull requests.',
  category: 'code',
  provides: [
    { key: 'code', label: 'Code' },
    { key: 'tasks', label: 'Issues' },
  ],
  capabilities: { multipleConnectionsPerToolkit: true, batchConnectionStatus: false, reauthorizeReusesConnectionId: true },
  permissions: DEFAULT_CONNECTION_PERMISSIONS,
  methods: [{ id: 'app', label: 'GitHub App', authKind: 'oauth', available: true }],
};

const githubConnection: ConnectionView = {
  id: 'github:app',
  connector: { id: 'github', name: 'GitHub', icon: 'github' },
  label: 'eclipt-ai-organization-with-a-long-installation-name',
  status: 'active',
  displayName: 'eclipt-ai-organization-with-a-long-installation-name',
  accountLabel: 'eclipt-ai-organization-with-a-long-installation-name',
  accountDetail: 'Organization · 42 repositories',
  method: 'GitHub App',
  provides: githubConnector.provides,
  state: { tone: 'ok', label: 'Live' },
  scope: 'organization',
  createdAt: '2026-11-01T10:00:00.000Z',
  dependents: 'Used by 3 Factories',
  actions: { rename: true, remove: true },
};

const sentryConnection: ConnectionView = {
  id: 'mcp:srv-sentry',
  connector: { id: 'mcp', name: 'MCP servers', icon: 'mcp' },
  status: 'active',
  displayName: 'Sentry production error tracking for every service',
  accountLabel: null,
  label: 'Sentry production error tracking for every service',
  mcp: true,
  provides: [],
  state: { tone: 'error', label: 'Error', message: 'The account was refused access; give it the role the server needs. (401)' },
  scope: 'factory',
  actions: { rename: true, unlink: true, remove: true },
};

const aggregate = (totalTokens: number, costUsd: number, turns = 1) => ({
  turns,
  totals: { inputTokens: totalTokens * 0.1, cacheReadTokens: totalTokens * 0.8, cacheWriteTokens: 0, outputTokens: totalTokens * 0.1, reasoningTokens: 0 },
  totalTokens,
  costUsd,
  reportedCostUsd: 0,
  unpricedTurns: 0,
});

const usageSummary = {
  from: '2026-11-10',
  to: '2026-11-11',
  total: aggregate(3_000_000, 12.5, 14),
  byDay: [
    { day: '2026-11-10', ...aggregate(1_000_000, 4, 6) },
    { day: '2026-11-11', ...aggregate(2_000_000, 8.5, 8) },
  ],
  byHarness: [{ key: 'claude-code', ...aggregate(2_000_000, 10) }],
  byModel: [{ key: 'claude-opus-5-5', ...aggregate(2_000_000, 10) }],
  byAccount: [{ key: 'acc-1', ...aggregate(3_000_000, 12.5) }],
  byFactory: [{ key: 'fp-1', ...aggregate(3_000_000, 12.5) }],
  byRole: [{ key: 'implementer', ...aggregate(2_500_000, 11) }],
  bySession: [{ key: 'session-1', ...aggregate(2_000_000, 9) }],
  labels: {
    accounts: { 'acc-1': LONG_EMAIL },
    factories: { 'fp-1': 'bookfate' },
    sessions: { 'session-1': 'Fix the login flow on the very long onboarding screen for new organizations' },
  },
};

const metrics = {
  daysCovered: 3,
  throughput: [
    { date: '2026-11-09', count: 1 },
    { date: '2026-11-10', count: 0 },
    { date: '2026-11-11', count: 2 },
  ],
  leadTime: { medianMs: 3 * 3_600_000, p90Ms: 26 * 3_600_000, samples: 3 },
  wipTotal: 4,
  sourceMix: [
    { source: 'github:issue', count: 3 },
    { source: 'manual', count: 1 },
  ],
  agentCoverage: [{ stage: 'triage', passes: 4, byAgent: 3, outcomes: { done: 2, canceled: 0, reworked: 1, inFlight: 0 } }],
};

function intakeRoute(id: string, name: string, position: number, when: unknown, phaseKey: string) {
  return {
    id,
    name,
    enabled: true,
    position,
    when,
    target: { boardKey: 'work', phaseKey, joinClosedIssue: false },
    on: ['work_item.created'],
    revision: 1,
    createdBy: 'ada',
    createdAt: NOW,
    updatedBy: 'ada',
    updatedAt: NOW,
    problems: [],
    triggered: null,
    origin: null,
  };
}

const intakeRoutes = [
  intakeRoute(
    '00000000-0000-4000-8000-000000000001',
    'Outside authors on the mobile application repository wait in Intake for a human',
    0,
    {
      operator: 'AND',
      conditions: [
        { field: 'source.integration', operator: 'equals', value: 'github' },
        { field: 'source.repository', operator: 'equals', value: 'eclipt-ai/bookfate-mobile-application-with-a-very-long-repository-name' },
        { field: 'author.trusted', operator: 'equals', value: false },
      ],
    },
    'intake',
  ),
  intakeRoute('00000000-0000-4000-8000-000000000002', 'ClickUp to Triage', 1, {
    operator: 'AND',
    conditions: [{ field: 'source.integration', operator: 'equals', value: 'clickup' }],
  }, 'triage'),
];

/** The handlers a settings page reads, ahead of the UI suite's ambient ones. */
export function settingsHandlers(): RequestHandler[] {
  return [
    http.get('*/auth/me', () =>
      HttpResponse.json({
        authenticated: true,
        authEnabled: true,
        provider: 'better-auth',
        user: {
          userId: 'ada',
          email: 'ada@example.com',
          name: 'Ада Лавлейс-Байрон',
          organizationId: 'org-acme',
          organizationRole: 'owner',
          permissions: ADMIN_PERMISSIONS,
        },
      }),
    ),
    http.get('*/web/factory/projects', () =>
      HttpResponse.json({
        projects: [
          {
            id: 'fp-1',
            name: 'bookfate',
            harness: 'mastra',
            createdAt: NOW,
            updatedAt: NOW,
            repositories: [
              listedRepository('pr-1', 'eclipt-ai/bookfate-mobile-application-with-a-very-long-repository-name'),
              listedRepository('pr-2', 'eclipt-ai/api'),
            ],
          },
        ],
      }),
    ),
    http.get('*/web/factory/projects/fp-1', () =>
      HttpResponse.json({ project: { id: 'fp-1', name: 'bookfate', harness: 'mastra', createdAt: NOW, updatedAt: NOW } }),
    ),
    http.get('*/web/factory/projects/fp-1/sessions', () => HttpResponse.json({ sessions: [] })),
    // No chat session for the Factory yet; its tool permissions are the defaults.
    http.get('*/api/agent-controller/code/sessions/fp-1', () => HttpResponse.json({ error: 'not_found' }, { status: 404 })),
    http.get('*/api/agent-controller/code/sessions/fp-1/permissions', () => HttpResponse.json({ categories: {}, tools: {} })),
    http.get('*/web/factory/projects/fp-1/health/thresholds', () => HttpResponse.json({ thresholds: [14400, 86400, 259200] })),
    http.get('*/auth/api/organization/get-full-organization', () => HttpResponse.json(organization)),
    http.get('*/auth/api/organization/list', () =>
      HttpResponse.json([
        { id: 'org-acme', name: LONG_ORG, slug: 'acme' },
        { id: 'org-two', name: 'syncta', slug: 'syncta' },
      ]),
    ),
    http.get('*/web/org/join-links', () => HttpResponse.json({ joinLinks })),
    http.get('*/web/factory/projects/fp-1/intake-routes', () => HttpResponse.json({ intakeRoutes, canEdit: true })),
    http.get('*/web/connections', () =>
      HttpResponse.json({ connections: [githubConnection, sentryConnection], failures: [], copy: { organizationWide: 'Whole organization' } }),
    ),
    http.get('*/web/connections/methods', () => HttpResponse.json({ connectors: [githubConnector] })),
    http.get('*/web/connections/activity', () =>
      HttpResponse.json({ since: '2026-11-11T12:00:00.000Z', total: 0, errors: 0, calls: [], truncated: false, failures: [] }),
    ),
    http.get('*/web/connections/:id/detail', () => HttpResponse.json({ sections: [] })),
    http.get('*/web/github/pat', () => HttpResponse.json({ configured: true, reviewerConfigured: false })),
    http.get('*/web/factory/projects/fp-1/metrics', () => HttpResponse.json({ metrics })),
    http.get('*/web/usage/summary', () => HttpResponse.json(usageSummary)),
    http.get('*/web/factory/projects/fp-1/environment', () => HttpResponse.json(environmentPayload())),
    http.get('*/web/intake/config', () =>
      HttpResponse.json({
        config: { github: { enabled: true, sourceIds: null }, gitlab: { enabled: false, sourceIds: null }, clickup: { enabled: true, sourceIds: null } },
      }),
    ),
    http.get('*/web/clickup/lists', () => HttpResponse.json({ lists: [] })),
    http.get('*/web/clickup/status', () =>
      HttpResponse.json({ configured: true, connected: true, workspaces: ['eclipt.ai workspace with a long name'], intervalSeconds: 60 }),
    ),
    http.get('*/web/config/om', () => HttpResponse.json(omResponse())),
    http.get('*/web/config/custom-providers', () => HttpResponse.json(customProvidersResponse)),
    http.get('*/web/config/versions', () =>
      HttpResponse.json({
        packages: [
          { name: '@mastra/core', version: '1.83.0' },
          { name: '@factory/harness-claude-code-core-with-a-long-package-name', version: '0.28.0-alpha.20261115' },
        ],
        nodeVersion: 'v22.23.3',
      }),
    ),
    http.get('*/auth/api/list-sessions', () => HttpResponse.json(sessions)),
    http.get('*/auth/api/get-session', () => HttpResponse.json({ session: sessions[0], user: { id: 'ada' } })),
  ];
}
