import { Button } from '@mastra/playground-ui/components/Button';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@mastra/playground-ui/components/Select';
import { Txt } from '@mastra/playground-ui/components/Txt';
import { useTranslation } from 'react-i18next';

import { useBoardCatalog } from '../../../../../hooks/useBoardCatalog';
import type { McpServerAssignment, McpToolPolicy } from '../../services/mcpServers';

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

/** One Factory a server is assigned to, optionally only some of its boards and phases. */
export function AssignmentRow({
  assignment,
  factories,
  onChange,
  onRemove,
}: {
  assignment: McpServerAssignment;
  factories: Array<{ id: string; name: string }>;
  onChange: (next: McpServerAssignment) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation('settings');
  const boards = useBoardCatalog(assignment.factoryProjectId || undefined).data ?? [];
  const chosenBoards = assignment.boards ?? [];
  const phases = boards
    .filter(board => chosenBoards.length === 0 || chosenBoards.includes(board.id))
    .flatMap(board => board.phases.filter(phase => phase.kind !== 'terminal').map(phase => ({ ...phase, board: board.name ?? board.id })));
  const toggle = (list: string[] | undefined, value: string) => {
    const next = (list ?? []).includes(value) ? (list ?? []).filter(item => item !== value) : [...(list ?? []), value];
    return next.length ? next : undefined;
  };
  const factoryName = factories.find(factory => factory.id === assignment.factoryProjectId)?.name;

  return (
    <div className="border-border1 flex flex-col gap-3 rounded-md border p-3" role="group" aria-label={t('mcpServers.access.row', { factory: factoryName ?? '—' })}>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={assignment.factoryProjectId} onValueChange={factoryProjectId => onChange({ factoryProjectId })}>
          <SelectTrigger aria-label={t('mcpServers.access.factory')} className="w-56">
            {factoryName ?? t('mcpServers.access.pickFactory')}
          </SelectTrigger>
          <SelectContent>
            {factories.map(factory => (
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
      {boards.length > 0 && (
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
                onClick={() => onChange({ ...assignment, boards: toggle(assignment.boards, board.id), phases: undefined })}
              >
                {board.name ?? board.id}
              </Button>
            ))}
          </div>
        </div>
      )}
      {phases.length > 0 && (
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
                onClick={() => onChange({ ...assignment, phases: toggle(assignment.phases, phase.id) })}
              >
                {phase.name ?? phase.title ?? phase.id}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
