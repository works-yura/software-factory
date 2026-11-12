/**
 * SPA route table (React Router v7, data mode).
 *
 * Auth gating happens in React layout components, not loaders: `RequireAuth`
 * wraps the app routes and reads `/auth/me` through the `useFactoryAuth` custom
 * React Query hook (shared cache key with the rest of the UI), redirecting
 * unauthenticated sessions to `/signin` when web auth is enabled. `SignInGate`
 * mirrors the guard: signed-in (or auth-disabled) visitors are sent back to
 * `/` so the app can choose the active factory's board or draft composer.
 *
 * The URL is the single source of truth for the active factory: everything
 * factory-scoped lives under `/factories/:factoryId/**` behind `FactoryLayout`.
 */
import { createBrowserRouter, Navigate, useLocation, useParams } from 'react-router';
import type { RouteObject } from 'react-router';

import { FactoryBoardLanding } from './domains/factory/components/FactoryBoardLanding';
import { boardConfigPath, boardSkillsPath, newBoardPath } from './domains/boardConfig/boardConfigPaths';
import { RootGuards, SignedInOnly } from './domains/auth/components/RootGuards';
import { KnowledgePage } from './pages/KnowledgePage';
import { PULL_REQUEST_SOURCE_FILTER } from './domains/factory/boardSourceFilters';
import { CustomBoardPage, WorkBoardPage } from './pages/BoardPage';
import { BoardConfigPage } from './pages/BoardConfigPage';
import { CreateFactoryPage } from './pages/CreateFactoryPage';
import { FactorySkillsPage } from './pages/FactorySkillsPage';
import { NewBoardPage } from './pages/NewBoardPage';
import { ConnectAccountPage } from './pages/ConnectAccountPage';
import { InvitePage } from './pages/InvitePage';
import { OAuthConsentPage } from './pages/OAuthConsentPage';
import { NewPage } from './pages/NewPage';
import { OnboardingPage } from './pages/OnboardingPage';
import { SettingsPage } from './pages/SettingsPage';
import { RulesPage } from './pages/RulesPage';
import { SignInPage } from './pages/SignInPage';
import { SupervisorPage } from './pages/SupervisorPage';
import { supervisorChatEnabled } from './domains/supervisor/services/supervisor';
import { ThreadPage } from './pages/ThreadPage';

import { useFactoriesQuery } from '../hooks/useFactories';
import { useKnowledgeAvailable } from '../hooks/useKnowledgeAvailable';
import { FactoryLayout } from './domains/workspaces/components/FactoryLayout';
import { AppLayout } from './layouts/AppLayout';
import { pendingCreateFlowFactoryId } from './domains/workspaces/hooks/useCreateFactoryFlow';
import { createFactoryPath } from './domains/workspaces/services/factoryPaths';
import { hasResumableFactoryOnboarding } from './domains/workspaces/services/onboardingFlow';

function RootLanding() {
  const { data: factories, isPending } = useFactoriesQuery();
  // Preserve `routeErrorNotice`-style state through the redirect chain (e.g.
  // FactoryLayout bouncing an unknown factoryId here).
  const { state, search } = useLocation();

  // OAuth callbacks land on `/?github=connected` etc. A mid-way create-factory
  // flow knows the Factory it was opened from, so it resumes there (with the
  // search intact) without waiting on any query.
  const createFlowFactoryId = pendingCreateFlowFactoryId();
  if (createFlowFactoryId) return <Navigate to={`${createFactoryPath(createFlowFactoryId)}${search}`} replace />;

  if (isPending || !factories) return null;

  const firstFactory = factories[0];
  // Empty list is bounced to /onboarding by OnboardingGuard before we render.
  if (!firstFactory) return null;

  // Onboarding does the same once its factory exists (created on repo pick): the
  // GitHub round-trips must resume the wizard, not land on the factory.
  if (hasResumableFactoryOnboarding(factories)) return <Navigate to={`/onboarding${search}`} replace />;

  return <Navigate to={`/factories/${firstFactory.id}`} replace state={state} />;
}

