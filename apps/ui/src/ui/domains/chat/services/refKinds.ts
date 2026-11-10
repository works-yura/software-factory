import { MessageSquare, SquareKanban } from 'lucide-react';
import type { ComponentType } from 'react';

import { boardTitle } from '../../../i18n/boardLabels';
import { translator } from '../../../i18n/t';
import type { FactoryRef } from './factoryRefs';

/** Where a reference is opened from: the Factory whose chat shows it. */
export interface RefKindContext {
  factoryId: string;
}

const tk = translator('chat');

/**
 * Everything the app knows about one kind of reference. Composer items, transcript cards, opening, drag and drop
 * and the `factory-refs` wire block all read a kind from here, so a new kind (a document, a PR, an attachment)
 * is one more `defineRefKind` call and nothing else.
 */
export interface RefKind {
  kind: string;
  /** Wire fields a reference of this kind must carry (non-empty strings), besides `kind` and `title`. */
  required: readonly string[];
  /** Wire fields it may carry; anything else is dropped when the reference is read. */
  optional?: readonly string[];
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  /** The muted line under the title: what it is, and where. Called at render time, so it may translate. */
  subtitle: (ref: FactoryRef) => string;
  /** The app path that opens it, or undefined when it cannot be opened from here. */
  href?: (ref: FactoryRef, context: RefKindContext) => string | undefined;
}

const registry = new Map<string, RefKind>();

/** All registered kinds, by name. */
export const REF_KINDS: ReadonlyMap<string, RefKind> = registry;

/** Registers a kind (replacing one of the same name) and returns it. */
export function defineRefKind(kind: RefKind): RefKind {
  registry.set(kind.kind, kind);
  return kind;
}

/** Removes a kind; for tests that register their own. */
export function removeRefKind(kind: string): void {
  registry.delete(kind);
}

export function refKind(kind: string): RefKind | undefined {
  return registry.get(kind);
}

function onBoard(label: string, ref: FactoryRef): string {
  const board = ref.fields.board;
  return board ? `${label} · ${boardTitle(board, board)}` : label;
}

function sessionPath(ref: FactoryRef, { factoryId }: RefKindContext): string | undefined {
  const { sessionId, threadId } = ref.fields;
  if (!sessionId) return undefined;
  return `/factories/${factoryId}/workspaces/${sessionId}${threadId ? `/threads/${threadId}` : ''}`;
}

/** A Factory session (a chat), opened in its thread. */
export const SESSION_REF_KIND = defineRefKind({
  kind: 'session',
  required: ['sessionId'],
  optional: ['threadId', 'workItemId', 'board'],
  icon: MessageSquare,
  subtitle: ref => onBoard(tk('refs.session'), ref),
  href: sessionPath,
});

/** A board card, opened in the session its work runs in. */
export const CARD_REF_KIND = defineRefKind({
  kind: 'card',
  required: ['sessionId'],
  optional: ['threadId', 'workItemId', 'board'],
  icon: SquareKanban,
  subtitle: ref => onBoard(tk('refs.card'), ref),
  href: sessionPath,
});
