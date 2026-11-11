import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useApiConfig } from '../api/config';
import { queryKeys } from '../api/keys';
import type {
  IntakeRuleFireInfo,
  IntakeRuleInfo,
  IntakeRuleKindsInfo,
  IntakeRuleListResponse,
  IntakeTriggerPreviewInfo,
} from '../api/types';
import { currentLanguage } from '../ui/i18n';

/** A kind and its config, as an intake rule's trigger and action are written. */
export interface IntakeKindDraft {
  kind: string;
  config: Record<string, unknown>;
}

/** What a rule is written with. */
export interface IntakeRuleDraft {
  name: string;
  enabled: boolean;
  trigger: IntakeKindDraft;
  action: IntakeKindDraft;
  policy: { kind: string };
}

const base = (factoryProjectId: string) => `/web/factory/projects/${encodeURIComponent(factoryProjectId)}/intake-rules`;
const withLocale = (path: string, locale: string) => `${path}${path.includes('?') ? '&' : '?'}locale=${locale}`;

/** A Factory project's intake rules, their summaries in the interface language. */
export function useIntakeRulesQuery(factoryProjectId: string | undefined) {
  const { client } = useApiConfig();
  const locale = currentLanguage();
  return useQuery({
    queryKey: queryKeys.intakeRules(factoryProjectId, locale),
    enabled: !!factoryProjectId,
    queryFn: () => client.get<IntakeRuleListResponse>(withLocale(base(factoryProjectId!), locale)),
    select: data => data.intakeRules,
  });
}

/** The trigger, action and policy kinds this server can run. */
export function useIntakeRuleKindsQuery(factoryProjectId: string | undefined) {
  const { client } = useApiConfig();
  const locale = currentLanguage();
  return useQuery({
    queryKey: queryKeys.intakeRuleKinds(factoryProjectId, locale),
    enabled: !!factoryProjectId,
    queryFn: () => client.get<IntakeRuleKindsInfo>(withLocale(`${base(factoryProjectId!)}/kinds`, locale)),
    staleTime: Infinity,
  });
}

/** A trigger config in words with its next fire times, read as it is edited. */
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

/** A rule's latest fires: what it filed, skipped or failed to file. */
export function useIntakeRuleFiresQuery(factoryProjectId: string, ruleId: string, enabled: boolean) {
  const { client } = useApiConfig();
  return useQuery({
    queryKey: queryKeys.intakeRuleFires(factoryProjectId, ruleId),
    enabled,
    queryFn: () => client.get<{ fires: IntakeRuleFireInfo[] }>(`${base(factoryProjectId)}/${encodeURIComponent(ruleId)}/fires`),
    select: data => data.fires,
  });
}

function useRefetchRules(factoryProjectId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.intakeRules(factoryProjectId) });
}

export function useCreateIntakeRuleMutation(factoryProjectId: string) {
  const { client } = useApiConfig();
  const refetch = useRefetchRules(factoryProjectId);
  return useMutation({
    mutationFn: (draft: IntakeRuleDraft) =>
      client.post<{ intakeRule: IntakeRuleInfo }>(withLocale(base(factoryProjectId), currentLanguage()), draft),
    onSettled: refetch,
  });
}

/** Changes the named fields; `revision` is the one read, so a concurrent edit is refused. */
export function useUpdateIntakeRuleMutation(factoryProjectId: string) {
  const { client } = useApiConfig();
  const refetch = useRefetchRules(factoryProjectId);
  return useMutation({
    mutationFn: ({ rule, patch }: { rule: IntakeRuleInfo; patch: Partial<IntakeRuleDraft> }) =>
      client.patch<{ intakeRule: IntakeRuleInfo }>(
        withLocale(`${base(factoryProjectId)}/${encodeURIComponent(rule.id)}`, currentLanguage()),
        { ...patch, expectedRevision: rule.revision },
      ),
    onSettled: refetch,
  });
}

export function useDeleteIntakeRuleMutation(factoryProjectId: string) {
  const { client } = useApiConfig();
  const refetch = useRefetchRules(factoryProjectId);
  return useMutation({
    mutationFn: (rule: IntakeRuleInfo) =>
      client.del<null>(
        `${base(factoryProjectId)}/${encodeURIComponent(rule.id)}?expectedRevision=${encodeURIComponent(String(rule.revision))}`,
      ),
    onSettled: refetch,
  });
}
