import { Button } from '@mastra/playground-ui/components/Button';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Textarea } from '@mastra/playground-ui/components/Textarea';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAssistantNotes, useNoteActions } from './api';

/** The «Нотатки» tab: what the person keeps for themself in this organization. */
export function NotesView() {
  const { t } = useTranslation('assistant');
  const notes = useAssistantNotes();
  const actions = useNoteActions();
  const [draft, setDraft] = useState('');

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4" data-testid="assistant-notes">
      <form
        className="flex flex-col gap-2"
        onSubmit={event => {
          event.preventDefault();
          if (!draft.trim()) return;
          actions.create.mutate(draft, { onSuccess: () => setDraft('') });
        }}
      >
        <Textarea aria-label={t('notes.placeholder')} placeholder={t('notes.placeholder')} rows={3} value={draft} onChange={event => setDraft(event.target.value)} />
        <div className="flex justify-end">
          <Button type="submit" size="sm" variant="primary" disabled={!draft.trim() || actions.create.isPending}>
            {t('notes.add')}
          </Button>
        </div>
      </form>
      {[actions.create, actions.remove].map((mutation, index) =>
        mutation.isError ? (
          <Notice key={index} variant="destructive">
            {mutation.error.message}
          </Notice>
        ) : null,
      )}
      {notes.isError ? <Notice variant="destructive">{notes.error.message}</Notice> : null}
      {notes.data?.length === 0 ? (
        <Txt as="p" variant="caption" tone="muted">
          {t('notes.empty')}
        </Txt>
      ) : null}
      <ul className="flex flex-col gap-2">
        {notes.data?.map(note => (
          <li key={note.id} className="border-border flex items-start gap-2 rounded-lg border p-3">
            <Txt as="p" variant="body-sm" className="min-w-0 flex-1 whitespace-pre-wrap">
              {note.text}
            </Txt>
            <Button size="icon-sm" variant="ghost" aria-label={t('notes.delete')} onClick={() => actions.remove.mutate(note.id)}>
              <Trash2 aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
