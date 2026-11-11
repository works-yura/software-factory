import { DEFAULT_BOARD_ID } from '@factory/core/boards/default-board';
import { cardRuleGroupSchema } from '@factory/core/rules/rule-group';
import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { Checkbox } from '@mastra/playground-ui/components/Checkbox';
import { Field, FieldDescription, FieldError, FieldLabel } from '@mastra/playground-ui/components/Field';
import { Input } from '@mastra/playground-ui/components/Input';
import { Notice } from '@mastra/playground-ui/components/Notice';
import { RuleBuilder } from '@mastra/playground-ui/components/RuleBuilder';
import type { RuleBuilderProps } from '@mastra/playground-ui/components/RuleBuilder';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Switch } from '@mastra/playground-ui/components/Switch';
import { Textarea } from '@mastra/playground-ui/components/Textarea';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { SettingsContainer } from '@mastra/playground-ui/new/settings';
import type { TFunction } from 'i18next';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { StoredBoardInfo, StoredPhaseInfo } from '../../../../api/types';
import { useBoardCatalog } from '../../../../hooks/useBoardCatalog';
import { useBoardQuery, useResetBoardMutation, useSaveBoardMutation } from '../../../../hooks/useBoardEditor';
import type { BoardRequestError } from '../../../../hooks/useBoardEditor';
import { useFactorySkillsQuery } from '../../../../hooks/useFactorySkills';
import { boardTitle, phaseTitle } from '../../../i18n/boardLabels';
import { SettingsSubsection } from './SettingsSubsection';

const WORK_BOARD = DEFAULT_BOARD_ID;
const MAX_INSTRUCTIONS = 1000;
const MAX_OBJECTIVE = 2000;
const MAX_GOAL_RUNS = 50;
const NO_SKILL = '__none__';

type CardRule = NonNullable<StoredPhaseInfo['autoStartWhen']>;
type CodeBehaviour = NonNullable<StoredBoardInfo['codeBehaviour']>[string];
type PhaseTool = NonNullable<StoredPhaseInfo['tools']>[number];

/** The Factory tools a phase can grant the session working its cards. */
const PHASE_TOOLS: { id: PhaseTool; label: 'recordVerdict' | 'reviewSource' }[] = [
  { id: 'factory_record_review_verdict', label: 'recordVerdict' },
  { id: 'factory_review_source', label: 'reviewSource' },
];

/** The card facts a phase rule can test (`CARD_RULE_FIELDS`), as the rule builder's field tree. */
function cardFacts(t: TFunction<'settings'>): RuleBuilderProps['schema'] {
  return {
    type: 'object',
    properties: {
      item: {
        type: 'object',
        title: t('workBoard.facts.card'),
        properties: {
          labels: { type: 'string', title: t('workBoard.facts.labels') },
          title: { type: 'string', title: t('workBoard.facts.title') },
          author: { type: 'string', title: t('workBoard.facts.author') },
          pullRequest: { type: 'number', title: t('workBoard.facts.pullRequest') },
        },
      },
      author: {
        type: 'object',
        title: t('workBoard.facts.author'),
        properties: { trusted: { type: 'boolean', title: t('workBoard.facts.trusted') } },
      },
      source: {
        type: 'object',
        title: t('workBoard.facts.source'),
        properties: {
          kind: { type: 'string', title: t('workBoard.facts.kind') },
          integration: { type: 'string', title: t('workBoard.facts.integration') },
        },
      },
    },
  };
}

interface Draft {
  name: string;
  phases: StoredPhaseInfo[];
}

/** Every other phase when `nextPhases` is unset, none from a terminal phase, as the server reads it. */
function nextPhasesOf(phase: StoredPhaseInfo, phases: StoredPhaseInfo[]): string[] {
  if (phase.nextPhases != null) return phase.nextPhases;
  return phase.kind === 'terminal' ? [] : phases.filter(other => other.key !== phase.key).map(other => other.key);
}

type RuleIssue = { path: PropertyKey[]; message: string; code: string; errors?: RuleIssue[][] };

