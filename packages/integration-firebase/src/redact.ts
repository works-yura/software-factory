/**
 * Masking for what Firebase returns, before anything leaves this package (agent tools, routes, logs).
 * Production logs and crash reports carry user emails, phone numbers, IPs and, now and then, a token
 * someone logged by mistake. The rules live in `@factory/capabilities`, shared with external MCP servers.
 */

import { OBSERVABILITY_LIMITS, redactText } from '@factory/capabilities';

export { redactDeep, redactText } from '@factory/capabilities';

/** Redacted and cut to `max` characters (an ellipsis marks the cut). */
export function redactAndCut(text: string, max: number = OBSERVABILITY_LIMITS.maxMessageChars): string {
  const redacted = redactText(text);
  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}

