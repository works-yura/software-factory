/** What a failed request or thrown value says, for a notice or a menu line: its message, or the value itself. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
