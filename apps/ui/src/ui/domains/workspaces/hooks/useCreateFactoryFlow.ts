import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '../../../../api/keys';
import { isFactoryHarness, isGitLabRepository } from '../services/github';
import type { FactoryHarness, FactoryProject, FactoryProjectPayload, SourceControlRepository } from '../services/github';

// Separate sessionStorage keys from onboarding so the two flows never collide.
const STEP_KEY = 'mastracode.factory-create.step';
const NAME_KEY = 'mastracode.factory-create.name';
const HARNESS_KEY = 'mastracode.factory-create.harness';
const REPO_KEY = 'mastracode.factory-create.repository';
const FACTORY_KEY = 'mastracode.factory-create.factory-id';
const LINKED_KEY = 'mastracode.factory-create.linked-repositories';
const HOST_KEY = 'mastracode.factory-create.host-factory-id';

export const CREATE_FACTORY_STEPS = ['name', 'harness', 'vcs', 'model-provider'] as const;

export type CreateFactoryFlowStep = (typeof CREATE_FACTORY_STEPS)[number];

/**
 * The steps this deployment walks through. The harness step only appears when
 * the server runs the Claude Code harness; otherwise every Factory is Mastra.
 */
export function createFactorySteps({ harnessChoice }: { harnessChoice: boolean }): readonly CreateFactoryFlowStep[] {
  return harnessChoice ? CREATE_FACTORY_STEPS : CREATE_FACTORY_STEPS.filter(step => step !== 'harness');
}

function isResumableStep(value: string | null): value is Exclude<CreateFactoryFlowStep, 'name'> {
  return value !== null && value !== 'name' && CREATE_FACTORY_STEPS.some(step => step === value);
}

function isKnownStep(value: string | null): value is CreateFactoryFlowStep {
  return value !== null && CREATE_FACTORY_STEPS.some(step => step === value);
}

/** A stored step is only honoured while the picks it was reached through are still there. */
function canResume(step: Exclude<CreateFactoryFlowStep, 'name'>, draft: Omit<CreateFactoryDraft, 'step'>): boolean {
  if (step === 'harness' || step === 'vcs') return Boolean(draft.name);
  return Boolean(draft.name && draft.repositories.length > 0);
}

function isSourceControlRepository(value: unknown): value is SourceControlRepository {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (typeof candidate.id === 'number' || typeof candidate.id === 'string') &&
    typeof candidate.fullName === 'string' &&
    typeof candidate.defaultBranch === 'string' &&
    ((candidate.provider === undefined && typeof candidate.installationStorageId === 'string') ||
      (candidate.provider === 'gitlab' &&
        typeof candidate.externalId === 'string' &&
        typeof candidate.sandboxProvider === 'string' &&
        typeof candidate.sandboxWorkdir === 'string'))
  );
}

/** Identity of a repository across providers; a slug alone can exist on both GitHub and GitLab. */
export function repositoryKey(repository: SourceControlRepository): string {
  return `${isGitLabRepository(repository) ? 'gitlab' : 'github'}:${repository.fullName}`;
}

function readRepositories(): SourceControlRepository[] {
  const stored = sessionStorage.getItem(REPO_KEY);
  if (!stored) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    parsed = undefined;
  }
  // A draft written before the wizard took several repositories holds a single object.
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  if (candidates.length > 0 && candidates.every(isSourceControlRepository)) return candidates;

  sessionStorage.removeItem(REPO_KEY);
  return [];
}

function readLinkedRepositories(): string[] {
  const stored = sessionStorage.getItem(LINKED_KEY);
  if (!stored) return [];
  try {
    const parsed: unknown = JSON.parse(stored);
    if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) return parsed;
  } catch {
    // Fall through: an unreadable marker means nothing is known to be linked.
  }
  sessionStorage.removeItem(LINKED_KEY);
  return [];
}

/**
 * The wizard's draft. Everything the user picked lives here until the last
 * step commits it, so quitting halfway leaves no half-built Factory behind.
 * `factoryId` and `linkedRepositories` only appear once that commit starts —
 * they let a failed attempt resume instead of creating a second Factory.
 * `repositories` are in link order: the first is the Factory's primary repository.
 */
export interface CreateFactoryDraft {
  step: CreateFactoryFlowStep;
  name?: string;
  /** The runtime picked on the harness step; unset means the server default (mastra). */
  harness?: FactoryHarness;
  repositories: SourceControlRepository[];
  factoryId?: string;
  /** Keys (see `repositoryKey`) of the repositories already linked to the Factory. */
  linkedRepositories: string[];
  /** The Factory whose shell hosts the wizard, so an OAuth return comes back to it. */
  hostFactoryId?: string;
}

function readHarness(): FactoryHarness | undefined {
  const stored = sessionStorage.getItem(HARNESS_KEY);
  return isFactoryHarness(stored) ? stored : undefined;
}

function readDraft(): CreateFactoryDraft {
  const picks = {
    name: sessionStorage.getItem(NAME_KEY) ?? undefined,
    harness: readHarness(),
    repositories: readRepositories(),
    factoryId: sessionStorage.getItem(FACTORY_KEY) ?? undefined,
    linkedRepositories: readLinkedRepositories(),
    hostFactoryId: sessionStorage.getItem(HOST_KEY) ?? undefined,
  };
  const step = sessionStorage.getItem(STEP_KEY);
  // Rewinding to `name` is a legitimate step (via Back), so keep the picks
  // intact — a follow-up patchDraft merges against them. Only strip picks
  // when the stored value is unknown or its resume gate fails.
  if (isKnownStep(step) && (step === 'name' || (isResumableStep(step) && canResume(step, picks))))
    return { ...picks, step };
  return {
    step: 'name',
    name: picks.name,
    harness: picks.harness,
    repositories: [],
    linkedRepositories: [],
    hostFactoryId: picks.hostFactoryId,
  };
}

