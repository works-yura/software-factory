import { compileBoardDefinition } from '@factory/core';
import type { BoardPhaseDefinition } from '@factory/core';

export type AuditsBoardPhase = 'intake' | 'analysis' | 'done' | 'canceled';

/**
 * Phases the Audits board had in its first release and what each became: it now starts in Intake
 * like every board, and Done means the report is written. Stored boards, cards, intake routes and
 * intake rules naming an old phase are moved onto the new one once, at startup.
 */
export const AUDITS_LEGACY_PHASE_RENAMES: Readonly<Record<string, AuditsBoardPhase>> = {
  scheduled: 'intake',
  report: 'done',
};

/** The session context an audit runs in: one session per card. */
export const AUDIT_CONTEXT = 'audit';

/** The skill that runs an audit; its procedure is the same for every kind of audit. */
export const AUDIT_SKILL = 'audit-run';

/**
 * Audits: read-only analysis of a project, filed by hand or by an intake rule on a schedule. An
 * audit card names its kind (security, dependencies, code quality, docs versus code, performance —
 * see `AUDIT_PROFILES`); the agent reads the repositories and docs, may run read-only scanners,
 * and writes a report to the project docs (`docs/audits/<date>-<topic>.md`) — never code, never a
 * pull request. Like every board it starts in Intake; Analysis starts on its own, so a card an
 * intake rule moves there is worked without a person. Done means the report is written; a person
 * files any follow-up work on Development.
 */
export const auditsBoard = compileBoardDefinition<'audits', Record<AuditsBoardPhase, BoardPhaseDefinition<AuditsBoardPhase>>>({
  id: 'audits',
  name: 'Audits',
  initialPhase: 'intake',
  phases: {
    intake: {
      name: 'Intake',
      kind: 'resting',
      description: 'The audit is filed and waits to run; an intake rule moves it straight to Analysis.',
      nextPhases: ['analysis', 'canceled'],
    },
    analysis: {
      name: 'Analysis',
      description:
        'Run the audit its card names: read the code and docs, run read-only checks, rate each finding, write the report, then move the card to Done. No code changes.',
      kind: 'working',
      runner: { context: AUDIT_CONTEXT, skill: AUDIT_SKILL },
      autoStart: true,
      nextPhases: ['done', 'canceled'],
    },
    done: {
      name: 'Done',
      kind: 'terminal',
      description: 'The report is written. Back to Analysis to run the audit again.',
      nextPhases: ['analysis'],
    },
    canceled: {
      name: 'Canceled',
      kind: 'terminal',
      nextPhases: ['intake'],
    },
  },
});

export function isAuditsBoardPhase(value: string): value is AuditsBoardPhase {
  return Object.hasOwn(auditsBoard.phases, value);
}
