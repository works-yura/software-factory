import { Button } from '@mastra/playground-ui/components/Button';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Pencil } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { errorText } from '../../../../../lib/errorText';
import { useUpdateProfile } from '../../hooks/useAccount';

/** The person's name, with a pencil to edit it in place (better-auth `update-user`). */
export function EditableName({ name }: { name: string }) {
  const { t } = useTranslation('settings');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const save = useUpdateProfile();
  const trimmed = draft.trim();

  if (!editing) {
    return (
      <Button
        size="sm"
        variant="ghost"
        className="max-w-full"
        aria-label={t('account.editName')}
        onClick={() => {
          setDraft(name);
          setEditing(true);
        }}
      >
        <span data-testid="account-name" className="truncate" title={name}>
          {name}
        </span>
        <Pencil aria-hidden="true" />
      </Button>
    );
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (trimmed && trimmed !== name) save.mutate({ name: trimmed }, { onSuccess: () => setEditing(false) });
    else setEditing(false);
  };
  return (
    <form onSubmit={submit} className="flex w-full min-w-0 flex-col items-start gap-2 sm:items-end">
      <div className="flex w-full min-w-0 flex-wrap items-center justify-start gap-2 sm:justify-end">
        <Input
          size="sm"
          className="min-w-0 flex-1"
          autoFocus
          maxLength={80}
          aria-label={t('account.nameLabel')}
          value={draft}
          onChange={event => setDraft(event.target.value)}
        />
        <Button type="submit" size="sm" variant="primary" disabled={!trimmed || save.isPending}>
          {t('account.saveName')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          {t('account.cancelEdit')}
        </Button>
      </div>
      {save.isError ? (
        <Notice variant="destructive" role="alert" className="self-stretch">
          {t('account.sessions.failed', { message: errorText(save.error) })}
        </Notice>
      ) : null}
    </form>
  );
}
