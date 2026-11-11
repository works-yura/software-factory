import { IDENTIFIER_RE, MAX_BOARD_IDENTIFIER_LENGTH } from '@factory/core/rules/validation';
import type { TFunction } from 'i18next';

import type { StoredBoardInfo, StoredPhaseInfo } from '../../../../api/types';
import { settingsSectionPath } from '../settingsSections';

/** A board as the editor holds it: everything a save sends except the key and the revision. */
export interface BoardDraft {
  name: string;
  description: string | null;
  phases: StoredPhaseInfo[];
}

export function draftOf(board: Pick<StoredBoardInfo, 'name' | 'description' | 'phases'>): BoardDraft {
  return { name: board.name, description: board.description ?? null, phases: board.phases };
}

/** A key for a name: lower case, with every run of other characters as one hyphen. */
export function keyFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^[-_]+/, '')
    .slice(0, MAX_BOARD_IDENTIFIER_LENGTH)
    .replace(/-+$/, '');
}

/** Why the server would refuse a board or phase key; the UI words it with `keyProblemText`. */
export type KeyProblem = 'empty' | 'tooLong' | 'invalid' | 'taken';

/** Why the server would refuse this key, if it would. */
export function keyProblem(key: string, taken: readonly string[] = []): KeyProblem | undefined {
  if (key === '') return 'empty';
  if (key.length > MAX_BOARD_IDENTIFIER_LENGTH) return 'tooLong';
  if (!IDENTIFIER_RE.test(key)) return 'invalid';
  if (taken.includes(key)) return 'taken';
  return undefined;
}

export function keyProblemText(t: TFunction<'settings'>, problem: KeyProblem): string {
  return t(`boards.keyProblems.${problem}`, { max: MAX_BOARD_IDENTIFIER_LENGTH });
}

/** The board a new one starts from: cards wait in Backlog, an agent works them in Doing, and they end in Done. */
export function starterBoard(): BoardDraft {
  return {
    name: '',
    description: null,
    phases: [
      { key: 'backlog', name: 'Backlog', kind: 'resting', nextPhases: ['doing'] },
      { key: 'doing', name: 'Doing', kind: 'working', runner: { context: 'work' }, nextPhases: ['done'] },
      { key: 'done', name: 'Done', kind: 'terminal', nextPhases: [] },
    ],
  };
}

/** Settings → Boards, on one board's editor or on the new-board form. */
export function boardSettingsPath(factoryId: string, target: { board: string } | { new: true }): string {
  const query = 'board' in target ? `board=${encodeURIComponent(target.board)}` : 'new=1';
  return `${settingsSectionPath(factoryId, 'board')}?${query}`;
}