/**
 * The retired Review board's links (`/review?item=…`) open Work filtered to cards carrying a pull
 * request, keeping the rest of their query.
 */
function RetiredReviewBoardRedirect() {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  // Picked sources widen the filter, so any other source would show cards the Review board never held.
  params.set('source', PULL_REQUEST_SOURCE_FILTER);
  return <Navigate to={`../work?${params}`} relative="path" replace />;
}

/** Analytics is a Settings section; its old pages keep the window a link names. */
function AnalyticsRedirect() {
  const { search } = useLocation();
  return <Navigate to={`../settings/analytics${search}`} relative="path" replace />;
}

function FactoryHomeRedirect() {
  const { factoryId } = useParams<{ factoryId: string }>();
  return <FactoryBoardLanding factoryId={factoryId} />;
}

/** A bookmarked supervisor link lands on the factory home while the chat is hidden. */
function SupervisorRoute() {
  const { factoryId } = useParams<{ factoryId: string }>();
  return supervisorChatEnabled() ? <SupervisorPage /> : <Navigate to={`/factories/${factoryId}`} replace />;
}

/**
 * Factory-agnostic thread deep link, used by server-built links that don't
 * know a factory id (e.g. the Slack "View Session" card, whose channel
 * sessions are controller-scoped). Forwards to the first factory's workspaces
 * thread route, preserving the query string — the `?sessionId=` override
 * (`?resourceId=` in older links) binds the chat surface to the channel session there.
 */
function ChannelThreadRedirect() {
  const { data: factories, isPending } = useFactoriesQuery();
  const { threadId } = useParams<{ threadId: string }>();
  const { search } = useLocation();

  if (isPending) return null;

  const firstFactory = factories?.[0];
  // Empty list is bounced to /onboarding by OnboardingGuard before we render.
  if (!firstFactory || !threadId) return null;

  return (
    <Navigate
      to={`/factories/${firstFactory.id}/workspaces/channel/threads/${encodeURIComponent(threadId)}${search}`}
      replace
    />
  );
}

/**
 * Factory-agnostic entry to the old Connections page, kept for links that do not
 * know a Factory id. Connections is gone, so it opens Repositories. Routing through the SPA guarantees the visitor is
 * authenticated before they start the OIDC flow.
 */
function ConnectionsRedirect() {
  const { data: factories, isPending } = useFactoriesQuery();

  if (isPending) return null;

  const firstFactory = factories?.[0];
  // Empty list is bounced to /onboarding by OnboardingGuard before we render.
  if (!firstFactory) return null;

  return <Navigate to={`/factories/${firstFactory.id}/settings/repositories`} replace />;
}

/**
 * Boards used to be edited in Settings: old links (`?board=…`, `?new=1`) open that board's settings, the
 * new-board form, or the Work board's settings.
 */
function BoardSettingsRedirect() {
  const { factoryId } = useParams<{ factoryId: string }>();
  const { search } = useLocation();
  if (!factoryId) return null;
  const params = new URLSearchParams(search);
  if (params.has('new')) return <Navigate to={newBoardPath(factoryId)} replace />;
  return <Navigate to={boardConfigPath(factoryId, params.get('board') ?? 'work')} replace />;
}

/** Skills used to live in Settings; old links open them beside the Work board's settings. */
function SkillsSettingsRedirect() {
  const { factoryId } = useParams<{ factoryId: string }>();
  if (!factoryId) return null;
  return <Navigate to={boardSkillsPath(factoryId, 'work')} replace />;
}

function KnowledgeRoute() {
  const { factoryId } = useParams<{ factoryId: string }>();
  const knowledge = useKnowledgeAvailable(factoryId);

  if (knowledge.pending || !factoryId) return null;
  if (!knowledge.available) return <Navigate to={`/factories/${factoryId}`} replace />;
  return <KnowledgePage />;
}

