import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { BoardOpenCard } from '../context/BoardOpenCardContext';

export interface LinkedComment {
  cardKey: string;
  commentId: string;
}

/** The card a click opened or closed, and the comment link it overrode. */
export interface OpenCardChoice {
  linkedComment: LinkedComment | undefined;
  key: string | undefined;
}

const sameLink = (a: LinkedComment | undefined, b: LinkedComment | undefined) =>
  a?.cardKey === b?.cardKey && a?.commentId === b?.commentId;

const openKeyOf = (choice: OpenCardChoice | undefined, linkedComment: LinkedComment | undefined) =>
  choice !== undefined && sameLink(choice.linkedComment, linkedComment) ? choice.key : linkedComment?.cardKey;

/**
 * The open card from a click's `choice` and the page's comment link. Kept apart from the state so a
 * page can read the clicked card before it knows where the linked one sits.
 */
export function boardOpenCard(
  choice: OpenCardChoice | undefined,
  setChoice: Dispatch<SetStateAction<OpenCardChoice | undefined>>,
  linkedComment: LinkedComment | undefined,
): BoardOpenCard {
  return {
    openKey: openKeyOf(choice, linkedComment),
    setCardOpen: (key, open) => {
      if (open) setChoice({ linkedComment, key });
      else
        setChoice(current => (openKeyOf(current, linkedComment) === key ? { linkedComment, key: undefined } : current));
    },
  };
}

/** A comment link opens its card; a click or a dismissal overrides it until the next link arrives. */
export function useOpenCardState(linkedComment: LinkedComment | undefined): BoardOpenCard {
  const [choice, setChoice] = useState<OpenCardChoice>();
  return boardOpenCard(choice, setChoice, linkedComment);
}
