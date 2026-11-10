import { compileBoardDefinition } from '@factory/core';
import type { BoardPhaseDefinition } from '@factory/core';

export type AuditsBoardPhase = 'scheduled' | 'analysis' | 'report' | 'done' | 'canceled';

/** The session context an audit runs in: one session per card. */
export const AUDIT_CONTEXT = 'audit';

/** The skill that runs an audit; its procedure is the same for every kind of audit. */
export const AUDIT_SKILL = 'audit-run';

/**
 * Audits: read-only analysis of a project, filed by hand or by an intake rule on a schedule. An
 * audit card names its kind (security, dependencies, code quality, docs versus code, performance —
 * see `AUDIT_PROFILES`); the agent reads the repositories and docs, may run read-only scanners,
 * and writes a report to the project docs (`docs/audits/<date>-<topic>.md`) — never code, never a
 * pull request. Analysis starts on its own, so a scheduled card is worked without a person; the
 * report then rests for a person, who files any follow-up work on Development.
 */
export const auditsBoard = compileBoardDefinition<'audits', Record<AuditsBoardPhase, BoardPhaseDefinition<AuditsBoardPhase>>>({
  id: 'audits',
  name: 'Audits',
  initialPhase: 'scheduled',
  phases: {
    scheduled: {
      name: 'Scheduled',
      kind: 'resting',
      description: 'The audit is filed and waits to run; an intake rule moves it straight to Analysis.',
      nextPhases: ['analysis', 'canceled'],
    },
    analysis: {
      name: 'Analysis',
      description:
        'Run the audit its card names: read the code and docs, run read-only checks, rate each finding, write the report. No code changes.',
      kind: 'working',
      runner: { context: AUDIT_CONTEXT, skill: AUDIT_SKILL },
      autoStart: true,
      nextPhases: ['report', 'canceled'],
    },
    report: {
      name: 'Report',
      kind: 'resting',
      description: 'A person reads the report and files follow-up work on Development. Back to Analysis to run it again.',
      nextPhases: ['analysis', 'done', 'canceled'],
    },
    done: {
      name: 'Done',
      kind: 'terminal',
    },
    canceled: {
      name: 'Canceled',
      kind: 'terminal',
      nextPhases: ['scheduled'],
    },
  },
});

export function isAuditsBoardPhase(value: string): value is AuditsBoardPhase {
  return Object.hasOwn(auditsBoard.phases, value);
}
