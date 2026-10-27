import { Button, buttonVariants } from '@mastra/playground-ui/components/Button';
import { Link } from 'react-router';

import { settingsSectionPath } from '../../settings/settingsSections';
import { translator } from '../../../i18n/t';

const tk = translator('board');

export function BoardEmptyStateActions({
  factoryId,
  connectSource,
  onCreate,
  onClearFilters,
}: {
  factoryId: string;
  connectSource: boolean;
  onCreate?: () => void;
  onClearFilters?: () => void;
}) {
  if (onClearFilters) {
    return (
      <Button size="sm" onClick={onClearFilters}>
        {tk('emptyActions.clearFilters')}
      </Button>
    );
  }

  return (
    <>
      {onCreate && (
        <Button size="sm" onClick={onCreate}>
          {tk('emptyActions.createCard')}
        </Button>
      )}
      {connectSource && (
        <Link to={settingsSectionPath(factoryId, 'intake')} className={buttonVariants({ size: 'sm' })}>
          {tk('emptyActions.connectSource')}
        </Link>
      )}
    </>
  );
}
