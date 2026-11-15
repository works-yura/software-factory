import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';

import { server } from '../../../e2e/ui/msw-server';
import { renderWithProviders, TEST_BASE_URL } from '../../../e2e/ui/render';
import { createAppRoutes } from '../router';

function renderFactoryRoute(initialEntry = '/factories/fp-1') {
  const router = createMemoryRouter(createAppRoutes(), { initialEntries: [initialEntry] });
  renderWithProviders(<RouterProvider router={router} />);
  return router;
}

const draft = {
  repository: {
    id: 99,
    fullName: 'octo/hello',
    name: 'hello',
    owner: 'octo',
    defaultBranch: 'main',
    private: false,
    installationId: 7,
    installationStorageId: 'inst-7',
    sandboxProvider: 'local',
    sandboxWorkdir: '/workspace/hello',
  },
  model: { providerId: 'openai', modelId: 'openai/gpt-5.6-sol', method: 'api_key' },
};

// Literal keys on purpose: these tests pin the sessionStorage contract the
// guard and RootLanding rely on across full-page OAuth redirects.
function seedOnboarding(step: string, factoryId: string | null, updatedAt: number | null = Date.now()) {
  sessionStorage.setItem('mastracode.factory-onboarding.step', step);
  sessionStorage.setItem('mastracode.factory-onboarding.draft', JSON.stringify(draft));
  if (factoryId !== null) sessionStorage.setItem('mastracode.factory-onboarding.factory-id', factoryId);
  if (updatedAt !== null) sessionStorage.setItem('mastracode.factory-onboarding.updated-at', String(updatedAt));
}

function clearOnboarding() {
  sessionStorage.removeItem('mastracode.factory-onboarding.step');
  sessionStorage.removeItem('mastracode.factory-onboarding.draft');
  sessionStorage.removeItem('mastracode.factory-onboarding.factory-id');
  sessionStorage.removeItem('mastracode.factory-onboarding.updated-at');
}

