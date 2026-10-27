import { buttonVariants } from '@mastra/playground-ui/components/Button';
import { EmptyState } from '@mastra/playground-ui/components/EmptyState';
import { GitBranch } from 'lucide-react';
import { Link } from 'react-router';

import { settingsSectionPath } from '../../settings/settingsSections';
import { translator } from '../../../i18n/t';

const tk = translator('board');

export function ConnectRepositoryEmptyState({ factoryId, review }: { factoryId: string; review: boolean }) {
  return (
    <EmptyState
      variant="fill"
      as="h2"
      iconSlot={<GitBranch />}
      titleSlot={review ? tk('connectRepository.reviewTitle') : tk('connectRepository.workTitle')}
      descriptionSlot={
        review
          ? tk('connectRepository.reviewDescription')
          : tk('connectRepository.workDescription')
      }
      actionSlot={
        <Link to={settingsSectionPath(factoryId, 'repositories')} className={buttonVariants({ variant: 'primary' })}>
          {tk('connectRepository.openSettings')}
        </Link>
      }
    />
  );
}
