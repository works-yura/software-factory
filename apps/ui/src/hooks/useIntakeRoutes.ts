import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import type { CardRuleGroup, IntakeRouteInfo, IntakeRouteListResponse } from '../api/types';

/** What a route is written with: where matching new cards land, and which cards match (`null`: every card). */
export interface IntakeRouteDraft {
  name: string;
  enabled: boolean;
  when: CardRuleGroup | null;
  target: { boardKey: string; phaseKey: string | null; joinClosedIssue?: boolean };
  /** The events the route handles; unset keeps the route's own (a new route places new cards). */
  on?: string[];
}

const base = (factoryProjectId: string) => `/web/factory/projects/${encodeURIComponent(factoryProjectId)}/intake-routes`;

/** A Factory project's intake routes, in the order they are tried. */
export function useIntakeRoutesQuery(factoryProjectId: string | undefined) {
  const { client } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.intakeRoutes(factoryProjectId),
    enabled: !!factoryProjectId,
    queryFn: () => client.get<IntakeRouteListResponse>(base(factoryProjectId!)),
    select: data => data.intakeRoutes,
  });
}

/** Whether the caller may add, edit, reorder or delete the project's routes (organization admins). */
export function useIntakeRoutesCanEditQuery(factoryProjectId: string | undefined) {
  const { client } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.intakeRoutes(factoryProjectId),
    enabled: !!factoryProjectId,
    queryFn: () => client.get<IntakeRouteListResponse>(base(factoryProjectId!)),
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
