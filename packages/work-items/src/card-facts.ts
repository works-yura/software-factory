import { hasPullRequest } from '@factory/core/boards/semantics';
import type { Card } from '@factory/store';
import { isHumanActorId } from '@factory/store/audit/actors';

import { metadataLabels } from './card-labels.ts';
import { factoryParticipantId, providerPeople } from './card-people.ts';
import type { BoardRelations, ProviderPerson, ProviderPersonRole } from './card-people.ts';
import { cardSearchText } from './card-search-text.ts';
import { cardSource } from './card-source.ts';
import type { SourceFacts } from './card-source-filters.ts';

/** What a board view's search and filters read of a card. */
export interface CardFacts extends SourceFacts {
  hasPullRequest: boolean;
  labels: ReadonlySet<string>;
  /** The people the card's source names. */
  people: Record<ProviderPersonRole, ProviderPerson[]>;
  /** Participant ids by role: the source's people, and the Factory users who worked on the card. */
  relations: BoardRelations;
  /** The Factory users who created the card, moved it or started a session on it. */
  humanActorIds: readonly string[];
  /** Lowercased, so a search lowercases only its own words. */
  text: string;
}

// A card object never changes: `listShared` gives a changed card a new object.
const factsByCard = new WeakMap<Card, CardFacts>();

/**
 * What the card's source says of it. A card no provider filed has no source: its facts are its
 * work item's with the card's own on top, as clients read them.
 */
export function sourceMetadata({ workItem, metadata }: Card): Record<string, unknown> {
  if (workItem.provider === 'factory') return { ...workItem.metadata, ...metadata };
  return {
    ...workItem.metadata,
    labels: workItem.labels,
    author: workItem.author,
    state: workItem.state,
    identifier: workItem.key,
  };
}

function humanActorIds(card: Card): string[] {
  const ids = new Set<string>();
  const add = (actorId: string | undefined) => {
    if (isHumanActorId(actorId)) ids.add(actorId);
  };
  add(card.createdBy);
  for (const entry of card.stageHistory) {
    add(entry.by);
    add(entry.exitedBy);
  }
  for (const session of Object.values(card.sessions)) add(session.startedBy);
  return [...ids];
}

/** The card's facts, computed once for every view that reads the card. */
export function cardFacts(card: Card): CardFacts {
  let facts = factsByCard.get(card);
  if (facts) return facts;
  const source = cardSource(card.externalSource);
  const metadata = sourceMetadata(card);
  const people = providerPeople({ source, metadata });
  const actorIds = humanActorIds(card);
  const authored = new Set(people.authored.map(person => person.id));
  // A card filed by hand has no source to name its author: the person who filed it is.
  if (source === 'manual' && isHumanActorId(card.createdBy)) authored.add(factoryParticipantId(card.createdBy));
  facts = {
    source,
    metadata,
    hasPullRequest: hasPullRequest({ source, workItem: card.workItem }),
    labels: new Set(metadataLabels(metadata)),
    people,
    relations: {
      worked: new Set(actorIds.map(factoryParticipantId)),
      authored,
      assigned: new Set(people.assigned.map(person => person.id)),
      'review-requested': new Set(people['review-requested'].map(person => person.id)),
    },
    humanActorIds: actorIds,
    text: cardSearchText(card),
  };
  factsByCard.set(card, facts);
  return facts;
}
