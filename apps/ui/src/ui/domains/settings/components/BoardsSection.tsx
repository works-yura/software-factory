import { DEFAULT_BOARD_ID } from '@factory/core/boards/default-board';
import { AlertDialog } from '@mastra/playground-ui/components/AlertDialog';
import { Button } from '@mastra/playground-ui/components/Button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@mastra/playground-ui/components/Field';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useId, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import type { Location } from 'react-router';

import { useApiConfig } from '../../../../api/config';
import type { InstalledBoardInfo, StoredBoardInfo } from '../../../../api/types';
import { useBoardCatalog } from '../../../../hooks/useBoardCatalog';
import {
  storedBoardQueryOptions,
  useBoardQuery,
  useCreateBoardMutation,
  useDeleteBoardMutation,
  useResetBoardMutation,
  useSaveBoardMutation,
} from '../../../../hooks/useBoardEditor';
import type { BoardRequestError } from '../../../../hooks/useBoardEditor';
import { useFactorySkillsQuery } from '../../../../hooks/useFactorySkills';
import { useCanEditBoards } from '../../../../hooks/useIntakeRoutes';
import { boardPath, orderedBoards } from '../../factory/boardCatalog';
import { boardTitle } from '../../../i18n/boardLabels';
import { draftOf, keyFromName, keyProblem, keyProblemText, starterBoard } from '../services/boardDraft';
import type { BoardDraft } from '../services/boardDraft';
import { settingsSectionPath } from '../settingsSections';
import { BoardDefinitionFields, draftIsComplete, useRuleProblems } from './BoardDefinitionFields';
import { SettingsSubsection } from './SettingsSubsection';

const STARTER = '__starter__';

function errorText(error: BoardRequestError): string {
  return error.conflicts.length > 0 ? error.conflicts.join('\n') : error.message;
}

function useSkillNames(factoryId: string): string[] {
  return (useFactorySkillsQuery(factoryId).data?.skills ?? []).map(skill => skill.name);
}

/** How cards get to a board other than Work: Factory files them by the project's intake routes. */
function IntakeNote({ factoryId }: { factoryId: string }) {
  const { t } = useTranslation('settings');
  return (
    <Notice variant="info">
      {/* One element: the notice stacks its children. */}
      <span>
        <Trans
          t={t}
          i18nKey="boards.intakeNote"
          components={{ intake: <Link to={settingsSectionPath(factoryId, 'intake')} className="underline" /> }}
        />
      </span>
    </Notice>
  );
}

function StaleNotice({ onReload }: { onReload: () => void }) {
  const { t } = useTranslation('settings');
  return (
    <Notice
      variant="warning"
      title={t('workBoard.staleTitle')}
      action={
        <Button size="sm" onClick={onReload}>
          {t('workBoard.reload')}
        </Button>
      }
    >
      {t('workBoard.staleDescription')}
    </Notice>
  );
}

