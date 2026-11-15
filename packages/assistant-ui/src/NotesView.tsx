import { AlertDialog } from '@mastra/playground-ui/components/AlertDialog';
import { Button } from '@mastra/playground-ui/components/Button';
import { EmptyState } from '@mastra/playground-ui/components/EmptyState';
import { Header, HeaderAction } from '@mastra/playground-ui/components/Header';
import { Kbd } from '@mastra/playground-ui/components/Kbd';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { SkeletonText } from '@mastra/playground-ui/components/Skeleton';
import { CodeEditor } from '@mastra/playground-ui/components/CodeEditor';
import { MarkdownRenderer } from '@mastra/playground-ui/components/MarkdownRenderer';
import { SegmentedControl, SegmentedControlItem } from '@mastra/playground-ui/components/SegmentedControl';
import { ThreadList, ThreadListItem, ThreadListItems } from '@mastra/playground-ui/components/ThreadList';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { ArrowLeft, Eye, Inbox, NotebookPen, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAssistantNotes, useAssistantRequests, useNoteActions } from './api';
import type { AssistantNote } from './api';
import { RequestTime, requestAge } from './time';

/** How long the editor waits after the last keystroke before it saves. */
export const NOTE_AUTOSAVE_MS = 700;

/** A note's title (its first line) and preview (what follows), as the list shows them. */
export function noteParts(text: string): { title: string; preview: string } {
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  return { title: lines[0] ?? '', preview: lines.slice(1).join(' ') };
}

function NoteRow({ note }: { note: AssistantNote }) {
  const { t, i18n } = useTranslation('assistant');
  const { title, preview } = noteParts(note.text);
  return (
    <span className="flex min-w-0 flex-col gap-0.5 py-1.5">
      <span className="flex min-w-0 items-center gap-2">
        <Txt as="span" variant="label" className="min-w-0 flex-1 truncate">
          {title || t('notes.untitled')}
        </Txt>
        <Txt as="span" variant="caption" tone="muted" className="shrink-0 tabular-nums">
          {requestAge(note.updatedAt, t, i18n.language)}
        </Txt>
      </span>
      {preview ? (
        <Txt as="span" variant="caption" tone="muted" className="truncate">
          {preview}
        </Txt>
      ) : null}
    </span>
  );
}

type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

/**
 * One note, edited in place: the text saves itself a moment after the person stops typing (and when
 * the field loses focus). A new note exists from its first save on.
 */
