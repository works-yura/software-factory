import { AlertDialog } from '@mastra/playground-ui/components/AlertDialog';
import { Button } from '@mastra/playground-ui/components/Button';
import {
  Dialog,
  DialogAction,
  DialogBody,
  DialogCancel,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@mastra/playground-ui/components/Dialog';
import { DropdownMenu } from '@mastra/playground-ui/components/DropdownMenu';
import { Field, FieldDescription, FieldError, FieldLabel } from '@mastra/playground-ui/components/Field';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { Table } from '@mastra/playground-ui/components/Table';
import { Textarea } from '@mastra/playground-ui/components/Textarea';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsRow } from '@mastra/playground-ui/new/settings';
import { Eye, MoreHorizontal, Plus } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useApiConfig } from '../../../../../api/config';
import { useSandboxEnvFileMutations, useSandboxEnvFilesQuery } from '../../../../../hooks/useSandboxEnvs';
import { revealSandboxEnvFile } from '../../../workspaces/services/sandbox-envs';
import type { SandboxEnvFile, SandboxStage } from '../../../workspaces/services/sandbox-envs';
import { StageBadge, StagePicker } from './SandboxStage';

const MASK = '••••••••••••';
const MAX_CONTENT_LENGTH = 64 * 1024;
const SEGMENT = /^[A-Za-z0-9._@+-]+$/;

type Mutations = ReturnType<typeof useSandboxEnvFileMutations>;

/**
 * The same rules the server applies (`sandboxEnvFilePathProblem`), so the
 * dialog explains a refused path before saving. The server stays the judge.
 */
