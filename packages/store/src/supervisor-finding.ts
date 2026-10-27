// Shape of a Supervisor health finding as WorkItemsStorage persists it. Copied from v3 supervisor/health.ts.

export type FactoryHealthFindingKind =
  | 'decision-stuck'
  | 'start-stalled'
  | 'seat-orphaned'
  | 'seat-missing'
  | 'held-waiting'
  | 'label-drift';

export type FactoryHealthRepair =
  | { action: 'revoke-binding'; bindingId: string }
  | { action: 'accept-work-item'; workItemId: string }
  | { action: 'start-run'; workItemId: string; role: string }
  | { action: 'reconcile-labels'; workItemId: string };

export interface FactoryHealthFinding {
  kind: FactoryHealthFindingKind;
  /** Stable per (kind, subject) so the UI and attention inbox can dedupe. */
  id: string;
  workItemId: string | null;
  /** Card number as shown on the board, when the row carries one. */
  workItemNumber: number | null;
  title: string;
  /** One sentence of grounded evidence: ids, timestamps, error text. */
  evidence: string;
  /** ISO instant the condition began, when it is age-based. */
  beganAt: string | null;
  suggestedRepair: FactoryHealthRepair | null;
}
