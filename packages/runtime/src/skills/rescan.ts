import type { Workspace } from '@mastra/core/workspace';

/** Skills only a review binding may load; a session's cache can predate that binding. */
export const REVIEW_ONLY_FACTORY_SKILLS = new Set([
  'factory-gitlab-rereview',
  'factory-gitlab-review',
  'factory-rereview',
  'factory-review',
  'factory-self-review',
]);

/**
 * Rescan a session's skill cache so a role gained after the cache was built
 * takes effect. v3 also registered the scan with its workspace skill resolver
 * (`workspace.ts`); that resolver moves with the Mastra harness, so this copy
 * only refreshes.
 */
export async function rescanFactorySkills(skills: NonNullable<Workspace['skills']>): Promise<void> {
  await skills.refresh();
}
