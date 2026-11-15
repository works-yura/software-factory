import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { Input } from '@mastra/playground-ui/components/Input';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import {
  useGithubPatStatusQuery,
  useRemoveGithubPatMutation,
  useSaveGithubPatMutation,
} from '../../../../hooks/useGithubPat';
import type { GithubPatKind } from '../../workspaces/services/github';
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

/**
 * One token as a settings row: its name with a configured/not-set badge, what it is for, and Add,
 * Update or Remove. Adding or updating opens the field under the row, full width; Enter saves and
 * Escape cancels.
 */
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
  const close = () => {
    setEditing(false);
    setDraft('');
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = draft.trim();
    if (token) saveMutation.mutate(token, { onSuccess: close });
  };

  return (
    <SettingsRow
      label={
        <span className="flex flex-wrap items-center gap-2">
          {title}
          <Badge size="sm" variant={configured ? 'success' : 'neutral'}>
            {configured ? t('githubPat.configured') : t('credentials.notSet')}
          </Badge>
        </span>
      }
      description={description}
      controlPlacement={editing ? 'below' : 'side'}
      errorMsg={mutationError instanceof Error ? mutationError.message : undefined}
    >
      {editing ? (
        <form onSubmit={submit} className="flex min-w-0 flex-wrap items-center gap-2">
          <Input
            autoFocus
            type="password"
            size="sm"
            className="min-w-0 flex-1"
            aria-label={t('githubPat.inputLabel', { title })}
            placeholder={t('githubPat.placeholder')}
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') close();
            }}
          />
          <Button size="sm" disabled={busy} onClick={close}>
            {t('githubPat.cancel')}
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={busy || !draft.trim()}>
            {saveMutation.isPending ? t('githubPat.saving') : t('githubPat.save')}
          </Button>
        </form>
      ) : (
        <>
          <Button size="sm" disabled={busy} onClick={() => setEditing(true)}>
            {configured ? t('githubPat.updateToken') : t('githubPat.addToken')}
          </Button>
          {configured && (
            <Button size="sm" disabled={busy} onClick={() => removeMutation.mutate()}>
              {removeMutation.isPending ? t('githubPat.removing') : t('githubPat.remove')}
            </Button>
          )}
        </>
      )}
    </SettingsRow>
  );
}
