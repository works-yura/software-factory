import { describe, expect, it } from 'vitest';

import type { SourceControlRepository } from '../github';
import { createBlockedReason } from '../createBlockedReason';
import { githubCallbackAwaitsAccess, githubCallbackRecovery } from '../githubCallbackRecovery';
import {
  nextOnboardingStep,
  onboardingSectionIndex,
  onboardingSections,
  restoredOnboardingStep,
} from '../onboardingSteps';

const repository: SourceControlRepository = {
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
};
const model = { turnHarness: false, providerConnected: true, modelsLoading: false };

describe('onboarding sections', () => {
  it('numbers Harness only while the server offers a choice', () => {
    expect(onboardingSections({ harnessChoice: true })).toEqual(['vcs', 'harness', 'model']);
    expect(onboardingSections({ harnessChoice: false })).toEqual(['vcs', 'model']);
    expect(onboardingSectionIndex('model', true)).toBe(3);
    expect(onboardingSectionIndex('model', false)).toBe(2);
  });

  it('opens the first section still missing a choice', () => {
    expect(nextOnboardingStep({}, { harnessChoice: true })).toBe('vcs');
    expect(nextOnboardingStep({ repository }, { harnessChoice: true })).toBe('harness');
    expect(nextOnboardingStep({ repository }, { harnessChoice: false })).toBe('model');
    expect(nextOnboardingStep({ repository, harness: 'codex' }, { harnessChoice: true })).toBe('model');
  });

  it('reopens Codebase without a repository, the stored section otherwise', () => {
    expect(restoredOnboardingStep('model', {}, { harnessChoice: false })).toBe('vcs');
    expect(restoredOnboardingStep('model', { repository }, { harnessChoice: false })).toBe('model');
    // A step of the old wizard reads as undefined: the first incomplete section opens.
    expect(restoredOnboardingStep(undefined, { repository }, { harnessChoice: false })).toBe('model');
    expect(restoredOnboardingStep('harness', { repository }, { harnessChoice: false })).toBe('model');
  });
});

describe('why Create is off', () => {
  it('names the repository first, then the provider, then the model', () => {
    expect(createBlockedReason({}, model)).toBe('Choose a repository in Codebase to create your factory.');
    expect(createBlockedReason({ repository }, { ...model, providerConnected: false })).toBe(
      'Connect a provider in Model to create your factory.',
    );
    expect(createBlockedReason({ repository }, model)).toBe('Pick a model in Model to create your factory.');
    expect(createBlockedReason({ repository, harness: 'codex' }, { ...model, turnHarness: true })).toBe(
      'Pick a model in Model to create your factory.',
    );
  });

  it('says nothing while a connected provider’s models load, or once Create can run', () => {
    expect(createBlockedReason({ repository }, { ...model, modelsLoading: true })).toBeUndefined();
    expect(
      createBlockedReason(
        { repository, model: { providerId: 'openai', method: 'api_key', modelId: 'openai/gpt-5.6-sol' } },
        model,
      ),
    ).toBeUndefined();
  });
});

describe('the way out of a GitHub App round trip', () => {
  it('connects with a token when the server has no App, refreshes an already-used link, else connects again', () => {
    expect(githubCallbackRecovery('no_app')).toEqual({ next: 'token' });
    expect(githubCallbackRecovery('github_app_link_already_used')).toEqual({ next: 'refresh' });
    expect(githubCallbackRecovery('connect_failed')).toEqual({ next: 'connect' });
  });

  it('waits on access for a requested install', () => {
    expect(githubCallbackAwaitsAccess({ kind: 'requested' })).toBe(true);
    expect(githubCallbackAwaitsAccess({ kind: 'error', code: 'connect_failed', message: '' })).toBe(false);
  });
});
