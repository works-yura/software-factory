/**
 * Browser-side helpers for Factory work items (the kanban board records).
 *
 * Talks to the server's `/web/factory/*` routes, which sit behind the
 * auth gate and scope everything to the caller's organization — the board is
 * org-wide, so every member of the org reads and moves the same cards.
 */

import type { FactoryRuleStage, FactoryTriageType } from '@factory/core/rules/types';
import type { ProviderWorkItem } from '@factory/core/card';

import { requestJson } from './request';
import { translator } from '../../../i18n/t';

const tk = translator('board');

export type WorkItemSource =
  | 'github-issue'
  | 'github-pr'
  | 'gitlab-issue'
  | 'gitlab-pr'
  | 'clickup-task'
  | 'manual';

/** Takes any source string so callers holding a wider union (a user session's `'user'`) need no guard. */
export function isPullRequestSource(source: string): source is 'github-pr' | 'gitlab-pr' {
  return source === 'github-pr' || source === 'gitlab-pr';
}

/** The pull and merge requests a card carries, oldest first: its own, or those attached to its issue. */
export function cardPullRequestSources(item: Pick<WorkItem, 'workItem'>): ProviderWorkItem['sources'] {
  return (item.workItem?.sources ?? []).filter(source => source.sourceType === 'pull-request');
}

type CardPullRequestSource = ProviderWorkItem['sources'][number];

