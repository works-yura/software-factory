import type { ComponentType } from 'react';

import type { InstalledBoardInfo } from '../../../../api/types';

/** What every kind's form gets besides its own config. */
export interface IntakeKindFormContext {
  factoryProjectId: string;
  boards: InstalledBoardInfo[];
  /** The placeholders text templates may use, as the server lists them. */
  placeholders: string[];
}

export interface IntakeKindFormProps {
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  disabled: boolean;
  context: IntakeKindFormContext;
}

/**
 * The editor of one trigger or action kind. The rule editor is generic: it lists the kinds the
 * server can run and shows the registered form of the chosen one. A kind with no form here is
 * listed but cannot be edited in this UI; its rules still show with the server's summary.
 */
export interface IntakeKindForm {
  kind: string;
  /** The config a new rule starts with. */
  defaultConfig: (context: IntakeKindFormContext) => Record<string, unknown>;
  /** Whether the config is complete enough to save; the server checks the rest. */
  ready: (config: Record<string, unknown>) => boolean;
  Form: ComponentType<IntakeKindFormProps>;
}

const triggerForms = new Map<string, IntakeKindForm>();
const actionForms = new Map<string, IntakeKindForm>();

export function registerIntakeTriggerForm(form: IntakeKindForm): () => void {
  triggerForms.set(form.kind, form);
  return () => triggerForms.delete(form.kind);
}

export function registerIntakeActionForm(form: IntakeKindForm): () => void {
  actionForms.set(form.kind, form);
  return () => actionForms.delete(form.kind);
}

export function intakeTriggerForm(kind: string): IntakeKindForm | undefined {
  return triggerForms.get(kind);
}

export function intakeActionForm(kind: string): IntakeKindForm | undefined {
  return actionForms.get(kind);
}
