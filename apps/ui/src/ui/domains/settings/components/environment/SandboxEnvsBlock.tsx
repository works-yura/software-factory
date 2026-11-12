import { AlertDialog } from '@mastra/playground-ui/components/AlertDialog';
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
import { DropdownMenu } from '@mastra/playground-ui/components/DropdownMenu';
import { Field, FieldDescription, FieldLabel } from '@mastra/playground-ui/components/Field';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import { Switch } from '@mastra/playground-ui/components/Switch';
import { Table } from '@mastra/playground-ui/components/Table';
import { InfoTooltip } from '@mastra/playground-ui/components/Tooltip';
import { toast } from '@mastra/playground-ui/components/Toaster';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';
import { MoreHorizontal, Plus } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSandboxEnvMutations, useSandboxEnvsQuery } from '../../../../../hooks/useSandboxEnvs';
import { relativeTime } from '../../../../../lib/date/relativeTime';
import type { SandboxEnv, SandboxStage } from '../../../workspaces/services/sandbox-envs';
import { ImportSandboxEnvsDialog } from './ImportSandboxEnvsDialog';
import { TargetsField, toAppliesTo, toTargets } from './SandboxEnvTargets';
import type { Targets } from './SandboxEnvTargets';
import { StageBadge, StagePicker } from './SandboxStage';

const MASK = '••••••••••••';

