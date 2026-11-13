import { Badge } from '@mastra/playground-ui/components/Badge';
import { Button } from '@mastra/playground-ui/components/Button';
import { Input } from '@mastra/playground-ui/components/Input';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Switch } from '@mastra/playground-ui/components/Switch';
import { Textarea } from '@mastra/playground-ui/components/Textarea';
import { cardRuleGroupSchema } from '@factory/core/rules/rule-group';
import { SettingsContainer, SettingsRow } from '@mastra/playground-ui/new/settings';

import { BookOpen, Bot, FileText, Flag, Pencil, Play, Route, Trash2 } from 'lucide-react';
import { useState } from 'react';

import type { FactorySkillInfo, StoredPhaseInfo } from '../../../../api/types';
import { FactorySkillEditorDialog } from '../../settings/components/FactorySkillEditorDialog';
import { RuleEditor } from '../../settings/components/RuleEditor';
import { SettingsSubsection } from '../../settings/components/SettingsSubsection';
import {
  MAX_GOAL_RUNS,
  MAX_INSTRUCTIONS,
  MAX_OBJECTIVE,
  PHASE_TOOLS,
  goalRunsValid,
  nextPhasesOf,
  phaseToolLabel,
} from '../boardDraft';
import { translator } from '../../../i18n/t';
import type { RuleField } from '../boardDraft';
import { PhaseMoves } from './PhaseMoves';
import { PhaseStep, PhaseSteps } from './PhaseSteps';

const tk = translator('boardConfig');

const NO_SKILL = '__none__';
/** Side controls share one width, so their left edges line up down the page. */
const CONTROL_WIDTH = 'sm:w-56 sm:shrink-0';
/** A counter only shows once its limit is near. */
const countNear = (length: number, max: number) => (length >= max - 200 ? ` ${length}/${max}` : '');

/** Runner context a phase gets when it names none. */
const DEFAULT_SESSION = 'work';

/** A skill's name with the same status badges as the Skills page. */
function SkillName({ name, skill, missing = false }: { name: string; skill?: FactorySkillInfo; missing?: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <BookOpen aria-hidden className="text-muted-foreground size-4 shrink-0" />
      {name}
      {missing && <Badge variant="destructive">{tk('skill.notFound')}</Badge>}
      {skill?.error && <Badge variant="destructive">{tk('skill.failedToLoad')}</Badge>}
      {skill?.builtIn && skill.origin !== undefined && skill.origin !== 'bundled' && (
        <Badge>{tk('skill.overridden')}</Badge>
      )}
      {skill?.edited && <Badge>{tk('skill.edited')}</Badge>}
    </span>
  );
}

