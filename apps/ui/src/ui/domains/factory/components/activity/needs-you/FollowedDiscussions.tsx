import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import { useFactoryAttentionHistory } from '../../../../../../hooks/useFactoryAttention';
import { FOLLOWED_KINDS } from '../../../services/attention';
import { AttentionList } from './AttentionList';

export function FollowedDiscussions({ factoryId }: { factoryId: string }) {
  const { t } = useTranslation('activity');
  const followed = useFactoryAttentionHistory(factoryId, 'open', FOLLOWED_KINDS);
  if (followed.isPending) return null;

  const followsNothing =
    followed.isSuccess && !followed.hasNextPage && followed.data.pages.every(page => page.items.length === 0);
  if (followsNothing) return null;

  return (
    <section aria-labelledby="followed-discussions-heading" className="flex flex-col gap-2 pt-2">
      <Txt as="h3" variant="meta" tone="muted" id="followed-discussions-heading" className="m-0">
        {t('needsYou.followed')}
      </Txt>
      <AttentionList factoryId={factoryId} view="open" kinds={FOLLOWED_KINDS} emptySlot={null} />
    </section>
  );
}