function BoardEditor({
  factoryId,
  board,
  canEdit,
  onReload,
  onDeleted,
}: {
  factoryId: string;
  board: StoredBoardInfo;
  canEdit: boolean;
  onReload: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation('settings');
  const [draft, setDraft] = useState<BoardDraft>(() => draftOf(board));
  const rules = useRuleProblems();
  const save = useSaveBoardMutation(factoryId, board.key);
  const reset = useResetBoardMutation(factoryId, board.key);
  const remove = useDeleteBoardMutation(factoryId, board.key, onDeleted);
  const skills = useSkillNames(factoryId);
  const readOnly = !canEdit || !board.editable;
  const changed = JSON.stringify(draft) !== JSON.stringify(draftOf(board));
  const error = save.error ?? reset.error ?? remove.error;
  const stale = error?.code === 'revision_mismatch';
  const pending = save.isPending || reset.isPending || remove.isPending;
  // Only the read-only Review board has no revision, and it can't be saved, reset or deleted.
  const revision = board.revision ?? 0;
  const clearErrors = () => {
    save.reset();
    reset.reset();
    remove.reset();
  };

  return (
    <div className="flex flex-col gap-4">
      {readOnly && (
        <Notice variant="info">
          {board.editable ? t('workBoard.adminsOnly') : t('workBoard.readOnly')}
        </Notice>
      )}
      {board.problems.map(problem => (
        <Notice key={problem} variant="warning">
          {problem}
        </Notice>
      ))}
      {board.key !== DEFAULT_BOARD_ID && <IntakeNote factoryId={factoryId} />}
      <BoardDefinitionFields
        boardKey={board.key}
        draft={draft}
        codeBehaviour={board.codeBehaviour}
        skills={skills}
        disabled={readOnly || pending}
        onChange={setDraft}
        onRuleProblem={rules.report}
      >
        <div className="flex flex-col gap-1 pt-6">
          <Txt as="span" font="mono" variant="caption" tone="muted">
            {board.key}
          </Txt>
          <Txt as="span" variant="caption" tone="muted" className="tabular-nums">
            {t('workBoard.revision', { revision: board.revision })}
          </Txt>
        </div>
      </BoardDefinitionFields>
      {stale && <StaleNotice onReload={onReload} />}
      {error && !stale && (
        // v4's Notice does not pass `role` through, so the alert wraps it.
        <div role="alert">
          <Notice variant="destructive" title={remove.error ? t('boards.notDeleted') : t('workBoard.notSaved')}>
            <span className="whitespace-pre-wrap">{errorText(error)}</span>
          </Notice>
        </div>
      )}
      {!readOnly && (
        <div className="flex flex-wrap justify-end gap-2">
          {board.source !== 'builtin' && (
            <AlertDialog>
              <AlertDialog.Trigger
                render={
                  <Button variant="destructive-ghost" disabled={pending}>
                    {t('boards.delete')}
                  </Button>
                }
              />
              <AlertDialog.Content>
                <AlertDialog.Header>
                  <AlertDialog.Title>{t('boards.deleteTitle', { name: board.name })}</AlertDialog.Title>
                  <AlertDialog.Description>{t('boards.deleteDescription')}</AlertDialog.Description>
                </AlertDialog.Header>
                <AlertDialog.Footer>
                  <AlertDialog.Cancel>{t('boards.cancel')}</AlertDialog.Cancel>
                  <AlertDialog.Action
                    onClick={() => {
                      clearErrors();
                      remove.mutate(revision);
                    }}
                  >
                    {t('boards.delete')}
                  </AlertDialog.Action>
                </AlertDialog.Footer>
              </AlertDialog.Content>
            </AlertDialog>
          )}
          {board.source !== 'stored' && (
            <Button
              disabled={pending}
              onClick={() => {
                clearErrors();
                reset.mutate(revision);
              }}
            >
              {t('workBoard.reset')}
            </Button>
          )}
          <Button
            variant="primary"
            disabled={!changed || rules.blocked || pending || !draftIsComplete(draft)}
            onClick={() => {
              clearErrors();
              save.mutate({ ...draft, name: draft.name.trim(), expectedRevision: revision });
            }}
          >
            {t('workBoard.save')}
          </Button>
        </div>
      )}
    </div>
  );
}

function NewBoardForm({
  factoryId,
  boards,
  onCancel,
}: {
  factoryId: string;
  boards: InstalledBoardInfo[];
  onCancel: () => void;
}) {
  const { t } = useTranslation('settings');
  const [draft, setDraft] = useState<BoardDraft>(starterBoard);
  const [typedKey, setTypedKey] = useState<string | undefined>(undefined);
  const [source, setSource] = useState(STARTER);
  const [copyError, setCopyError] = useState<string | undefined>(undefined);
  const [copying, setCopying] = useState(false);
  const rules = useRuleProblems();
  const create = useCreateBoardMutation(factoryId);
  const skills = useSkillNames(factoryId);
  const { baseUrl } = useApiConfig();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const id = useId();

  // The key follows the name until it is typed by hand.
  const key = typedKey ?? keyFromName(draft.name);
  const untouched = typedKey === undefined && draft.name.trim() === '';
  // A create the server answers with a conflict is about the key, whatever holds it: shown on the key field.
  const refusedKey = create.error?.status === 409 ? create.error.message : undefined;
  const invalidKeyCode = untouched
    ? undefined
    : keyProblem(
        key,
        boards.map(board => board.id),
      );
  const invalidKey = invalidKeyCode && keyProblemText(t, invalidKeyCode);
  const keyError = invalidKey ?? refusedKey;
  const pending = create.isPending || copying;
  const sourceName = (value: string) => {
    const board = boards.find(candidate => candidate.id === value);
    return board ? t('boards.copyOf', { name: boardTitle(board.id, board.title) }) : t('boards.starter');
  };

  const startFrom = async (value: string) => {
    setSource(value);
    setCopyError(undefined);
    rules.clear();
    if (value === STARTER) {
      setDraft(current => ({ ...starterBoard(), name: current.name }));
      return;
    }
    setCopying(true);
    try {
      const { board } = await queryClient.fetchQuery(storedBoardQueryOptions(baseUrl, factoryId, value));
      setDraft(current => ({ ...draftOf(board), name: current.name }));
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      setCopyError(error.message);
    } finally {
      setCopying(false);
    }
  };

  return (
    // Not a form: the phase editor's own buttons would submit it.
    <section className="flex flex-col gap-4" aria-label={t('boards.newBoard')}>
      <Field>
        <FieldLabel htmlFor={`${id}-source`}>{t('boards.startFrom')}</FieldLabel>
        <Select value={source} disabled={pending} onValueChange={value => void startFrom(String(value))}>
          <SelectTrigger id={`${id}-source`} size="sm" aria-label={t('boards.startFrom')}>
            {sourceName(source)}
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={STARTER}>{sourceName(STARTER)}</SelectItem>
            {boards.map(board => (
              <SelectItem key={board.id} value={board.id}>
                {sourceName(board.id)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>{t('boards.startFromHint')}</FieldDescription>
      </Field>
      {copyError && (
        <div role="alert">
          <Notice variant="destructive" title={t('boards.notCopied')}>
            {copyError}
          </Notice>
        </div>
      )}
      <BoardDefinitionFields
        draft={draft}
        skills={skills}
        disabled={pending}
        onChange={update => {
          if (create.error) create.reset();
          setDraft(update);
        }}
        onRuleProblem={rules.report}
      >
        <Field className="min-w-60 flex-1" invalid={keyError !== undefined}>
          <FieldLabel htmlFor={`${id}-key`}>{t('boards.key')}</FieldLabel>
          <Input
            id={`${id}-key`}
            value={key}
            disabled={pending}
            onChange={event => {
              if (create.error) create.reset();
              setTypedKey(event.target.value);
            }}
          />
          {keyError ? (
            <FieldError>{keyError}</FieldError>
          ) : (
            <FieldDescription>{t('boards.keyHint')}</FieldDescription>
          )}
        </Field>
      </BoardDefinitionFields>
      <IntakeNote factoryId={factoryId} />
      {create.error && !refusedKey && (
        <div role="alert">
          <Notice variant="destructive" title={t('boards.notCreated')}>
            <span className="whitespace-pre-wrap">{errorText(create.error)}</span>
          </Notice>
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button disabled={create.isPending} onClick={onCancel}>
          {t('boards.cancel')}
        </Button>
        <Button
          variant="primary"
          disabled={pending || rules.blocked || !draftIsComplete(draft) || untouched || invalidKey !== undefined}
          onClick={() =>
            create.mutate(
              { ...draft, key, name: draft.name.trim() },
              { onSuccess: ({ board }) => void navigate(boardPath(factoryId, board.key)) },
            )
          }
        >
          {t('boards.create')}
        </Button>
      </div>
    </section>
  );
}

/**
 * The project's boards as stored. Organization admins create a board, edit any of them — its name,
 * description and phases — delete the ones the project or the app added, and reset the built-in
 * and app boards to their code definition. Everyone else sees them read-only.
 */
export function BoardsSection({ factoryId }: { factoryId?: string }) {
  const { t } = useTranslation('settings');
  const [params, setParams] = useSearchParams();
  const catalog = useBoardCatalog(factoryId);
  const boards = orderedBoards(catalog.data ?? []);
  // The Work board unless the project has none: then its first board, if it has any.
  const first = (without?: string) =>
    boards.find(board => board.id === DEFAULT_BOARD_ID && board.id !== without)?.id ??
    boards.find(board => board.id !== without)?.id;
  const picked = params.get('board');
  // A project can have no boards at all: there is none to read then.
  const none = picked === null && catalog.data?.length === 0;
  const selected = picked ?? first() ?? DEFAULT_BOARD_ID;
  const canEdit = useCanEditBoards(factoryId);
  // A link to the new-board form shows the Work board to someone who may not create one.
  const creating = canEdit && params.has('new');
  // Which board to open with is not known until the boards are.
  const waiting = creating || none || (picked === null && catalog.isPending);
  const query = useBoardQuery(waiting ? undefined : factoryId, selected);
  const data = query.data;
  const id = useId();
  const location = useLocation();
  // Closing Settings returns to the page it was opened from, which the location's state carries.
  const show = (target: { board?: string; new?: true }, state: unknown = location.state) =>
    setParams(target.new ? { new: '1' } : target.board ? { board: target.board } : {}, { replace: true, state });
  const showAfterDelete = (deleted: string) => {
    const from = (location.state as { from?: Location } | null)?.from;
    // The page Settings was opened from is gone with the board: return to a board that is left
    // instead, or to the Factory when that was its last.
    const gone = factoryId !== undefined && from?.pathname === boardPath(factoryId, deleted);
    const next = first(deleted);
    const pathname = next === undefined ? `/factories/${factoryId}` : boardPath(factoryId ?? '', next);
    show(
      next === undefined || next === DEFAULT_BOARD_ID ? {} : { board: next },
      gone ? { from: { ...from, pathname, search: '', hash: '' } } : location.state,
    );
  };

  return (
    <SettingsSubsection
      scope="factory"
      title={t('boards.title')}
      description={t('boards.description')}
      action={
        factoryId && canEdit && !creating ? (
          <Button size="sm" onClick={() => show({ new: true })}>
            <Plus />
            {t('boards.newBoard')}
          </Button>
        ) : undefined
      }
    >
      {!factoryId && <Notice variant="info">{t('workBoard.openFactory')}</Notice>}
      {factoryId && creating && <NewBoardForm factoryId={factoryId} boards={boards} onCancel={() => show({})} />}
      {factoryId && !creating && (
        <>
          {boards.length > 1 && (
            <Field>
              <FieldLabel htmlFor={`${id}-board`}>{t('boards.board')}</FieldLabel>
              <Select value={selected} onValueChange={value => show({ board: String(value) })}>
                <SelectTrigger id={`${id}-board`} size="sm" aria-label={t('boards.board')}>
                  {boardTitle(selected, boards.find(board => board.id === selected)?.title ?? selected)}
                </SelectTrigger>
                <SelectContent>
                  {boards.map(board => (
                    <SelectItem key={board.id} value={board.id}>
                      {boardTitle(board.id, board.title)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          {none && <Notice variant="info">{t('boards.none')}</Notice>}
          {!none && query.isPending && (
            <Txt tone="muted" as="p" variant="caption" role="status">
              {t('workBoard.loading')}
            </Txt>
          )}
          {query.error && <Notice variant="destructive">{query.error.message}</Notice>}
          {data && (
            <BoardEditor
              // Another board, or a new revision (saved, reset or reloaded), starts a fresh draft.
              key={`${data.board.key}:${data.board.revision ?? 'code'}`}
              factoryId={factoryId}
              board={data.board}
              canEdit={data.canEdit ?? false}
              onReload={() => void query.refetch()}
              onDeleted={() => showAfterDelete(data.board.key)}
            />
          )}
        </>
      )}
    </SettingsSubsection>
  );
}