type Mutations = ReturnType<typeof useSandboxEnvMutations>;

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** Opens the add-or-import dialog; rendered as the Environment variables subsection action. */
export function AddSandboxEnvButton({ factoryId }: { factoryId: string }) {
  const envsQuery = useSandboxEnvsQuery(factoryId);
  const mutations = useSandboxEnvMutations(factoryId);
  const [open, setOpen] = useState(false);
  const data = envsQuery.data;
  const { t } = useTranslation('settings');

  return (
    <>
      <Button size="sm" icon={<Plus />} disabled={!data?.writable} onClick={() => setOpen(true)}>
        {t('sandboxEnvs.add')}
      </Button>
      {open && data && <ImportSandboxEnvsDialog envs={data.envs} mutations={mutations} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The Factory's sandbox environment variables. Values are write-only: the
 * table lists names and where each applies; editing sets a new value without
 * showing the old one.
 */
export function SandboxEnvsBlock({ factoryId }: { factoryId: string }) {
  const envsQuery = useSandboxEnvsQuery(factoryId);
  const mutations = useSandboxEnvMutations(factoryId);
  const [editing, setEditing] = useState<SandboxEnv>();
  const [deleting, setDeleting] = useState<SandboxEnv>();
  const { t } = useTranslation('settings');

  if (envsQuery.isError) {
    return (
      <Notice variant="destructive">{errorMessage(envsQuery.error, t('sandboxEnvs.loadFailed'))}</Notice>
    );
  }
  if (!envsQuery.data) return <Skeleton className="h-16 w-full" />;

  const { envs, writable, stages, canManage } = envsQuery.data;

  return (
    <div className="flex flex-col gap-4">
      <SandboxStagesRow stages={stages} canManage={canManage} mutations={mutations} />
      {!writable && (
        <Notice variant="destructive">
          {t('sandboxEnvs.notWritable')}
        </Notice>
      )}
      {envs.length === 0 ? (
        <Txt as="p" variant="body-sm" tone="muted">
          {t('sandboxEnvs.empty')}
        </Txt>
      ) : (
        <Table variant="inset" aria-label={t('sandboxEnvs.title')}>
          <Table.Header>
            <Table.Row>
              <Table.Head>{t('sandboxEnvs.name')}</Table.Head>
              <Table.Head>{t('sandboxEnvs.value')}</Table.Head>
              <Table.Head>
                <span className="inline-flex items-center gap-1">
                  {t('sandboxEnvs.appliesTo')}
                  <InfoTooltip aria-label={t('sandboxEnvs.appliesToAbout')}>{t('sandboxEnvs.appliesToHelp')}</InfoTooltip>
                </span>
              </Table.Head>
              <Table.Head>{t('sandboxStages.stageColumn')}</Table.Head>
              <Table.Head>{t('sandboxEnvs.updated')}</Table.Head>
              <Table.Head align="end">
                <span className="sr-only">{t('sandboxEnvs.actions')}</span>
              </Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {envs.map(env => {
              const targets = toTargets(env.appliesTo);
              return (
                <Table.Row key={env.name}>
                  <Table.Cell>
                    <span className="font-mono">{env.name}</span>
                  </Table.Cell>
                  <Table.Cell>
                    <Txt
                      as="span"
                      variant="body-sm"
                      tone="muted"
                      className="font-mono"
                      aria-label={t('sandboxEnvs.valueHidden', { name: env.name })}
                    >
                      {MASK}
                    </Txt>
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex gap-1" aria-label={t('sandboxEnvs.appliesToOf', { name: env.name })}>
                      {targets.build && (
                        <Badge size="sm" variant="purple">
                          {t('sandboxEnvs.build')}
                        </Badge>
                      )}
                      {targets.runtime && (
                        <Badge size="sm" variant="cyan">
                          {t('sandboxEnvs.runtime')}
                        </Badge>
                      )}
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <span aria-label={t('sandboxStages.stageOf', { name: env.name })}>
                      <StageBadge stage={env.stage} />
                    </span>
                  </Table.Cell>
                  <Table.Cell>
                    <Txt as="span" variant="body-sm" tone="muted">
                      {relativeTime(env.updatedAt)}
                    </Txt>
                  </Table.Cell>
                  <Table.Cell align="end">
                    <DropdownMenu>
                      <DropdownMenu.Trigger
                        render={
                          <Button variant="ghost" size="icon-sm" aria-label={t('sandboxEnvs.actionsOf', { name: env.name })}>
                            <MoreHorizontal />
                          </Button>
                        }
                      />
                      <DropdownMenu.Content align="end">
                        <DropdownMenu.Item disabled={!writable} onClick={() => setEditing(env)}>
                          {t('sandboxEnvs.edit')}
                        </DropdownMenu.Item>
                        <DropdownMenu.Item onClick={() => setDeleting(env)}>{t('sandboxEnvs.delete')}</DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu>
                  </Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table>
      )}
      {editing && (
        <SandboxEnvDialog env={editing} mutations={mutations} onClose={() => setEditing(undefined)} />
      )}
      <AlertDialog open={deleting !== undefined} onOpenChange={open => !open && setDeleting(undefined)}>
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>{t('sandboxEnvs.deleteTitle', { name: deleting?.name ?? '' })}</AlertDialog.Title>
            <AlertDialog.Description>{t('sandboxEnvs.deleteDescription')}</AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{t('sandboxEnvs.cancel')}</AlertDialog.Cancel>
            <AlertDialog.Action
              onClick={() => {
                if (!deleting) return;
                mutations.remove.mutate(deleting.name, {
                  onError: error => toast.error(errorMessage(error, t('sandboxEnvs.deleteFailed'))),
                });
              }}
            >
              {t('sandboxEnvs.delete')}
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog>
    </div>
  );
}

/** Edit one variable: a new value, where it applies, or its stage. Adding goes through the import dialog. */
function SandboxEnvDialog({ env, mutations, onClose }: { env: SandboxEnv; mutations: Mutations; onClose: () => void }) {
  const id = useId();
  const { t } = useTranslation('settings');
  const [value, setValue] = useState('');
  const [targets, setTargets] = useState<Targets>(toTargets(env.appliesTo));
  const [stage, setStage] = useState<SandboxStage>(env.stage);
  const [error, setError] = useState<string>();

  const appliesTo = toAppliesTo(targets);
  const changed = Boolean(value) || appliesTo !== env.appliesTo || stage !== env.stage;
  const pending = mutations.set.isPending || mutations.updateAppliesTo.isPending;
  const canSave = changed && appliesTo !== undefined && !pending;

  const callbacks = {
    onSuccess: () => {
      toast.success(t('sandboxEnvs.saved', { name: env.name }));
      onClose();
    },
    onError: (failure: unknown) => setError(errorMessage(failure, t('sandboxEnvs.saveFailed'))),
  };

  const save = () => {
    if (!canSave || !appliesTo) return;
    setError(undefined);
    // A new value is sent with where it applies; otherwise only what changed is.
    const stageChange = stage !== env.stage ? { stage } : {};
    if (value) mutations.set.mutate({ name: env.name, value, appliesTo, ...stageChange }, callbacks);
    else {
      mutations.updateAppliesTo.mutate(
        { name: env.name, ...(appliesTo !== env.appliesTo ? { appliesTo } : {}), ...stageChange },
        callbacks,
      );
    }
  };

  return (
    <Dialog open onOpenChange={open => !open && onClose()} pending={pending}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('sandboxEnvs.editTitle', { name: env.name })}</DialogTitle>
          <DialogDescription>{t('sandboxEnvs.dialogDescription')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>{t('sandboxEnvs.name')}</FieldLabel>
            <Input id={`${id}-name`} className="font-mono" value={env.name} disabled />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-value`}>{t('sandboxEnvs.value')}</FieldLabel>
            <Input
              id={`${id}-value`}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              placeholder={t('sandboxEnvs.keepValue')}
              value={value}
              onChange={event => setValue(event.target.value)}
            />
          </Field>
          <TargetsField value={targets} onChange={setTargets} />
          <Field>
            <FieldLabel>{t('sandboxStages.stageColumn')}</FieldLabel>
            <StagePicker value={stage} onChange={setStage} label={t('sandboxStages.stageColumn')} />
            <FieldDescription>
              {stage === 'production' ? t('sandboxStages.productionNever') : t('sandboxStages.stageHelp')}
            </FieldDescription>
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

/**
 * Which stages this Factory's sandboxes get: development always, staging when
 * switched on (organization admins). Production never reaches an agent sandbox.
 */
function SandboxStagesRow({
  stages,
  canManage,
  mutations,
}: {
  stages: SandboxStage[];
  canManage: boolean;
  mutations: Mutations;
}) {
  const { t } = useTranslation('settings');
  const staging = stages.includes('staging');
  return (
    <SettingsContainer>
      <SettingsRow
        label={t('sandboxStages.stagingLabel')}
        description={
          <>
            <span>{t('sandboxStages.stagingDescription')}</span>
            <span>{t('sandboxStages.productionNever')}</span>
            {!canManage && <span>{t('sandboxStages.adminOnly')}</span>}
          </>
        }
      >
        <Switch
          aria-label={t('sandboxStages.stagingLabel')}
          checked={staging}
          disabled={!canManage || mutations.setStages.isPending}
          onCheckedChange={checked =>
            mutations.setStages.mutate(checked ? ['development', 'staging'] : ['development'], {
              onSuccess: () => toast.success(checked ? t('sandboxStages.stagingOn') : t('sandboxStages.stagingOff')),
              onError: error => toast.error(errorMessage(error, t('sandboxStages.saveFailed'))),
            })
          }
        />
      </SettingsRow>
    </SettingsContainer>
  );
}