function NoteEditor({
  note,
  requestId,
  compact,
  onCreated,
  onDeleted,
  onBack,
  onOpenRequest,
}: {
  note: AssistantNote | undefined;
  requestId: string | null;
  compact: boolean;
  onCreated: (note: AssistantNote) => void;
  onDeleted: () => void;
  onBack: () => void;
  onOpenRequest?: (id: string) => void;
}) {
  const { t } = useTranslation('assistant');
  const actions = useNoteActions();
  const requests = useAssistantRequests();
  const [text, setText] = useState(note?.text ?? '');
  const [state, setState] = useState<SaveState>(note ? 'saved' : 'idle');
  // A stored note opens as rendered Markdown; a new one opens for writing.
  const [mode, setMode] = useState<'edit' | 'preview'>(note?.text ? 'preview' : 'edit');
  const id = useRef<string | undefined>(note?.id);
  const saved = useRef(note?.text ?? '');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const linked = note?.requestId ?? requestId;
  const linkedRequest = linked ? requests.data?.find(request => request.id === linked) : undefined;

  const save = (value: string) => {
    clearTimeout(timer.current);
    // An empty note is not one: the server refuses it, and nothing is lost by waiting for text.
    if (!value.trim() || value === saved.current) return;
    setState('saving');
    const done = {
      onSuccess: (stored: AssistantNote) => {
        saved.current = stored.text;
        if (!id.current) {
          id.current = stored.id;
          onCreated(stored);
        }
        setState('saved');
      },
      onError: () => setState('failed'),
    };
    if (id.current) actions.update.mutate({ id: id.current, text: value }, done);
    else actions.create.mutate({ text: value, requestId: linked }, done);
  };

  useEffect(() => {
    if (text === saved.current) return;
    timer.current = setTimeout(() => save(text), NOTE_AUTOSAVE_MS);
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `save` reads refs; the text is what changes
  }, [text]);

  const status =
    state === 'saving' ? t('notes.saving') : state === 'saved' ? t('notes.saved') : state === 'failed' ? t('notes.saveFailed') : '';

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="assistant-note-editor">
      <Header border={false}>
        {compact ? (
          <Button size="icon-sm" variant="ghost" aria-label={t('notes.back')} onClick={onBack}>
            <ArrowLeft />
          </Button>
        ) : null}
        <SegmentedControl<'edit' | 'preview'> size="sm" iconOnly aria-label={t('notes.mode')} value={mode} onValueChange={setMode}>
          <SegmentedControlItem value="edit" aria-label={t('notes.edit')}>
            <Pencil />
          </SegmentedControlItem>
          <SegmentedControlItem value="preview" aria-label={t('notes.preview')}>
            <Eye />
          </SegmentedControlItem>
        </SegmentedControl>
        <Txt as="span" variant="caption" tone="muted" role="status" className="truncate">
          {status}
        </Txt>
        <HeaderAction>
          {id.current ? (
            <AlertDialog>
              <AlertDialog.Trigger
                render={
                  <Button size="icon-sm" variant="ghost" aria-label={t('notes.delete')} tooltip={t('notes.delete')}>
                    <Trash2 />
                  </Button>
                }
              />
              <AlertDialog.Content>
                <AlertDialog.Header>
                  <AlertDialog.Title>{t('notes.deleteConfirmTitle')}</AlertDialog.Title>
                  <AlertDialog.Description>{t('notes.deleteConfirmDescription')}</AlertDialog.Description>
                </AlertDialog.Header>
                <AlertDialog.Footer>
                  <AlertDialog.Cancel>{t('actions.cancel')}</AlertDialog.Cancel>
                  <AlertDialog.Action onClick={() => actions.remove.mutate(id.current!, { onSuccess: onDeleted })}>
                    {t('notes.delete')}
                  </AlertDialog.Action>
                </AlertDialog.Footer>
              </AlertDialog.Content>
            </AlertDialog>
          ) : null}
        </HeaderAction>
      </Header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3">
        {linked ? (
          <span className="flex min-w-0 items-center gap-1">
            <Txt as="span" variant="caption" tone="muted" className="shrink-0">
              {t('notes.about')}
            </Txt>
            {onOpenRequest && linkedRequest ? (
              <Button variant="ghost" size="sm" className="min-w-0" onClick={() => onOpenRequest(linked)}>
                <span className="truncate">{linkedRequest.topic}</span>
              </Button>
            ) : (
              <Txt as="span" variant="caption" className="truncate">
                {linkedRequest?.topic ?? t('notes.someRequest')}
              </Txt>
            )}
          </span>
        ) : null}
        {note ? (
          <Txt as="span" variant="caption" tone="muted">
            <RequestTime value={note.updatedAt} label={t('notes.edited')} />
          </Txt>
        ) : null}
        {mode === 'edit' ? (
          // The app's Markdown editor (the skill editor's), in the body face for prose.
          <CodeEditor
            data-testid="assistant-note-input"
            aria-label={t('notes.text')}
            language="markdown"
            font="body"
            lineNumbers={false}
            showCopyButton={false}
            autoFocus={!note}
            placeholder={t('notes.placeholder')}
            className="min-h-40 flex-1"
            value={text}
            onChange={value => {
              setText(value);
              if (state !== 'saving') setState('idle');
            }}
            onBlur={() => save(text)}
          />
        ) : (
          <div
            className="border-border min-h-40 flex-1 cursor-text overflow-y-auto rounded-lg border p-3"
            data-testid="assistant-note-preview"
            onDoubleClick={() => setMode('edit')}
          >
            {text.trim() ? (
              <MarkdownRenderer>{text}</MarkdownRenderer>
            ) : (
              <Txt as="p" variant="body-sm" tone="muted">
                {t('notes.placeholder')}
              </Txt>
            )}
          </div>
        )}
        {actions.remove.isError ? <Notice variant="destructive">{actions.remove.error.message}</Notice> : null}
      </div>
    </div>
  );
}

/** Which note the editor shows: a stored one, or a new one (maybe about a request) until its first save. */
export type NoteSelection = { note: string } | { draft: string; requestId: string | null };

