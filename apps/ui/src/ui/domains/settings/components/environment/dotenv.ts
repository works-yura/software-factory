/**
 * Parsing `.env` text for the import dialog, and checking what it found against
 * the server's rules before anything is sent.
 *
 * Unlike `parseEnvFileText` in playground-ui (upstream Mastra), nothing is
 * skipped quietly: a line that isn't an assignment, or a quote that never
 * closes, comes back as a problem with its line number so the dialog can show it.
 */

export interface DotenvEntry {
  key: string;
  value: string;
  /** 1-based line (or form row) the entry starts on. */
  line: number;
}

export type DotenvLineProblem = 'missingEquals' | 'missingName' | 'unterminatedQuote' | 'textAfterQuote';

export interface DotenvProblem {
  line: number;
  problem: DotenvLineProblem;
  /** The name before `=`, when there was one; never the value. */
  key?: string;
}

export interface DotenvParseResult {
  entries: DotenvEntry[];
  problems: DotenvProblem[];
}

const QUOTES = new Set(['"', "'", '`']);

/** Index of the closing quote at or after `from`, or -1. Only double quotes honour `\"`. */
function closingQuote(text: string, quote: string, from: number): number {
  for (let index = from; index < text.length; index++) {
    if (quote === '"' && text[index] === '\\') {
      index++;
      continue;
    }
    if (text[index] === quote) return index;
  }
  return -1;
}

/** Whatever follows a closing quote may only be whitespace or a `#` comment. */
function onlyCommentAfter(rest: string): boolean {
  const trimmed = rest.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

function unescapeDoubleQuoted(value: string): string {
  return value.replace(/\\([nrt"\\])/g, (_match, char: string) => {
    if (char === 'n') return '\n';
    if (char === 'r') return '\r';
    if (char === 't') return '\t';
    return char;
  });
}

/**
 * Handles `KEY=value`, `export KEY=value`, blank and `#` lines, inline ` #`
 * comments after unquoted values, `=` inside values, empty values, and
 * single-, double- or backtick-quoted values that may span lines (private
 * keys). Double quotes understand `\n`, `\r`, `\t`, `\"` and `\\`; the others
 * are literal.
 */
export function parseDotenv(text: string): DotenvParseResult {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const entries: DotenvEntry[] = [];
  const problems: DotenvProblem[] = [];

  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const trimmed = lines[index]!.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const assignment = trimmed.replace(/^export\s+/, '');
    const eq = assignment.indexOf('=');
    if (eq === -1) {
      problems.push({ line: lineNumber, problem: 'missingEquals' });
      continue;
    }
    const key = assignment.slice(0, eq).trim();
    if (!key) {
      problems.push({ line: lineNumber, problem: 'missingName' });
      continue;
    }

    const raw = assignment.slice(eq + 1).trimStart();
    const quote = raw[0];
    if (quote === undefined || !QUOTES.has(quote)) {
      const comment = raw.search(/\s#/);
      entries.push({ key, value: (comment === -1 ? raw : raw.slice(0, comment)).trim(), line: lineNumber });
      continue;
    }

    // A quoted value: find where it closes, on this line or a later one.
    let close = closingQuote(raw, quote, 1);
    let value: string;
    let after: string;
    let endIndex = index;
    if (close !== -1) {
      value = raw.slice(1, close);
      after = raw.slice(close + 1);
    } else {
      const parts = [raw.slice(1)];
      for (let next = index + 1; next < lines.length; next++) {
        const candidate = lines[next]!;
        const found = closingQuote(candidate, quote, 0);
        if (found !== -1) {
          parts.push(candidate.slice(0, found));
          close = found;
          endIndex = next;
          break;
        }
        parts.push(candidate);
      }
      if (close === -1) {
        // Report it and keep reading after this line, so the rest of the file isn't swallowed.
        problems.push({ line: lineNumber, problem: 'unterminatedQuote', key });
        continue;
      }
      value = parts.join('\n');
      after = lines[endIndex]!.slice(close + 1);
    }

    if (!onlyCommentAfter(after)) {
      // On one line the quote closed too early; across lines it most likely never closed, and
      // the quote found belongs to a later line, which is read again on its own.
      problems.push({ line: lineNumber, problem: endIndex === index ? 'textAfterQuote' : 'unterminatedQuote', key });
      continue;
    }
    entries.push({ key, value: quote === '"' ? unescapeDoubleQuoted(value) : value, line: lineNumber });
    index = endIndex;
  }

  return { entries, problems };
}

// The server's rules for a variable (`sandboxEnvNameSchema`, `sandboxEnvSetBodySchema`
// in packages/contracts), repeated so the review can explain a refusal before saving.
// The server stays the judge.
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_NAME_LENGTH = 128;
const RESERVED_NAMES = [/^GH_TOKEN(_\d+)?$/, /^MASTRA_REPOSITORY_ACCESS_TOKEN(_\d+)?$/, /^MASTRA_BUILD_ENV_REVISION$/];
export const MAX_SANDBOX_ENV_VALUE_LENGTH = 32 * 1024;

export type ImportEntryProblem = 'invalidName' | 'reserved' | 'valueTooLong' | 'valueNul' | 'duplicate';

export interface ImportReviewRow extends DotenvEntry {
  /** Set when the row is not saved; `duplicate` means a later line with the same name wins. */
  problem?: ImportEntryProblem;
  /** For a duplicate, the line whose value is used instead. */
  replacedBy?: number;
  /** The name already exists, so saving replaces its value, where it applies and its stage. */
  overwrites: boolean;
}

function entryProblem({ key, value }: DotenvEntry): ImportEntryProblem | undefined {
  if (key.length > MAX_NAME_LENGTH || !NAME.test(key) || key in Object.prototype) return 'invalidName';
  if (RESERVED_NAMES.some(pattern => pattern.test(key))) return 'reserved';
  if (value.length > MAX_SANDBOX_ENV_VALUE_LENGTH) return 'valueTooLong';
  if (value.includes('\0')) return 'valueNul';
  return undefined;
}

/**
 * What saving would do with each entry: rows with a `problem` are not sent.
 * When a name repeats, the last one wins and the earlier ones are marked.
 */
export function reviewImport(entries: readonly DotenvEntry[], existingNames: ReadonlySet<string>): ImportReviewRow[] {
  const lastLine = new Map<string, number>();
  for (const entry of entries) lastLine.set(entry.key, entry.line);
  return entries.map(entry => {
    const winner = lastLine.get(entry.key)!;
    const overwrites = existingNames.has(entry.key);
    if (winner !== entry.line) return { ...entry, problem: 'duplicate', replacedBy: winner, overwrites };
    const problem = entryProblem(entry);
    return problem ? { ...entry, problem, overwrites } : { ...entry, overwrites };
  });
}