/** Zod issues as `path: message`, following the closest branch of a condition-or-group union. */
function describeIssues(issues: RuleIssue[], prefix: PropertyKey[] = []): string[] {
  return issues.flatMap(issue => {
    const path = [...prefix, ...issue.path];
    if (issue.code === 'invalid_union' && issue.errors?.length) {
      const closest = issue.errors.reduce((best, branch) => (branch.length < best.length ? branch : best));
      return describeIssues(closest, path);
    }
    return [`${path.map(String).join('.') || 'rule'}: ${issue.message}`];
  });
}

/** Why the server would refuse this rule, if it would. */
function validateRule(value: unknown): { rule: CardRule } | { problem: string } {
  const parsed = cardRuleGroupSchema.safeParse(value);
  if (parsed.success) return { rule: parsed.data };
  return { problem: describeIssues(parsed.error.issues).join('; ') };
}

function ruleProblem(rule: CardRule | null | undefined): string | undefined {
  if (rule == null) return undefined;
  const checked = validateRule(rule);
  return 'problem' in checked ? checked.problem : undefined;
}

/**
 * A phase condition, edited with the rule builder or as raw JSON. Unset means "every card".
 * Reports a rule the server would refuse, so the form can hold back the save.
 */
function RuleEditor({
  label,
  description,
  rule,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  rule: CardRule | null | undefined;
  disabled: boolean;
  onChange: (rule: CardRule | null, problem: string | undefined) => void;
}) {
  const { t } = useTranslation('settings');
  const [raw, setRaw] = useState<string | undefined>(undefined);
  const [rawProblem, setRawProblem] = useState<string | undefined>(undefined);
  const id = useId();
  const problem = raw === undefined ? ruleProblem(rule) : rawProblem;

  const editRaw = (text: string) => {
    setRaw(text);
    if (text.trim() === '') {
      setRawProblem(undefined);
      onChange(null, undefined);
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      setRawProblem(t('workBoard.rule.invalidJson'));
      onChange(rule ?? null, t('workBoard.rule.invalidJson'));
      return;
    }
    const checked = validateRule(value);
    if ('problem' in checked) {
      setRawProblem(checked.problem);
      onChange(rule ?? null, checked.problem);
      return;
    }
    setRawProblem(undefined);
    onChange(checked.rule, undefined);
  };

  return (
    <Field invalid={problem !== undefined}>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            setRawProblem(undefined);
            if (raw === undefined) {
              setRaw(rule ? JSON.stringify(rule, null, 2) : '');
              return;
            }
            setRaw(undefined);
            // The builder edits the last valid rule, so JSON that never parsed no longer holds the save.
            onChange(rule ?? null, ruleProblem(rule));
          }}
        >
          {raw === undefined ? t('workBoard.rule.editJson') : t('workBoard.rule.useBuilder')}
        </Button>
      </div>
      <FieldDescription>{description}</FieldDescription>
      {raw !== undefined ? (
        <Textarea
          id={id}
          aria-label={t('workBoard.rule.jsonLabel', { label })}
          value={raw}
          disabled={disabled}
          rows={6}
          onChange={event => editRaw(event.target.value)}
        />
      ) : disabled ? (
        <Txt id={id} as="p" variant="caption" tone="muted">
          {rule ? JSON.stringify(rule) : t('workBoard.rule.everyCard')}
        </Txt>
      ) : (
        <div id={id}>
          <RuleBuilder
            schema={cardFacts(t)}
            // Factory's rule groups have the builder's shape; the server validates the depth.
            ruleGroup={(rule ?? undefined) as RuleBuilderProps['ruleGroup']}
            onChange={next => {
              const value = (next ?? null) as CardRule | null;
              onChange(value, ruleProblem(value));
            }}
          />
        </div>
      )}
      {problem && <FieldError>{problem}</FieldError>}
    </Field>
  );
}

