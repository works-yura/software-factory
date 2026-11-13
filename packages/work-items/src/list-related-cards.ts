import { isPullRequestCard } from '@factory/core/boards/semantics';
import { relatedCardIndex } from '@factory/core/related-cards';
import type { PullRequestFacts } from '@factory/core/related-cards';
import { workItemSource } from '@factory/core/rules/types';
import type { Card } from '@factory/store';

const CARD_PULL_REQUESTS: PullRequestFacts<Card> = {
  isPullRequest: card => isPullRequestCard({ source: workItemSource(card.externalSource) }),
  headBranch: card => {
    const branch = card.workItem.metadata?.headBranch;
    return typeof branch === 'string' ? branch : undefined;
  },
};

// One index per list version: `listShared` returns the same array until a card changes.
const relatedByList = new WeakMap<readonly Card[], (card: Card) => Card[]>();

/** Reads the cards related to one of the list's cards, in list order. */
export function relatedCardsIn(list: readonly Card[]): (card: Card) => Card[] {
  let relatedTo = relatedByList.get(list);
  if (!relatedTo) {
    relatedTo = relatedCardIndex(list, CARD_PULL_REQUESTS);
    relatedByList.set(list, relatedTo);
  }
  return relatedTo;
}
