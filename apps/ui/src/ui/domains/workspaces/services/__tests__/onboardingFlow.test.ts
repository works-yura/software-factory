import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  hasResumableFactoryOnboarding,
  ONBOARDING_FACTORY_KEY,
  ONBOARDING_LINKED_REPOSITORY_KEY,
  ONBOARDING_STEP_KEY,
  ONBOARDING_UPDATED_AT_KEY,
  onboardingCreateReadiness,
  persistOnboardingFactory,
  persistOnboardingStep,
  readOnboardingStep,
  readOnboardingLinkedRepositories,
} from '../onboardingFlow';

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: new MemoryStorage() });
  vi.restoreAllMocks();
});

describe('Factory onboarding flow', () => {
  it('ignores a corrupt repository link marker', () => {
    sessionStorage.setItem(ONBOARDING_LINKED_REPOSITORY_KEY, 'link-original');
    expect(readOnboardingLinkedRepositories()).toEqual([]);
  });

  it('keeps the flow going when session storage refuses writes', () => {
    vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    expect(() => persistOnboardingStep('vcs')).not.toThrow();
    expect(readOnboardingStep()).toBeUndefined();
  });

  it('round-trips the open section', () => {
    persistOnboardingStep('model');

    expect(readOnboardingStep()).toBe('model');
    expect(sessionStorage.getItem(ONBOARDING_STEP_KEY)).toBe('model');
    expect(sessionStorage.getItem(ONBOARDING_UPDATED_AT_KEY)).not.toBeNull();
  });

  it('reads a step of the old wizard as no open section, and still resumes its Factory', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    for (const legacy of ['model-provider', 'review']) {
      sessionStorage.setItem(ONBOARDING_STEP_KEY, legacy);
      sessionStorage.setItem(ONBOARDING_UPDATED_AT_KEY, '1000000');
      persistOnboardingFactory('factory-1');
      expect(readOnboardingStep()).toBeUndefined();
      expect(hasResumableFactoryOnboarding([{ id: 'factory-1' }])).toBe(true);
    }
  });

  it('says which fields Create still needs', () => {
    expect(onboardingCreateReadiness({})).toEqual({ ready: false, missing: ['repository', 'model'] });
    expect(onboardingCreateReadiness({ harness: 'claude-code', harnessModel: null })).toEqual({
      ready: false,
      missing: ['repository'],
    });
  });

  it('resumes the open section for its pending Factory', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    persistOnboardingStep('model');
    persistOnboardingFactory('factory-1');

    expect(sessionStorage.getItem(ONBOARDING_FACTORY_KEY)).toBe('factory-1');
    expect(hasResumableFactoryOnboarding([{ id: 'factory-1' }])).toBe(true);
    expect(hasResumableFactoryOnboarding([{ id: 'factory-2' }])).toBe(false);
  });
});
