/**
 * The person's own sources (ADR-0051 phase 2; the tag per the amendment of 2026-11-16) at
 * `/web/assistant/sources`: ClickUp Chat connected with a personal API token, the person's tag
 * (what in a chat makes a request), the last sync. The token is sent once and never comes back.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { assistantKeys, call, json, useAssistantApi } from './api';

/** Who may tag: only the person (the default), or anyone in the chat. */
export type TagWho = 'me' | 'anyone';

/** The person's tag: their pattern (`null`: the default one), who may tag, and how many earlier messages come along. */
export interface TagSettings {
  pattern: string | null;
  defaultPattern: string;
  who: TagWho;
  contextMessages: number;
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
  tag: TagSettings;
  /** The chats looked at for the tag: every one the token sees. */
  chats: { total: number; inSidebar: number };
}

/** The pattern's flags on the server too: case-insensitive, Unicode. */
export const TAG_FLAGS = 'iu';

/**
 * Why a pattern cannot be a tag (the server checks the same and has the last word), or `null`:
 * it must compile and must not match an empty or ordinary message.
 */
export function tagPatternError(pattern: string): 'empty' | 'invalid' | 'matchesEverything' | null {
  if (!pattern.trim()) return 'empty';
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, TAG_FLAGS);
  } catch {
    return 'invalid';
  }
  return ['', ' ', 'да', 'ok'].some(line => regex.test(line)) ? 'matchesEverything' : null;
}

/** What the tag does to a test message: whether it is found, and the instruction left once it is stripped. */
export function tryTag(pattern: string, text: string): { matches: boolean; instruction: string } | null {
  if (tagPatternError(pattern)) return null;
  const matches = new RegExp(pattern, TAG_FLAGS).test(text);
  const instruction = text
    .replace(new RegExp(pattern, `${TAG_FLAGS}g`), ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t,:;—-]+/gm, '')
    .trim();
  return { matches, instruction };
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
    /** The person's tag: `{ pattern?: string | null, who?, contextMessages? }`. */
    setTag: useMutation({
      mutationFn: (input: { pattern?: string | null; who?: TagWho; contextMessages?: number }) =>
        call<{ clickup: ClickUpConnection }>(api, '/sources/clickup/tag', json('PUT', input)).then(body => body.clickup),
      onSuccess: store,
    }),
  };
}