/** One phase's settings, in the order a card meets them: how it starts, what the agent runs, how it ends and where it goes. */
export function PhaseConfig({
  phase,
  phases,
  requiredNextPhases,
  skills,
  skillsEditable,
  factoryId,
  boardId,
  disabled,
  rawRules,
  onChange,
  onRawRule,
  onUnfinished,
  onRemove,
}: {
  phase: StoredPhaseInfo;
  phases: StoredPhaseInfo[];
  /** Moves Factory's code makes from this phase, which stay allowed. */
  requiredNextPhases: readonly string[];
  /** The factory's skills; undefined until they load, so a skill is never flagged missing early. */
  skills: FactorySkillInfo[] | undefined;
  /** Whether the user may edit the factory's skills, which is separate from editing the board. */
  skillsEditable: boolean;
  factoryId: string;
  boardId: string;
  disabled: boolean;
  /** JSON typed for this phase's rules, by field. */
  rawRules: Partial<Record<RuleField, string>>;
  onChange: (phase: StoredPhaseInfo) => void;
  onRawRule: (field: RuleField, text: string | undefined) => void;
  /** Whether a rule's condition rows hold a half-filled row, which holds the board's save until it is finished. */
  onUnfinished: (field: RuleField, unfinished: boolean) => void;
  /** Unset when the phase can't be removed. */
  onRemove?: () => void;
}) {
  const working = phase.kind === 'working';
  const next = nextPhasesOf(phase, phases);
  const instructions = phase.runner?.instructions ?? '';
  const goal = phase.runner?.goal;
  const objective = goal?.objective ?? '';
  const tools = phase.tools ?? [];
  const exitToolId = phase.exitTool?.id ?? '';
  const skillName = phase.runner?.skill;
  const skill = skillName ? skills?.find(candidate => candidate.name === skillName) : undefined;
  const skillMissing = skillName !== undefined && skills !== undefined && skill === undefined;
  const [openSkill, setOpenSkill] = useState<FactorySkillInfo>();

  const setRunner = (runner: Partial<NonNullable<StoredPhaseInfo['runner']>>) => {
    const merged = { ...phase.runner, ...runner };
    const cleaned = Object.fromEntries(Object.entries(merged).filter(([, value]) => value != null && value !== ''));
    onChange({ ...phase, runner: Object.keys(cleaned).length > 0 ? cleaned : null });
  };
  const json = (field: RuleField) => ({
    text: rawRules[field],
    onChange: (text: string | undefined) => onRawRule(field, text),
  });

  const moves = (
    <PhaseMoves
      phase={phase}
      phases={phases}
      next={next}
      required={new Set(requiredNextPhases)}
      boardId={boardId}
      disabled={disabled}
      onChange={nextPhases => onChange({ ...phase, nextPhases })}
    />
  );
  const remove = onRemove && (
    <div>
      <Button variant="ghost" icon={<Trash2 />} onClick={onRemove}>
        {tk('phase.remove', { name: phase.name })}
      </Button>
    </div>
  );

  if (!working) {
    return (
      <div className="flex flex-col gap-8">
        <SettingsSubsection title={tk('phase.allowedMoves')}>{moves}</SettingsSubsection>
        {remove}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <PhaseSteps label={tk('phase.howItRuns', { name: phase.name })}>
        <PhaseStep icon={<Play />} title={tk('phase.starts')}>
          <SettingsContainer>
            <SettingsRow label={tk('phase.autoStart')} disabled={disabled}>
              <Switch
                aria-label={tk('phase.autoStartOf', { name: phase.name })}
                checked={phase.autoStart ?? false}
                disabled={disabled}
                onCheckedChange={checked => {
                  onChange({ ...phase, autoStart: checked, autoStartWhen: checked ? phase.autoStartWhen : null });
                  if (!checked) onRawRule('autoStartWhen', undefined);
                }}
              />
            </SettingsRow>
            {phase.autoStart && (
              <div className="px-4 py-3">
                <RuleEditor
                  label={tk('phase.autoStartWhen', { name: phase.name })}
                  description={tk('phase.autoStartWhenHint')}
                  rule={phase.autoStartWhen}
                  schema={cardRuleGroupSchema}
                  disabled={disabled}
                  json={json('autoStartWhen')}
                  onUnfinished={unfinished => onUnfinished('autoStartWhen', unfinished)}
                  onChange={rule => onChange({ ...phase, autoStartWhen: rule })}
                />
              </div>
            )}
          </SettingsContainer>
        </PhaseStep>

        <PhaseStep icon={<Bot />} title={tk('phase.agentRuns')}>
          <SettingsContainer>
            <SettingsRow
              label={tk('phase.instructions')}
              description={`${tk('phase.instructionsHint')}${countNear(instructions.length, MAX_INSTRUCTIONS)}`}
              errorMsg={instructions.length > MAX_INSTRUCTIONS ? tk('phase.tooLong') : undefined}
              disabled={disabled}
              className="sm:flex-col sm:items-stretch"
            >
              <Textarea
                aria-label={tk('phase.instructionsOf', { name: phase.name })}
                value={instructions}
                maxLength={MAX_INSTRUCTIONS}
                rows={4}
                disabled={disabled}
                onChange={event => setRunner({ instructions: event.target.value })}
              />
            </SettingsRow>
            <SettingsRow
              label={tk('phase.goal')}
              description={`${tk('phase.goalHint')}${countNear(objective.length, MAX_OBJECTIVE)}`}
              errorMsg={objective.length > MAX_OBJECTIVE ? tk('phase.tooLong') : undefined}
              disabled={disabled}
              className="sm:flex-col sm:items-stretch"
            >
              <Textarea
                aria-label={tk('phase.goalOf', { name: phase.name })}
                value={objective}
                maxLength={MAX_OBJECTIVE}
                rows={4}
                disabled={disabled}
                onChange={event => {
                  const text = event.target.value;
                  setRunner({ goal: text.trim() ? { ...goal, objective: text } : undefined });
                }}
              />
            </SettingsRow>
            {goal && (
              <SettingsRow
                label={tk('phase.goalRuns')}
                description={tk('phase.goalRunsHint', { max: MAX_GOAL_RUNS })}
                errorMsg={goalRunsValid(goal.maxRuns) ? undefined : tk('phase.goalRunsInvalid', { max: MAX_GOAL_RUNS })}
                disabled={disabled}
              >
                <Input
                  size="sm"
                  type="number"
                  min={1}
                  max={MAX_GOAL_RUNS}
                  className={CONTROL_WIDTH}
                  aria-label={tk('phase.goalRunsOf', { name: phase.name })}
                  value={goal.maxRuns ?? ''}
                  disabled={disabled}
                  onChange={event => {
                    const runs = Number.parseInt(event.target.value, 10);
                    const { maxRuns: _maxRuns, ...rest } = goal;
                    setRunner({ goal: Number.isInteger(runs) ? { ...rest, maxRuns: runs } : rest });
                  }}
                />
              </SettingsRow>
            )}
            <SettingsRow
              label={tk('phase.session')}
              description={tk('phase.sessionHint')}
              disabled={disabled}
            >
              <Input
                size="sm"
                className={CONTROL_WIDTH}
                aria-label={tk('phase.sessionOf', { name: phase.name })}
                value={phase.runner?.context ?? ''}
                placeholder={DEFAULT_SESSION}
                disabled={disabled}
                onChange={event => setRunner({ context: event.target.value })}
              />
            </SettingsRow>
          </SettingsContainer>

          <SettingsSubsection title={tk('phase.skill')}>
            <SettingsContainer>
              <SettingsRow
                label={<SkillName name={skillName ?? tk('phase.none')} skill={skill} missing={skillMissing} />}
                description={skill?.error ? undefined : skill?.description}
                errorMsg={
                  skill?.error
                    ? tk('skill.loadError', { error: skill.error })
                    : skillMissing
                      ? tk('skill.missing', { skill: skillName, phase: phase.name })
                      : undefined
                }
                disabled={disabled}
              >
                <div className="flex items-center gap-2">
                  <Select
                    value={skillName ?? NO_SKILL}
                    disabled={disabled}
                    onValueChange={value => setRunner({ skill: value === NO_SKILL ? undefined : String(value) })}
                  >
                    <SelectTrigger size="sm" aria-label={tk('phase.skillOf', { name: phase.name })}>
                      {tk('phase.change')}
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_SKILL}>{tk('phase.none')}</SelectItem>
                      {(skills ?? []).map(candidate => (
                        <SelectItem key={candidate.name} value={candidate.name}>
                          {candidate.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {skill && (
                    <Button
                      size="sm"
                      icon={skillsEditable ? <Pencil /> : <FileText />}
                      aria-label={skillsEditable ? tk('skill.editOf', { name: skill.name }) : tk('skill.viewOf', { name: skill.name })}
                      onClick={() => setOpenSkill(skill)}
                    >
                      {skillsEditable ? tk('skill.edit') : tk('skill.view')}
                    </Button>
                  )}
                </div>
              </SettingsRow>
            </SettingsContainer>
          </SettingsSubsection>

          <SettingsSubsection
            title={tk('phase.tools')}
            description={tk('phase.toolsHint')}
          >
            <SettingsContainer>
              {PHASE_TOOLS.map(tool => (
                <SettingsRow key={tool.id} label={phaseToolLabel(tool)} disabled={disabled}>
                  <Switch
                    aria-label={tk('phase.toolOf', { name: phase.name, tool: phaseToolLabel(tool) })}
                    checked={tools.includes(tool.id)}
                    disabled={disabled}
                    onCheckedChange={checked => {
                      const chosen = PHASE_TOOLS.map(({ id }) => id).filter(id =>
                        id === tool.id ? checked : tools.includes(id),
                      );
                      onChange({ ...phase, tools: chosen.length > 0 ? chosen : null });
                    }}
                  />
                </SettingsRow>
              ))}
            </SettingsContainer>
          </SettingsSubsection>
        </PhaseStep>

        <PhaseStep icon={<Flag />} title={tk('phase.ends')}>
          <SettingsContainer>
            <SettingsRow
              label={tk('phase.exitTool')}
              description={tk('phase.exitToolHint')}
              disabled={disabled}
            >
              <Input
                size="sm"
                className={CONTROL_WIDTH}
                aria-label={tk('phase.exitToolOf', { name: phase.name })}
                value={exitToolId}
                disabled={disabled}
                onChange={event => {
                  const value = event.target.value.trim();
                  onChange({ ...phase, exitTool: value ? { ...phase.exitTool, id: value } : null });
                  if (!value) onRawRule('autoApproveWhen', undefined);
                }}
              />
            </SettingsRow>
            {exitToolId !== '' && (
              <SettingsRow label={tk('phase.autoApprove')} disabled={disabled}>
                <Switch
                  aria-label={tk('phase.autoApproveOf', { name: phase.name, tool: exitToolId })}
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
                    if (!checked) onRawRule('autoApproveWhen', undefined);
                  }}
                />
              </SettingsRow>
            )}
            {exitToolId !== '' && phase.exitTool?.autoApprove && (
              <div className="px-4 py-3">
                <RuleEditor
                  label={tk('phase.autoApproveWhen', { name: phase.name })}
                  description={tk('phase.autoApproveWhenHint')}
                  rule={phase.exitTool.autoApproveWhen}
                  schema={cardRuleGroupSchema}
                  disabled={disabled}
                  json={json('autoApproveWhen')}
                  onUnfinished={unfinished => onUnfinished('autoApproveWhen', unfinished)}
                  onChange={rule =>
                    onChange({
                      ...phase,
                      exitTool: {
                        ...phase.exitTool,
                        id: exitToolId,
                        autoApprove: true,
                        autoApproveWhen: rule ?? undefined,
                      },
                    })
                  }
                />
              </div>
            )}
          </SettingsContainer>
        </PhaseStep>

        <PhaseStep icon={<Route />} title={tk('phase.allowedMoves')}>
          {moves}
        </PhaseStep>
      </PhaseSteps>

      {remove}

      {openSkill && (
        <FactorySkillEditorDialog
          skill={openSkill}
          factoryId={factoryId}
          canEdit={skillsEditable}
          onClose={() => setOpenSkill(undefined)}
        />
      )}
    </div>
  );
}
