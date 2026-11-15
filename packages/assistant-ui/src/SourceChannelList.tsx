import { Avatar } from '@mastra/playground-ui/components/Avatar';
import { Button } from '@mastra/playground-ui/components/Button';
import { EmptyState } from '@mastra/playground-ui/components/EmptyState';
import { SearchInput } from '@mastra/playground-ui/components/SearchInput';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@mastra/playground-ui/components/Select';
import {
  SettingsContainer,
  SettingsGroup,
  SettingsItem,
  SettingsItemIcon,
  SettingsListHeader,
  SettingsTitle,
} from '@mastra/playground-ui/new/settings';
import { Folder, Hash, LayoutGrid, List, SearchX } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { ChannelMode, SourceChannel } from './sources-api';
import { CHANNEL_MODES, useSourceActions } from './sources-api';

function when(iso: string | null, never: string): string {
  return iso ? new Date(iso).toLocaleString() : never;
}

/** What the row says the chat is: a DM, a group DM, a channel — of a List, a Folder, a Space, or a plain one. */
type KindKey = 'channel' | 'dm' | 'group_dm' | 'list_channel' | 'folder_channel' | 'space_channel';

function kindKey(channel: SourceChannel): KindKey {
  if (channel.kind !== 'channel') return channel.kind;
  return channel.location ? `${channel.location.kind}_channel` : 'channel';
}

/** The location's path for the second line; the channel's own name, when it ends the path, is the title already. */
function pathOf(channel: SourceChannel): string {
  return (channel.location?.path ?? []).join(' › ');
}

/** The row's name for the mode select: `#Bugs — Clients › Syncta › Bugs`, so equal names never read alike. */
function accessibleName(channel: SourceChannel): string {
  if (channel.kind !== 'channel') return channel.name;
  const path = pathOf(channel);
  return path ? `#${channel.name} — ${path}` : `#${channel.name}`;
}

function inSidebar(channel: SourceChannel): boolean {
  return channel.inSidebar ?? true;
}

function matches(channel: SourceChannel, query: string): boolean {
  const text = [channel.name, pathOf(channel), ...(channel.members ?? []).map(member => member.name)].join(' ').toLowerCase();
  return text.includes(query);
}

function ChannelMedia({ channel }: { channel: SourceChannel }) {
  const members = channel.members ?? [];
  if (channel.kind === 'dm') {
    const person = members[0];
    return <Avatar name={person?.name ?? channel.name} src={person?.avatarUrl ?? undefined} size="md" />;
  }
  if (channel.kind === 'group_dm') {
    return (
      <Avatar.Group size="md">
        {(members.length ? members : [{ id: channel.channelId, name: channel.name, avatarUrl: null }]).slice(0, 3).map(member => (
          <Avatar key={member.id} name={member.name} src={member.avatarUrl ?? undefined} />
        ))}
      </Avatar.Group>
    );
  }
  const Icon = channel.location?.kind === 'list' ? List : channel.location?.kind === 'folder' ? Folder : channel.location?.kind === 'space' ? LayoutGrid : Hash;
  return (
    <SettingsItemIcon>
      <Icon />
    </SettingsItemIcon>
  );
}

