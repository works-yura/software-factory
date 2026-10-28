import { AlertDialog } from '@mastra/playground-ui/components/AlertDialog';
import { Button } from '@mastra/playground-ui/components/Button';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router';

import { useDeleteFactoryMutation, useFactoryQuery } from '../../../../hooks/useFactories';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';

import { SettingsSubsection } from './SettingsSubsection';

export function FactoryManagementSection() {
  const { factoryId } = useParams<{ factoryId: string }>();
  const factoryQuery = useFactoryQuery(factoryId);
  const factory = factoryQuery.data;
  const deleteMutation = useDeleteFactoryMutation();
  const { t } = useTranslation('settings');

  if (!factory) {
    return <Notice variant="info">{t('factory.selectFactory')}</Notice>;
  }

  return (
    <div className="flex flex-col gap-8">
      <SettingsSubsection
        scope="factory"
        title={t('factory.harness.title')}
        description={t('factory.harness.description')}
      >
        <SettingsContainer>
          {/* Read-only: the harness is fixed when the Factory is created. */}
          <SettingsRow label={t('factory.harness.label')} description={t('factory.harness.fixedNote')}>
            <Txt as="span" variant="body" data-testid="factory-harness">
              {factory.harness === 'claude-code' ? t('factory.harness.claudeCode') : t('factory.harness.mastra')}
            </Txt>
          </SettingsRow>
        </SettingsContainer>
      </SettingsSubsection>
      <SettingsSubsection scope="factory" title={t('factory.dangerZone')}>
        <SettingsContainer>
          <SettingsRow
            label={t('factory.deleteNamed', { name: factory.name })}
            description={t('factory.deleteDescription')}
          >
            <AlertDialog>
              <AlertDialog.Trigger
                render={
                  <Button
                    size="sm"
                    variant="destructive-ghost"
                    disabled={deleteMutation.isPending}
                    aria-label={t('factory.deleteNamed', { name: factory.name })}
                  >
                    <Trash2 size={14} />
                    {t('factory.delete')}
                  </Button>
                }
              />
              <AlertDialog.Content>
                <AlertDialog.Header>
                  <AlertDialog.Title>{t('factory.confirmTitle', { name: factory.name })}</AlertDialog.Title>
                  <AlertDialog.Description>{t('factory.confirmDescription')}</AlertDialog.Description>
                </AlertDialog.Header>
                <AlertDialog.Footer>
                  <AlertDialog.Cancel>{t('factory.cancel')}</AlertDialog.Cancel>
                  <AlertDialog.Action onClick={() => deleteMutation.mutate(factory.id)}>
                    {t('factory.delete')}
                  </AlertDialog.Action>
                </AlertDialog.Footer>
              </AlertDialog.Content>
            </AlertDialog>
          </SettingsRow>
          {deleteMutation.isError && (
            <div className="p-4">
              <Notice variant="destructive">
                {deleteMutation.error instanceof Error ? deleteMutation.error.message : t('factory.deleteFailed')}
              </Notice>
            </div>
          )}
        </SettingsContainer>
      </SettingsSubsection>
    </div>
  );
}
