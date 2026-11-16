/**
 * What drives the assistant, for its settings page (ADR-0051): the base instructions document, the
 * skills (catalogue, overrides, the person's own), «What the agent sees», how each provider fared
 * and the model check.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { assistantKeys, call, json, useAssistantApi } from './api';
import type { TurnFailure } from './api';

export interface AssistantBehavior {
  /** The person's version, or the default when they have none. */
  document: string;
  defaultDocument: string;
  customized: boolean;
  updatedAt: string | null;
  /** The version of the whole system prompt (as each reply's details name it). */
  version: string;
}

export interface AssistantSkillEntry {
  name: string;
  description: string;
  origin: 'factory' | 'personal';
  overridden: boolean;
  enabled: boolean;
}

export interface AssistantSkillDetail extends AssistantSkillEntry {
  instructions: string;
  original: { description: string; instructions: string } | null;
  updatedAt: string | null;
}

export type AssistantToolKind = 'read' | 'write_own' | 'proposal' | 'workspace' | 'asks';

export interface AgentPreview {
  systemPrompt: string;
  version: string;
  modelId: string | null;
  skills: Array<{ name: string; description: string }>;
  tools: Array<{ name: string; description: string; kind: AssistantToolKind }>;
}

export interface ProviderState {
  provider: string;
  modelId: string | null;
  state: 'ok' | TurnFailure['kind'];
  detail: string | null;
  at: string;
}

export interface ModelCheck {
  ok: boolean;
  modelId: string | null;
  reply: string | null;
  failure: TurnFailure | null;
  durationMs: number;
}

export function useAssistantBehavior() {
  const api = useAssistantApi();
  return useQuery({
    queryKey: assistantKeys.behavior(),
    queryFn: () => call<{ behavior: AssistantBehavior }>(api, '/behavior').then(body => body.behavior),
  });
}

export function useBehaviorActions() {
  const api = useAssistantApi();
  const queryClient = useQueryClient();
  const done = {
    onSuccess: (behavior: AssistantBehavior) => {
      queryClient.setQueryData(assistantKeys.behavior(), behavior);
      void queryClient.invalidateQueries({ queryKey: assistantKeys.preview() });
    },
  };
  return {
    save: useMutation({
      mutationFn: (document: string) => call<{ behavior: AssistantBehavior }>(api, '/behavior', json('PUT', { document })).then(body => body.behavior),
      ...done,
    }),
    reset: useMutation({
      mutationFn: () => call<{ behavior: AssistantBehavior }>(api, '/behavior', { method: 'DELETE' }).then(body => body.behavior),
      ...done,
    }),
  };
}

export function useAssistantSkills() {
  const api = useAssistantApi();
  return useQuery({
    queryKey: assistantKeys.skills(),
    queryFn: () => call<{ skills: AssistantSkillEntry[] }>(api, '/skills').then(body => body.skills),
  });
}

export function useAssistantSkill(name: string | undefined) {
  const api = useAssistantApi();
  return useQuery({
    queryKey: assistantKeys.skill(name ?? ''),
    queryFn: () => call<{ skill: AssistantSkillDetail }>(api, `/skills/${encodeURIComponent(name!)}`).then(body => body.skill),
    enabled: Boolean(name),
  });
}

export function useSkillActions() {
  const api = useAssistantApi();
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: assistantKeys.skills() });
    void queryClient.invalidateQueries({ queryKey: ['assistant', 'skill'] });
    void queryClient.invalidateQueries({ queryKey: assistantKeys.preview() });
    void queryClient.invalidateQueries({ queryKey: assistantKeys.settings() });
  };
  const path = (name: string) => `/skills/${encodeURIComponent(name)}`;
  return {
    save: useMutation({
      mutationFn: (input: { name: string; description: string; instructions: string }) =>
        call<{ skill: AssistantSkillDetail }>(api, path(input.name), json('PUT', { description: input.description, instructions: input.instructions })),
      onSuccess: refresh,
    }),
    create: useMutation({
      mutationFn: (input: { name: string; description: string; instructions: string }) =>
        call<{ skill: AssistantSkillDetail }>(api, '/skills', json('POST', input)),
      onSuccess: refresh,
    }),
    /** An override goes back to the original; a skill of the person's own is deleted. */
    remove: useMutation({
      mutationFn: (name: string) => call<{ reverted: boolean; deleted: boolean }>(api, path(name), { method: 'DELETE' }),
      onSuccess: refresh,
    }),
  };
}

export function useAgentPreview(options: { enabled?: boolean } = {}) {
  const api = useAssistantApi();
  return useQuery({
    queryKey: assistantKeys.preview(),
    queryFn: () => call<{ preview: AgentPreview }>(api, '/agent-preview').then(body => body.preview),
    enabled: options.enabled ?? true,
  });
}

export function useModelStatus() {
  const api = useAssistantApi();
  return useQuery({
    queryKey: assistantKeys.modelStatus(),
    queryFn: () => call<{ providers: ProviderState[] }>(api, '/model-status').then(body => body.providers),
    retry: false,
  });
}

/** «Check the model»: a tiny call; `undefined` checks the model the settings name (or the default). */
export function useModelCheck() {
  const api = useAssistantApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (modelId?: string | null) =>
      call<{ check: ModelCheck }>(api, '/model-test', json('POST', modelId === undefined ? {} : { modelId })).then(body => body.check),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: assistantKeys.modelStatus() }),
  });
}
