/**
 * The one place personal data and secrets are removed from what an outside system returns (logs,
 * crash reports, an external MCP server's tool results) before it reaches a model, a route or a log.
 * Moved here from the Firebase integration so every consumer masks the same way.
 *
 * Patterns are deliberately broad: a false positive costs an agent a masked value, a false negative
 * sends a customer's data to a model.
 */

const RULES: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  // JWTs (three base64url parts, the first decoding to a JSON header).
  { pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, replacement: '[redacted-jwt]' },
  // Authorization headers and bearer tokens, whatever follows.
  { pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: '$1 [redacted-token]' },
  // Google API keys, OAuth access tokens, refresh tokens.
  { pattern: /\bAIza[0-9A-Za-z_-]{30,}/g, replacement: '[redacted-key]' },
  { pattern: /\bya29\.[0-9A-Za-z_-]{20,}/g, replacement: '[redacted-token]' },
  { pattern: /\b1\/\/[0-9A-Za-z_-]{20,}/g, replacement: '[redacted-token]' },
  // Common secret prefixes (Stripe, GitHub, Slack, OpenAI-style keys).
  { pattern: /\b(sk|pk|rk)_(live|test)_[0-9A-Za-z]{8,}/g, replacement: '[redacted-key]' },
  { pattern: /\b(ghp|gho|ghs|ghu|github_pat)_[0-9A-Za-z_]{16,}/g, replacement: '[redacted-key]' },
  { pattern: /\bxox[abposr]-[0-9A-Za-z-]{10,}/g, replacement: '[redacted-key]' },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, replacement: '[redacted-key]' },
  // key=value pairs whose key says secret.
  {
    pattern: /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization)(["']?\s*[:=]\s*["']?)(?!(?:Bearer|Basic|Token)\b)[^\s"',;&\[]{4,}/gi,
    replacement: '$1$2[redacted]',
  },
  // Private key blocks.
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '[redacted-private-key]' },
  // Emails.
  { pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, replacement: '[email]' },
  // IPv4 and IPv6.
  { pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, replacement: '[ip]' },
  { pattern: /\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi, replacement: '[ip]' },
  // Phone numbers: an optional +, then 9–15 digits with spaces, dots, dashes or brackets between.
  { pattern: /(?<![\w.])\+?\d[\d\s().-]{7,}\d(?!\w|\.\d)/g, replacement: '[phone]' },
];

/** The text with personal data and secrets masked. */
export function redactText(text: string): string {
  let result = text;
  for (const { pattern, replacement } of RULES) result = result.replace(pattern, replacement);
  return result;
}

/** Every string in a JSON-like value redacted; keys are kept. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T;
  if (Array.isArray(value)) return value.map(item => redactDeep(item)) as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item)])) as T;
  }
  return value;
}
