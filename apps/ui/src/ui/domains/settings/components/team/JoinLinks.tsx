import { Badge } from '@mastra/playground-ui/components/Badge';
import type { BadgeVariant } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { CopyButton } from '@mastra/playground-ui/components/CopyButton';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { Skeleton } from '@mastra/playground-ui/components/Skeleton';
import {
  SettingsContainer,
  SettingsEmptyRow,
  SettingsItem,
  SettingsItemIcon,
  SettingsListHeader,
  SettingsNoticeRow,
} from '@mastra/playground-ui/new/settings';
import { Link2, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { joinLinkUrl } from '../../../auth/services/team';
import type { JoinLink, JoinLinkStatus } from '../../../auth/services/team';
import { errorText } from '../../../../../lib/errorText';
import { useJoinLinks, useRevokeJoinLink } from '../../hooks/useJoinLinks';
import { SettingsSubsection } from '../SettingsSubsection';
import { CreateJoinLinkDialog } from './CreateJoinLinkDialog';

const STATUS_BADGE: Record<JoinLinkStatus, BadgeVariant> = {
  active: 'success',
  expired: 'neutral',
  revoked: 'neutral',
  used_up: 'neutral',
};

function JoinLinkRow({ link }: { link: JoinLink }) {
  const { t, i18n } = useTranslation('settings');
  const revoke = useRevokeJoinLink(link.organizationId, link.id);
  const details = [
    t(`organization.roles.${link.role}`),
    link.maxUses === null
      ? t('team.joinLinks.uses_unlimited', { uses: link.uses })
      : t('team.joinLinks.uses_limited', { uses: link.uses, max: link.maxUses }),
    link.expiresAt
      ? t('team.joinLinks.expiresOn', { date: new Date(link.expiresAt).toLocaleDateString(i18n.language) })
      : t('team.joinLinks.neverExpires'),
    link.allowedDomains.length > 0 ? link.allowedDomains.join(', ') : t('team.joinLinks.anyDomain'),
  ].join(' · ');

  return (
    <SettingsItem
      media={
        <SettingsItemIcon>
          <Link2 />
        </SettingsItemIcon>
      }
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate" title={link.name}>
            {link.name}
          </span>
          <Badge size="sm" variant={STATUS_BADGE[link.status]} className="shrink-0">
            {t(`team.joinLinks.status.${link.status}`)}
          </Badge>
        </span>
      }
      description={details}
      notice={
        revoke.isError ? (
          <Notice variant="destructive" role="alert">
            {t('organization.actionFailed', { message: errorText(revoke.error) })}
          </Notice>
        ) : null
      }
    >
      {link.status === 'active' ? (
        <>
          <CopyButton
            content={joinLinkUrl(link.token)}
            size="icon-sm"
            variant="ghost"
            tooltip={t('team.joinLinks.copyNamed', { name: link.name })}
          />
          <Button
            size="sm"
            variant="ghost"
            disabled={revoke.isPending}
            aria-label={t('team.joinLinks.revokeNamed', { name: link.name })}
            onClick={() => revoke.mutate()}
          >
            <X aria-hidden="true" />
            {t('team.joinLinks.revoke')}
          </Button>
        </>
      ) : null}
    </SettingsItem>
  );
}

/** Settings › Команда › Посилання для вступу: each link with its rules, copy and revoke; admins only. */
export function JoinLinks({ organizationId }: { organizationId: string }) {
  const { t } = useTranslation('settings');
  const [creating, setCreating] = useState(false);
  const links = useJoinLinks(organizationId);
  const createButton = (
    <Button size="sm" onClick={() => setCreating(true)}>
      {t('team.joinLinks.create')}
    </Button>
  );

  return (
    <SettingsSubsection scope="org" title={t('team.joinLinks.title')} description={t('team.joinLinks.description')}>
      <SettingsContainer>
        {links.isPending ? (
          <SettingsItem title={<Skeleton className="h-4 w-40" />} />
        ) : links.isError ? (
          <SettingsNoticeRow>
            <Notice variant="destructive" role="alert">
              {t('team.joinLinks.loadFailed', { message: errorText(links.error) })}
            </Notice>
          </SettingsNoticeRow>
        ) : links.data.length === 0 ? (
          <SettingsEmptyRow action={createButton}>{t('team.joinLinks.empty')}</SettingsEmptyRow>
        ) : (
          <>
            <SettingsListHeader action={createButton}>
              {t('team.joinLinks.count', { count: links.data.length })}
            </SettingsListHeader>
            {links.data.map(link => (
              <JoinLinkRow key={link.id} link={link} />
            ))}
          </>
        )}
      </SettingsContainer>
      {creating ? <CreateJoinLinkDialog organizationId={organizationId} onClose={() => setCreating(false)} /> : null}
    </SettingsSubsection>
  );
}
