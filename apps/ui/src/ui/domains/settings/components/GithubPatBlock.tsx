import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { Input } from '@mastra/playground-ui/components/Input';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  useGithubPatStatusQuery,
  useRemoveGithubPatMutation,
  useSaveGithubPatMutation,
} from '../../../../hooks/useGithubPat';
import type { GithubPatKind } from '../../workspaces/services/github';
import { SettingsContainer } from '@mastra/playground-ui/new/settings';
import { SettingsSubsection } from './SettingsSubsection';

// GitHub App tokens cannot authorize the gh CLI endpoints; sandboxes use PATs.
export function GithubPatBlock() {
  const { t } = useTranslation('settings');
  const statusQuery = useGithubPatStatusQuery();

  return (
    <SettingsSubsection
      scope="org"
      title={t('githubPat.title')}
      description={t('githubPat.description')}
    >
      <SettingsContainer>
        <TokenRow
          kind="default"
          title={t('githubPat.worker.title')}
          description={t('githubPat.worker.description')}
          configured={statusQuery.data?.configured === true}
        />
        <TokenRow
          kind="reviewer"
          title={t('githubPat.reviewer.title')}
          description={t('githubPat.reviewer.description')}
          configured={statusQuery.data?.reviewerConfigured === true}
        />
      </SettingsContainer>
    </SettingsSubsection>
  );
}

function TokenRow({
  kind,
  title,
  description,
  configured,
}: {
  kind: GithubPatKind;
  title: string;
  description: string;
  configured: boolean;
}) {
  const { t } = useTranslation('settings');
  const saveMutation = useSaveGithubPatMutation(kind);
  const removeMutation = useRemoveGithubPatMutation(kind);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const busy = saveMutation.isPending || removeMutation.isPending;
  const mutationError = saveMutation.error ?? removeMutation.error;
  const error = mutationError instanceof Error ? mutationError.message : undefined;

  const save = async () => {
    const token = draft.trim();
    if (!token) return;
    try {
      await saveMutation.mutateAsync(token);
      setEditing(false);
      setDraft('');
    } catch {
      // Mutation error is rendered below.
    }
  };

  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between lg:gap-4">
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2">
            <Txt tone="ink" variant="body">
              {title}
            </Txt>
            <Badge size="sm" variant={configured ? 'success' : 'neutral'}>
              {configured ? t('githubPat.configured') : t('credentials.notSet')}
            </Badge>
          </div>
          <Txt tone="muted" variant="caption">
            {description}
          </Txt>
        </div>
        {!editing && (
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                setEditing(true);
                setDraft('');
              }}
            >
              {configured ? t('githubPat.updateToken') : t('githubPat.addToken')}
            </Button>
            {configured && (
              <Button size="sm" disabled={busy} onClick={() => removeMutation.mutate()}>
                {removeMutation.isPending ? t('githubPat.removing') : t('githubPat.remove')}
              </Button>
            )}
          </div>
        )}
      </div>

      {editing && (
        <div className="flex items-center gap-2">
          <Input
            autoFocus
            type="password"
            size="sm"
            aria-label={t('githubPat.inputLabel', { title })}
            placeholder={t('githubPat.placeholder')}
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') void save();
              if (event.key === 'Escape') {
                setEditing(false);
                setDraft('');
              }
            }}
          />
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setDraft('');
            }}
          >
            {t('githubPat.cancel')}
          </Button>
          <Button variant="primary" size="sm" disabled={busy || !draft.trim()} onClick={() => void save()}>
            {saveMutation.isPending ? t('githubPat.saving') : t('githubPat.save')}
          </Button>
        </div>
      )}

      {error && (
        <Txt as="p" variant="caption" className="text-destructive-foreground">
          {error}
        </Txt>
      )}
    </div>
  );
}
