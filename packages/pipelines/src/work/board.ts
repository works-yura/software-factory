import { compileBoardDefinition, DEFAULT_BOARD_ID, isPullRequestCard, pullRequestCardRejection } from '@factory/core';
import type { BoardPhaseDefinition } from '@factory/core';

/**
 * A change request tracked on its own card never attaches to this one, so Review refuses the card and
 * the builder leaves it in Building: the goal counts that hand-off as done rather than looping on it.
 */
export const OWN_CARD_HAND_OFF =
  'Also done, with the card left in Building, when the change request was opened but is tracked on its own card ' +
  "and the builder's latest message posts its link and says a person should confirm it is reviewed there.";

/**
 * The goal Building pursues. The goal judge sees only this text and the latest messages, so it
 * spells out when the build is done and when it waits for a person.
 */
export const BUILD_OBJECTIVE =
  'Build the plan approved in Planning for this work item. Done when every step of that plan is implemented on ' +
  "the work branch; the plan's verification gates (the tests, typecheck and lint it names, else the narrowest " +
  'relevant ones) were run on the final head and passed; the branch is pushed; and the card was moved on with ' +
  'factory_transition_work_item out of Building (to Review after opening the change request, or back to ' +
  "Planning if the plan proved wrong); the builder's latest message names the move and the pushed head. " +
  OWN_CARD_HAND_OFF +
  ' Continue while any of that is missing. Waiting only when the agent asked a person a question it cannot ' +
  'answer from the repository.';

export type WorkBoardPhase = 'intake' | 'planning' | 'execute' | 'pr-review' | 'done' | 'canceled';

export const workBoard = compileBoardDefinition<'work', Record<WorkBoardPhase, BoardPhaseDefinition<WorkBoardPhase>>>({
  id: DEFAULT_BOARD_ID,
  name: 'Work',
  initialPhase: 'intake',
  // The one rule `nextPhases` can't say: a pull request's own card is only reviewed, and PR review
  // holds only cards that carry a pull request. The transition service checks it for every board
  // with a pull request loop; Work states it here too for moves that don't go through the service.
  transitionPolicy: ({ item, toStage }) => {
    const reason = pullRequestCardRejection(
      workBoard,
      {
        standalonePullRequest: isPullRequestCard(item),
        hasPullRequest:
          isPullRequestCard(item) || item.workItem.sources.some(source => source.sourceType === 'pull-request'),
      },
      toStage,
    );
    return reason ? { type: 'reject', code: 'invalid_transition', reason } : undefined;
  },
  sourceClosed: { completed: 'done', canceled: 'canceled' },
  triageClassification: true,
  phases: {
    intake: {
      name: 'Intake',
      kind: 'resting',
      // Never straight to Building: a plan comes first. Review takes a pull request's own card;
      // Done is where a completed source closes it. New projects' Work has no Triage; projects
      // stored before keep theirs (`triageWorkBoard`, upstream #29901).
      nextPhases: ['planning', 'pr-review', 'done', 'canceled'],
    },
    planning: {
      name: 'Planning',
      kind: 'working',
      // Planning and Building share one session, so the builder keeps the plan's context.
      runner: { skill: 'factory-plan', context: 'work' },
      nextPhases: ['execute', 'intake', 'done', 'canceled'],
      // The card stays in Planning until submit_plan comes back approved; then factory-plan moves it.
      exitTool: { id: 'submit_plan', autoApprove: false },
    },
    execute: {
      name: 'Building',
      kind: 'working',
      runner: { skill: 'factory-build', context: 'work', goal: { objective: BUILD_OBJECTIVE, maxRuns: 20 } },
      // Review once the builder opened the change request; Planning again when the build shows
      // the plan was wrong.
      nextPhases: ['pr-review', 'planning', 'done', 'canceled'],
    },
    'pr-review': {
      // Keyed `pr-review`: projects stored before Work dropped its self-review phase hold a
      // `review` phase for it, and the retired Review board's cards read as `pr-review`.
      name: 'Review',
      // A card's pull request is reviewed here by the independent reviewer, in its own
      // review seat on the pull request's branch. Work has no self-review phase; a board that
      // wants one adds a review-context phase granting only factory_record_review_verdict.
      kind: 'working',
      runner: { skill: 'factory-review', context: 'review' },
      tools: ['factory_record_review_verdict', 'factory_review_source'],
      // Merged, closed, or set aside in Intake. An issue card can go back to its builder for a
      // fix; a pull request's own card never reaches the builder's lanes (pullRequestCardRejection).
      nextPhases: ['intake', 'planning', 'execute', 'done', 'canceled'],
    },
    done: {
      name: 'Done',
      kind: 'terminal',
      // A review request on a finished pull request reopens its review.
      nextPhases: ['pr-review'],
    },
    canceled: {
      name: 'Canceled',
      kind: 'terminal',
      // Revived into Intake; a pull request closed without merging and then reopened goes back to Review.
      nextPhases: ['intake', 'pr-review'],
    },
  },
});
