import { Button } from '@mastra/playground-ui/components/Button';
import { Card, CardContent } from '@mastra/playground-ui/components/Card';
import { EmptyState } from '@mastra/playground-ui/components/EmptyState';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { Textarea } from '@mastra/playground-ui/components/Textarea';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { NotebookPen, Trash2 } from 'lucide-react';
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
    <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4" data-testid="assistant-notes">
      <form
        className="flex flex-col gap-2"
        onSubmit={event => {
          event.preventDefault();
          if (!draft.trim()) return;
          actions.create.mutate(draft, { onSuccess: () => setDraft('') });
        }}
      >
        <Textarea aria-label={t('notes.placeholder')} placeholder={t('notes.placeholder')} rows={3} value={draft} onChange={event => setDraft(event.target.value)} />
        <Button type="submit" size="sm" variant="primary" className="self-end" disabled={!draft.trim() || actions.create.isPending}>
          {t('notes.add')}
        </Button>
      </form>
      {[actions.create, actions.remove].map((mutation, index) =>
        mutation.isError ? (
          <Notice key={index} variant="destructive">
            {mutation.error.message}
          </Notice>
        ) : null,
      )}
      {notes.isError ? <Notice variant="destructive">{notes.error.message}</Notice> : null}
      {notes.isPending ? <Skeleton className="h-16" role="status" aria-label={t('panel.loading')} /> : null}
      {notes.data?.length === 0 ? <EmptyState iconSlot={<NotebookPen />} titleSlot={t('notes.empty')} /> : null}
      <ul className="flex flex-col gap-2">
        {notes.data?.map(note => (
          <Card as="li" key={note.id} elevation="flat">
            <CardContent className="flex items-start gap-2">
              <Txt as="p" variant="body-sm" className="min-w-0 flex-1 whitespace-pre-wrap">
                {note.text}
              </Txt>
              <Button size="icon-sm" variant="ghost" aria-label={t('notes.delete')} onClick={() => actions.remove.mutate(note.id)}>
                <Trash2 />
              </Button>
            </CardContent>
          </Card>
        ))}
      </ul>
    </div>
  );
}
