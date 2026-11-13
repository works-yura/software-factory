import type { WorkItemStarters } from '../../../api/types';
import type { BoardInfo } from './boardFlow';
import { triageDecisions } from './cardPrimaryAction';
import { phaseTitle } from '../../i18n/boardLabels';
import { translator } from '../../i18n/t';

export type StarterKind = 'unblock' | 'feedback' | 'review' | 'decide' | 'triage' | 'bug' | 'sweep' | 'stale';

interface StarterFact {
  label: string;
  value: number;
  unit?: string;
  action: string;
}

export interface StarterPrompt extends StarterFact {
  kind: StarterKind;
  prompt: string;
}

const SHOWN = 6;
const BATCH = 5;
const SWEEP_MIN = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The default board, by its own names: starters speak of its rest phase and the choices triage leaves. */
function prompts(board: BoardInfo): Record<StarterKind, string> {
  const boardName = board.name ?? board.title;
  const restPhase = board.phases.find(phase => phase.id === board.initialPhase);
  const rest = `${restPhase?.name ?? restPhase?.title ?? board.initialPhase} on the ${boardName} board`;
  const choices = new Intl.ListFormat('en', { type: 'disjunction' }).format(
    triageDecisions(board).map(({ label }) => label),
  );
  return {
    unblock: `Look at the open cards whose last run failed, ${BATCH} at most. For each one, find out why the run failed. Retry the ones you can fix, and tell me what the others need.`,
    feedback: `Find Factory's open pull requests whose latest review asked for changes, ${BATCH} at most. Make the changes each review comment asks for, push them, and request a new review.`,
    review: `Start a review session for each of the ${BATCH} oldest open pull requests in ${rest} that were opened in the last month.`,
    decide: `Go through the ${BATCH} oldest cards triage left in ${rest} for a person to decide on. For each one, say in a line what it is and suggest ${choices}, with your reason. Change nothing until I say so.`,
    triage: `Triage the ${BATCH} newest untriaged cards in ${rest}. Accept the clear ones and flag the rest for me.`,
    bug: `Of the open bugs on the ${boardName} board that nobody has planned yet, pick the one with the biggest impact and draft a plan to fix it.`,
    sweep: `Find the area label with the most open cards on the ${boardName} board that nobody has started yet. Group those cards by root cause, point out duplicates, and draft a plan for the biggest group. Change nothing until I say so.`,
    stale: `Go through the ${BATCH} oldest pull requests that have waited in ${rest} for over a month. For each one, suggest closing it or keeping it open, and say why. Close nothing until I say so.`,
  };
}

const tk = translator('chat');

/** A starter's action for one card or for the batch it works through, in the reader's language. */
function batchAction(starter: string, total: number): string {
  if (total === 1) return tk(`starters.${starter}.actionOne`);
  return tk(`starters.${starter}.actionMany`, { count: Math.min(BATCH, total) });
}

function reviewWait({ count, oldestOpenedAt }: WorkItemStarters['review'], now: number): StarterFact | undefined {
  if (oldestOpenedAt === undefined) return undefined;
  const days = Math.floor((now - Date.parse(oldestOpenedAt)) / DAY_MS);
  return {
    label: tk('starters.review.label'),
    value: days,
    unit: tk('starters.review.unit', { count: days }),
    action: batchAction('review', count),
  };
}

/** The buttons for what the server counted on the default board, in the order they are offered. */
export function starterPrompts({
  board,
  starters,
  now,
}: {
  /** The project's default board; without it there is nothing to suggest. */
  board: BoardInfo | undefined;
  starters: WorkItemStarters;
  now: Date;
}): StarterPrompt[] {
  if (!board) return [];
  const texts = prompts(board);
  const { failed, changesRequested, review, undecided, untriaged, unplannedBugs, sweep, stale } = starters;
  const rest = board.phases.find(phase => phase.id === board.initialPhase);
  const restTitle = rest ? phaseTitle(board.id, rest.id, rest.title) : board.initialPhase;
  const facts: Array<[StarterKind, StarterFact | false | undefined]> = [
    ['unblock', failed > 0 && { label: tk('starters.unblock.label'), value: failed, action: batchAction('unblock', failed) }],
    [
      'feedback',
      changesRequested > 0 && {
        label: tk('starters.feedback.label'),
        value: changesRequested,
        action: tk('starters.feedback.action'),
      },
    ],
    ['review', reviewWait(review, now.getTime())],
    [
      'decide',
      undecided > 0 && { label: tk('starters.decide.label'), value: undecided, action: tk('starters.decide.action') },
    ],
    [
      'triage',
      untriaged > 0 && {
        label: tk('starters.triage.label', { phase: restTitle }),
        value: untriaged,
        action: batchAction('triage', untriaged),
      },
    ],
    [
      'bug',
      unplannedBugs > 0 && {
        label: tk('starters.bug.label'),
        value: unplannedBugs,
        action: unplannedBugs === 1 ? tk('starters.bug.actionOne') : tk('starters.bug.actionMany'),
      },
    ],
    [
      'sweep',
      sweep !== undefined &&
        sweep.count >= SWEEP_MIN && {
          label: tk('starters.sweep.label', { area: sweep.area }),
          value: sweep.count,
          action: tk('starters.sweep.action'),
        },
    ],
    ['stale', stale > 0 && { label: tk('starters.stale.label'), value: stale, action: tk('starters.stale.action') }],
  ];
  return facts.flatMap(([kind, fact]) => (fact ? [{ kind, prompt: texts[kind], ...fact }] : [])).slice(0, SHOWN);
}
