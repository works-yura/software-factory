/**
 * A session or card of this Factory that the person dragged (or added from a row's menu) into the composer.
 * It travels in the sent message as a fenced `factory-refs` block, one JSON object per line, which the agent
 * reads with `factory_read_session` and the transcript renders back as chips.
 */
export interface FactoryRef {
  kind: 'session' | 'card';
  sessionId: string;
  threadId?: string;
  workItemId?: string;
  title: string;
  board?: string;
}

/** The drag payload type of a sidebar session or card row. */
export const FACTORY_REF_MIME = 'application/x-factory-ref';

/** The window event a row's "Add to chat" sends; the open composer takes it. */
export const FACTORY_REF_EVENT = 'factory:add-ref';

const FENCE = 'factory-refs';
const BLOCK = new RegExp(`(?:^|\\n+)\`\`\`${FENCE}\\n([\\s\\S]*?)\\n\`\`\`\\s*$`);

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A reference read from untrusted JSON, or undefined when it is not one. */
export function toFactoryRef(value: unknown): FactoryRef | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  const sessionId = optionalString(raw.sessionId);
  const title = optionalString(raw.title);
  if ((kind !== 'session' && kind !== 'card') || !sessionId || !title) return undefined;
  const threadId = optionalString(raw.threadId);
  const workItemId = optionalString(raw.workItemId);
  const board = optionalString(raw.board);
  return {
    kind,
    sessionId,
    title,
    ...(threadId ? { threadId } : {}),
    ...(workItemId ? { workItemId } : {}),
    ...(board ? { board } : {}),
  };
}

/** The reference a drag carries, or undefined when the drag is not a Factory row. */
export function readDraggedRef(data: Partial<Pick<DataTransfer, 'getData'>> | null | undefined): FactoryRef | undefined {
  // A file drop (or a synthetic one) may carry no readable data at all: it is simply not a reference.
  if (typeof data?.getData !== 'function') return undefined;
  const raw = data.getData(FACTORY_REF_MIME);
  if (!raw) return undefined;
  try {
    return toFactoryRef(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** Puts `ref` on a drag: the typed payload, and its title for anything that only takes text. */
export function writeDraggedRef(data: Pick<DataTransfer, 'setData'> & { effectAllowed: string }, ref: FactoryRef) {
  data.setData(FACTORY_REF_MIME, JSON.stringify(ref));
  data.setData('text/plain', ref.title);
  data.effectAllowed = 'copy';
}

export function sameRef(a: FactoryRef, b: FactoryRef): boolean {
  return a.sessionId === b.sessionId && a.workItemId === b.workItemId;
}

/** `refs` with `ref` added once. */
export function withRef(refs: readonly FactoryRef[], ref: FactoryRef): FactoryRef[] {
  return refs.some(existing => sameRef(existing, ref)) ? [...refs] : [...refs, ref];
}

/** The message the agent receives: what the person wrote, then the references as a fenced block. */
export function serializeRefs(text: string, refs: readonly FactoryRef[]): string {
  if (refs.length === 0) return text;
  const lines = refs.map(ref =>
    JSON.stringify({
      kind: ref.kind,
      sessionId: ref.sessionId,
      ...(ref.threadId ? { threadId: ref.threadId } : {}),
      ...(ref.workItemId ? { workItemId: ref.workItemId } : {}),
      title: ref.title,
      ...(ref.board ? { board: ref.board } : {}),
    }),
  );
  const block = ['```' + FENCE, ...lines, '```'].join('\n');
  return text.trim() ? `${text}\n\n${block}` : block;
}

/** A sent message split into what the person wrote and the references it carried. */
export function parseRefs(text: string): { body: string; refs: FactoryRef[] } {
  const match = BLOCK.exec(text);
  if (!match) return { body: text, refs: [] };
  const refs: FactoryRef[] = [];
  for (const line of match[1]!.split('\n')) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { body: text, refs: [] };
    }
    const ref = toFactoryRef(parsed);
    if (!ref) return { body: text, refs: [] };
    refs.push(ref);
  }
  return { body: text.slice(0, match.index), refs };
}

/**
 * Asks the open composer to add `ref` (the keyboard path from a row's menu). False when no composer took it,
 * so the caller can say so instead of the reference silently going nowhere.
 */
export function addFactoryRef(ref: FactoryRef): boolean {
  const event = new CustomEvent<FactoryRef>(FACTORY_REF_EVENT, { detail: ref, cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
