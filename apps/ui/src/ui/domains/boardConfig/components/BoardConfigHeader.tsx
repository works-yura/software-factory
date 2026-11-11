import { Badge } from '@mastra/playground-ui/components/Badge';
import { PageHeader } from '@mastra/playground-ui/components/PageHeader';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@mastra/playground-ui/components/Tooltip';
import { focusRing } from '@mastra/playground-ui/primitives/transitions';
import type { ReactNode } from 'react';

import type { StoredBoardResponse, StoredPhaseInfo } from '../../../../api/types';
import { BoardStageIcon, phaseIconKind } from '../../factory/components/BoardIcons';
import { useBoardDraft } from '../BoardDraftProvider';
import { kindLocked, rawRuleKey, withKind } from '../boardDraft';
import type { PhaseKind } from '../boardDraft';
import { InlineText } from './InlineText';
import { cn } from '@mastra/playground-ui/utils/cn';

import { translator } from '../../../i18n/t';

const tk = translator('boardConfig');

/** A phase kind's name and what it means for the cards in it, in the interface language. */
function kindText(kind: StoredPhaseInfo['kind']): { label: string; meaning: string } {
  return { label: tk(`kinds.${kind}.label`), meaning: tk(`kinds.${kind}.meaning`) };
}

const KIND_ORDER: readonly PhaseKind[] = ['resting', 'working', 'terminal'];

/** A short label that explains itself on hover or focus. */
function Explained({ label, meaning, children }: { label: string; meaning: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            tabIndex={0}
            aria-label={`${label}. ${meaning}`}
            className={cn('inline-flex rounded-sm', focusRing)}
          >
            {children}
          </span>
        }
      />
      <TooltipContent side="bottom" className="max-w-72">
        {meaning}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The open page's own fields, edited in place: the board's name and revision on General, or the phase's
 * name, kind and description on a phase page.
 */
export function BoardConfigHeader({
  factoryId,
  boardId,
  phaseKey,
  response,
}: {
  factoryId: string;
  boardId: string;
  phaseKey: string | undefined;
  response: StoredBoardResponse;
}) {
  const { board, canEdit } = response;
  const { draft, locked, setDraft, setRawRule } = useBoardDraft(factoryId, boardId, board);
  const readOnly = !canEdit || !board.editable || locked;
  const phase = phaseKey ? draft.phases.find(candidate => candidate.key === phaseKey) : undefined;
  if (phaseKey && !phase) return null;

  const setPhase = (patch: Partial<StoredPhaseInfo>) =>
    setDraft(current => ({
      ...current,
      phases: current.phases.map(candidate => (candidate.key === phaseKey ? { ...candidate, ...patch } : candidate)),
    }));
  const setKind = (kind: PhaseKind) => {
    if (!phase) return;
    // The rules belong to the old kind, so JSON typed for them goes too.
    setRawRule(rawRuleKey(phase.key, 'autoStartWhen'), undefined);
    setRawRule(rawRuleKey(phase.key, 'autoApproveWhen'), undefined);
    setDraft(current => ({
      ...current,
      phases: current.phases.map(candidate =>
        candidate.key === phase.key ? withKind(candidate, kind, current.phases) : candidate,
      ),
    }));
  };
  const name = phase ? phase.name : draft.name;
  const description = (phase ? phase.description : draft.description) ?? '';
  const kindEditable = phase !== undefined && !readOnly && !kindLocked(draft.phases, phase.key, board.codeBehaviour);

  return (
    <PageHeader>
      {/* The icon sits in the title row, so the icon, the description and the sections below share one left edge. */}
      <PageHeader.Title className="gap-2.5">
        {phase && <BoardStageIcon stage={phase.key} kind={phaseIconKind(boardId, phase.kind)} decorative />}
        <InlineText
          value={name}
          label={phase ? tk('header.phaseName') : tk('header.boardName')}
          required
          readOnly={readOnly}
          variant="heading"
          tone="ink"
          onChange={next => (phase ? setPhase({ name: next }) : setDraft(current => ({ ...current, name: next })))}
        />
      </PageHeader.Title>
      {(phase || board.revision != null) && (
        <PageHeader.Meta beside>
          {phase && kindEditable ? (
            <Select
              value={phase.kind}
              onValueChange={value => {
                const kind = KIND_ORDER.find(candidate => candidate === value);
                if (kind) setKind(kind);
              }}
            >
              <SelectTrigger size="sm" aria-label={tk('header.phaseKind')}>
                {kindText(phase.kind).label}
              </SelectTrigger>
              <SelectContent>
                {KIND_ORDER.map(kind => (
                  <SelectItem key={kind} value={kind}>
                    {kindText(kind).label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : phase ? (
            <Explained label={kindText(phase.kind).label} meaning={kindText(phase.kind).meaning}>
              <Badge>{kindText(phase.kind).label}</Badge>
            </Explained>
          ) : (
            <Explained
              label={tk('header.revision', { revision: board.revision })}
              meaning={tk('header.revisionMeaning')}
            >
              {tk('header.revision', { revision: board.revision })}
            </Explained>
          )}
        </PageHeader.Meta>
      )}
      {(description || !readOnly) && (
        <PageHeader.Description>
          <InlineText
            value={description}
            label={phase ? tk('header.phaseDescription') : tk('header.boardDescription')}
            placeholder={tk('header.addDescription')}
            multiline
            readOnly={readOnly}
            variant="caption"
            tone="muted"
            className="zoom-safe-text w-full"
            onChange={next =>
              phase
                ? setPhase({ description: next || null })
                : setDraft(current => ({ ...current, description: next || null }))
            }
          />
        </PageHeader.Description>
      )}
    </PageHeader>
  );
}