function PhaseEditor({
  boardKey,
  phase,
  phases,
  code,
  skills,
  disabled,
  onChange,
  onRuleProblem,
}: {
  /** Board the phase belongs to: built-in phases show their translated names. */
  boardKey: string;
  phase: StoredPhaseInfo;
  phases: StoredPhaseInfo[];
  code: CodeBehaviour | undefined;
  skills: string[];
  disabled: boolean;
  onChange: (phase: StoredPhaseInfo) => void;
  onRuleProblem: (field: string, problem: string | undefined) => void;
}) {
  const { t } = useTranslation('settings');
  const id = useId();
  const working = phase.kind === 'working';
  const title = (p: StoredPhaseInfo) => phaseTitle(boardKey, p.key, p.name);
  const next = nextPhasesOf(phase, phases);
  const required = new Set(code?.requiredNextPhases ?? []);
  const instructions = phase.runner?.instructions ?? '';
  const exitToolId = phase.exitTool?.id ?? '';
  const goal = phase.runner?.goal;
  const objective = goal?.objective ?? '';
  const tools = phase.tools ?? [];
  const skillOptions =
    phase.runner?.skill && !skills.includes(phase.runner.skill) ? [phase.runner.skill, ...skills] : skills;
  const setRunner = (runner: Partial<NonNullable<StoredPhaseInfo['runner']>>) => {
    const merged = { ...phase.runner, ...runner };
    const cleaned = Object.fromEntries(Object.entries(merged).filter(([, value]) => value != null && value !== ''));
    onChange({ ...phase, runner: Object.keys(cleaned).length > 0 ? cleaned : null });
  };

  return (
    <SettingsContainer>
      <section aria-label={t('workBoard.phase.label', { name: title(phase) })} className="flex flex-col gap-4 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Txt tone="ink" as="h4" variant="body" className="m-0">
            {title(phase)}
          </Txt>
          <Txt font="mono" tone="muted" as="span" variant="caption">
            {phase.key}
          </Txt>
          <Badge>{t(`workBoard.phase.kinds.${phase.kind}`)}</Badge>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${id}-name`}>{t('workBoard.phase.name')}</FieldLabel>
            <Input
              id={`${id}-name`}
              value={phase.name}
              disabled={disabled}
              onChange={event => onChange({ ...phase, name: event.target.value })}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-description`}>{t('workBoard.phase.description')}</FieldLabel>
            <Input
              id={`${id}-description`}
              value={phase.description ?? ''}
              disabled={disabled}
              onChange={event => onChange({ ...phase, description: event.target.value || null })}
            />
          </Field>
        </div>

        {working && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`${id}-skill`}>{t('workBoard.phase.skill')}</FieldLabel>
                <Select
                  value={phase.runner?.skill ?? NO_SKILL}
                  disabled={disabled}
                  onValueChange={value => setRunner({ skill: value === NO_SKILL ? undefined : String(value) })}
                >
                  <SelectTrigger id={`${id}-skill`} size="sm" aria-label={t('workBoard.phase.skillOf', { name: title(phase) })}>
                    {phase.runner?.skill ?? t('workBoard.phase.none')}
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_SKILL}>{t('workBoard.phase.none')}</SelectItem>
                    {skillOptions.map(skill => (
                      <SelectItem key={skill} value={skill}>
                        {skill}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-context`}>{t('workBoard.phase.context')}</FieldLabel>
                <Input
                  id={`${id}-context`}
                  value={phase.runner?.context ?? ''}
                  placeholder="work"
                  disabled={disabled}
                  onChange={event => setRunner({ context: event.target.value })}
                />
              </Field>
            </div>
            <Field invalid={instructions.length > MAX_INSTRUCTIONS}>
              <FieldLabel htmlFor={`${id}-instructions`}>{t('workBoard.phase.instructions')}</FieldLabel>
              <FieldDescription>
                {t('workBoard.phase.instructionsHint', { count: instructions.length, max: MAX_INSTRUCTIONS })}
              </FieldDescription>
              <Textarea
                id={`${id}-instructions`}
                value={instructions}
                maxLength={MAX_INSTRUCTIONS}
                rows={3}
                disabled={disabled}
                onChange={event => setRunner({ instructions: event.target.value })}
              />
            </Field>
            <Field invalid={objective.length > MAX_OBJECTIVE}>
              <FieldLabel htmlFor={`${id}-goal`}>{t('workBoard.phase.goal')}</FieldLabel>
              <FieldDescription>
                {t('workBoard.phase.goalHint', { count: objective.length, max: MAX_OBJECTIVE })}
              </FieldDescription>
              <Textarea
                id={`${id}-goal`}
                value={objective}
                maxLength={MAX_OBJECTIVE}
                rows={4}
                disabled={disabled}
                onChange={event => {
                  const text = event.target.value;
                  setRunner({ goal: text.trim() ? { ...goal, objective: text } : undefined });
                }}
              />
            </Field>
            {goal && (
              <Field>
                <FieldLabel htmlFor={`${id}-goal-runs`}>{t('workBoard.phase.goalRuns')}</FieldLabel>
                <FieldDescription>{t('workBoard.phase.goalRunsHint', { max: MAX_GOAL_RUNS })}</FieldDescription>
                <Input
                  id={`${id}-goal-runs`}
                  type="number"
                  min={1}
                  max={MAX_GOAL_RUNS}
                  value={goal.maxRuns ?? ''}
                  disabled={disabled}
                  onChange={event => {
                    const runs = Number.parseInt(event.target.value, 10);
                    const { maxRuns: _maxRuns, ...rest } = goal;
                    setRunner({ goal: Number.isInteger(runs) ? { ...rest, maxRuns: runs } : rest });
                  }}
                />
              </Field>
            )}

            <Field orientation="horizontal" className="items-start gap-4">
              <div className="flex flex-1 flex-col gap-1">
                <FieldLabel htmlFor={`${id}-auto-start`}>{t('workBoard.phase.autoStart')}</FieldLabel>
                <FieldDescription>{t('workBoard.phase.autoStartHint')}</FieldDescription>
              </div>
              <Switch
                id={`${id}-auto-start`}
                aria-label={t('workBoard.phase.autoStartOf', { name: title(phase) })}
                checked={phase.autoStart ?? false}
                disabled={disabled}
                onCheckedChange={checked => {
                  onChange({ ...phase, autoStart: checked, autoStartWhen: checked ? phase.autoStartWhen : null });
                  if (!checked) onRuleProblem('autoStartWhen', undefined);
                }}
              />
            </Field>
            {phase.autoStart && (
              <RuleEditor
                label={t('workBoard.phase.autoStartWhen', { name: title(phase) })}
                description={t('workBoard.phase.autoStartWhenHint')}
                rule={phase.autoStartWhen}
                disabled={disabled}
                onChange={(rule, problem) => {
                  onChange({ ...phase, autoStartWhen: rule });
                  onRuleProblem('autoStartWhen', problem);
                }}
              />
            )}

            <Field>
              <FieldLabel htmlFor={`${id}-exit-tool`}>{t('workBoard.phase.exitTool')}</FieldLabel>
              <FieldDescription>{t('workBoard.phase.exitToolHint')}</FieldDescription>
              <Input
                id={`${id}-exit-tool`}
                value={exitToolId}
                disabled={disabled}
                onChange={event => {
                  const value = event.target.value.trim();
                  onChange({ ...phase, exitTool: value ? { ...phase.exitTool, id: value } : null });
                  if (!value) onRuleProblem('autoApproveWhen', undefined);
                }}
              />
            </Field>
            {exitToolId !== '' && (
              <Field orientation="horizontal" className="items-start gap-4">
                <div className="flex flex-1 flex-col gap-1">
                  <FieldLabel htmlFor={`${id}-auto-approve`}>{t('workBoard.phase.autoApprove')}</FieldLabel>
                  <FieldDescription>{t('workBoard.phase.autoApproveHint', { tool: exitToolId })}</FieldDescription>
                </div>
                <Switch
                  id={`${id}-auto-approve`}
                  aria-label={t('workBoard.phase.autoApproveOf', { name: title(phase), tool: exitToolId })}
                  checked={phase.exitTool?.autoApprove ?? false}
                  disabled={disabled}
                  onCheckedChange={checked => {
                    onChange({
                      ...phase,
                      exitTool: {
                        ...phase.exitTool,
                        id: exitToolId,
                        autoApprove: checked,
                        autoApproveWhen: checked ? phase.exitTool?.autoApproveWhen : undefined,
                      },
                    });
                    if (!checked) onRuleProblem('autoApproveWhen', undefined);
                  }}
                />
              </Field>
            )}
            {exitToolId !== '' && phase.exitTool?.autoApprove && (
              <RuleEditor
                label={t('workBoard.phase.autoApproveWhen', { name: title(phase) })}
                description={t('workBoard.phase.autoApproveWhenHint')}
                rule={phase.exitTool.autoApproveWhen}
                disabled={disabled}
                onChange={(rule, problem) => {
                  onChange({
                    ...phase,
                    exitTool: {
                      ...phase.exitTool,
                      id: exitToolId,
                      autoApprove: true,
                      autoApproveWhen: rule ?? undefined,
                    },
                  });
                  onRuleProblem('autoApproveWhen', problem);
                }}
              />
            )}
            <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
              <legend>
                <Txt as="span" variant="caption" tone="ink">
                  {t('workBoard.phase.tools')}
                </Txt>
              </legend>
              <Txt as="p" variant="caption" tone="muted">
                {t('workBoard.phase.toolsHint')}
              </Txt>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {PHASE_TOOLS.map(tool => (
                  <label key={tool.id} className="flex items-center gap-2">
                    <Checkbox
                      aria-label={`${phase.name}: ${t(`workBoard.phase.toolLabels.${tool.label}`)}`}
                      checked={tools.includes(tool.id)}
                      disabled={disabled}
                      onCheckedChange={checked => {
                        const chosen = PHASE_TOOLS.map(({ id: key }) => key).filter(key =>
                          key === tool.id ? checked === true : tools.includes(key),
                        );
                        onChange({ ...phase, tools: chosen.length > 0 ? chosen : null });
                      }}
                    />
                    <Txt as="span" variant="caption">
                      {t(`workBoard.phase.toolLabels.${tool.label}`)}
                    </Txt>
                  </label>
                ))}
              </div>
            </fieldset>
          </>
        )}

        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend>
            <Txt as="span" variant="caption" tone="ink">
              {t('workBoard.phase.nextPhases')}
            </Txt>
          </legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {phases
              .filter(other => other.key !== phase.key)
              .map(other => (
                <label key={other.key} className="flex items-center gap-2">
                  <Checkbox
                    aria-label={t('workBoard.phase.movesTo', { from: title(phase), to: title(other) })}
                    checked={next.includes(other.key)}
                    disabled={disabled || required.has(other.key)}
                    onCheckedChange={checked =>
                      onChange({
                        ...phase,
                        nextPhases: checked
                          ? phases.filter(p => p.key === other.key || next.includes(p.key)).map(p => p.key)
                          : next.filter(key => key !== other.key),
                      })
                    }
                  />
                  <Txt as="span" variant="caption">
                    {title(other)}
                  </Txt>
                </label>
              ))}
          </div>
        </fieldset>
      </section>
    </SettingsContainer>
  );
}

function errorText(error: BoardRequestError): string {
  return error.conflicts.length > 0 ? error.conflicts.join('\n') : error.message;
}

function BoardEditor({
  factoryId,
  boardKey,
  board,
  canEdit,
  onReload,
}: {
  factoryId: string;
  boardKey: string;
  board: StoredBoardInfo;
  canEdit: boolean;
  onReload: () => void;
}) {
  const { t } = useTranslation('settings');
  const [draft, setDraft] = useState<Draft>({ name: board.name, phases: board.phases });
  const [ruleProblems, setRuleProblems] = useState<Record<string, string>>({});
  const save = useSaveBoardMutation(factoryId, boardKey);
  const reset = useResetBoardMutation(factoryId, boardKey);
  const skills = (useFactorySkillsQuery(factoryId).data?.skills ?? []).map(skill => skill.name);
  const id = useId();
  const readOnly = !canEdit || !board.editable;
  const changed = JSON.stringify(draft) !== JSON.stringify({ name: board.name, phases: board.phases });
  const blocked = Object.keys(ruleProblems).length > 0;
  const error = save.error ?? reset.error;
  const stale = error?.code === 'revision_mismatch';
  const pending = save.isPending || reset.isPending;
  // Only the read-only Review board has no revision, and it can't be saved or reset.
  const revision = board.revision ?? 0;

  const setPhase = (phase: StoredPhaseInfo) =>
    setDraft(current => ({ ...current, phases: current.phases.map(p => (p.key === phase.key ? phase : p)) }));
  const setRuleProblem = (key: string, field: string, problem: string | undefined) =>
    setRuleProblems(current => {
      const { [`${key}.${field}`]: _previous, ...rest } = current;
      return problem ? { ...rest, [`${key}.${field}`]: problem } : rest;
    });

  return (
    <div className="flex flex-col gap-4">
      {readOnly && (
        <Notice variant="info">
          {board.editable
            ? t('workBoard.adminsOnly')
            : t('workBoard.readOnly')}
        </Notice>
      )}
      {board.problems.map(problem => (
        <Notice key={problem} variant="warning">
          {problem}
        </Notice>
      ))}
      <div className="flex flex-wrap items-end gap-4">
        <Field className="min-w-60 flex-1">
          <FieldLabel htmlFor={`${id}-board-name`}>{t('workBoard.boardName')}</FieldLabel>
          <Input
            id={`${id}-board-name`}
            value={draft.name}
            disabled={readOnly}
            onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}
          />
        </Field>
        <Txt as="span" variant="caption" tone="muted" className="tabular-nums">
          {t('workBoard.revision', { revision: board.revision })}
        </Txt>
      </div>
      <div className="flex flex-col gap-3">
        {draft.phases.map(phase => (
          <PhaseEditor
            key={phase.key}
            boardKey={boardKey}
            phase={phase}
            phases={draft.phases}
            code={board.codeBehaviour?.[phase.key]}
            skills={skills}
            disabled={readOnly || pending}
            onChange={setPhase}
            onRuleProblem={(field, problem) => setRuleProblem(phase.key, field, problem)}
          />
        ))}
      </div>
      {stale && (
        <Notice
          variant="warning"
          title={t('workBoard.staleTitle')}
          action={
            <Button size="sm" onClick={onReload}>
              {t('workBoard.reload')}
            </Button>
          }
        >
          {t('workBoard.staleDescription')}
        </Notice>
      )}
      {error && !stale && (
        // v4's Notice does not pass `role` through, so the alert wraps it.
        <div role="alert">
          <Notice variant="destructive" title={t('workBoard.notSaved')}>
            <span className="whitespace-pre-wrap">{errorText(error)}</span>
          </Notice>
        </div>
      )}
      {!readOnly && (
        <div className="flex justify-end gap-2">
          <Button
            disabled={pending}
            onClick={() => {
              save.reset();
              reset.mutate(revision);
            }}
          >
            {t('workBoard.reset')}
          </Button>
          <Button
            variant="primary"
            disabled={!changed || blocked || pending || instructionsTooLong(draft)}
            onClick={() => {
              reset.reset();
              save.mutate({ name: draft.name, phases: draft.phases, expectedRevision: revision });
            }}
          >
            {t('workBoard.save')}
          </Button>
        </div>
      )}
    </div>
  );
}

function instructionsTooLong(draft: Draft): boolean {
  return draft.phases.some(
    phase =>
      (phase.runner?.instructions?.length ?? 0) > MAX_INSTRUCTIONS ||
      (phase.runner?.goal?.objective.length ?? 0) > MAX_OBJECTIVE,
  );
}

/**
 * The project's Work board as stored: each phase's name, runner (skill, context, instructions,
 * goal), automation, exit tool, Factory tools and next phases. Organization admins edit it or reset it to Factory's default; the moves the
 * board's code makes stay checked.
 */
function BoardSection({ factoryId, boardKey }: { factoryId?: string; boardKey: string }) {
  const { t } = useTranslation('settings');
  const query = useBoardQuery(factoryId, boardKey);
  const data = query.data;

  return (
    <SettingsSubsection
      scope="factory"
      title={boardTitle(boardKey, data?.board.name ?? boardKey)}
      description={t('workBoard.description')}
    >
      {query.isPending && factoryId && (
        <Txt tone="muted" as="p" variant="caption" role="status">
          {t('workBoard.loading')}
        </Txt>
      )}
      {!factoryId && <Notice variant="info">{t('workBoard.openFactory')}</Notice>}
      {query.error && <Notice variant="destructive">{query.error.message}</Notice>}
      {factoryId && data && (
        <BoardEditor
          // A new revision (saved, reset or reloaded) starts a fresh draft.
          key={data.board.revision ?? 'code'}
          factoryId={factoryId}
          boardKey={boardKey}
          board={data.board}
          canEdit={data.canEdit ?? false}
          onReload={() => void query.refetch()}
        />
      )}
    </SettingsSubsection>
  );
}

/** Every board of the project, Work first as the catalog serves it, each edited on its own. */
export function WorkBoardSection({ factoryId }: { factoryId?: string }) {
  const catalog = useBoardCatalog(factoryId);
  const boardKeys = catalog.data?.map(board => board.id) ?? [WORK_BOARD];
  return (
    <>
      {boardKeys.map(boardKey => (
        <BoardSection key={boardKey} factoryId={factoryId} boardKey={boardKey} />
      ))}
    </>
  );
}
