/**
 * Session-scoped markers for the `/onboarding` wizard (`EmptyFactoryState`).
 * The draft and step survive full-page OAuth redirects
 * (GitHub) so the flow can resume where it left off. The
 * create-Factory wizard uses separate keys (`useCreateFactoryFlow`) so
 * the two flows never collide.
 *
 * Every write also stamps `updated-at`: resumability is time-bound so a stale
 * tab (or markers written by an older version of the flow) can never trap the
 * user in onboarding once a factory exists.
 */
import { z } from 'zod';
import { CLAUDE_CODE_MODELS } from '@factory/harness-claude-code/models/aliases';
import type { SourceControlRepository } from './github';

export const ONBOARDING_REVIEW_RETURN_KEY = 'mastracode.factory-onboarding.return-to-review';
export const ONBOARDING_DRAFT_KEY = 'mastracode.factory-onboarding.draft';
export const ONBOARDING_STEP_KEY = 'mastracode.factory-onboarding.step';
export const ONBOARDING_FACTORY_KEY = 'mastracode.factory-onboarding.factory-id';
export const ONBOARDING_LINKED_REPOSITORY_KEY = 'mastracode.factory-onboarding.linked-repository-id';
export const ONBOARDING_UPDATED_AT_KEY = 'mastracode.factory-onboarding.updated-at';

/**
 * How long a mid-flow marker stays resumable after the flow last progressed.
 * Generous for an OAuth consent screen (seconds to minutes), far too short
 * for an abandoned tab rediscovered hours later.
 */
export const ONBOARDING_RESUME_WINDOW_MS = 30 * 60 * 1000;

/** `harness` is only walked when the server runs Claude Code or Codex (`features.claudeCode`, `features.codex`). */
export const ONBOARDING_STEPS = [
  'initial',
  'vcs',
  'harness',
  'model-provider',
  'review',
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

function isOnboardingStep(value: string | null): value is OnboardingStep {
  return ONBOARDING_STEPS.some(step => step === value);
}

const repositoryFields = {
  fullName: z.string(),
  name: z.string(),
  owner: z.string(),
  defaultBranch: z.string(),
  private: z.boolean(),
  sandboxProvider: z.string(),
  sandboxWorkdir: z.string(),
};
const repositorySchema: z.ZodType<SourceControlRepository> = z.union([
  z.object({ ...repositoryFields, id: z.number(), installationId: z.number(), installationStorageId: z.string() }),
  z.object({
    ...repositoryFields,
    provider: z.literal('gitlab'),
    id: z.string(),
    externalId: z.string(),
    installationStorageId: z.string().optional(),
  }),
]);
const connectionSchema = z.object({ providerId: z.string(), method: z.enum(['api_key', 'oauth']) });
const modelChoiceSchema = connectionSchema.extend({ modelId: z.string().min(1) });
/** A turn-based harness's model: a Claude alias or a Codex catalog slug; null = the harness's own default. */
const harnessModelSchema = z.string().min(1).nullable();
const draftSchema = z.preprocess(
  // Drafts saved before Codex named the Claude model `claudeCodeModel`.
  value =>
    value && typeof value === 'object' && 'claudeCodeModel' in value && !('harnessModel' in value)
      ? { ...(value as Record<string, unknown>), harnessModel: (value as { claudeCodeModel: unknown }).claudeCodeModel }
      : value,
  z.object({
    repository: repositorySchema.optional(),
    /** Absent = Mastra (no harness step on servers without Claude Code or Codex). */
    harness: z.string().min(1).optional(),
    model: connectionSchema.extend({ modelId: z.string() }).optional(),
    /** The model of a Claude Code or Codex Factory; null = the harness's default, absent = not picked yet. */
    harnessModel: harnessModelSchema.optional(),
  }),
);

/**
 * A Factory is created with its repository and either the company account's
 * model (Mastra) or, on Claude Code or Codex, the model its sessions run.
 */
export const completeOnboardingSchema = z.union([
  z.object({ repository: repositorySchema, harness: z.literal('mastra').optional(), model: modelChoiceSchema }),
  z.object({ repository: repositorySchema, harness: z.literal('claude-code'), harnessModel: z.enum(CLAUDE_CODE_MODELS).nullable() }),
  z.object({ repository: repositorySchema, harness: z.literal('codex'), harnessModel: harnessModelSchema }),
]);

export type CompleteOnboardingSetup = z.infer<typeof completeOnboardingSchema>;

export type OnboardingDraft = z.infer<typeof draftSchema>;
export type OnboardingModelChoice = NonNullable<OnboardingDraft['model']>;

/** Only non-secret choices survive redirects. Account credentials stay on the server. */
export function readOnboardingDraft(): OnboardingDraft {
  try {
    return draftSchema.parse(JSON.parse(sessionStorage.getItem(ONBOARDING_DRAFT_KEY) ?? '{}'));
  } catch {
    return {};
  }
}

function writeOnboardingMarker(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Storage quota or a private window must never block the wizard; markers only aid resume.
  }
}

