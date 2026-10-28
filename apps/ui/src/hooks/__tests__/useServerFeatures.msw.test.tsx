import { waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { server } from '../../../e2e/ui/msw-server';
import { renderHookWithProviders, TEST_BASE_URL } from '../../../e2e/ui/render';
import { useServerFeatures } from '../useServerFeatures';

describe('useServerFeatures', () => {
  describe('when the server enables experimental knowledge', () => {
    it('exposes the enabled capability to UI gates', async () => {
      server.use(http.get(`${TEST_BASE_URL}/web/config/features`, () => HttpResponse.json({ knowledge: true })));

      const { result } = renderHookWithProviders(() => useServerFeatures());

      await waitFor(() => expect(result.current.data).toEqual({ knowledge: true }));
    });
  });

  describe('when the server serves its MCP endpoint', () => {
    it('exposes the MCP flag so the UI can show the connect URL', async () => {
      server.use(
        http.get(`${TEST_BASE_URL}/web/config/features`, () => HttpResponse.json({ knowledge: false, mcp: true })),
      );

      const { result } = renderHookWithProviders(() => useServerFeatures());

      await waitFor(() => expect(result.current.data?.mcp).toBe(true));
    });
  });

  describe('when the server runs the Claude Code harness', () => {
    it('exposes the flag so the create-Factory wizard can offer the harness step', async () => {
      server.use(
        http.get(`${TEST_BASE_URL}/web/config/features`, () =>
          HttpResponse.json({ knowledge: false, mcp: false, claudeCode: true }),
        ),
      );

      const { result } = renderHookWithProviders(() => useServerFeatures());

      await waitFor(() => expect(result.current.data?.claudeCode).toBe(true));
    });
  });
});
