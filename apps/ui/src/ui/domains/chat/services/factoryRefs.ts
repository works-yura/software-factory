import { refKind } from './refKinds';

/**
 * Something of this Factory the person dragged (or added from a row's menu) into the composer: a session, a card,
 * or any kind registered with `defineRefKind`. It travels in the sent message as a fenced `factory-refs` block,
 * one JSON object per line (`kind`, `title` and the kind's fields, all strings), which the agent reads and the
 * transcript renders back beside the sent files.
 */
export interface FactoryRef {
  kind: string;
  title: string;
  /** The kind's wire fields (for a session or card: `sessionId`, `threadId`, `workItemId`, `board`). */
  fields: Readonly<Record<string, string>>;
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

/**
 * A reference read from untrusted JSON, or undefined when it is not one. A registered kind keeps only its own
 * fields and needs its required ones. An unknown kind is refused when `known` is set (a drag must be something this
 * app made); otherwise it keeps every string field, so a message from a newer client still shows what it carried.
 */
export function toFactoryRef(value: unknown, { known = false }: { known?: boolean } = {}): FactoryRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { kind, title, ...rest } = value as Record<string, unknown>;
  const name = optionalString(kind);
  const label = optionalString(title);
  if (!name || !label) return undefined;
  const definition = refKind(name);
  if (!definition && known) return undefined;
  const allowed = definition ? [...definition.required, ...(definition.optional ?? [])] : Object.keys(rest);
  const fields: Record<string, string> = {};
  for (const key of allowed) {
    const field = optionalString(rest[key]);
    if (field !== undefined) fields[key] = field;
  }
  if (definition?.required.some(key => fields[key] === undefined)) return undefined;
  return { kind: name, title: label, fields };
}

/** The reference a drag carries, or undefined when the drag is not a Factory row. */
export function readDraggedRef(data: Partial<Pick<DataTransfer, 'getData'>> | null | undefined): FactoryRef | undefined {
  // A file drop (or a synthetic one) may carry no readable data at all: it is simply not a reference.
  if (typeof data?.getData !== 'function') return undefined;
  const raw = data.getData(FACTORY_REF_MIME);
  if (!raw) return undefined;
  try {
    return toFactoryRef(JSON.parse(raw), { known: true });
  } catch {
    return undefined;
  }
}

/** The wire object of a reference: `kind`, `title`, then its fields. */
function toWire(ref: FactoryRef): Record<string, string> {
  return { kind: ref.kind, title: ref.title, ...ref.fields };
}

/** Puts `ref` on a drag: the typed payload, and its title for anything that only takes text. */
export function writeDraggedRef(data: Pick<DataTransfer, 'setData'> & { effectAllowed: string }, ref: FactoryRef) {
  data.setData(FACTORY_REF_MIME, JSON.stringify(toWire(ref)));
  data.setData('text/plain', ref.title);
  data.effectAllowed = 'copy';
}

/** One key per referenced thing: its kind and fields. */
export function refKey(ref: FactoryRef): string {
  const fields = Object.keys(ref.fields)
    .sort()
    .map(key => `${key}=${ref.fields[key]}`);
  return [ref.kind, ...fields].join('\n');
}

export function sameRef(a: FactoryRef, b: FactoryRef): boolean {
  return refKey(a) === refKey(b);
}

/** `refs` with `ref` added once. */
export function withRef(refs: readonly FactoryRef[], ref: FactoryRef): FactoryRef[] {
  return refs.some(existing => sameRef(existing, ref)) ? [...refs] : [...refs, ref];
}

/** The message the agent receives: what the person wrote, then the references as a fenced block. */
export function serializeRefs(text: string, refs: readonly FactoryRef[]): string {
  if (refs.length === 0) return text;
  const lines = refs.map(ref => JSON.stringify(toWire(ref)));
  const block = ['```' + FENCE, ...lines, '```'].join('\n');
  return text.trim() ? `${text}\n\n${block}` : block;
}

/**
 * A sent message split into what the person wrote and the references it carried. A reference of an unknown kind
 * is kept (shown, not dropped); a line that is not a reference at all leaves the whole message as written.
 */
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
