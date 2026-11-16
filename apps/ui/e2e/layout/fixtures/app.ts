import { http, HttpResponse } from 'msw';
import type { RequestHandler } from 'msw';

import { largeBoard } from '../../../src/ui/__tests__/fixtures/largeBoard';
import { storedWorkBoard } from '../../../src/ui/domains/boardConfig/__tests__/fixtures/work-board';
import { builtinBoardCatalog } from '../../ui/board-catalog';
import { answerBoardPhases, answerWorkItemFilterOptions } from '../../ui/board-reads';
import type { StubbedProject } from '../../ui/board-reads';
import { LONG_EMAIL, LONG_ORG, settingsHandlers } from './settings';

/**
 * Outside settings: organization links, the sidebar's account menu, the board, card moves, the
 * onboarding page and a chat thread whose status line carries every stat. Signed in as the same
 * organization owner as the settings fixtures, with the same long names.
 */
const IN_A_WEEK = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

export const JOIN_TOKEN = 'jl-engineering-onboarding-token';
export const INVITATION_ID = 'inv-long';

export function organizationLinkHandlers(): RequestHandler[] {
  return [
    http.get('*/web/join/:token', () =>
      HttpResponse.json({
        organization: { id: 'org-acme', name: LONG_ORG, logo: null },
        role: 'member',
        name: 'Engineering onboarding for the platform and infrastructure teams',
        alreadyMember: false,
        refusal: null,
      }),
    ),
    http.get('*/auth/api/organization/get-invitation', () =>
      HttpResponse.json({
        id: INVITATION_ID,
        email: LONG_EMAIL,
        role: 'admin',
        status: 'pending',
        expiresAt: IN_A_WEEK,
        organizationId: 'org-acme',
        organizationName: LONG_ORG,
        inviterEmail: 'ada.lovelace-byron@analytical-engines.example.com',
      }),
    ),
    ...settingsHandlers(),
  ];
}

/** Two organizations, so the account menu offers the switch. */
export function accountMenuHandlers(): RequestHandler[] {
  return [
    http.get('*/auth/api/organization/list', () =>
      HttpResponse.json([
        { id: 'org-acme', name: LONG_ORG, slug: 'acme', logo: null },
        { id: 'org-side', name: 'Side project with a very long organization name', slug: 'side', logo: null },
      ]),
    ),
    ...appHandlers(),
  ];
}

const LONG_TITLE = 'Migrate the billing reconciliation job to the new ledger service without double-charging';

/** Six cards in triage, one with a title longer than any phone row. */
function boardCards() {
  return largeBoard(6).map((card, index) =>
    index === 0 ? { ...card, title: LONG_TITLE, workItem: { ...card.workItem, title: LONG_TITLE } } : card,
  );
}

/**
 * The board reads (its phases, its filter options) answered here from the stated cards: the UI
 * suite's ambient board reads fetch the stub from the MSW server, which this harness does not run.
 */
function boardHandlers(): RequestHandler[] {
  const workItems = boardCards();
  const project: StubbedProject = { workItems, boards: builtinBoardCatalog.boards, userId: 'ada' };
  const queuedSince = new Date(Date.now() - 12 * 60 * 1000).toISOString();
  const queued = [1, 2, 3].map(position => ({
    decisionId: `decision-${position}`,
    state: 'waiting' as const,
    type: 'invokeSkill' as const,
    role: 'implementer',
    skillName: 'implement-with-a-very-long-skill-name',
    queuedSince,
    position,
    workItem: { id: workItems[position - 1]!.workItemId, key: 'ACME-1234', title: LONG_TITLE, board: 'work', phase: 'triage' },
  }));
  return [
    http.get('*/web/factory/projects/:id/work-items', () => HttpResponse.json({ workItems })),
    http.get('*/web/factory/projects/:id/boards/work', () => HttpResponse.json(storedWorkBoard())),
    http.get('*/web/factory/projects/:id/boards/:boardKey/phases', ({ request, params }) =>
      answerBoardPhases(request, project, String(params.boardKey)),
    ),
    http.get('*/web/factory/projects/:id/work-items/filter-options', () => answerWorkItemFilterOptions(workItems)),
    http.get('*/web/factory/projects/:id/run-queue', () =>
      HttpResponse.json({ slots: { scope: 'server', inUse: 10, cap: 10 }, running: 10, claimed: [], queuedCount: 3, queued }),
    ),
    http.get('*/web/github/projects/:id/issues', () => HttpResponse.json({ issues: [], nextPage: null })),
    http.get('*/web/gitlab/status', () => HttpResponse.json({ enabled: false, connected: false })),
  ];
}

export function appHandlers(): RequestHandler[] {
  return [...boardHandlers(), ...settingsHandlers()];
}

export const SESSION_ID = 'sess-composer';

const AC = '*/api/agent-controller/code';

/** One recorded turn: 113.6K tokens this session, 37.2K of a 1M context, on a Claude Code account. */
function sessionUsage() {
  const totals = { inputTokens: 1_600, cacheReadTokens: 108_000, cacheWriteTokens: 3_000, outputTokens: 1_000, reasoningTokens: 0 };
  const turn = {
    id: 'turn-1',
    sessionId: SESSION_ID,
    threadId: SESSION_ID,
    runId: null,
    factoryProjectId: 'fp-1',
    workItemId: null,
    kickoffId: null,
    role: null,
    userId: 'ada',
    harnessId: 'claude-code',
    model: 'claude-opus-5-5',
    accountId: 'acc-claude',
    occurredAt: new Date().toISOString(),
    totals,
    stepCount: 3,
    contextTokens: 37_200,
    reportedCostUsd: null,
    totalTokens: 113_600,
    costUsd: 0.41,
    costSource: 'estimated',
  };
  return {
    usage: {
      sessionId: SESSION_ID,
      turns: [turn],
      total: { turns: 1, totals, totalTokens: 113_600, costUsd: 0.41, reportedCostUsd: 0, unpricedTurns: 0 },
      context: { tokens: 37_200, window: 1_000_000 },
    },
  };
}