export function createAppRoutes(): RouteObject[] {
  // NOTE: route paths must not (case-insensitively) match a file at the Vite
  // root (src/ui), or dev deep-links serve the module source instead of
  // the app (e.g. /chat used to resolve to a root-level Chat.tsx).
  return [
    {
      path: '/',
      element: <RootGuards />,
      children: [
        { index: true, element: <RootLanding /> },
        { path: 'onboarding', element: <OnboardingPage /> },
        {
          path: 'factories/:factoryId',
          element: <FactoryLayout />,
          children: [
            {
              element: <AppLayout />,
              children: [
                { index: true, element: <FactoryHomeRedirect /> },
                { path: 'workspaces/:sessionId', element: <NewPage /> },
                { path: 'workspaces/:sessionId/threads/:threadId', element: <ThreadPage /> },
                { path: 'user/new/:draftSessionId', element: <NewPage /> },
                { path: 'user/threads/:threadId', element: <ThreadPage /> },
                { path: 'supervisor', element: <SupervisorRoute /> },
                { path: 'new', element: <NewPage /> },
                { path: 'new-factory', element: <CreateFactoryPage /> },
                { path: 'new-board', element: <NewBoardPage /> },
                { path: 'work', element: <WorkBoardPage /> },
                // The Review board was retired: pull requests are reviewed on Work.
                { path: 'review', element: <RetiredReviewBoardRedirect /> },
                { path: 'boards/:boardId', element: <CustomBoardPage /> },
                { path: 'work/config/:phaseKey?', element: <BoardConfigPage /> },
                { path: 'boards/:boardId/config/:phaseKey?', element: <BoardConfigPage /> },
                { path: 'work/skills', element: <FactorySkillsPage /> },
                { path: 'boards/:boardId/skills', element: <FactorySkillsPage /> },
                { path: 'activity', element: <FactoryHomeRedirect /> },
                // Upstream's Overview and Metrics became Analytics, a Settings section.
                { path: 'analytics', element: <AnalyticsRedirect /> },
                { path: 'overview', element: <AnalyticsRedirect /> },
                { path: 'attention', element: <FactoryHomeRedirect /> },
                { path: 'metrics', element: <AnalyticsRedirect /> },
                { path: 'audit', element: <FactoryHomeRedirect /> },
                { path: 'rules', element: <RulesPage /> },
                { path: 'knowledge', element: <KnowledgeRoute /> },
                {
                  path: 'settings',
                  children: [
                    { index: true, element: <Navigate to="preferences" replace /> },
                    { path: 'board', element: <BoardSettingsRedirect /> },
                    { path: 'skills', element: <SkillsSettingsRedirect /> },
                    { path: ':section', element: <SettingsPage /> },
                  ],
                },
              ],
            },
          ],
        },
        // Server-built thread deep links without a factory id (Slack cards).
        { path: 'threads/:threadId', element: <ChannelThreadRedirect /> },
        { path: 'settings/connections', element: <ConnectionsRedirect /> },
        // Where a conversation channel's connect reply points (no identity in the link).
        { path: 'connect/:platform', element: <ConnectAccountPage /> },
        // Legacy deep links (the app used to serve everything at any path).
        { path: '*', element: <Navigate to="/" replace /> },
      ],
    },
    // An invitation link: sign-in required, onboarding not (the invited person may have no Factory yet).
    { path: '/invite/:invitationId', element: <SignedInOnly />, children: [{ index: true, element: <InvitePage /> }] },
    // An MCP client (Claude Code, Cursor) asks to act as the signed-in person: Factory's OAuth consent.
    { path: '/oauth/consent', element: <SignedInOnly />, children: [{ index: true, element: <OAuthConsentPage /> }] },
    { path: '/signin', element: <SignInPage /> },
  ];
}

export function createAppRouter() {
  return createBrowserRouter(createAppRoutes());
}
