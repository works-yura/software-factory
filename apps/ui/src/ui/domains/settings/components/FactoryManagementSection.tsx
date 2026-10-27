import { AlertDialog } from '@mastra/playground-ui/components/AlertDialog';
import { Button } from '@mastra/playground-ui/components/Button';
import { Notice } from '@mastra/playground-ui/components/Notice';
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
  );
}
