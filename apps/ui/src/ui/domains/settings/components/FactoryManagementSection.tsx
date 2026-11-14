import { AlertDialog } from '@mastra/playground-ui/components/AlertDialog';
import { Button, buttonVariants } from '@mastra/playground-ui/components/Button';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';

import { useDeleteFactoryMutation, useFactoryQuery } from '../../../../hooks/useFactories';
import { useHarness } from '../../../../hooks/useHarness';
import { SettingsContainer, SettingsNoticeRow, SettingsRow } from '@mastra/playground-ui/new/settings';

import { settingsSectionPath } from '../settingsSections';
import { SettingsSubsection } from './SettingsSubsection';

export function FactoryManagementSection() {
  const { factoryId } = useParams<{ factoryId: string }>();
  const factoryQuery = useFactoryQuery(factoryId);
  const factory = factoryQuery.data;
  const harness = useHarness(factory?.harness);
  const deleteMutation = useDeleteFactoryMutation();
  const { t } = useTranslation('settings');

  if (!factory) {
    return <Notice variant="info">{t('factory.selectFactory')}</Notice>;
  }

  return (
    <>
      <SettingsSubsection
        scope="factory"
        title={t('factory.harness.title')}
        description={t('factory.harness.description')}
      >
        <SettingsContainer>
          {/* The switch itself lives in Models, next to the settings of each harness; this only points there. */}
          <SettingsRow label={t('factory.harness.label')} description={t('factory.harness.changeNote')}>
            <div className="flex items-center gap-3">
              <Txt as="span" variant="body" data-testid="factory-harness">
                {harness.label}
              </Txt>
              <Link
                to={settingsSectionPath(factory.id, 'models')}
                className={buttonVariants({ variant: 'ghost', size: 'sm' })}
              >
                {t('factory.harness.openModels')}
              </Link>
            </div>
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
            <SettingsNoticeRow>
              <Notice variant="destructive">
                {deleteMutation.error instanceof Error ? deleteMutation.error.message : t('factory.deleteFailed')}
              </Notice>
            </SettingsNoticeRow>
          )}
        </SettingsContainer>
      </SettingsSubsection>
    </>
  );
}
