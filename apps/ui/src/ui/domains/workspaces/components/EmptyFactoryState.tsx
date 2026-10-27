import { Button } from '@mastra/playground-ui/components/Button';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';
import { useFactoryAuth } from '../../../../hooks/useFactoryAuth';
import { SkeletonRows } from '../../../ui/SkeletonRows';
import { FactoryOnboarding } from './FactoryOnboarding';

export function EmptyFactoryState() {
  const { t } = useTranslation('workspaces');
  const auth = useFactoryAuth();
  if (auth.isPending) return <SkeletonRows label={t('setup.loading')} rows={3} />;
  if (auth.isError)
    return (
      <div className="p-6">
        <Txt role="alert">{t('setup.accountError')}</Txt>
        <Button onClick={() => void auth.refetch()}>{t('actions.retry')}</Button>
      </div>
    );
  return <FactoryOnboarding local={!auth.data.authEnabled} />;
}
