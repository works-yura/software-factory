import { Avatar } from '@mastra/playground-ui/components/Avatar';
import type { FilterBarField, FilterBarOperator, FilterBarOption } from '@mastra/playground-ui/components/FilterBar';
import {
  Activity,
  Inbox,
  Tag,
  UserRoundCheck,
  UserRoundPen,
  UserRoundSearch,
  UsersRound,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { factoryParticipantId } from '@factory/work-items/card-people';
import { PULL_REQUEST_SOURCE_FILTER } from '@factory/work-items/card-source-filters';

import { boardFilterFieldIds } from '../boardFilters';
import type { BoardFilterFieldId, BoardFilterState } from '../boardFilters';
import type { BoardParticipant } from '../boardPeople';
import { BOARD_SOURCE_OPTIONS } from '../boardSourceFilters';
import { translator } from '../../../i18n/t';

const tk = translator('board');

export const BOARD_FILTER_OPERATORS: FilterBarOperator[] = [
  {
    id: 'in',
    get label() {
      return tk('filters.isAnyOf');
    },
    arity: 'many',
  },
];

export type BoardFilterOption = FilterBarOption & { alsoMatches?: string };

export type BoardFilterField = FilterBarField & { id: BoardFilterFieldId; suggestions: BoardFilterOption[] };

const FIELD_ICONS: Record<BoardFilterFieldId, LucideIcon> = {
  source: Inbox,
  teammate: UsersRound,
  author: UserRoundPen,
  assignee: UserRoundCheck,
  reviewer: UserRoundSearch,
  worked: Activity,
  label: Tag,
};

function fieldLabel(fieldId: BoardFilterFieldId): string {
  switch (fieldId) {
    case 'source':
      return tk('filters.fields.source');
    case 'teammate':
      return tk('filters.fields.teammate');
    case 'author':
      return tk('filters.fields.author');
    case 'assignee':
      return tk('filters.fields.assignee');
    case 'reviewer':
      return tk('filters.fields.reviewer');
    case 'worked':
      return tk('filters.fields.worked');
    case 'label':
      return tk('filters.fields.label');
  }
}

function peopleOptions(
  participants: readonly BoardParticipant[],
  currentUserId: string | undefined,
): BoardFilterOption[] {
  const you = currentUserId ? factoryParticipantId(currentUserId) : undefined;
  const option = (participant: BoardParticipant): BoardFilterOption => ({
    value: participant.id,
    label: participant.id === you ? tk('filters.you') : participant.name,
    alsoMatches: participant.id === you ? participant.name : undefined,
    start: <Avatar src={participant.avatarUrl} name={participant.name} size="sm" />,
  });
  return [
    ...participants.filter(participant => participant.id === you).map(option),
    ...participants.filter(participant => participant.id !== you).map(option),
  ];
}

interface BoardFilterFieldsOptions {
  reviewsPullRequests: boolean;
  filters: BoardFilterState;
  participants: readonly BoardParticipant[];
  availableLabels: readonly string[];
  currentUserId?: string;
  connectedSources?: ReadonlySet<string>;
}

export function boardFilterFields({
  reviewsPullRequests,
  filters,
  participants,
  availableLabels,
  currentUserId,
  connectedSources,
}: BoardFilterFieldsOptions): BoardFilterField[] {
  const people = peopleOptions(participants, currentUserId);
  const suggestions: Record<BoardFilterFieldId, FilterBarOption[]> = {
    // Keep already-picked sources so saved views still label and edit them after a provider disconnects.
    source: BOARD_SOURCE_OPTIONS.filter(
      option =>
        option.value === 'manual' ||
        connectedSources?.has(option.value) ||
        (option.value === PULL_REQUEST_SOURCE_FILTER &&
          (connectedSources?.has('github') === true || connectedSources?.has('gitlab') === true)) ||
        filters.source.has(option.value),
    ),
    teammate: people,
    author: people,
    assignee: people,
    reviewer: people,
    worked: people,
    label: availableLabels.map(label => ({ value: label })),
  };

  return boardFilterFieldIds(reviewsPullRequests).map(fieldId => ({
    id: fieldId,
    label: fieldLabel(fieldId),
    icon: FIELD_ICONS[fieldId],
    operators: ['in'],
    strict: true,
    suggestions: suggestions[fieldId],
  }));
}

/** The field's options, plus any picked value no longer offered (a disconnected source, a person off the board). */
export function boardFilterOptions(field: BoardFilterField, selected: readonly string[]): BoardFilterOption[] {
  const offered = new Set(field.suggestions.map(option => option.value));
  const orphaned = selected.filter(value => !offered.has(value)).map((value): BoardFilterOption => ({ value }));
  return [...field.suggestions, ...orphaned];
}

export function boardFilterSummary(field: BoardFilterField, selected: readonly string[]): string {
  if (selected.length > 1) return tk('filters.selected', { count: selected.length });
  const only = boardFilterOptions(field, selected).find(option => option.value === selected[0]);
  return only?.label ?? selected[0];
}