function ModeSelect({ channel }: { channel: SourceChannel }) {
  const { t } = useTranslation('assistant');
  const actions = useSourceActions();
  return (
    <Select
      value={channel.mode}
      disabled={actions.setMode.isPending}
      onValueChange={value =>
        actions.setMode.mutate({ workspaceId: channel.workspaceId, channelId: channel.channelId, mode: value as ChannelMode })
      }
    >
      <SelectTrigger size="sm" aria-label={t('sources.modeFor', { channel: accessibleName(channel) })}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {CHANNEL_MODES.map(mode => (
          <SelectItem key={mode} value={mode}>
            {t(`sources.mode.${mode}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Why ClickUp would not describe the chat (newer servers send it): its people, its path, its followers. */
type DetailsError = { what: 'members' | 'path' | 'followers'; code: string };

function detailsErrorOf(channel: SourceChannel): DetailsError | null {
  return (channel as SourceChannel & { detailsError?: DetailsError | null }).detailsError ?? null;
}

/** The failed lookup, said on the second line instead of a silent blank. */
function useDetailsFailure(channel: SourceChannel): string | null {
  const { t } = useTranslation('assistant');
  const failure = detailsErrorOf(channel);
  if (!failure) return null;
  if (failure.what === 'members') {
    return t('sources.detailsFailed.members', { code: failure.code });
  }
  if (failure.what === 'path') {
    return t('sources.detailsFailed.path', { code: failure.code });
  }
  return t('sources.detailsFailed.followers', { code: failure.code });
}

function ChannelItem({ channel }: { channel: SourceChannel }) {
  const { t } = useTranslation('assistant');
  const path = pathOf(channel);
  const failure = useDetailsFailure(channel);
  const details = [
    t(`sources.kind.${kindKey(channel)}`),
    ...(failure ? [failure] : []),
    ...(path ? [path] : []),
    ...(channel.visibility === 'PRIVATE' ? [t('sources.private')] : []),
    ...(channel.mode !== 'ignore' ? [t('sources.lastSync', { when: when(channel.lastSyncAt, t('sources.never')) })] : []),
  ];
  return (
    <SettingsItem
      data-testid="source-channel"
      media={<ChannelMedia channel={channel} />}
      title={channel.kind === 'channel' ? `#${channel.name}` : channel.name}
      description={details.join(' · ')}
      notice={channel.lastError ? <span className="text-caption text-destructive-foreground">{channel.lastError}</span> : undefined}
    >
      <ModeSelect channel={channel} />
    </SettingsItem>
  );
}

/** «Усі DM: …» — one mode for every DM and group DM. */
function AllDmsSelect() {
  const { t } = useTranslation('assistant');
  const actions = useSourceActions();
  return (
    <Select value="" disabled={actions.setDmModes.isPending} onValueChange={value => actions.setDmModes.mutate(value as ChannelMode)}>
      <SelectTrigger size="sm" aria-label={t('sources.allDms')}>
        <SelectValue placeholder={t('sources.allDmsPlaceholder')} />
      </SelectTrigger>
      <SelectContent>
        {CHANNEL_MODES.map(mode => (
          <SelectItem key={mode} value={mode}>
            {t('sources.allDmsTo', { mode: t(`sources.mode.${mode}`) })}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ChannelGroup({
  title,
  channels,
  searching,
  action,
}: {
  title: string;
  channels: SourceChannel[];
  searching: boolean;
  action?: ReactNode;
}) {
  const { t } = useTranslation('assistant');
  const [showAll, setShowAll] = useState(false);
  // What the person's ClickUp sidebar shows comes first; the rest waits behind «Show all» (a search looks everywhere).
  const shown = searching || showAll ? channels : channels.filter(inSidebar);
  const more = channels.length - shown.length;
  if (channels.length === 0) return null;
  return (
    <SettingsGroup>
      <SettingsTitle>{title}</SettingsTitle>
      <SettingsContainer role="group" aria-label={title}>
        <SettingsListHeader action={action}>{t('sources.count', { count: shown.length })}</SettingsListHeader>
        {shown.map(channel => (
          <ChannelItem key={`${channel.workspaceId}:${channel.channelId}`} channel={channel} />
        ))}
        {more > 0 ? (
          <div>
            <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>
              {t('sources.showAll', { count: channels.length })}
            </Button>
          </div>
        ) : null}
        {showAll && !searching && channels.some(channel => !inSidebar(channel)) ? (
          <div>
            <Button size="sm" variant="ghost" onClick={() => setShowAll(false)}>
              {t('sources.showSidebar')}
            </Button>
          </div>
        ) : null}
      </SettingsContainer>
    </SettingsGroup>
  );
}

/**
 * The person's ClickUp chats as their sidebar shows them: «Особисті повідомлення» (each DM by its
 * person, a group DM by its people) and «Канали» (a location channel with its Space › Folder › List,
 * so equal names never read alike). The sidebar's chats first, the rest behind «Show all»; a search
 * looks through all of them.
 */
export function SourceChannelList({ channels }: { channels: SourceChannel[] }) {
  const { t } = useTranslation('assistant');
  const actions = useSourceActions();
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const { dms, rooms } = useMemo(() => {
    const found = needle ? channels.filter(channel => matches(channel, needle)) : channels;
    return { dms: found.filter(channel => channel.kind !== 'channel'), rooms: found.filter(channel => channel.kind === 'channel') };
  }, [channels, needle]);
  const hasDms = channels.some(channel => channel.kind !== 'channel');
  return (
    <div role="group" aria-label={t('sources.channels')} className="flex flex-col gap-4">
      <SearchInput label={t('sources.search')} placeholder={t('sources.searchPlaceholder')} value={query} onValueChange={setQuery} />
      {actions.setDmModes.isError ? <span className="text-caption text-destructive-foreground">{actions.setDmModes.error.message}</span> : null}
      {dms.length === 0 && rooms.length === 0 ? (
        <EmptyState iconSlot={<SearchX />} titleSlot={t('sources.nothingFound')} descriptionSlot={t('sources.nothingFoundHint', { query })} />
      ) : null}
      <ChannelGroup title={t('sources.dms')} channels={dms} searching={Boolean(needle)} action={hasDms ? <AllDmsSelect /> : undefined} />
      <ChannelGroup title={t('sources.rooms')} channels={rooms} searching={Boolean(needle)} />
    </div>
  );
}
