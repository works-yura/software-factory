import { Badge } from '@mastra/playground-ui/components/Badge';
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
import { Field, FieldDescription, FieldError, FieldLabel } from '@mastra/playground-ui/components/Field';
import { FileDropZone } from '@mastra/playground-ui/components/FileDropZone';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Table } from '@mastra/playground-ui/components/Table';
import { Tab, TabContent, TabList, Tabs } from '@mastra/playground-ui/components/Tabs';
import { Textarea } from '@mastra/playground-ui/components/Textarea';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { Braces, Plus, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { SandboxEnvSaveResult, useSandboxEnvMutations } from '../../../../../hooks/useSandboxEnvs';
import type { SandboxEnv, SandboxStage } from '../../../workspaces/services/sandbox-envs';
import { parseDotenv, reviewImport } from './dotenv';
import type { DotenvEntry, DotenvParseResult, DotenvProblem, ImportReviewRow } from './dotenv';
import { readTextFile } from './readTextFile';
import { TargetsField, toAppliesTo } from './SandboxEnvTargets';
import type { Targets } from './SandboxEnvTargets';
import { StagePicker } from './SandboxStage';

const MASK = '••••••••••••';
/** Larger than any sensible .env; a file this size is refused before it is read. */
const MAX_RAW_LENGTH = 256 * 1024;

type Mode = 'form' | 'raw';
type FormRow = { id: number; key: string; value: string };
type Review = { mode: Mode; rows: ImportReviewRow[]; problems: DotenvProblem[] };

/** Form rows as entries; a blank row is no entry, a value without a name is a problem. */
function parseForm(rows: readonly FormRow[]): DotenvParseResult {
  const entries: DotenvEntry[] = [];
  const problems: DotenvProblem[] = [];
  rows.forEach((row, index) => {
    const key = row.key.trim();
    if (!key && !row.value) return;
    if (!key) problems.push({ line: index + 1, problem: 'missingName' });
    else entries.push({ key, value: row.value, line: index + 1 });
  });
  return { entries, problems };
}

/**
 * Add variables in a form or paste/drop `.env` content, then review what will
 * be saved (values masked; duplicates, refused names and overwrites flagged)
 * before anything is sent. The API saves one variable per request, so a
 * partial failure leaves the dialog open with each row's result and a retry.
 */
export function ImportSandboxEnvsDialog({
  envs,
  mutations,
  onClose,
}: {
  envs: SandboxEnv[];
  mutations: ReturnType<typeof useSandboxEnvMutations>;
  onClose: () => void;
}) {
  const id = useId();
  const { t } = useTranslation('settings');
  const [mode, setMode] = useState<Mode>('form');
  const [rows, setRows] = useState<FormRow[]>([{ id: 0, key: '', value: '' }]);
  const [nextRowId, setNextRowId] = useState(1);
  const [raw, setRaw] = useState('');
  const [fileError, setFileError] = useState<string>();
  const [targets, setTargets] = useState<Targets>({ build: false, runtime: true });
  const [stage, setStage] = useState<SandboxStage>('development');
  const [review, setReview] = useState<Review>();
  const [results, setResults] = useState<Map<string, SandboxEnvSaveResult>>(new Map());
  const [error, setError] = useState<string>();

  const appliesTo = toAppliesTo(targets);
  const parsed = mode === 'raw' ? parseDotenv(raw) : parseForm(rows);
  const hasInput = parsed.entries.length > 0 || parsed.problems.length > 0;
  const pending = mutations.setMany.isPending;

  const toSave = review?.rows.filter(row => !row.problem) ?? [];
  const failed = toSave.filter(row => results.get(row.key)?.ok === false);
  const savedCount = toSave.filter(row => results.get(row.key)?.ok).length;
  const where = (n: number) => t(review?.mode === 'raw' ? 'sandboxEnvs.import.line' : 'sandboxEnvs.import.row', { n });

  const readFile = async (file: File) => {
    setFileError(undefined);
    const read = await readTextFile(file, MAX_RAW_LENGTH);
    if (!read.ok) {
      setFileError(t(`sandboxEnvs.import.file.${read.reason}`, { name: file.name, max: MAX_RAW_LENGTH / 1024 }));
      return;
    }
    setRaw(read.text);
  };

  const openReview = () => {
    if (!hasInput || !appliesTo) return;
    setResults(new Map());
    setError(undefined);
    setReview({
      mode,
      rows: reviewImport(parsed.entries, new Set(envs.map(env => env.name))),
      problems: parsed.problems,
    });
  };

  const save = () => {
    if (!review || !appliesTo) return;
    const batch = failed.length > 0 ? failed : toSave;
    if (batch.length === 0) return;
    setError(undefined);
    mutations.setMany.mutate(
      batch.map(row => ({ name: row.key, value: row.value, appliesTo, stage })),
      {
        onSuccess: batchResults => {
          const next = new Map(results);
          for (const result of batchResults) next.set(result.name, result);
          setResults(next);
          if (toSave.every(row => next.get(row.key)?.ok)) {
            toast.success(t('sandboxEnvs.import.saved', { count: toSave.length }));
            onClose();
          }
        },
        onError: failure => setError(failure instanceof Error ? failure.message : t('sandboxEnvs.saveFailed')),
      },
    );
  };

  return (
    <Dialog open onOpenChange={open => !open && onClose()} pending={pending}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{review ? t('sandboxEnvs.import.reviewTitle') : t('sandboxEnvs.import.title')}</DialogTitle>
          <DialogDescription>
            {review
              ? t('sandboxEnvs.import.reviewDescription', {
                  count: toSave.length,
                  stage: t(`sandboxStages.stage.${stage}`),
                  targets: [targets.build && t('sandboxEnvs.build'), targets.runtime && t('sandboxEnvs.runtime')]
                    .filter(Boolean)
                    .join(' + '),
                })
              : t('sandboxEnvs.import.description')}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {!review ? (
            <>
              <Tabs<Mode> defaultTab="form" value={mode} onValueChange={setMode}>
                <TabList aria-label={t('sandboxEnvs.import.mode')} size="sm">
                  <Tab value="form">
                    <Plus aria-hidden className="size-3.5" /> {t('sandboxEnvs.import.form')}
                  </Tab>
                  <Tab value="raw">
                    <Braces aria-hidden className="size-3.5" /> {t('sandboxEnvs.import.raw')}
                  </Tab>
                </TabList>
                <TabContent value="form" className="pt-3">
                  <div className="flex flex-col gap-2">
                    {rows.map((row, index) => (
                      <div key={row.id} className="flex items-center gap-2">
                        <Input
                          aria-label={t('sandboxEnvs.name')}
                          autoComplete="off"
                          spellCheck={false}
                          className="flex-1 font-mono"
                          placeholder="OPENAI_API_KEY"
                          value={row.key}
                          onChange={event =>
                            setRows(current =>
                              current.map(item => (item.id === row.id ? { ...item, key: event.target.value } : item)),
                            )
                          }
                        />
                        <Input
                          aria-label={t('sandboxEnvs.value')}
                          autoComplete="off"
                          spellCheck={false}
                          className="flex-1 font-mono"
                          placeholder="sk-xxxxxxxx"
                          value={row.value}
                          onChange={event =>
                            setRows(current =>
                              current.map(item => (item.id === row.id ? { ...item, value: event.target.value } : item)),
                            )
                          }
                        />
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('sandboxEnvs.import.removeRow', { n: index + 1 })}
                          disabled={rows.length === 1}
                          onClick={() => setRows(current => current.filter(item => item.id !== row.id))}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    ))}
                    <div>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Plus />}
                        onClick={() => {
                          setRows(current => [...current, { id: nextRowId, key: '', value: '' }]);
                          setNextRowId(nextRowId + 1);
                        }}
                      >
                        {t('sandboxEnvs.import.addRow')}
                      </Button>
                    </div>
                  </div>
                </TabContent>
                <TabContent value="raw" className="pt-3">
                  <div className="flex flex-col gap-3">
                    <FileDropZone
                      title={t('sandboxEnvs.import.dropTitle')}
                      description={t('sandboxEnvs.import.dropDescription')}
                      buttonLabel={t('sandboxEnvs.import.chooseFile')}
                      onFiles={([file]) => file && void readFile(file)}
                    />
                    {fileError && (
                      <Txt as="p" variant="caption" className="text-destructive-foreground" role="alert">
                        {fileError}
                      </Txt>
                    )}
                    <Field>
                      <FieldLabel htmlFor={`${id}-raw`}>{t('sandboxEnvs.import.rawLabel')}</FieldLabel>
                      <Textarea
                        id={`${id}-raw`}
                        autoComplete="off"
                        spellCheck={false}
                        className="min-h-40 font-mono"
                        placeholder={'OPENAI_API_KEY=sk-xxxxxxxx\nDATABASE_URL=postgres://user:password@host:5432/db'}
                        value={raw}
                        onChange={event => setRaw(event.target.value)}
                      />
                      <FieldDescription>{t('sandboxEnvs.import.rawHelp')}</FieldDescription>
                    </Field>
                  </div>
                </TabContent>
              </Tabs>
              <TargetsField value={targets} onChange={setTargets} />
              <Field>
                <FieldLabel>{t('sandboxEnvs.import.applyTo')}</FieldLabel>
                <StagePicker value={stage} onChange={setStage} label={t('sandboxEnvs.import.applyTo')} />
                <FieldDescription>
                  {stage === 'production' ? t('sandboxStages.productionNever') : t('sandboxStages.stageHelp')}
                </FieldDescription>
              </Field>
            </>
          ) : (
            <div className="flex flex-col gap-3">
              {review.problems.length > 0 && (
                <Notice variant="warning" title={t('sandboxEnvs.import.unreadable', { count: review.problems.length })}>
                  <ul aria-label={t('sandboxEnvs.import.unreadableList')} className="list-disc pl-4">
                    {review.problems.map(problem => (
                      <li key={problem.line}>
                        {where(problem.line)}: {problem.key && <span className="font-mono">{problem.key} </span>}
                        {t(`sandboxEnvs.import.problem.${problem.problem}`)}
                      </li>
                    ))}
                  </ul>
                </Notice>
              )}
              {failed.length > 0 && (
                <Notice variant="destructive" role="alert">
                  {t('sandboxEnvs.import.partial', { saved: savedCount, total: toSave.length, failed: failed.length })}
                </Notice>
              )}
              {review.rows.length > 0 ? (
                <Table variant="inset" aria-label={t('sandboxEnvs.import.reviewTable')}>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>{t(review.mode === 'raw' ? 'sandboxEnvs.import.lineColumn' : 'sandboxEnvs.import.rowColumn')}</Table.Head>
                      <Table.Head>{t('sandboxEnvs.name')}</Table.Head>
                      <Table.Head>{t('sandboxEnvs.value')}</Table.Head>
                      <Table.Head>{t('sandboxEnvs.import.status')}</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {review.rows.map(row => (
                      <Table.Row key={row.line}>
                        <Table.Cell>
                          <Txt as="span" variant="body-sm" tone="muted">
                            {row.line}
                          </Txt>
                        </Table.Cell>
                        <Table.Cell>
                          <span className="font-mono">{row.key}</span>
                        </Table.Cell>
                        <Table.Cell>
                          <Txt as="span" variant="body-sm" tone="muted" className="font-mono">
                            {row.value ? MASK : t('sandboxEnvs.import.emptyValue')}
                          </Txt>
                        </Table.Cell>
                        <Table.Cell>
                          <span
                            className="flex flex-wrap items-center gap-1"
                            aria-label={t('sandboxEnvs.import.statusOf', { name: row.key, n: row.line })}
                          >
                            <RowStatus row={row} result={row.problem ? undefined : results.get(row.key)} mode={review.mode} />
                          </span>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              ) : (
                <Txt as="p" variant="body-sm" tone="muted">
                  {t('sandboxEnvs.import.nothing')}
                </Txt>
              )}
              {error && (
                <Txt as="p" variant="caption" className="text-destructive-foreground" role="alert">
                  {error}
                </Txt>
              )}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          {review && (
            <Button variant="ghost" disabled={pending} onClick={() => setReview(undefined)}>
              {t('sandboxEnvs.import.back')}
            </Button>
          )}
          <DialogCancel>{t('sandboxEnvs.cancel')}</DialogCancel>
          {!review ? (
            <DialogAction disabled={!hasInput || !appliesTo} onConfirm={openReview}>
              {t('sandboxEnvs.import.review')}
            </DialogAction>
          ) : (
            <DialogAction disabled={toSave.length === 0 || pending} onConfirm={save}>
              {pending
                ? t('sandboxEnvs.saving')
                : failed.length > 0
                  ? t('sandboxEnvs.import.retry', { count: failed.length })
                  : t('sandboxEnvs.import.save', { count: toSave.length })}
            </DialogAction>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RowStatus({
  row,
  result,
  mode,
}: {
  row: ImportReviewRow;
  result: SandboxEnvSaveResult | undefined;
  mode: Mode;
}) {
  const { t } = useTranslation('settings');
  if (row.problem === 'duplicate') {
    return (
      <Badge size="sm" variant="neutral">
        {t(mode === 'raw' ? 'sandboxEnvs.import.duplicateLine' : 'sandboxEnvs.import.duplicateRow', { n: row.replacedBy })}
      </Badge>
    );
  }
  if (row.problem) {
    return (
      <Badge size="sm" variant="destructive">
        {t(`sandboxEnvs.import.entryProblem.${row.problem}`)}
      </Badge>
    );
  }
  return (
    <>
      {row.overwrites ? (
        <Badge size="sm" variant="warning">
          {t('sandboxEnvs.import.overwrites')}
        </Badge>
      ) : (
        <Badge size="sm" variant="success">
          {t('sandboxEnvs.import.new')}
        </Badge>
      )}
      {result?.ok && (
        <Badge size="sm" variant="success">
          {t('sandboxEnvs.import.rowSaved')}
        </Badge>
      )}
      {result && !result.ok && (
        <Txt as="span" variant="caption" className="text-destructive-foreground">
          {t('sandboxEnvs.import.rowFailed', { error: result.error })}
        </Txt>
      )}
    </>
  );
}
