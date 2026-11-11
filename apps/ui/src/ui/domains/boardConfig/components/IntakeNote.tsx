import { Notice } from '@mastra/playground-ui/components/Notice';
import { Link } from 'react-router';

import { NEW_CARD_ROUTES_ANCHOR, settingsSectionPath } from '../../settings/settingsSections';
import { translator } from '../../../i18n/t';

const tk = translator('boardConfig');

/** How cards get to a board: Factory files them by the project's intake routes. */
export function IntakeNote({ factoryId }: { factoryId: string }) {
  return (
    <Notice variant="info">
      {/* One element: the notice stacks its children. */}
      <span>
        {tk('intakeNote.before')}{' '}
        <Link to={settingsSectionPath(factoryId, 'intake', NEW_CARD_ROUTES_ANCHOR)} className="underline">
          {tk('intakeNote.link')}
        </Link>
        {tk('intakeNote.after')}
      </span>
    </Notice>
  );
}