/**
 * The «Нотатки» tab: the person's own notes in this organization — the list (title, preview, how
 * long ago) beside the note being edited, which saves itself. «+» starts a new one; a note can be
 * about a request (started from its thread) and opens it. On a phone one view at a time.
 */
export function NotesView({
  compact = false,
  selection,
  onSelect,
  onOpenRequest,
}: {
  compact?: boolean;
  /** The note open in the editor; the panel keeps it so a thread can start a note about itself. */
  selection: NoteSelection | undefined;
  onSelect: (selection: NoteSelection | undefined) => void;
  onOpenRequest?: (id: string) => void;
}) {
  const { t } = useTranslation('assistant');
  const notes = useAssistantNotes();
  const all = notes.data ?? [];
  const startNew = () => onSelect({ draft: crypto.randomUUID(), requestId: null });
  // The editor keeps its session across the first save (a draft becoming a stored note).
  const [sessions, setSessions] = useState<Record<string, string>>({});
  const current = selection && 'note' in selection ? all.find(note => note.id === selection.note) : undefined;
  const editorKey = selection ? ('draft' in selection ? selection.draft : (sessions[selection.note] ?? selection.note)) : undefined;

  const list = (
    <div className={compact ? 'flex min-h-0 flex-1 flex-col' : 'border-border flex min-h-0 w-72 shrink-0 flex-col border-r'}>
      <Header border={false}>
        <Txt as="span" variant="label" tone="muted">
          {t('notes.title')}
        </Txt>
        <HeaderAction>
          <Button
            size="icon-sm"
            variant="primary"
            aria-label={t('notes.new')}
            tooltip={t('notes.new')}
            onClick={startNew}
          >
            <Plus />
          </Button>
        </HeaderAction>
      </Header>
      {notes.isError ? <Notice variant="destructive">{notes.error.message}</Notice> : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {notes.isPending ? (
          <div className="flex flex-col gap-3 p-3" role="status" aria-label={t('panel.loading')}>
            {[0, 1].map(row => (
              <SkeletonText key={row} className="w-full" />
            ))}
          </div>
        ) : all.length === 0 ? (
          <EmptyState
            iconSlot={<NotebookPen />}
            titleSlot={t('notes.empty')}
            descriptionSlot={t('notes.emptyDescription')}
            actionSlot={
              <Button size="sm" icon={<Plus />} onClick={startNew}>
                {t('notes.new')}
              </Button>
            }
          />
        ) : (
          <ThreadList aria-label={t('notes.title')} embedded>
            <ThreadListItems>
              {all.map(note => (
                <ThreadListItem key={note.id} className="h-auto" isActive={current?.id === note.id} onClick={() => onSelect({ note: note.id })}>
                  <NoteRow note={note} />
                </ThreadListItem>
              ))}
            </ThreadListItems>
          </ThreadList>
        )}
      </div>
    </div>
  );

  const editor = selection ? (
    'note' in selection && !current && !sessions[selection.note] ? (
      notes.isPending ? null : (
        <EmptyState variant="fill" iconSlot={<Inbox />} titleSlot={t('notes.gone')} />
      )
    ) : (
      <NoteEditor
        key={editorKey}
        note={current}
        requestId={'draft' in selection ? selection.requestId : null}
        compact={compact}
        onCreated={note => {
          if ('draft' in selection) setSessions(map => ({ ...map, [note.id]: selection.draft }));
          onSelect({ note: note.id });
        }}
        onDeleted={() => onSelect(undefined)}
        onBack={() => onSelect(undefined)}
        onOpenRequest={onOpenRequest}
      />
    )
  ) : (
    <EmptyState
      variant="fill"
      iconSlot={<NotebookPen />}
      titleSlot={t('notes.select')}
      descriptionSlot={
        <span className="flex items-center justify-center gap-1">
          <Kbd size="xs">+</Kbd>
          {t('notes.new')}
        </span>
      }
    />
  );

  if (compact) return <div className="flex min-h-0 flex-1 flex-col" data-testid="assistant-notes">{selection ? editor : list}</div>;
  return (
    <div className="flex min-h-0 flex-1" data-testid="assistant-notes">
      {list}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{editor}</div>
    </div>
  );
}
