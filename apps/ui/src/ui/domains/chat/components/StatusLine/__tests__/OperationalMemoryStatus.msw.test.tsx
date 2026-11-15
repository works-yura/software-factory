import type { AgentControllerOMProgress } from '@mastra/client-js';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '../../../../../../../e2e/ui/render';
import { CLAUDE_CODE_HARNESS, MASTRA_HARNESS } from '@factory/contracts/harnesses';
import type { HarnessDescriptor } from '@factory/contracts/harnesses';

import { ChatRuntimeContext } from '../../../context/ChatRuntimeContext';
import { ChatSessionContext } from '../../../context/ChatSessionContext';
import type { ChatRuntimeApi } from '../../../context/ChatRuntimeContext';
import { OperationalMemoryStatus } from '../OperationalMemoryStatus';
import { RuntimeActivity } from '../RuntimeActivity';

const omProgress: AgentControllerOMProgress = {
  status: 'idle',
  pendingTokens: 14_900,
  threshold: 30_000,
  thresholdPercent: 49.7,
  observationTokens: 12_000,
  reflectionThreshold: 40_000,
  reflectionThresholdPercent: 30,
  projectedMessageRemoval: 0,
  projectedReflectionSavings: 0,
};

function renderStatus(runtime: Partial<ChatRuntimeApi>) {
  return renderWithProviders(
    <ChatRuntimeContext.Provider
      value={{
        followUpCount: 0,
        runsStarted: 0,
        omProgress,
        omPhase: 'idle',
        bufferingMessages: false,
        bufferingObservations: false,
        tokensPerSec: 0,
        ...runtime,
      }}
    >
      <OperationalMemoryStatus />
      <RuntimeActivity />
    </ChatRuntimeContext.Provider>,
  );
}

function renderForHarness(harness: HarnessDescriptor) {
  return renderWithProviders(
    <ChatSessionContext.Provider
      value={{
        sessionId: 'session-1',
        resourceId: 'resource-1',
        sessionEnabled: true,
        resourceReady: true,
        sandboxReady: true,
        sandboxPreparing: false,
        resourceEnabled: true,
        baseUrl: '',
        kind: 'user',
        harness,
      }}
    >
      <ChatRuntimeContext.Provider
        value={{
          runsStarted: 0,
          followUpCount: 0,
          omProgress,
          omPhase: 'idle',
          bufferingMessages: false,
          bufferingObservations: false,
          tokensPerSec: 0,
        }}
      >
        <OperationalMemoryStatus />
      </ChatRuntimeContext.Provider>
    </ChatSessionContext.Provider>,
  );
}

describe('observational memory status', () => {
  describe('when the session runs on a harness without observational memory', () => {
    it('shows no memory budgets, even when the runtime reports a window', () => {
      renderForHarness(CLAUDE_CODE_HARNESS);

      expect(screen.queryByRole('button', { name: /^Memory budgets:/ })).toBeNull();
      expect(screen.queryByRole('meter', { name: 'Message window until next observation' })).toBeNull();
    });

    it('keeps them on a harness that has it', () => {
      renderForHarness(MASTRA_HARNESS);

      expect(screen.getByRole('button', { name: /^Memory budgets:/ })).toBeVisible();
    });
  });

  describe('when memory consolidates in the background', () => {
    it('works the ring of the budget it acts on and stays silent otherwise', () => {
      const { container } = renderStatus({ bufferingObservations: true });

      const working = container.querySelectorAll<HTMLElement>('[data-working]');

      expect(working).toHaveLength(1);
      expect(screen.getByRole('meter', { name: 'Consolidating observations in the background' })).toContainElement(
        working.item(0),
      );
      expect(screen.queryByText('consolidating memory')).toBeNull();
    });

    it('names the working budget on the control, which hides the rings from assistive tech', () => {
      renderStatus({ bufferingObservations: true });

      expect(
        screen.getByRole('button', {
          name: 'Memory budgets: Message window until next observation, 14.9K of 30K. Consolidating observations in the background, 12K of 40K',
        }),
      ).toBeVisible();
    });
  });

  describe('when a reflection holds the turn', () => {
    it('names the wait', () => {
      renderStatus({ omPhase: 'reflecting' });

      expect(screen.getByText('consolidating memory')).toBeVisible();
      expect(screen.getByRole('meter', { name: 'Consolidating observations' })).toHaveAttribute(
        'aria-valuetext',
        '12K/40K',
      );
    });
  });

  describe('when a background reflection emits a retry start event', () => {
    it('keeps reporting background work rather than a wait', () => {
      renderStatus({ omPhase: 'reflecting', bufferingObservations: true });

      expect(screen.queryByText('consolidating memory')).toBeNull();
      expect(screen.getByRole('meter', { name: 'Consolidating observations in the background' })).toBeVisible();
    });
  });

  describe('when memory is idle', () => {
    it('shows both budgets at rest', () => {
      const { container } = renderStatus({});

      expect(screen.getByRole('meter', { name: 'Message window until next observation' })).toHaveAttribute(
        'aria-valuetext',
        '14.9K/30K',
      );
      expect(container.querySelector('[data-working]')).toBeNull();
    });

    it('speaks both budgets on the control, which hides the rings from assistive tech', () => {
      renderStatus({});

      expect(
        screen.getByRole('button', {
          name: 'Memory budgets: Message window until next observation, 14.9K of 30K. Observations accumulated until next reflection, 12K of 40K',
        }),
      ).toBeVisible();
    });

    it('opens both budgets and what they do from a single control', async () => {
      renderStatus({});

      fireEvent.click(screen.getByRole('button', { name: /^Memory budgets:/ }));

      await waitFor(() => expect(screen.getByText('Read into memory once full')).toBeVisible());
      expect(screen.getByText('Consolidated into a reflection once full')).toBeVisible();
      expect(screen.getAllByText('/40K')).toHaveLength(2);
    });
  });
});