function sourcePullRequestNumber(source: CardPullRequestSource): number | undefined {
  const metadata = source.metadata ?? {};
  const value = metadata.githubPullRequestNumber ?? metadata.gitlabMergeRequestIid ?? metadata.number;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function openPullRequestSource(source: CardPullRequestSource): boolean {
  const state = source.state ?? source.metadata?.state;
  return state !== 'closed' && state !== 'merged' && source.metadata?.merged !== true;
}

/**
 * The pull request attached to an issue card that Review (`pr-review`) looks at: the one the card points
 * at, else the newest open one, else the newest. Mirrors the server's `reviewedPullRequest`.
 */
export function attachedPullRequestSource(
  item: Pick<WorkItem, 'source' | 'workItem' | 'metadata'>,
): CardPullRequestSource | undefined {
  if (isPullRequestSource(item.source)) return undefined;
  const sources = cardPullRequestSources(item);
  const pointer = item.metadata.openPullRequestNumber;
  return (
    sources.find(source => typeof pointer === 'number' && sourcePullRequestNumber(source) === pointer) ??
    sources.filter(openPullRequestSource).at(-1) ??
    sources.at(-1)
  );
}

export interface CardPullRequestLink {
  url: string;
  provider: 'github' | 'gitlab';
  number: number | undefined;
  state: 'open' | 'merged' | 'closed';
}

/** The pull and merge requests attached to the card that have a URL, open ones first, newest first within each. */
export function cardPullRequestLinks(item: Pick<WorkItem, 'workItem'>): CardPullRequestLink[] {
  const links = cardPullRequestSources(item).flatMap((source): CardPullRequestLink[] => {
    if (!source.url) return [];
    const merged = source.metadata?.merged === true || (source.state ?? source.metadata?.state) === 'merged';
    return [
      {
        url: source.url,
        provider: source.provider === 'gitlab' ? 'gitlab' : 'github',
        number: sourcePullRequestNumber(source),
        state: openPullRequestSource(source) ? 'open' : merged ? 'merged' : 'closed',
      },
    ];
  });
  return links.toReversed().toSorted((a, b) => Number(b.state === 'open') - Number(a.state === 'open'));
}

/** Whether the card carries a pull or merge request, as its own source or one attached to its issue. */
export function cardHasPullRequest(item: Pick<WorkItem, 'source' | 'workItem'>): boolean {
  return isPullRequestSource(item.source) || cardPullRequestSources(item).length > 0;
}

export interface WorkItemSessionRef {
  sessionId: string;
  branch: string;
  threadId: string;
  /** User id whose sandbox the session runs in (stamped server-side). */
  startedBy: string;
}

export interface WorkItemStageEntry {
  stage: string;
  enteredAt: string;
  exitedAt?: string;
  by: string;
  exitedBy?: string;
}

export interface WorkItem {
  /** Optional during the one-release legacy wire migration. */
  workItem?: Pick<ProviderWorkItem, 'provider' | 'key' | 'url' | 'title' | 'state' | 'labels' | 'author' | 'metadata'> &
    Partial<Pick<ProviderWorkItem, 'sources'>>;
  id: string;
  orgId: string;
  createdBy: string;
  githubProjectId: string;
  board?: string | null;
  source: WorkItemSource;
  sourceKey: string | null;
  parentWorkItemId: string | null;
  title: string;
  /** The card's own description, which its runs start from (upstream #29062). */
  description?: string | null;
  url: string | null;
  stages: string[];
  stageHistory: WorkItemStageEntry[];
  sessions: Record<string, WorkItemSessionRef>;
  metadata: Record<string, unknown>;
  /** Classification the triage run recorded; non-bug kinds wait for a person before agents advance them. */
  triageType: FactoryTriageType | null;
  /** When a person first moved the card into Planning/Build, which is the approval agents then honor. */
  acceptedAt: string | null;
  commentCount: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Session ref as sent by the client — `startedBy` is stamped server-side. */
export interface WorkItemSessionInput {
  sessionId: string;
  branch: string;
  threadId: string;
}

export interface CreateWorkItemInput {
  board?: string;
  source: WorkItemSource;
  sourceKey: string | null;
  parentWorkItemId?: string | null;
  title: string;
  url?: string | null;
  stages?: string[];
  sessions?: Record<string, WorkItemSessionInput>;
  metadata?: Record<string, unknown>;
}

interface ExternalWorkItemSource {
  integrationId: string;
  type: string;
  externalId: string;
  url?: string;
}

interface WireWorkItem extends Omit<
  WorkItem,
  'githubProjectId' | 'source' | 'sourceKey' | 'url' | 'metadata' | 'commentCount' | 'triageType' | 'acceptedAt'
> {
  factoryProjectId: string;
  externalSource: ExternalWorkItemSource | null;
  metadata: Record<string, unknown> | null;
  commentCount?: number;
  triageType?: WorkItem['triageType'];
  acceptedAt?: string | null;
}

interface WireCreateWorkItemInput extends Omit<CreateWorkItemInput, 'source' | 'sourceKey' | 'url'> {
  externalSource?: ExternalWorkItemSource;
}

function sourceFromExternalSource(source: ExternalWorkItemSource | null): WorkItemSource {
  if (!source) return 'manual';
  if (source.integrationId === 'github' && source.type === 'issue') return 'github-issue';
  if (source.integrationId === 'github' && source.type === 'pull-request') return 'github-pr';
  if (source.integrationId === 'gitlab' && source.type === 'issue') return 'gitlab-issue';
  if (source.integrationId === 'gitlab' && source.type === 'pull-request') return 'gitlab-pr';
  if (source.integrationId === 'clickup' && source.type === 'task') return 'clickup-task';
  return 'manual';
}

function externalSourceTarget(
  source: Exclude<WorkItemSource, 'manual'>,
): Pick<ExternalWorkItemSource, 'integrationId' | 'type'> {
  switch (source) {
    case 'github-issue':
      return { integrationId: 'github', type: 'issue' };
    case 'github-pr':
      return { integrationId: 'github', type: 'pull-request' };
    case 'gitlab-issue':
      return { integrationId: 'gitlab', type: 'issue' };
    case 'gitlab-pr':
      return { integrationId: 'gitlab', type: 'pull-request' };
    case 'clickup-task':
      return { integrationId: 'clickup', type: 'task' };
  }
}

function toExternalSource(input: CreateWorkItemInput): ExternalWorkItemSource | undefined {
  const source = input.source;
  if (source === 'manual' || !input.sourceKey) return undefined;
  return {
    ...externalSourceTarget(source),
    externalId: input.sourceKey,
    ...(input.url ? { url: input.url } : {}),
  };
}

function toWireCreateInput(input: CreateWorkItemInput): WireCreateWorkItemInput {
  const { source: _source, sourceKey: _sourceKey, url: _url, ...rest } = input;
  const externalSource = toExternalSource(input);
  return { ...rest, ...(externalSource ? { externalSource } : {}) };
}

function fromWireWorkItem(item: WireWorkItem): WorkItem {
  const { factoryProjectId, externalSource, metadata, commentCount, triageType, acceptedAt, ...rest } = item;
  return {
    ...rest,
    githubProjectId: factoryProjectId,
    source: sourceFromExternalSource(externalSource),
    sourceKey: externalSource?.externalId ?? null,
    title: item.workItem?.title ?? item.title,
    url: item.workItem?.url ?? externalSource?.url ?? null,
    metadata: metadata ?? {},
    commentCount: commentCount ?? 0,
    triageType: triageType ?? null,
    acceptedAt: acceptedAt ?? null,
  };
}

export type FactoryBoard = string;

export type FactoryTransitionResult =
  | {
      status: 'accepted';
      transitionId: string;
      itemId: string;
      revision: number;
      stage: FactoryRuleStage;
      decisions: unknown[];
    }
  | { status: 'rejected'; transitionId: string; itemId: string; code: string; reason: string };

export interface UpdateWorkItemInput {
  parentWorkItemId?: string | null;
  title?: string;
  /** Blank clears it. */
  description?: string | null;
  sessions?: Record<string, WorkItemSessionInput>;
  metadata?: Record<string, unknown>;
}

/**
 * The board as of one read: its cards, plus the sessions running on them right
 * then. Both come from the same response so a card and its run marker can
 * never disagree.
 */
export interface BoardSnapshot {
  workItems: WorkItem[];
  runningSessionIds: string[];
  /** Sessions parked on a tool until someone answers, read live with the cards. */
  parkedSessionIds: string[];
}

/** List the org's work items for a Factory project. */
export async function listWorkItems(
  baseUrl: string,
  factoryProjectId: string,
  signal?: AbortSignal,
): Promise<BoardSnapshot> {
  const data = await requestJson<{
    workItems: WireWorkItem[];
    runningSessionIds?: string[];
    parkedSessionIds?: string[];
  }>(`${baseUrl}/web/factory/projects/${encodeURIComponent(factoryProjectId)}/work-items`, { signal });
  return {
    workItems: data.workItems.map(fromWireWorkItem),
    runningSessionIds: data.runningSessionIds ?? [],
    parkedSessionIds: data.parkedSessionIds ?? [],
  };
}

/** Create a work item; the server upserts on its external source identity so repeats reuse the card. */
export async function createWorkItem(
  baseUrl: string,
  factoryProjectId: string,
  input: CreateWorkItemInput,
): Promise<WorkItem> {
  const data = await requestJson<{ workItem: WireWorkItem }>(
    `${baseUrl}/web/factory/projects/${encodeURIComponent(factoryProjectId)}/work-items`,
    { method: 'POST', body: JSON.stringify(toWireCreateInput(input)) },
  );
  return fromWireWorkItem(data.workItem);
}

export async function transitionWorkItem(
  baseUrl: string,
  githubProjectId: string,
  id: string,
  input: {
    board: FactoryBoard;
    stage: FactoryRuleStage;
    expectedRevision: number;
    requestId: string;
    cause: string;
    /** Re-enter the lane the card is already in, so its rule runs again. */
    reenter?: boolean;
  },
): Promise<FactoryTransitionResult> {
  const res = await fetch(
    `${baseUrl}/web/factory/projects/${encodeURIComponent(githubProjectId)}/work-items/${encodeURIComponent(id)}/transition`,
    {
      method: 'POST',
      headers: { Accept: 'application/json', 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(input),
    },
  );
  const body = (await res.json()) as { result?: FactoryTransitionResult; error?: string };
  if (body.result) return body.result;
  throw new Error(body.error ?? tk('errors.requestFailed', { status: res.status }));
}

/** Patch a work item's non-stage metadata, session refs, or title. */
export async function updateWorkItem(baseUrl: string, id: string, patch: UpdateWorkItemInput): Promise<WorkItem> {
  const data = await requestJson<{ workItem: WireWorkItem }>(
    `${baseUrl}/web/factory/work-items/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
  );
  return fromWireWorkItem(data.workItem);
}

export interface StartFactoryRunRequest {
  sessionId: string;
  threadTitle: string;
  kickoffKey: string;
  workItem: {
    id: string;
    role: string;
    input: CreateWorkItemInput;
  };
}

export interface StartFactoryRunPrepared {
  workItemId: string;
  bindingId: string;
  threadId: string;
  resourceId: string;
  sessionId: string;
  branch: string;
  revision: number;
  kickoffStatus: 'pending' | 'leased' | 'retry' | 'sent' | 'failed';
  replayed: boolean;
}

export async function startFactoryRun(
  baseUrl: string,
  factoryProjectId: string,
  input: StartFactoryRunRequest,
): Promise<StartFactoryRunPrepared> {
  const request = {
    ...input,
    workItem: {
      ...input.workItem,
      input: toWireCreateInput(input.workItem.input),
    },
  };
  const data = await requestJson<{ prepared: StartFactoryRunPrepared }>(
    `${baseUrl}/web/factory/projects/${encodeURIComponent(factoryProjectId)}/runs/start`,
    { method: 'POST', body: JSON.stringify(request) },
  );
  return data.prepared;
}

/** Remove a work item from the board. */
export async function deleteWorkItem(baseUrl: string, id: string): Promise<void> {
  await requestJson<{ ok: boolean }>(`${baseUrl}/web/factory/work-items/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}
