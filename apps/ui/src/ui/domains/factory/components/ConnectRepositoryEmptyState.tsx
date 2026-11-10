import { buttonVariants } from '@mastra/playground-ui/components/Button';
import { EmptyState } from '@mastra/playground-ui/components/EmptyState';
import { GitBranch } from 'lucide-react';
import { Link } from 'react-router';

import { settingsSectionPath } from '../../settings/settingsSections';
import { translator } from '../../../i18n/t';

const tk = translator('board');

export function ConnectRepositoryEmptyState({ factoryId }: { factoryId: string }) {
  return (
    <EmptyState
      variant="fill"
      as="h2"
      iconSlot={<GitBranch />}
      titleSlot={tk('connectRepository.workTitle')}
      descriptionSlot={tk('connectRepository.workDescription')}
      actionSlot={
        <Link to={settingsSectionPath(factoryId, 'repositories')} className={buttonVariants({ variant: 'primary' })}>
          {tk('connectRepository.openSettings')}
        </Link>
      }
    />
  );
}
