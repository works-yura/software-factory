import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../../../../api/config';
import { queryKeys } from '../../../../api/keys';
import { useCreateFactoryMutation, useLinkRepositoryMutation } from '../../../../hooks/useFactories';
import { updateFactoryDefaultModel, updateFactoryHarness } from '../services/github';
import type { ClaudeCodeModel, FactoryProjectPayload } from '../services/github';
import type { CreateFactoryDraft } from './useCreateFactoryFlow';
import { translator } from '../../../i18n/t';

const tk = translator('workspaces');

export interface CreateFactoryFromDraftOptions {
  draft?: CreateFactoryDraft;
  /** Persisted as each stage lands, so a failed attempt resumes instead of duplicating. */
  onFactoryCreated: (factory: FactoryProjectPayload) => Promise<unknown>;
  onRepositoryLinked: (linkedRepositoryId: string) => Promise<unknown>;
  onCreated: (factory: FactoryProjectPayload) => Promise<unknown>;
}

/**
 * What the last step picked: a Mastra model to save as the Factory default, or
 * for a Claude Code Factory the `claude --model` alias (null = the CLI default),
 * which is created with the Factory.
 */
export type CreateFactoryModelPick = { modelId: string } | { claudeCodeModel: ClaudeCodeModel | null };

/**
 * The wizard's single write: create the Factory, link the repository (which
 * feeds its issue intake), and save the model its runs start on. Nothing
 * before this touches the server, so an abandoned wizard leaves nothing behind.
 */
export function useCreateFactoryFromDraft({
  draft,
  onFactoryCreated,
  onRepositoryLinked,
  onCreated,
}: CreateFactoryFromDraftOptions) {
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const createFactory = useCreateFactoryMutation();
  const linkRepository = useLinkRepositoryMutation();

  return useMutation({
    mutationFn: async (pick: CreateFactoryModelPick) => {
      if (!draft?.name || !draft.repository) throw new Error(tk('createFactory.startOver'));

      const claude = 'claudeCodeModel' in pick;
      const factory = draft.factoryId
        ? { id: draft.factoryId, name: draft.name }
        : await createFactory.mutateAsync(
            claude
              ? { name: draft.name, harness: 'claude-code', claudeCodeModel: pick.claudeCodeModel }
              : { name: draft.name, harness: draft.harness ?? 'mastra' },
          );
      if (!draft.factoryId) await onFactoryCreated(factory);

      if (!draft.linkedRepositoryId) {
        const linked = await linkRepository.mutateAsync({ factoryProjectId: factory.id, repo: draft.repository });
        await onRepositoryLinked(linked.projectRepositoryId);
      }

      // A Claude Code Factory got its model on create; a retry after a failed link still sends it.
      if (claude) {
        if (draft.factoryId) await updateFactoryHarness(baseUrl, factory.id, { claudeCodeModel: pick.claudeCodeModel });
      } else {
        await updateFactoryDefaultModel(baseUrl, factory.id, pick.modelId);
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.factories() });
      await onCreated(factory);
    },
  });
}
