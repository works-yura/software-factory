/**
 * The person's own sources (ADR-0051 phase 2) at `/web/assistant/sources`: ClickUp Chat connected
 * with a personal API token, a mode per channel, the last sync. The token is sent once and never
 * comes back.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { assistantKeys, call, json, useAssistantApi } from './api';

export type ChannelMode = 'ignore' | 'addressed' | 'watch';
export const CHANNEL_MODES: readonly ChannelMode[] = ['ignore', 'addressed', 'watch'];

export interface SourceChannel {
  workspaceId: string;
  channelId: string;
  name: string;
  kind: 'channel' | 'dm' | 'group_dm';
  mode: ChannelMode;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface ClickUpConnection {
  connected: boolean;
  /** Read with the person's own token, or with the organization's connection (their own ClickUp account). */
  via?: 'personal' | 'org' | null;
  /** The organization's ClickUp connection, offered only to the person whose account its token is. */
  orgOffer?: { accountName: string; workspaces: string[] } | null;
  account: { id: string; name: string } | null;
  status: 'active' | 'rejected' | null;
  lastSyncAt: string | null;
  lastError: string | null;
  nextPollAt: string | null;
  channels: SourceChannel[];
}

export const sourcesKey = () => [...assistantKeys.all, 'sources'] as const;

export function useAssistantSources() {
  const api = useAssistantApi();
  return useQuery({
    queryKey: sourcesKey(),
    queryFn: () => call<{ clickup: ClickUpConnection }>(api, '/sources').then(body => body.clickup),
    retry: false,
  });
}

export function useSourceActions() {
  const api = useAssistantApi();
  const queryClient = useQueryClient();
  const store = (clickup: ClickUpConnection) => queryClient.setQueryData(sourcesKey(), clickup);
  return {
    connect: useMutation({
      mutationFn: (token: string) =>
        call<{ clickup: ClickUpConnection }>(api, '/sources/clickup', json('POST', { token })).then(body => body.clickup),
      onSuccess: store,
    }),
    /** Reads with the organization's ClickUp connection: offered only when its token is this person's account. */
    connectOrg: useMutation({
      mutationFn: () =>
        call<{ clickup: ClickUpConnection }>(api, '/sources/clickup/org', json('POST', {})).then(body => body.clickup),
      onSuccess: store,
    }),
    disconnect: useMutation({
      mutationFn: () => call<{ clickup: ClickUpConnection }>(api, '/sources/clickup', { method: 'DELETE' }).then(body => body.clickup),
      onSuccess: store,
    }),
    sync: useMutation({
      mutationFn: () =>
        call<{ result: { ingested: number; channels: number; error: string | null }; clickup: ClickUpConnection }>(
          api,
          '/sources/clickup/sync',
          json('POST', {}),
        ),
      onSuccess: body => {
        store(body.clickup);
        void queryClient.invalidateQueries({ queryKey: assistantKeys.requests() });
      },
    }),
    setMode: useMutation({
      mutationFn: (input: { workspaceId: string; channelId: string; mode: ChannelMode }) =>
        call<{ clickup: ClickUpConnection }>(
          api,
          `/sources/clickup/channels/${encodeURIComponent(input.workspaceId)}/${encodeURIComponent(input.channelId)}`,
          json('PUT', { mode: input.mode }),
        ).then(body => body.clickup),
      onSuccess: store,
    }),
  };
}
