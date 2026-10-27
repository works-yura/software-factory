import { AlertDialog } from '@mastra/playground-ui/components/AlertDialog';
import { ButtonsGroup } from '@mastra/playground-ui/components/ButtonsGroup';
import { Spinner } from '@mastra/playground-ui/components/Spinner';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { formatModelName } from '@mastra/playground-ui/utils/model';
import { SettingsRow } from '@mastra/playground-ui/new/settings';
import type { MouseEvent } from 'react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import type { AvailableModelOption } from '../../../../hooks/useAvailableModels';
import {
  useApplyFactoryDefaultModelMutation,
  useFactoryProjectQuery,
  useSetFactoryDefaultModelMutation,
} from '../../../../hooks/useFactoryDefaultModel';

import { FactoryThinkingControl } from './FactoryThinkingControl';
import { ModelCombobox } from './ModelCombobox';
import { SharedCredentialNotice } from './SharedCredentialNotice';

function skippedReasonSummary(reasons: Array<{ reason: string }>) {
  const counts = new Map<string, number>();
  for (const { reason } of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, count]) => `${reason.replaceAll('-', ' ')} (${count})`).join(', ');
}

export function FactoryDefaultModelSection({ models }: { models: AvailableModelOption[] }) {
  const { factoryId } = useParams<{ factoryId: string }>();
  const projectQuery = useFactoryProjectQuery(factoryId);
  const setDefaultModel = useSetFactoryDefaultModelMutation(factoryId);
  const applyToSessions = useApplyFactoryDefaultModelMutation(factoryId ?? '');
  const [confirmModelId, setConfirmModelId] = useState<string>();
  const applyRequested = useRef(false);
  const { t } = useTranslation('settings');

  if (!factoryId) return null;

  const defaultModelId = projectQuery.data?.defaultModelId ?? '';
  const errorText = (applyToSessions.error ?? setDefaultModel.error ?? projectQuery.error)?.message;
  const applyResult = applyToSessions.data;

  const saveDefaultModel = (value: string) => {
    if (value === defaultModelId) return;
    applyToSessions.reset();
    setDefaultModel.mutate(value, { onSuccess: () => setConfirmModelId(value) });
  };

  const setDialogOpen = (open: boolean) => {
    if (!open && !applyRequested.current) setConfirmModelId(undefined);
  };

  const switchRunningSessions = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    applyRequested.current = true;
    applyToSessions.mutate(undefined, {
      onSuccess: () => setConfirmModelId(undefined),
      onSettled: () => {
        applyRequested.current = false;
      },
    });
  };

  return (
    <>
      <SettingsRow
        label={t('models.factoryDefault.label')}
        description={
          <>
            <span>
              {t('models.factoryDefault.description')}
            </span>
            {errorText && (
              <Txt as="span" variant="meta" className="text-destructive-foreground">
                {errorText}
              </Txt>
            )}
            <SharedCredentialNotice modelId={defaultModelId || undefined} />
          </>
        }
      >
        <div className="flex flex-col gap-2 sm:items-end">
          <div className="flex items-center gap-2">
            {setDefaultModel.isPending && (
              <Spinner
                size="sm"
                aria-label={t('models.factoryDefault.saving')}
                className="text-muted-foreground shrink-0"
              />
            )}
            <ButtonsGroup size="sm" aria-label={t('models.factoryDefault.label')}>
              <ModelCombobox
                models={models}
                value={defaultModelId}
                onValueChange={saveDefaultModel}
                placeholder={t('models.factoryDefault.placeholder')}
                aria-label={t('models.factoryDefault.pickerLabel')}
                variant="ghost"
                size="sm"
                disabled={projectQuery.isPending || setDefaultModel.isPending}
              />
              <FactoryThinkingControl factoryId={factoryId} />
            </ButtonsGroup>
          </div>
          {applyResult && (
            <Txt variant="meta">
              {applyResult.applied.length > 0
                ? t('models.factoryDefault.switched', { count: applyResult.applied.length })
                : t('models.factoryDefault.nothingToSwitch')}
              {applyResult.skipped.length > 0 &&
                t('models.factoryDefault.skipped', {
                  count: applyResult.skipped.length,
                  reasons: skippedReasonSummary(applyResult.skipped),
                })}
            </Txt>
          )}
        </div>
      </SettingsRow>

      <AlertDialog open={!!confirmModelId} onOpenChange={setDialogOpen}>
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {t('models.factoryDefault.confirmTitle', {
                model: confirmModelId ? formatModelName(confirmModelId) : '',
              })}
            </AlertDialog.Title>
            <AlertDialog.Description>{t('models.factoryDefault.confirmDescription')}</AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={applyToSessions.isPending}>
              {t('models.factoryDefault.keep')}
            </AlertDialog.Cancel>
            <AlertDialog.Action disabled={applyToSessions.isPending} onClick={switchRunningSessions}>
              {t('models.factoryDefault.switch')}
            </AlertDialog.Action>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog>
    </>
  );
}
