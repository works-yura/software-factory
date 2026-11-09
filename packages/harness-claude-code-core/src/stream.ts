/**
 * Parser for `claude -p --output-format stream-json --verbose` stdout.
 *
 * Every stdout line is one JSON object. The CLI adds message kinds between
 * releases, so anything unrecognised is kept as `unknown` instead of failing
 * the turn; a non-JSON line (a stray log, a crash banner) becomes `invalid`.
 */

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { type: 'unknown'; raw: Record<string, unknown> };

export type ClaudeStreamMessage =
  | {
      type: 'system';
      subtype: 'init';
      sessionId: string;
      model?: string;
      cwd?: string;
      permissionMode?: string;
      tools?: string[];
      raw: Record<string, unknown>;
    }
  | { type: 'system'; subtype: string; sessionId?: string; raw: Record<string, unknown> }
  | {
      type: 'assistant';
      sessionId?: string;
      messageId?: string;
      model?: string;
      /** Set when a subagent (Task tool) produced the message. */
      parentToolUseId?: string;
      content: ClaudeContentBlock[];
      usage?: ClaudeUsage;
      /** The CLI marks synthetic API-error messages (`rate_limit`, `authentication_failed`, …). */
      error?: string;
      raw: Record<string, unknown>;
    }
  | {
      type: 'user';
      sessionId?: string;
      parentToolUseId?: string;
      content: ClaudeContentBlock[];
      raw: Record<string, unknown>;
    }
  | {
      type: 'stream_event';
      sessionId?: string;
      parentToolUseId?: string;
      event: Record<string, unknown>;
      raw: Record<string, unknown>;
    }
  | {
      type: 'rate_limit';
      sessionId?: string;
      status?: string;
      /** When the limit resets, if the CLI said. */
      resetsAt?: Date;
      rateLimitType?: string;
      raw: Record<string, unknown>;
    }
  | {
      type: 'result';
      subtype: string;
      isError: boolean;
      sessionId?: string;
      result?: string;
      usage?: ClaudeUsage;
      totalCostUsd?: number;
      durationMs?: number;
      numTurns?: number;
      apiErrorStatus?: number;
      errors: string[];
      raw: Record<string, unknown>;
    }
  | { type: 'unknown'; raw: Record<string, unknown> }
  | { type: 'invalid'; line: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function usageOf(value: unknown): ClaudeUsage | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const cacheCreation = record(raw.cache_creation);
  const usage: ClaudeUsage = {};
  const copy = (key: 'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens') => {
    const n = num(raw[key]);
    if (n !== undefined) usage[key] = n;
  };
  copy('input_tokens');
  copy('output_tokens');
  copy('cache_read_input_tokens');
  copy('cache_creation_input_tokens');
  if (cacheCreation) {
    usage.cache_creation = {};
    const m5 = num(cacheCreation.ephemeral_5m_input_tokens);
    const h1 = num(cacheCreation.ephemeral_1h_input_tokens);
    if (m5 !== undefined) usage.cache_creation.ephemeral_5m_input_tokens = m5;
    if (h1 !== undefined) usage.cache_creation.ephemeral_1h_input_tokens = h1;
  }
  return usage;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => str(record(part)?.text))
    .filter((text): text is string => text !== undefined)
    .join('\n');
}

function contentOf(message: Record<string, unknown> | undefined): ClaudeContentBlock[] {
  const content = message?.content;
  // A user turn the CLI echoes back can carry plain string content.
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: ClaudeContentBlock[] = [];
  for (const entry of content) {
    const block = record(entry);
    if (!block) continue;
    switch (block.type) {
      case 'text':
        blocks.push({ type: 'text', text: typeof block.text === 'string' ? block.text : '' });
        break;
      case 'thinking':
        blocks.push({ type: 'thinking', thinking: typeof block.thinking === 'string' ? block.thinking : '' });
        break;
      case 'tool_use':
        blocks.push({
          type: 'tool_use',
          id: str(block.id) ?? '',
          name: str(block.name) ?? 'unknown',
          input: block.input ?? {},
        });
        break;
      case 'tool_result':
        blocks.push({
          type: 'tool_result',
          toolUseId: str(block.tool_use_id) ?? '',
          content: toolResultText(block.content),
          isError: block.is_error === true,
        });
        break;
      default:
        blocks.push({ type: 'unknown', raw: block });
    }
  }
  return blocks;
}

function errorsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const messages: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      if (entry.trim()) messages.push(entry.trim());
      continue;
    }
    const obj = record(entry);
    if (!obj) continue;
    const message = str(obj.message) ?? str(obj.error) ?? str(obj.code);
    messages.push(message ?? JSON.stringify(obj));
  }
  return messages;
}