function usageLimits() {
  const inDays = (days: number, hours: number) => new Date(Date.now() + (days * 24 + hours) * 60 * 60 * 1000).toISOString();
  return {
    accounts: [
      {
        accountId: 'acc-claude',
        label: LONG_EMAIL,
        harnessId: 'claude-code',
        harnessName: 'Claude Code',
        provider: 'anthropic',
        disabled: false,
        usage: {
          checkedAt: new Date().toISOString(),
          source: 'probe',
          windows: [
            { id: 'primary', kind: 'session', usedPercent: 12, windowDurationMins: 300, resetsAt: inDays(0, 2) },
            { id: 'seven_day', kind: 'weekly', usedPercent: 57, windowDurationMins: 10_080, resetsAt: inDays(3, 13) },
          ],
        },
      },
    ],
  };
}

/** A personal Claude Code session's thread, its composer and the status line with every stat. */
export function threadHandlers(): RequestHandler[] {
  const session = {
    id: 'row-1',
    sessionId: SESSION_ID,
    projectRepositoryId: 'ghp-1',
    orgId: 'org-acme',
    userId: 'ada',
    visibility: 'private',
    title: LONG_TITLE,
    branch: `user/session-${SESSION_ID}`,
    baseBranch: 'main',
    sandboxId: 'sb-1',
    sandboxWorkdir: '/local/acme/app',
    materializedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    capabilities: { recreateSandbox: false, switchModel: true },
  };
  return [
    http.get('*/web/factory/projects/fp-1/sessions', () => HttpResponse.json({ sessions: [session] })),
    http.get(`*/web/user-sessions/${SESSION_ID}`, () => HttpResponse.json({ session })),
    http.get('*/web/github/subscriptions', () => HttpResponse.json({ subscriptions: [] })),
    http.get('*/web/usage/sessions/:sessionId', () => HttpResponse.json(sessionUsage())),
    http.get('*/web/usage/limits', () => HttpResponse.json(usageLimits())),
    http.post(`${AC}/sessions`, () => HttpResponse.json({ controllerId: 'code', resourceId: SESSION_ID, threadId: SESSION_ID })),
    http.get(`${AC}/sessions/:resourceId`, () =>
      HttpResponse.json({
        controllerId: 'code',
        resourceId: SESSION_ID,
        modeId: 'build',
        modelId: 'anthropic/claude-opus-5-5',
        threadId: SESSION_ID,
        settings: { yolo: false, thinkingLevel: 'high', notifications: 'bell', smartEditing: true },
      }),
    ),
    http.put(`${AC}/sessions/:resourceId/state`, () => HttpResponse.json({ ok: true })),
    // The live stream stays open and quiet: nothing runs in this thread.
    http.get(`${AC}/sessions/:resourceId/stream`, () => new HttpResponse('', { headers: { 'content-type': 'text/event-stream' } })),
    http.get(`${AC}/sessions/:resourceId/permissions`, () => HttpResponse.json({})),
    http.get(`${AC}/sessions/:resourceId/threads`, () => HttpResponse.json({ threads: [] })),
    http.get(`${AC}/sessions/:resourceId/threads/:threadId/messages`, () => HttpResponse.json({ messages: [] })),
    ...appHandlers(),
  ];
}

/** A 2×2 PNG, red and blue, for the Files panel's image view. */
const SHOT_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4zwAEIOI/kAAAG/ID/VxhF44AAAAASUVORK5CYII=';

/**
 * The same thread with a reply that names files and links: a path as text, one as `code`, a path on
 * the server outside the workspace, and a web address. The workspace serves the screenshot it names.
 */
export function threadWithLinksHandlers(): RequestHandler[] {
  const reply =
    'Готово. Зміни в `apps/web/src/home.tsx`, скріншот — e2e/shots/home.png.\n\n' +
    'Лог тестів: /private/tmp/run-42/vitest.log\n\nPR: https://github.com/acme/app/pull/176';
  const updatedAt = new Date().toISOString();
  return [
    http.get(`${AC}/sessions/:resourceId/threads/:threadId/messages`, () =>
      HttpResponse.json({
        messages: [
          { id: 'reply-1', role: 'assistant', createdAt: updatedAt, content: { format: 2, parts: [{ type: 'text', text: reply }] } },
        ],
      }),
    ),
    http.get('*/web/workspace/tree', ({ request }) => {
      const path = new URL(request.url).searchParams.get('path') ?? '';
      return HttpResponse.json({ workspacePath: SESSION_ID, path, available: true, entries: [] });
    }),
    http.get('*/web/workspace/file', ({ request }) => {
      const path = new URL(request.url).searchParams.get('path') ?? '';
      const name = path.slice(path.lastIndexOf('/') + 1);
      return path.endsWith('.png')
        ? HttpResponse.json({ workspacePath: SESSION_ID, path, name, size: 74, updatedAt, contentType: 'media', mimeType: 'image/png', content: SHOT_PNG })
        : HttpResponse.json({ workspacePath: SESSION_ID, path, name, size: 40, updatedAt, contentType: 'text', content: 'export function Home() {\n  return null;\n}\n' });
    }),
    ...threadHandlers(),
  ];
}

/** No Factory yet: `/onboarding` stays on «Set up your factory» instead of opening the board. */
export function onboardingHandlers(): RequestHandler[] {
  return [http.get('*/web/factory/projects', () => HttpResponse.json({ projects: [] })), ...appHandlers()];
}
