/**
 * Audit kinds as data. Each profile names one kind of audit the `audit-run` skill knows: its
 * checklist lives in the skill's `references/<reference>` file, and its default severity rule
 * says what counts as urgent. A new kind of audit is one profile here and one reference file —
 * the board, the skill's procedure and the intake rule that files the cards stay as they are.
 */

export type AuditSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const AUDIT_SEVERITIES: readonly AuditSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];

export interface AuditProfile {
  /** The kind a card names in its description (`Аудит: security`). */
  kind: string;
  title: { uk: string; en: string };
  /** The skill reference file with this kind's checklist. */
  reference: string;
  /** Findings at or above this severity make the card need a person (raised in «Потребує вас»). */
  urgentFrom: AuditSeverity;
  /** The report's file name topic: `docs/audits/<date>-<topic>.md`. */
  topic: string;
}

export const AUDIT_PROFILES: readonly AuditProfile[] = [
  {
    kind: 'security',
    title: { uk: 'Безпека', en: 'Security' },
    reference: 'references/security.md',
    urgentFrom: 'high',
    topic: 'security',
  },
  {
    kind: 'dependencies',
    title: { uk: 'Залежності', en: 'Dependencies' },
    reference: 'references/dependencies.md',
    urgentFrom: 'critical',
    topic: 'dependencies',
  },
  {
    kind: 'code-quality',
    title: { uk: 'Якість коду', en: 'Code quality' },
    reference: 'references/code-quality.md',
    urgentFrom: 'critical',
    topic: 'code-quality',
  },
  {
    kind: 'docs-drift',
    title: { uk: 'Документація проти коду', en: 'Docs versus code' },
    reference: 'references/docs-drift.md',
    urgentFrom: 'critical',
    topic: 'docs-drift',
  },
  {
    kind: 'performance',
    title: { uk: 'Продуктивність', en: 'Performance' },
    reference: 'references/performance.md',
    urgentFrom: 'critical',
    topic: 'performance',
  },  {
    kind: 'stability',
    title: { uk: 'Стабільність: логи і креші', en: 'Stability: logs and crashes' },
    reference: 'references/stability.md',
    urgentFrom: 'high',
    topic: 'stability',
  },
];

export function auditProfile(kind: string): AuditProfile | undefined {
  return AUDIT_PROFILES.find(profile => profile.kind === kind);
}

/** Whether a finding of `severity` is urgent under `profile`. */
export function isUrgentFinding(profile: AuditProfile, severity: AuditSeverity): boolean {
  return AUDIT_SEVERITIES.indexOf(severity) <= AUDIT_SEVERITIES.indexOf(profile.urgentFrom);
}
