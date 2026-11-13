/** `value` as one POSIX shell word: single-quoted, with each `'` closed, escaped and reopened. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
