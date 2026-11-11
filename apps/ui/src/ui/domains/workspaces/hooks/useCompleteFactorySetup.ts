import { CLAUDE_CODE_INSTANCE_ID } from '@factory/harness-claude-code/models/aliases';
import { MASTRA_INSTANCE_ID } from '@factory/credentials/mastra-models';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { translator } from '../../../i18n/t';
import { useApiConfig } from '../../../../api/config';
import { isProviderConnected } from './useProviderConnection';
import { queryKeys } from '../../../../api/keys';
import { availableModelsQueryOptions } from '../../../../hooks/useAvailableModels';
import { providersQueryOptions } from '../../../../hooks/use-providers';
import { useLinkRepositoryMutation } from '../../../../hooks/useFactories';
import {
  createFactoryProject,
  fetchFactoryProject,
  renameFactoryProject,
  unlinkRepository,
  clearFactoryModelDefault,
  createFactoryWithClaudeModel,
  setFactoryModelDefault,
  updateFactoryHarness,
} from '../services/github';
import {
  clearOnboardingFlow,
  completeOnboardingSchema,
  persistOnboardingFactory,
  persistOnboardingLinkedRepositories,
  readOnboardingFactory,
  readOnboardingLinkedRepositories,
} from '../services/onboardingFlow';
import type { OnboardingDraft } from '../services/onboardingFlow';

const tk = translator('workspaces');

async function findPendingFactory(baseUrl: string, pendingId: string) {
  try {
    return await fetchFactoryProject(baseUrl, pendingId);
  } catch (error) {
    if (error instanceof Error && 'status' in error && (error.status === 404 || error.status === 403)) return undefined;
    throw error;
  }
}

export function useCompleteFactorySetup({ local }: { local: boolean }) {
  const { baseUrl, client } = useApiConfig();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const link = useLinkRepositoryMutation();
  return useMutation({
    mutationFn: async (draft: OnboardingDraft) => {
      const parsed = completeOnboardingSchema.safeParse(draft);
      if (!parsed.success) throw new Error(tk('setup.incomplete'));
      const setup = parsed.data;
      const repo = setup.repository;
      // Claude Code signs in on its own (local login or the organization's Claude Code accounts): no provider to check.
      const claude = setup.harness === 'claude-code' ? { claudeCodeModel: setup.claudeCodeModel } : undefined;
      const choice = setup.harness === 'claude-code' ? undefined : setup.model;
      if (choice) {
        const [providers, catalog] = await Promise.all([
          queryClient.fetchQuery({ ...providersQueryOptions(client), staleTime: 0 }),
          queryClient.fetchQuery({ ...availableModelsQueryOptions(baseUrl), staleTime: 0 }),
        ]);
        if (!catalog.models.some(model => model.id === choice.modelId && model.provider === choice.providerId)) {
          throw new Error(tk('setup.modelUnavailableCompany', { model: choice.modelId }));
        }
        const provider = providers.providers.find(item => item.provider === choice.providerId);
        if (!provider || !isProviderConnected(provider, local ? undefined : 'org', choice.method)) {
          throw new Error(tk('setup.connectionChangedCompany'));
        }
      }

      const pendingId = readOnboardingFactory();
      const existing = pendingId ? await findPendingFactory(baseUrl, pendingId) : undefined;
      const factory =
        existing ??
        (claude
          ? await createFactoryWithClaudeModel(baseUrl, { name: repo.name, harness: 'claude-code', claudeCodeModel: claude.claudeCodeModel })
          : await createFactoryProject(baseUrl, repo.name));
      // Linking refetches the Factory list; the marker keeps the root guard from leaving onboarding.
      persistOnboardingFactory(factory.id);
      if (existing && existing.name !== repo.name) await renameFactoryProject(baseUrl, factory.id, repo.name);
      const previouslyLinked = existing ? readOnboardingLinkedRepositories() : [];
      await link.mutateAsync({
        factoryProjectId: factory.id,
        repo,
        onLinked: async linked => {
          const onboardingLinks = [...new Set([...previouslyLinked, linked.projectRepositoryId])];
          // Record the new link before cleanup can fail, including across a reload and another repo choice.
          persistOnboardingLinkedRepositories(onboardingLinks);
          for (const id of onboardingLinks) {
            if (id !== linked.projectRepositoryId) await unlinkRepository(baseUrl, factory.id, id);
          }
          persistOnboardingLinkedRepositories([linked.projectRepositoryId]);
        },
      });
      if (choice) {
        // A retry may find the Factory an earlier attempt created on Claude Code.
        if (existing && existing.harness === 'claude-code') {
          await updateFactoryHarness(baseUrl, factory.id, { harness: 'mastra' });
        }
        await setFactoryModelDefault(baseUrl, factory.id, MASTRA_INSTANCE_ID, { model: choice.modelId });
      } else if (existing && claude) {
        await updateFactoryHarness(baseUrl, factory.id, { harness: 'claude-code' });
        await (claude.claudeCodeModel
          ? setFactoryModelDefault(baseUrl, factory.id, CLAUDE_CODE_INSTANCE_ID, { model: claude.claudeCodeModel })
          : clearFactoryModelDefault(baseUrl, factory.id, CLAUDE_CODE_INSTANCE_ID));
      }
      return factory.id;
    },
    onSuccess: async factoryId => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.factories() });
      clearOnboardingFlow();
      void navigate(`/factories/${factoryId}`);
    },
  });
}