/** Unix seconds or milliseconds, or an ISO string. */
function dateOf(value: unknown): Date | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value < 1e12 ? value * 1000 : value);
  }
  if (typeof value === 'string' && value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}

export function parseStreamLine(line: string): ClaudeStreamMessage | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { type: 'invalid', line: trimmed };
  }
  const raw = record(parsed);
  if (!raw) return { type: 'invalid', line: trimmed };
  const sessionId = str(raw.session_id);
  const parentToolUseId = str(raw.parent_tool_use_id);
  const withSession = <T extends object>(value: T) => (sessionId ? { ...value, sessionId } : value);
  const withParent = <T extends object>(value: T) => (parentToolUseId ? { ...value, parentToolUseId } : value);

  switch (raw.type) {
    case 'system':
      return systemMessage(raw, sessionId) ?? withSession({ type: 'system' as const, subtype: str(raw.subtype) ?? '', raw });
    case 'assistant':
      return withParent(withSession(assistantMessage(raw)));
    case 'user':
      return withParent(withSession({ type: 'user' as const, content: contentOf(record(raw.message)), raw }));
    case 'stream_event':
      return withParent(withSession({ type: 'stream_event' as const, event: record(raw.event) ?? {}, raw }));
    case 'rate_limit_event':
      return withSession(rateLimitMessage(raw));
    case 'result':
      return withSession(resultMessage(raw));
    default:
      return { type: 'unknown', raw };
  }
}

/** The `system init` line, which names the session; any other system line is left to the caller. */
function systemMessage(raw: Record<string, unknown>, sessionId: string | undefined): ClaudeStreamMessage | undefined {
  if (str(raw.subtype) !== 'init' || !sessionId) return undefined;
  const tools = Array.isArray(raw.tools) ? raw.tools.filter((t): t is string => typeof t === 'string') : undefined;
  return {
    type: 'system',
    subtype: 'init',
    sessionId,
    ...(str(raw.model) ? { model: str(raw.model) } : {}),
    ...(str(raw.cwd) ? { cwd: str(raw.cwd) } : {}),
    ...(str(raw.permissionMode) ? { permissionMode: str(raw.permissionMode) } : {}),
    ...(tools ? { tools } : {}),
    raw,
  };
}

function assistantMessage(raw: Record<string, unknown>) {
  const message = record(raw.message);
  const usage = usageOf(message?.usage);
  const messageId = str(message?.id);
  const model = str(message?.model);
  const error = str(raw.error);
  return {
    type: 'assistant' as const,
    content: contentOf(message),
    ...(messageId ? { messageId } : {}),
    ...(model ? { model } : {}),
    ...(usage ? { usage } : {}),
    ...(error ? { error } : {}),
    raw,
  };
}

function rateLimitMessage(raw: Record<string, unknown>) {
  const info = record(raw.rate_limit_info) ?? {};
  const resetsAt = dateOf(info.resetsAt ?? info.resets_at);
  const status = str(info.status);
  const rateLimitType = str(info.rateLimitType ?? info.rate_limit_type);
  return {
    type: 'rate_limit' as const,
    ...(status ? { status } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    ...(rateLimitType ? { rateLimitType } : {}),
    raw,
  };
}

function resultMessage(raw: Record<string, unknown>) {
  const usage = usageOf(raw.usage);
  const result = typeof raw.result === 'string' ? raw.result : undefined;
  const totalCostUsd = num(raw.total_cost_usd);
  const durationMs = num(raw.duration_ms);
  const numTurns = num(raw.num_turns);
  const apiErrorStatus = num(raw.api_error_status);
  return {
    type: 'result' as const,
    subtype: str(raw.subtype) ?? '',
    isError: raw.is_error === true,
    errors: errorsOf(raw.errors),
    ...(result !== undefined ? { result } : {}),
    ...(usage ? { usage } : {}),
    ...(totalCostUsd !== undefined ? { totalCostUsd } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(numTurns !== undefined ? { numTurns } : {}),
    ...(apiErrorStatus !== undefined ? { apiErrorStatus } : {}),
    raw,
  };
}

/** Splits a byte stream into lines, holding a partial line until its newline arrives. */
export function createLineSplitter(onLine: (line: string) => void) {
  let buffer = '';
  return {
    push(chunk: string) {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (line.trim()) onLine(line);
        newline = buffer.indexOf('\n');
      }
    },
    flush() {
      const rest = buffer.replace(/\r$/, '');
      buffer = '';
      if (rest.trim()) onLine(rest);
    },
  };
}
