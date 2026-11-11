import { Button, buttonVariants } from '@mastra/playground-ui/components/Button';
import { Link } from 'react-router';

import { NEW_CARD_ROUTES_ANCHOR, settingsSectionPath } from '../../settings/settingsSections';
import { translator } from '../../../i18n/t';
import type { IntakeSetup } from './BoardColumnEmptyState';

const tk = translator('board');

export function BoardEmptyStateActions({
  factoryId,
  intakeSetup,
  onCreate,
  onClearFilters,
}: {
  factoryId: string;
  intakeSetup?: IntakeSetup;
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
      {intakeSetup === 'source' && (
        <Link to={settingsSectionPath(factoryId, 'intake')} className={buttonVariants({ size: 'sm' })}>
          {tk('emptyActions.connectSource')}
        </Link>
      )}
      {intakeSetup === 'route' && (
        <Link
          to={settingsSectionPath(factoryId, 'intake', NEW_CARD_ROUTES_ANCHOR)}
          className={buttonVariants({ size: 'sm' })}
        >
          {tk('emptyActions.addRoute')}
        </Link>
      )}
    </>
  );
}
