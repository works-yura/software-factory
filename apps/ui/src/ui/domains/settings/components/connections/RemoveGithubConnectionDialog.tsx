import { Button } from '@mastra/playground-ui/components/Button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@mastra/playground-ui/components/Dialog';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import { useGithubConnectionMutations, useGithubConnectionUsageQuery } from '../../../../../hooks/useGithubConnections';
import type { GithubConnectionUsage } from '../../../workspaces/services/github';

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Which confirm label fits: anything unlinked → «Видалити й відв'язати», only moves → «… й перенести». */
export function removalConfirmKey(usage: GithubConnectionUsage | undefined): 'confirm' | 'confirmMove' | 'confirmUnlink' {
  if (!usage || usage.repositories.length === 0) return 'confirm';
  return usage.repositories.some(repository => !repository.target) ? 'confirmUnlink' : 'confirmMove';
}

/**
 * «Видалити» for one GitHub connection (App installation or token). Before anything is deleted it
 * reads what depends on the connection and says it in plain words: the Factories it is unlinked
 * from and, per repository, whether it moves to another connection of the organization or Factory
 * stops seeing it. Confirming does exactly that (ADR-0034); nothing is lost silently.
 */
export function RemoveGithubConnectionDialog({
  id,
  name,
  onClose,
  onRemoved,
}: {
  /** Storage id of the connection. */
  id: string;
  /** How the connection is named in the title. */
  name: string;
  onClose: () => void;
  onRemoved?: () => void;
}) {
  const { t } = useTranslation('settings');
  const usage = useGithubConnectionUsageQuery(id);
  const { disconnect } = useGithubConnectionMutations();
  const data = usage.data;
  const kindLabel = (kind: 'app' | 'token') => t(`githubConnections.remove.kind.${kind}`);

  return (
    <Dialog open onOpenChange={open => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('githubConnections.remove.title', { name })}</DialogTitle>
          <DialogDescription>{t('githubConnections.remove.body')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="gap-3">
          {usage.isPending ? (
            <span className="flex items-center gap-2">
              <Spinner size="sm" aria-hidden />
              <Txt as="span" variant="caption" tone="muted">
                {t('githubConnections.remove.counting')}
              </Txt>
            </span>
          ) : usage.isError ? (
            <Notice variant="destructive" title={t('githubConnections.remove.uncounted')} role="alert">
              <Notice.Message>{errorMessage(usage.error)}</Notice.Message>
            </Notice>
          ) : !data || data.repositories.length === 0 ? (
            <Txt as="p" variant="body-sm" tone="muted">
              {t('githubConnections.remove.nothing')}
            </Txt>
          ) : (
            <>
              <Txt as="p" variant="body-sm" tone="ink">
                {t('githubConnections.remove.factories', { factories: data.factories.map(factory => factory.name).join(', ') })}
              </Txt>
              <Txt as="p" variant="caption" tone="muted">
                {t('githubConnections.remove.repositories')}
              </Txt>
              <ul className="flex flex-col gap-1.5" aria-label={t('githubConnections.remove.repositories')}>
                {data.repositories.map(repository => (
                  <li key={repository.id} className="flex min-w-0 flex-col">
                    <Txt as="span" variant="body-sm" tone="ink" className="break-all">
                      {repository.slug}
                    </Txt>
                    <Txt as="span" variant="caption" tone="muted">
                      {repository.target
                        ? t('githubConnections.remove.moves', {
                            account: repository.target.accountLogin ? `@${repository.target.accountLogin}` : t('githubConnections.unknownAccount'),
                            kind: kindLabel(repository.target.kind),
                          })
                        : t('githubConnections.remove.unlinks')}
                    </Txt>
                  </li>
                ))}
              </ul>
            </>
          )}
          {disconnect.isError && (
            <Notice variant="destructive" title={t('githubConnections.disconnectFailed')} role="alert">
              <Notice.Message>{errorMessage(disconnect.error)}</Notice.Message>
            </Notice>
          )}
        </DialogBody>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('githubConnections.cancel')}
          </Button>
          <Button
            size="sm"
            disabled={usage.isPending || usage.isError || disconnect.isPending}
            onClick={() =>
              disconnect.mutate(id, {
                onSuccess: () => {
                  onRemoved?.();
                  onClose();
                },
              })
            }
          >
            {t(`githubConnections.remove.${removalConfirmKey(data)}`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
