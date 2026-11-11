import { MASTRA_INSTANCE_ID } from '@factory/credentials/mastra-models';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../../../../api/config';
import { queryKeys } from '../../../../api/keys';
import { useCreateFactoryMutation, useLinkRepositoryMutation } from '../../../../hooks/useFactories';
import { clearFactoryModelDefault, setFactoryModelDefault } from '../services/github';
import type { FactoryProjectPayload, SourceControlRepository } from '../services/github';
import { isTurnHarness } from '../services/turnHarness';
import { repositoryKey } from './useCreateFactoryFlow';
import type { CreateFactoryDraft } from './useCreateFactoryFlow';
import { translator } from '../../../i18n/t';

const tk = translator('workspaces');

export interface CreateFactoryFromDraftOptions {
  draft?: CreateFactoryDraft;
  /** Persisted as each stage lands, so a failed attempt resumes instead of duplicating. */
  onFactoryCreated: (factory: FactoryProjectPayload) => Promise<unknown>;
  onRepositoryLinked: (repository: SourceControlRepository) => Promise<unknown>;
  onCreated: (factory: FactoryProjectPayload) => Promise<unknown>;
}

/**
 * What the last step picked: a Mastra model to save as the Factory default, or for a Factory on a
 * turn-based harness (Claude Code, Codex) that harness's model (null = its own default), which is
 * created with the Factory.
 */
export type CreateFactoryModelPick = { modelId: string } | { harnessModel: string | null };

/**
 * The wizard's single write: create the Factory, link its repositories in pick order (the first is
 * the primary one; each feeds its issue intake), and save the model its runs start on. Nothing
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
      if (!draft?.name || draft.repositories.length === 0) throw new Error(tk('createFactory.startOver'));

      const turn = 'harnessModel' in pick && isTurnHarness(draft.harness) ? { harness: draft.harness, model: pick.harnessModel } : undefined;
      const factory = draft.factoryId
        ? { id: draft.factoryId, name: draft.name }
        : await createFactory.mutateAsync(
            turn ? { name: draft.name, harness: turn.harness, model: turn.model } : { name: draft.name, harness: draft.harness ?? 'mastra' },
          );
      if (!draft.factoryId) await onFactoryCreated(factory);

      // One at a time, in pick order: link order is the environment's position order, and
      // each link rewrites the shared intake config. A retry skips what already landed.
      for (const repository of draft.repositories) {
        if (draft.linkedRepositories.includes(repositoryKey(repository))) continue;
        await linkRepository.mutateAsync({ factoryProjectId: factory.id, repo: repository });
        await onRepositoryLinked(repository);
      }

      // A turn-based harness's Factory got its model on create; a retry after a failed link still sends it.
      if (turn) {
        if (draft.factoryId) {
          await (turn.model
            ? setFactoryModelDefault(baseUrl, factory.id, turn.harness, { model: turn.model })
            : clearFactoryModelDefault(baseUrl, factory.id, turn.harness));
        }
      } else if ('modelId' in pick) {
        await setFactoryModelDefault(baseUrl, factory.id, MASTRA_INSTANCE_ID, { model: pick.modelId });
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.factories() });
      await onCreated(factory);
    },
  });
}