export function envFilePathProblem(path: string): 'empty' | 'absolute' | 'parent' | 'segments' | 'git' | 'chars' | undefined {
  if (!path) return 'empty';
  if (path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:/.test(path)) return 'absolute';
  const segments = path.split('/');
  if (segments.includes('..')) return 'parent';
  if (segments.some(segment => segment === '' || segment === '.')) return 'segments';
  if (segments.some(segment => segment.toLowerCase() === '.git')) return 'git';
  if (path.length > 256 || !segments.every(segment => SEGMENT.test(segment))) return 'chars';
  return undefined;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/**
 * The env files of one repository: written into its checkout in every
 * sandbox (stages the Factory enables; never production) before its setup
 * command. Members see paths and stages; organization admins add, reveal,
 * edit and delete.
 */
export function RepositoryEnvFiles({
  factoryId,
  projectRepositoryId,
  repositoryName,
}: {
  factoryId: string;
  projectRepositoryId: string;
  repositoryName: string;
}) {
  const { t } = useTranslation('settings');
  const filesQuery = useSandboxEnvFilesQuery(factoryId);
  const mutations = useSandboxEnvFileMutations(factoryId);
  const [editing, setEditing] = useState<SandboxEnvFile | 'new'>();
  const [deleting, setDeleting] = useState<SandboxEnvFile>();

  const data = filesQuery.data;
  const files = (data?.files ?? []).filter(file => file.projectRepositoryId === projectRepositoryId);
  const canManage = data?.canManage ?? false;
  const writable = data?.writable ?? false;

  return (
    <>
      <SettingsRow
        label={t('envFiles.title')}
        description={
          <>
            <span>{t('envFiles.description')}</span>
            {data && !canManage && <span>{t('envFiles.adminOnly')}</span>}
          </>
        }
      >
        <Button
          size="sm"
          icon={<Plus />}
          disabled={!canManage || !writable}
          aria-label={t('envFiles.addTo', { name: repositoryName })}
          onClick={() => setEditing('new')}
        >
          {t('envFiles.add')}
        </Button>
      </SettingsRow>
      <div className="flex flex-col gap-2 px-4 pb-3">
        {filesQuery.isError && (
          <Notice variant="destructive">{errorMessage(filesQuery.error, t('envFiles.loadFailed'))}</Notice>
        )}
        {data && canManage && !writable && <Notice variant="destructive">{t('envFiles.notWritable')}</Notice>}
        {!data && !filesQuery.isError && <Skeleton className="h-8 w-full" />}
        {data && files.length === 0 && (
          <Txt as="p" variant="body-sm" tone="muted">
            {t('envFiles.empty')}
          </Txt>
        )}
        {files.length > 0 && (
          <Table variant="inset" aria-label={t('envFiles.tableOf', { name: repositoryName })}>
            <Table.Header>
              <Table.Row>
                <Table.Head>{t('envFiles.path')}</Table.Head>
                <Table.Head>{t('envFiles.content')}</Table.Head>
                <Table.Head>{t('sandboxStages.stageColumn')}</Table.Head>
                <Table.Head align="end">
                  <span className="sr-only">{t('sandboxEnvs.actions')}</span>
                </Table.Head>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {files.map(file => (
                <Table.Row key={file.id}>
                  <Table.Cell>
                    <span className="font-mono">{file.path}</span>
                  </Table.Cell>
                  <Table.Cell>
                    <Txt
                      as="span"
                      variant="body-sm"
                      tone="muted"
                      className="font-mono"
                      aria-label={t('envFiles.contentHidden', { path: file.path })}
                    >
                      {file.size === 0 ? t('envFiles.emptyFile') : MASK}
                    </Txt>
                  </Table.Cell>
                  <Table.Cell>
                    <span aria-label={t('sandboxStages.stageOf', { name: file.path })}>
                      <StageBadge stage={file.stage} />
                    </span>
                  </Table.Cell>
                  <Table.Cell align="end">
                    {canManage && (
                      <DropdownMenu>
                        <DropdownMenu.Trigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={t('sandboxEnvs.actionsOf', { name: file.path })}
                            >
                              <MoreHorizontal />
                            </Button>
                          }
                        />
                        <DropdownMenu.Content align="end">
                          <DropdownMenu.Item disabled={!writable} onClick={() => setEditing(file)}>
                            {t('sandboxEnvs.edit')}
                          </DropdownMenu.Item>
                          <DropdownMenu.Item onClick={() => setDeleting(file)}>
                            {t('sandboxEnvs.delete')}
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu>
                    )}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        )}
      </div>
      {editing && (
        <EnvFileDialog
          factoryId={factoryId}
          projectRepositoryId={projectRepositoryId}
          file={editing === 'new' ? undefined : editing}
          taken={files.map(file => file.path)}
          mutations={mutations}
          onClose={() => setEditing(undefined)}
        />
      )}
      <AlertDialog open={deleting !== undefined} onOpenChange={open => !open && setDeleting(undefined)}>
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>{t('envFiles.deleteTitle', { path: deleting?.path ?? '' })}</AlertDialog.Title>
            <AlertDialog.Description>{t('envFiles.deleteDescription')}</AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{t('sandboxEnvs.cancel')}</AlertDialog.Cancel>
            <AlertDialog.Action
              onClick={() => {
                if (!deleting) return;
                mutations.remove.mutate(deleting.id, {
                  onError: error => toast.error(errorMessage(error, t('envFiles.deleteFailed'))),
                });
              }}
            >
              {t('sandboxEnvs.delete')}
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog>
    </>
  );
}

/**
 * Add (no `file`) or edit one env file. An edit starts with the content
 * hidden: leaving it hidden keeps the stored content, Reveal loads it to view
 * or change. The content is never kept after the dialog closes.
 */
function EnvFileDialog({
  factoryId,
  projectRepositoryId,
  file,
  taken,
  mutations,
  onClose,
}: {
  factoryId: string;
  projectRepositoryId: string;
  file?: SandboxEnvFile;
  taken: string[];
  mutations: Mutations;
  onClose: () => void;
}) {
  const id = useId();
  const { t } = useTranslation('settings');
  const { baseUrl } = useApiConfig();
  const [path, setPath] = useState(file?.path ?? '');
  const [stage, setStage] = useState<SandboxStage>(file?.stage ?? 'development');
  // `undefined` while an existing file's content stays hidden (and unchanged).
  const [content, setContent] = useState<string | undefined>(file ? undefined : '');
  const [revealing, setRevealing] = useState(false);
  const [error, setError] = useState<string>();

  const trimmedPath = path.trim();
  const problem = envFilePathProblem(trimmedPath);
  const duplicate = trimmedPath !== file?.path && taken.includes(trimmedPath);
  const tooLong = (content?.length ?? 0) > MAX_CONTENT_LENGTH;
  const changed = file
    ? trimmedPath !== file.path || stage !== file.stage || content !== undefined
    : Boolean(trimmedPath);
  const pending = mutations.create.isPending || mutations.update.isPending;
  const canSave = changed && !problem && !duplicate && !tooLong && !pending;

  const reveal = async () => {
    if (!file) return;
    setRevealing(true);
    setError(undefined);
    try {
      setContent((await revealSandboxEnvFile(baseUrl, factoryId, file.id)).content);
    } catch (failure) {
      setError(errorMessage(failure, t('envFiles.revealFailed')));
    } finally {
      setRevealing(false);
    }
  };

  const save = () => {
    if (!canSave) return;
    setError(undefined);
    const callbacks = {
      onSuccess: () => {
        toast.success(t('envFiles.saved', { path: trimmedPath }));
        onClose();
      },
      onError: (failure: unknown) => setError(errorMessage(failure, t('envFiles.saveFailed'))),
    };
    if (!file) {
      mutations.create.mutate({ projectRepositoryId, path: trimmedPath, stage, content: content ?? '' }, callbacks);
      return;
    }
    mutations.update.mutate(
      {
        id: file.id,
        ...(trimmedPath !== file.path ? { path: trimmedPath } : {}),
        ...(stage !== file.stage ? { stage } : {}),
        ...(content !== undefined ? { content } : {}),
      },
      callbacks,
    );
  };

  const pathError = trimmedPath && problem ? t(`envFiles.pathProblem.${problem}`) : undefined;

  return (
    <Dialog open onOpenChange={open => !open && onClose()} pending={pending}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{file ? t('envFiles.editTitle', { path: file.path }) : t('envFiles.add')}</DialogTitle>
          <DialogDescription>{t('envFiles.dialogDescription')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field invalid={Boolean(pathError) || duplicate}>
            <FieldLabel htmlFor={`${id}-path`}>{t('envFiles.path')}</FieldLabel>
            <Input
              id={`${id}-path`}
              autoFocus={!file}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              placeholder=".env.staging"
              value={path}
              onChange={event => setPath(event.target.value)}
            />
            <FieldDescription>{t('envFiles.pathHelp')}</FieldDescription>
            {pathError && <FieldError>{pathError}</FieldError>}
            {duplicate && <FieldError>{t('envFiles.taken', { path: trimmedPath })}</FieldError>}
          </Field>
          <Field>
            <FieldLabel>{t('sandboxStages.stageColumn')}</FieldLabel>
            <StagePicker value={stage} onChange={setStage} label={t('sandboxStages.stageColumn')} />
            <FieldDescription>
              {stage === 'production' ? t('sandboxStages.productionNever') : t('sandboxStages.stageHelp')}
            </FieldDescription>
          </Field>
          <Field invalid={tooLong}>
            <FieldLabel htmlFor={`${id}-content`}>{t('envFiles.content')}</FieldLabel>
            {content === undefined ? (
              <div className="flex items-center gap-3">
                <Txt
                  as="span"
                  variant="body-sm"
                  tone="muted"
                  className="font-mono"
                  aria-label={t('envFiles.contentHidden', { path: file?.path ?? '' })}
                >
                  {MASK}
                </Txt>
                <Button size="sm" icon={<Eye />} disabled={revealing} onClick={() => void reveal()}>
                  {revealing ? t('envFiles.revealing') : t('envFiles.reveal')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setContent('')}>
                  {t('envFiles.replace')}
                </Button>
              </div>
            ) : (
              <Textarea
                id={`${id}-content`}
                autoComplete="off"
                spellCheck={false}
                className="min-h-40 font-mono"
                placeholder={'API_URL=https://staging.example.com\nAPI_KEY=…'}
                value={content}
                onChange={event => setContent(event.target.value)}
              />
            )}
            <FieldDescription>
              {file && content === undefined ? t('envFiles.keepContent') : t('envFiles.contentHelp')}
            </FieldDescription>
            {tooLong && <FieldError>{t('envFiles.tooLong')}</FieldError>}
          </Field>
          {error && (
            <Txt as="p" variant="caption" className="text-destructive-foreground" role="alert">
              {error}
            </Txt>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogCancel>{t('sandboxEnvs.cancel')}</DialogCancel>
          <DialogAction disabled={!canSave} onConfirm={save}>
            {pending ? t('sandboxEnvs.saving') : t('sandboxEnvs.save')}
          </DialogAction>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