function writeDraft({
  step,
  name,
  harness,
  repositories,
  factoryId,
  linkedRepositories,
  hostFactoryId,
}: CreateFactoryDraft): void {
  sessionStorage.setItem(STEP_KEY, step);
  writeEntry(NAME_KEY, name);
  writeEntry(HARNESS_KEY, harness);
  writeEntry(REPO_KEY, repositories.length > 0 ? JSON.stringify(repositories) : undefined);
  writeEntry(FACTORY_KEY, factoryId);
  writeEntry(LINKED_KEY, linkedRepositories.length > 0 ? JSON.stringify(linkedRepositories) : undefined);
  writeEntry(HOST_KEY, hostFactoryId);
}

function writeEntry(key: string, value: string | undefined): void {
  if (value) sessionStorage.setItem(key, value);
  else sessionStorage.removeItem(key);
}

function clearDraft(): void {
  for (const key of [
    STEP_KEY,
    NAME_KEY,
    HARNESS_KEY,
    REPO_KEY,
    FACTORY_KEY,
    LINKED_KEY,
    HOST_KEY,
  ])
    sessionStorage.removeItem(key);
}

/**
 * The Factory whose wizard an OAuth callback must return to, read straight from
 * sessionStorage so `RootLanding` can redirect before any query resolves. Only
 * steps past `name` count — merely visiting the page is not a pending flow.
 */
export function pendingCreateFlowFactoryId(): string | undefined {
  if (!isResumableStep(sessionStorage.getItem(STEP_KEY))) return undefined;
  return sessionStorage.getItem(HOST_KEY) ?? undefined;
}

/**
 * State machine for the create-Factory wizard (Name → Harness → VCS → Model
 * provider; the harness step is left out when the server only runs Mastra).
 * The draft lives in sessionStorage so a full-page OAuth redirect (GitHub)
 * resumes where it left off.
 */
export function useCreateFactoryFlow() {
  const queryClient = useQueryClient();
  const patchDraft = useMutation({
    mutationFn: async (patch: Partial<CreateFactoryDraft>) => writeDraft({ ...readDraft(), ...patch }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.factoryCreateFlow() }),
  });
  const draftQuery = useQuery({
    queryKey: queryKeys.factoryCreateFlow(),
    queryFn: readDraft,
  });

  const clear = useMutation({
    mutationFn: async () => clearDraft(),
    onSuccess: () => queryClient.setQueryData(queryKeys.factoryCreateFlow(), { step: 'name', repositories: [], linkedRepositories: [] }),
  });

  const step = draftQuery.data?.step ?? 'name';

  return {
    draft: draftQuery.data,
    /**
     * Commit the name. With a harness choice it moves on to the harness step;
     * without one it drops any stale pick so the Factory is created on Mastra.
     */
    submitName: (name: string, { harnessChoice }: { harnessChoice: boolean }) =>
      patchDraft.mutateAsync(
        harnessChoice ? { step: 'harness', name } : { step: 'vcs', name, harness: undefined },
      ),
    chooseHarness: (harness: FactoryHarness) => patchDraft.mutateAsync({ step: 'vcs', harness }),
    /** Add the repository to the pick, or drop it if it is already picked. Stays on the step. */
    toggleRepository: (repository: SourceControlRepository) => {
      const current = readDraft().repositories;
      const key = repositoryKey(repository);
      return patchDraft.mutateAsync({
        repositories: current.some(item => repositoryKey(item) === key)
          ? current.filter(item => repositoryKey(item) !== key)
          : [...current, repository],
      });
    },
    /** Commit the picked repositories and move on; needs at least one. */
    confirmRepositories: () => {
      if (readDraft().repositories.length === 0) return Promise.resolve(null);
      return patchDraft.mutateAsync({ step: 'model-provider' });
    },
    /** Step backwards to the previous wizard step, preserving already-collected picks. */
    back: ({ harnessChoice }: { harnessChoice: boolean }) => {
      const steps = createFactorySteps({ harnessChoice });
      const currentIndex = steps.indexOf(step);
      if (currentIndex <= 0) return Promise.resolve(null);
      const previous = steps[currentIndex - 1];
      return previous ? patchDraft.mutateAsync({ step: previous }) : Promise.resolve(null);
    },
    /** Keep what the final commit already achieved, so a retry resumes instead of duplicating. */
    rememberFactory: (factory: FactoryProject | FactoryProjectPayload) =>
      patchDraft.mutateAsync({ factoryId: factory.id }),
    rememberLinkedRepository: (repository: SourceControlRepository) =>
      patchDraft.mutateAsync({ linkedRepositories: [...readDraft().linkedRepositories, repositoryKey(repository)] }),
    /** Re-persist the current draft, with its host, right before a full-page OAuth redirect. */
    persistBeforeRedirect: (hostFactoryId: string | undefined) => writeDraft({ ...readDraft(), hostFactoryId }),
    clear: clear.mutateAsync,
  };
}