export function persistOnboardingDraft(draft: OnboardingDraft): void {
  writeOnboardingMarker(ONBOARDING_DRAFT_KEY, JSON.stringify(draftSchema.parse(draft)));
  writeOnboardingMarker(ONBOARDING_UPDATED_AT_KEY, String(Date.now()));
}

/** Persist the current step and refresh the resume window. */
export function persistOnboardingStep(step: OnboardingStep): void {
  writeOnboardingMarker(ONBOARDING_STEP_KEY, step);
  writeOnboardingMarker(ONBOARDING_UPDATED_AT_KEY, String(Date.now()));
}

/** Persist the mid-flow factory id and refresh the resume window. */
export function persistOnboardingFactory(factoryId: string): void {
  writeOnboardingMarker(ONBOARDING_FACTORY_KEY, factoryId);
  writeOnboardingMarker(ONBOARDING_UPDATED_AT_KEY, String(Date.now()));
}

export function readOnboardingFactory(): string | undefined {
  return sessionStorage.getItem(ONBOARDING_FACTORY_KEY) ?? undefined;
}

/** All links this onboarding created, including superseded links whose cleanup may need retrying. */
export function persistOnboardingLinkedRepositories(projectRepositoryIds: readonly string[]): void {
  writeOnboardingMarker(ONBOARDING_LINKED_REPOSITORY_KEY, JSON.stringify(projectRepositoryIds));
}

export function readOnboardingLinkedRepositories(): string[] {
  const value = sessionStorage.getItem(ONBOARDING_LINKED_REPOSITORY_KEY);
  if (!value) return [];
  try {
    return z.array(z.string()).parse(JSON.parse(value));
  } catch {
    return [];
  }
}

export function readOnboardingReviewReturn(): boolean {
  return sessionStorage.getItem(ONBOARDING_REVIEW_RETURN_KEY) === 'true';
}

export function persistOnboardingReviewReturn(returnToReview: boolean): void {
  if (returnToReview) writeOnboardingMarker(ONBOARDING_REVIEW_RETURN_KEY, 'true');
  else sessionStorage.removeItem(ONBOARDING_REVIEW_RETURN_KEY);
}

/** Read the persisted step, defaulting to the beginning of the flow. */
export function readOnboardingStep(): OnboardingStep {
  const value = sessionStorage.getItem(ONBOARDING_STEP_KEY);
  return isOnboardingStep(value) ? value : 'initial';
}

/** Drop every onboarding marker (flow finished or abandoned). */
export function clearOnboardingFlow(): void {
  sessionStorage.removeItem(ONBOARDING_REVIEW_RETURN_KEY);
  sessionStorage.removeItem(ONBOARDING_DRAFT_KEY);
  sessionStorage.removeItem(ONBOARDING_STEP_KEY);
  sessionStorage.removeItem(ONBOARDING_FACTORY_KEY);
  sessionStorage.removeItem(ONBOARDING_LINKED_REPOSITORY_KEY);
  sessionStorage.removeItem(ONBOARDING_UPDATED_AT_KEY);
}

/**
 * Whether an onboarding flow is mid-way with its factory already created —
 * the only case where `/onboarding` may stay open (and `/` must route back
 * into it) even though a factory exists. A failed final confirmation can leave
 * a Factory to finish configuring. GitHub OAuth callbacks land on `/`, so
 * without this check the wizard would be abandoned at the factory home.
 *
 * Three gates, all required:
 * - a step past `initial` is stored,
 * - the stored factory id exists in the server-backed list (a deleted
 *   factory never traps the user),
 * - the flow progressed within {@link ONBOARDING_RESUME_WINDOW_MS} (markers
 *   without a fresh timestamp — including ones written by older versions of
 *   the flow — are treated as abandoned).
 */
export function hasResumableFactoryOnboarding(factories: readonly { id: string }[]): boolean {
  const step = sessionStorage.getItem(ONBOARDING_STEP_KEY);
  if (!isOnboardingStep(step) || step === 'initial') return false;

  const updatedAt = Number(sessionStorage.getItem(ONBOARDING_UPDATED_AT_KEY));
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > ONBOARDING_RESUME_WINDOW_MS) return false;

  const pendingFactoryId = sessionStorage.getItem(ONBOARDING_FACTORY_KEY);
  return pendingFactoryId !== null && factories.some(factory => factory.id === pendingFactoryId);
}
