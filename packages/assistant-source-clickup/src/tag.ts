/**
 * The tag (ADR-0051 amendment 2026-11-16): the only thing in a chat that makes a request. A message
 * carrying it — `#помічник оціни це` — is found by a regular expression, never by a model reading the
 * conversation. The person may set their own pattern; it is always matched case-insensitively, with
 * Unicode (`iu`).
 */
import { AssistantError } from '@factory/assistant-core';

/**
 * `#помічник`, `@помічник`, `#assistant`, `@assistant`, in any case, as a whole word: not inside
 * another word (`#помічникові`) or an address (`me@assistant.example`).
 */
export const DEFAULT_TAG_PATTERN = '(?<![\\p{L}\\p{N}_])[#@](?:помічник|assistant)(?![\\p{L}\\p{N}_])';

export const TAG_FLAGS = 'iu';

/** Who may tag: only the person themself (the default), or anyone in the chat. */
export type TagWho = 'me' | 'anyone';

/** Messages before a tag in a flat chat taken as its context (unless an earlier tag comes first). */
export const DEFAULT_CONTEXT_MESSAGES = 10;
export const MAX_CONTEXT_MESSAGES = 50;

export const MAX_TAG_PATTERN_LENGTH = 200;

/** The part of a message a tag is looked for in: a pattern never runs over more than this. */
export const TAG_SCAN_CHARS = 4000;

/** The person's tag settings; `pattern: null` is the default pattern. */
export interface TagSettings {
  pattern: string | null;
  who: TagWho;
  contextMessages: number;
}

export const DEFAULT_TAG_SETTINGS: TagSettings = { pattern: null, who: 'me', contextMessages: DEFAULT_CONTEXT_MESSAGES };

/** Ordinary chat lines (from the case that retired the channel modes): a tag must never match one. */
const ORDINARY = ['', ' ', 'да', 'ВЖЕ', '7 ЗАПИСАВ', 'ok', 'дякую'];

/**
 * Why a pattern cannot be a tag, or `null` when it can: it must compile, stay short, not match an
 * empty or ordinary line (that would make every message a request), and not nest quantifiers (a
 * pattern that could backtrack for ever runs on the server).
 */
export function tagPatternProblem(pattern: string): string | null {
  if (typeof pattern !== 'string' || !pattern.trim()) return 'The tag pattern is empty.';
  if (pattern.length > MAX_TAG_PATTERN_LENGTH) return `The tag pattern is longer than ${MAX_TAG_PATTERN_LENGTH} characters.`;
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, TAG_FLAGS);
  } catch (error) {
    return `The tag pattern is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(pattern)) {
    return 'The tag pattern repeats a group that itself repeats (like (a+)+); write it without nested repetition.';
  }
  const ordinary = ORDINARY.find(line => regex.test(line));
  if (ordinary !== undefined) {
    return ordinary.trim() ? `The tag pattern matches an ordinary message ("${ordinary}"): it must need a tag.` : 'The tag pattern matches an empty message: it must need a tag.';
  }
  return null;
}

/** The person's pattern checked; throws `invalid_tag_pattern` (400) saying why. */
export function assertTagPattern(pattern: string): void {
  const problem = tagPatternProblem(pattern);
  if (problem) throw new AssistantError('invalid_tag_pattern', problem, 400);
}

/** A tag matcher for one read: whether a text carries the tag, and the text with it stripped. */
export interface TagMatcher {
  test(text: string): boolean;
  strip(text: string): string;
}

export function tagMatcher(pattern: string | null): TagMatcher {
  const source = pattern ?? DEFAULT_TAG_PATTERN;
  const once = new RegExp(source, TAG_FLAGS);
  const every = new RegExp(source, `${TAG_FLAGS}g`);
  return {
    test: text => once.test((text ?? '').slice(0, TAG_SCAN_CHARS)),
    strip: text =>
      (text ?? '')
        .replace(every, ' ')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/^[ \t,:;—-]+/gm, '')
        .trim(),
  };
}
