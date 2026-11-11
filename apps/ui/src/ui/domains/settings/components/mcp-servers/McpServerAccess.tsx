import { Button } from '@mastra/playground-ui/components/Button';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import { MCP_SESSION_KINDS, mcpAssignmentKinds } from '@factory/core';

import { useBoardCatalog } from '../../../../../hooks/useBoardCatalog';
import { boardTitle, phaseTitle } from '../../../../i18n/boardLabels';
import type { McpServerAssignment, McpSessionKind, McpToolPolicy } from '../../services/mcpServers';

/** What a person may choose; `review` only comes from a check and is shown, never offered. */
const POLICIES: McpToolPolicy[] = ['allow', 'ask', 'deny'];

export function PolicySelect({ value, onChange, label }: { value: McpToolPolicy; onChange: (value: McpToolPolicy) => void; label: string }) {
  const { t } = useTranslation('settings');
  return (
    <Select value={value} onValueChange={next => onChange(next as McpToolPolicy)}>
      <SelectTrigger aria-label={label} className="w-44">
        {t(`mcpServers.policy.${value}`)}
      </SelectTrigger>
      <SelectContent>
        {POLICIES.map(policy => (
          <SelectItem key={policy} value={policy}>
            {t(`mcpServers.policy.${policy}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A new access row: the first Factory not yet listed, every kind of session. */
export function newAssignment(factories: Array<{ id: string }>, used: readonly string[]): McpServerAssignment | undefined {
  const factory = factories.find(candidate => !used.includes(candidate.id));
  return factory ? { factoryProjectId: factory.id, sessions: [...MCP_SESSION_KINDS] } : undefined;
}

/**
 * One Factory a server reaches, and which of its sessions: the Factory chat, members' own sessions,
 * cards — and for cards optionally only some boards and phases. A row read from before the kinds
 * existed shows the kinds it meant and is written with them on the next save.
 */
export function AssignmentRow({
  assignment,
  factories,
  usedFactoryIds,
  onChange,
  onRemove,
}: {
  assignment: McpServerAssignment;
  factories: Array<{ id: string; name: string }>;
  /** Factories other rows already name: one row per Factory. */
  usedFactoryIds: readonly string[];
  onChange: (next: McpServerAssignment) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('settings');
  const boards = useBoardCatalog(assignment.factoryProjectId || undefined).data ?? [];
  const kinds = mcpAssignmentKinds(assignment);
  const cards = kinds.includes('cards');
  const chosenBoards = assignment.boards ?? [];
  const phases = boards
    .filter(board => chosenBoards.length === 0 || chosenBoards.includes(board.id))
    .flatMap(board =>
      board.phases
        .filter(phase => phase.kind !== 'terminal')
        .map(phase => ({
          id: phase.id,
          board: board.id,
          title: phaseTitle(board.id, phase.id, phase.name ?? phase.title ?? phase.id),
          boardTitle: boardTitle(board.id, board.name ?? board.id),
        })),
    );
  const showBoardInPhase = chosenBoards.length !== 1;
  const toggle = (list: string[] | undefined, value: string) => {
    const next = (list ?? []).includes(value) ? (list ?? []).filter(item => item !== value) : [...(list ?? []), value];
    return next.length ? next : undefined;
  };
  const toggleKind = (kind: McpSessionKind) => {
    const next = kinds.includes(kind) ? kinds.filter(item => item !== kind) : MCP_SESSION_KINDS.filter(item => item === kind || kinds.includes(item));
    // Leaving cards out drops the board and phase limits with them.
    onChange({
      factoryProjectId: assignment.factoryProjectId,
      sessions: next,
      ...(next.includes('cards') && assignment.boards ? { boards: assignment.boards } : {}),
      ...(next.includes('cards') && assignment.phases ? { phases: assignment.phases } : {}),
    });
  };
  const factoryName = factories.find(factory => factory.id === assignment.factoryProjectId)?.name;
  const choosable = factories.filter(factory => factory.id === assignment.factoryProjectId || !usedFactoryIds.includes(factory.id));

  return (
    <div className="border-border1 flex flex-col gap-3 rounded-md border p-3" role="group" aria-label={t('mcpServers.access.row', { factory: factoryName ?? '—' })}>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={assignment.factoryProjectId}
          onValueChange={factoryProjectId => onChange({ factoryProjectId, sessions: kinds })}
        >
          <SelectTrigger aria-label={t('mcpServers.access.factory')} className="w-56">
            {factoryName ?? t('mcpServers.access.pickFactory')}
          </SelectTrigger>
          <SelectContent>
            {choosable.map(factory => (
              <SelectItem key={factory.id} value={factory.id}>
                {factory.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="ghost" onClick={onRemove}>
          {t('mcpServers.access.remove')}
        </Button>
      </div>
      <div className="flex flex-col gap-1">
        <Txt as="span" variant="caption" tone="muted">
          {kinds.length ? t('mcpServers.access.sessions') : t('mcpServers.access.noSessions')}
        </Txt>
        <div className="flex flex-wrap gap-1" role="group" aria-label={t('mcpServers.access.sessions')}>
          {MCP_SESSION_KINDS.map(kind => (
            <Button
              key={kind}
              size="sm"
              variant={kinds.includes(kind) ? 'default' : 'ghost'}
              aria-pressed={kinds.includes(kind)}
              onClick={() => toggleKind(kind)}
            >
              {t(`mcpServers.access.kind.${kind}`)}
            </Button>
          ))}
        </div>
      </div>
      {cards && boards.length > 0 && (
        <div className="flex flex-col gap-1">
          <Txt as="span" variant="caption" tone="muted">
            {chosenBoards.length ? t('mcpServers.access.boards') : t('mcpServers.access.allBoards')}
          </Txt>
          <div className="flex flex-wrap gap-1">
            {boards.map(board => (
              <Button
                key={board.id}
                size="sm"
                variant={chosenBoards.includes(board.id) ? 'default' : 'ghost'}
                aria-pressed={chosenBoards.includes(board.id)}
                onClick={() => onChange({ ...assignment, sessions: kinds, boards: toggle(assignment.boards, board.id), phases: undefined })}
              >
                {boardTitle(board.id, board.name ?? board.id)}
              </Button>
            ))}
          </div>
        </div>
      )}
      {cards && phases.length > 0 && (
        <div className="flex flex-col gap-1">
          <Txt as="span" variant="caption" tone="muted">
            {assignment.phases?.length ? t('mcpServers.access.phases') : t('mcpServers.access.allPhases')}
          </Txt>
          <div className="flex flex-wrap gap-1">
            {phases.map(phase => (
              <Button
                key={`${phase.board}:${phase.id}`}
                size="sm"
                variant={assignment.phases?.includes(phase.id) ? 'default' : 'ghost'}
                aria-pressed={assignment.phases?.includes(phase.id) ?? false}
                onClick={() => onChange({ ...assignment, sessions: kinds, phases: toggle(assignment.phases, phase.id) })}
              >
                {showBoardInPhase ? `${phase.boardTitle} › ${phase.title}` : phase.title}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