describe('Factory root route', () => {
  it('redirects the bare factory URL to the work board', async () => {
    server.use(
      http.get(`${TEST_BASE_URL}/auth/me`, () =>
        HttpResponse.json({ authenticated: true, authEnabled: true, user: { userId: 'user-1', permissions: ['board.read', 'self.write', 'card.write', 'comment.write', 'run.start', 'session.write', 'factory.configure'] } }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
        HttpResponse.json({ projects: [{ id: 'fp-1', name: 'Empty Factory', repositories: [] }] }),
      ),
    );

    const router = renderFactoryRoute();

    await waitFor(() => expect(router.state.location.pathname).toBe('/factories/fp-1/work'));
  });

  it('redirects the root route to onboarding when no factories exist', async () => {
    server.use(
      http.get(`${TEST_BASE_URL}/auth/me`, () =>
        HttpResponse.json({ authenticated: true, authEnabled: true, user: { userId: 'user-1', permissions: ['board.read', 'self.write', 'card.write', 'comment.write', 'run.start', 'session.write', 'factory.configure'] } }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () => HttpResponse.json({ projects: [] })),
    );

    const router = renderFactoryRoute('/');

    await screen.findByRole('heading', { name: 'Set up your factory' });
    expect(router.state.location.pathname).toBe('/onboarding');
  });

  it('redirects onboarding to the first factory when one exists', async () => {
    server.use(
      http.get(`${TEST_BASE_URL}/auth/me`, () =>
        HttpResponse.json({ authenticated: true, authEnabled: true, user: { userId: 'user-1', permissions: ['board.read', 'self.write', 'card.write', 'comment.write', 'run.start', 'session.write', 'factory.configure'] } }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
        HttpResponse.json({ projects: [{ id: 'fp-1', name: 'Existing Factory', repositories: [] }] }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects/fp-1/work-items`, () => HttpResponse.json({ workItems: [] })),
    );

    const router = renderFactoryRoute('/onboarding');

    await waitFor(() => expect(router.state.location.pathname).toBe('/factories/fp-1/work'));
  });

  it('keeps the Model section open after a failed confirmation created its factory', async () => {
    seedOnboarding('model', 'fp-1');

    server.use(
      http.get(`${TEST_BASE_URL}/auth/me`, () =>
        HttpResponse.json({ authenticated: true, authEnabled: true, user: { userId: 'user-1', permissions: ['board.read', 'self.write', 'card.write', 'comment.write', 'run.start', 'session.write', 'factory.configure'] } }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
        HttpResponse.json({ projects: [{ id: 'fp-1', name: 'Pending Factory', repositories: [] }] }),
      ),
    );

    const router = renderFactoryRoute('/onboarding');

    try {
      await screen.findByRole('heading', { level: 2, name: 'Model' });
      expect(router.state.location.pathname).toBe('/onboarding');
    } finally {
      clearOnboarding();
    }
  });

  it('resumes a mid-flow onboarding from the root route after an OAuth round-trip', async () => {
    // A step of the old wizard (`review`) resumes at the first incomplete section: here Model.
    seedOnboarding('review', null);

    server.use(
      http.get(`${TEST_BASE_URL}/auth/me`, () =>
        HttpResponse.json({ authenticated: true, authEnabled: true, user: { userId: 'user-1', permissions: ['board.read', 'self.write', 'card.write', 'comment.write', 'run.start', 'session.write', 'factory.configure'] } }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () => HttpResponse.json({ projects: [] })),
    );

    const router = renderFactoryRoute('/?github=connected');

    try {
      await screen.findByRole('heading', { level: 2, name: 'Model' });
      expect(router.state.location.pathname).toBe('/onboarding');
    } finally {
      clearOnboarding();
    }
  });

  it('ignores stale onboarding markers whose factory no longer exists', async () => {
    // Fresh timestamp: this test pins the factory-existence gate specifically.
    seedOnboarding('vcs', 'fp-deleted');

    server.use(
      http.get(`${TEST_BASE_URL}/auth/me`, () =>
        HttpResponse.json({ authenticated: true, authEnabled: true, user: { userId: 'user-1', permissions: ['board.read', 'self.write', 'card.write', 'comment.write', 'run.start', 'session.write', 'factory.configure'] } }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
        HttpResponse.json({ projects: [{ id: 'fp-1', name: 'Existing Factory', repositories: [] }] }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects/fp-1/work-items`, () => HttpResponse.json({ workItems: [] })),
    );

    const router = renderFactoryRoute('/');

    try {
      await waitFor(() => expect(router.state.location.pathname).toBe('/factories/fp-1/work'));
    } finally {
      clearOnboarding();
    }
  });

  it('treats onboarding markers without a fresh timestamp as abandoned', async () => {
    // Markers written by an older version of the flow (or a tab rediscovered
    // hours later) have no fresh `updated-at`: with a factory existing they
    // must bounce to it instead of re-opening the wizard.
    seedOnboarding('vcs', 'fp-1', null);

    server.use(
      http.get(`${TEST_BASE_URL}/auth/me`, () =>
        HttpResponse.json({ authenticated: true, authEnabled: true, user: { userId: 'user-1', permissions: ['board.read', 'self.write', 'card.write', 'comment.write', 'run.start', 'session.write', 'factory.configure'] } }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects`, () =>
        HttpResponse.json({ projects: [{ id: 'fp-1', name: 'Existing Factory', repositories: [] }] }),
      ),
      http.get(`${TEST_BASE_URL}/web/factory/projects/fp-1/work-items`, () => HttpResponse.json({ workItems: [] })),
    );

    const router = renderFactoryRoute('/onboarding');

    try {
      await waitFor(() => expect(router.state.location.pathname).toBe('/factories/fp-1/work'));
    } finally {
      clearOnboarding();
    }
  });
});
