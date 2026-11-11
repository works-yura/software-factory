import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import type {
  CardRuleGroup,
  IntakeRouteFireInfo,
  IntakeRouteInfo,
  IntakeRouteListResponse,
  IntakeTriggerKindsInfo,
  IntakeTriggerPreviewInfo,
} from '../api/types';
import { currentLanguage } from '../ui/i18n';

export interface IntakeKindDraft {
  kind: string;
  config: Record<string, unknown>;
}

/** What makes a route «За розкладом»: its trigger, what each fire does, and the overlap policy. */
export interface IntakeRouteTriggeredDraft {
  trigger: IntakeKindDraft;
  action: IntakeKindDraft;
  policy: { kind: string };
}

/** What a route is written with: where matching new cards land, and which cards match (`null`: every card). */
export interface IntakeRouteDraft {
  name: string;
  enabled: boolean;
  when: CardRuleGroup | null;
  target: { boardKey: string; phaseKey: string | null; joinClosedIssue?: boolean };
  /** The events the route handles; unset keeps the route's own (a new route places new cards). */
  on?: string[];
  /** A trigger of the route's own: it makes its cards itself («За розкладом») and takes no condition. */
  triggered?: IntakeRouteTriggeredDraft;
}

// The server writes a route «За розкладом»'s summaries in the reader's language.
const base = (factoryProjectId: string) => `/web/factory/projects/${encodeURIComponent(factoryProjectId)}/intake-routes`;
const withLocale = (path: string) => `${path}${path.includes('?') ? '&' : '?'}locale=${currentLanguage()}`;

/** The trigger, action and policy kinds a route «За розкладом» can use on this server, labelled. */
export function useIntakeTriggerKindsQuery(factoryProjectId: string | undefined) {
  const { client } = useApiConfig();
  const locale = currentLanguage();
  return useQuery({
    queryKey: queryKeys.intakeTriggerKinds(factoryProjectId, locale),
    enabled: !!factoryProjectId,
    queryFn: () => client.get<IntakeTriggerKindsInfo>(withLocale(`${base(factoryProjectId!)}/kinds`)),
    staleTime: Infinity,
  });
}

/** A trigger config in words with its next fires, as the person edits it; the last answer stays while the next loads. */
export function useIntakeTriggerPreview(factoryProjectId: string, trigger: IntakeKindDraft | undefined) {
  const { client } = useApiConfig();
  const locale = currentLanguage();
  const key = trigger ? JSON.stringify(trigger) : '';
  return useQuery({
    queryKey: queryKeys.intakeTriggerPreview(factoryProjectId, key, locale),
    enabled: !!trigger,
    placeholderData: keepPreviousData,
    queryFn: () => client.post<IntakeTriggerPreviewInfo>(`${base(factoryProjectId)}/preview`, { trigger, locale }),
  });
}

/** A route «За розкладом»'s latest fires: the cards it filed, what it skipped and why, what failed. */
export function useIntakeRouteFiresQuery(factoryProjectId: string, routeId: string, enabled: boolean) {
  const { client } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.intakeRouteFires(factoryProjectId, routeId),
    enabled,
    queryFn: () =>
      client.get<{ fires: IntakeRouteFireInfo[] }>(`${base(factoryProjectId)}/${encodeURIComponent(routeId)}/fires`),
    select: data => data.fires,
  });
}

/** A Factory project's intake routes, in the order they are tried. */
export function useIntakeRoutesQuery(factoryProjectId: string | undefined) {
  const { client } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.intakeRoutes(factoryProjectId),
    enabled: !!factoryProjectId,
    queryFn: () => client.get<IntakeRouteListResponse>(withLocale(base(factoryProjectId!))),
    select: data => data.intakeRoutes,
  });
}

/** Whether the caller may add, edit, reorder or delete the project's routes (organization admins). */
export function useIntakeRoutesCanEditQuery(factoryProjectId: string | undefined) {
  const { client } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.intakeRoutes(factoryProjectId),
    enabled: !!factoryProjectId,
    queryFn: () => client.get<IntakeRouteListResponse>(withLocale(base(factoryProjectId!))),
    select: data => data.canEdit,
  });
}

/**
 * Whether the caller may create, edit and delete this project's boards (an organization admin).
 * Read off the intake routes, which answer for the project whatever boards it has: a project
 * need not have a Work board. The server enforces it on every write.
 */
export function useCanEditBoards(factoryProjectId: string | undefined): boolean {
  return useIntakeRoutesCanEditQuery(factoryProjectId).data ?? false;
}

function useRefetchRoutes(factoryProjectId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.intakeRoutes(factoryProjectId) });
}

export function useCreateIntakeRouteMutation(factoryProjectId: string) {
  const { client } = useApiConfig();
  const refetch = useRefetchRoutes(factoryProjectId);
  return useMutation({
    mutationFn: (draft: IntakeRouteDraft) =>
      client.post<{ intakeRoute: IntakeRouteInfo }>(base(factoryProjectId), draft),
    onSettled: refetch,
  });
}

/** Changes the named fields of a route; `revision` is the one read, so a concurrent edit is refused. */
export function useUpdateIntakeRouteMutation(factoryProjectId: string) {
  const { client } = useApiConfig();
  const refetch = useRefetchRoutes(factoryProjectId);
  return useMutation({
    mutationFn: ({ route, patch }: { route: IntakeRouteInfo; patch: Partial<IntakeRouteDraft> }) =>
      client.patch<{ intakeRoute: IntakeRouteInfo }>(`${base(factoryProjectId)}/${encodeURIComponent(route.id)}`, {
        ...patch,
        expectedRevision: route.revision,
      }),
    onSettled: refetch,
  });
}

export function useDeleteIntakeRouteMutation(factoryProjectId: string) {
  const { client } = useApiConfig();
  const refetch = useRefetchRoutes(factoryProjectId);
  return useMutation({
    mutationFn: (route: IntakeRouteInfo) =>
      client.del<null>(
        `${base(factoryProjectId)}/${encodeURIComponent(route.id)}?expectedRevision=${encodeURIComponent(String(route.revision))}`,
      ),
    onSettled: refetch,
  });
}

/** Saves a new order: every route of the project, once each. */
export function useReorderIntakeRoutesMutation(factoryProjectId: string) {
  const { client } = useApiConfig();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => client.post<IntakeRouteListResponse>(`${base(factoryProjectId)}/reorder`, { ids }),
    onSuccess: data => queryClient.setQueryData(queryKeys.intakeRoutes(factoryProjectId), data),
    onError: () => queryClient.invalidateQueries({ queryKey: queryKeys.intakeRoutes(factoryProjectId) }),
  });
}
