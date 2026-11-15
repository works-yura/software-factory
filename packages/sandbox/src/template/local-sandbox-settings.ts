/**
 * The local sandbox's Factory settings (Settings › Environment › Sandbox,
 * stored on the Factory's `sandbox_settings`; ADR-0039). Every field is
 * optional; absent means the default shown as the placeholder.
 */

import { z } from 'zod';

import { DEFAULT_SLEEP_POLICY } from './sleep-policy.ts';
import type { SleepPolicy } from './sleep-policy.ts';

export const DEFAULT_HIDDEN_REF_RETENTION_DAYS = 30;

/**
 * How agents of this Factory are kept from the rest of the machine (ADR-0041, ADR-0048):
 * `seatbelt` — the separate macOS user plus the Seatbelt profile (writes only in the card folder and
 * the agent's home, no other disk, no Factory port; Xcode and SwiftPM build inside it);
 * `user` — the separate user alone. Only where agents run as a separate user (FACTORY_AGENT_USER).
 */
export const AGENT_ISOLATIONS = ['seatbelt', 'user'] as const;
export type AgentIsolation = (typeof AGENT_ISOLATIONS)[number];
export const DEFAULT_AGENT_ISOLATION: AgentIsolation = 'seatbelt';

export const localSandboxSettingsSchema = z.object({
  agentIsolation: z
    .enum(AGENT_ISOLATIONS)
    .default(DEFAULT_AGENT_ISOLATION)
    .meta({
      title: 'Agent isolation',
      description:
        'seatbelt: the separate user plus the Seatbelt sandbox (writes only in the card folder, Xcode builds inside it). user: the separate user alone. Applies to new commands within a minute.',
    }),
  maxActiveSandboxes: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(DEFAULT_SLEEP_POLICY.maxActive)
    .meta({ title: 'Awake sandboxes at most', description: 'Over this, the sandboxes idle longest go to sleep.' }),
  idleSleepMinutes: z
    .number()
    .int()
    .min(10)
    .max(43_200)
    .default(DEFAULT_SLEEP_POLICY.idleMs / 60_000)
    .meta({ title: 'Sleep after idle (minutes)', description: 'A sandbox without work this long goes to sleep.' }),
  hiddenRefRetentionDays: z
    .number()
    .int()
    .min(1)
    .max(365)
    .default(DEFAULT_HIDDEN_REF_RETENTION_DAYS)
    .meta({
      title: 'Keep published work (days)',
      description: 'Work published to hidden refs on GitHub is removed after this long once the remote holds it, or its card closed.',
    }),
});

export type LocalSandboxSettings = z.input<typeof localSandboxSettingsSchema>;

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** The sleep policy a Factory's stored settings ask for, defaults filled in. */
export function sleepPolicyOf(settings: Record<string, unknown> | null | undefined): SleepPolicy {
  const maxActive = positive(settings?.maxActiveSandboxes);
  const idleMinutes = positive(settings?.idleSleepMinutes);
  return {
    maxActive: maxActive ? Math.floor(maxActive) : DEFAULT_SLEEP_POLICY.maxActive,
    idleMs: idleMinutes ? idleMinutes * 60_000 : DEFAULT_SLEEP_POLICY.idleMs,
  };
}

/** How long published work is kept, from a Factory's stored settings. */
export function hiddenRefRetentionMsOf(settings: Record<string, unknown> | null | undefined): number {
  return (positive(settings?.hiddenRefRetentionDays) ?? DEFAULT_HIDDEN_REF_RETENTION_DAYS) * 24 * 60 * 60_000;
}

/** The isolation a Factory's stored settings ask for; anything unknown is the default (Seatbelt). */
export function agentIsolationOf(settings: Record<string, unknown> | null | undefined): AgentIsolation {
  const value = settings?.agentIsolation;
  return value === 'user' ? 'user' : DEFAULT_AGENT_ISOLATION;
}
