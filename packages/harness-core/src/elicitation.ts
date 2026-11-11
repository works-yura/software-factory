// An MCP server's elicitation as the Factory's question card, for every harness whose agent
// forwards one (Codex's `mcpServer/elicitation/request`, Claude Code's `elicitation` control
// request): a form's fields become the card's questions (choices for enums and booleans, a free
// answer for text and numbers), a link the person opens becomes a Done / Decline question, and the
// person's answers are read back into the typed content the server asked for.

/** A JSON value, as an elicitation's schema defaults and answers carry them. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** One field of an elicitation form, as the MCP `requestedSchema` describes it. */
export interface McpElicitationField {
  readonly type?: string | null;
  readonly title?: string | null;
  readonly description?: string | null;
  readonly default?: JsonValue;
  readonly enum?: ReadonlyArray<string> | null;
  readonly enumNames?: ReadonlyArray<string> | null;
  readonly oneOf?: ReadonlyArray<{ readonly const: string; readonly title?: string | null }> | null;
  readonly anyOf?: ReadonlyArray<{ readonly const: string; readonly title?: string | null }> | null;
  readonly items?: {
    readonly type?: string | null;
    readonly enum?: ReadonlyArray<string> | null;
    readonly anyOf?: ReadonlyArray<{ readonly const: string; readonly title?: string | null }> | null;
    readonly oneOf?: ReadonlyArray<{ readonly const: string; readonly title?: string | null }> | null;
  } | null;
  readonly minimum?: number | null;
  readonly maximum?: number | null;
}

export interface McpElicitationForm {
  readonly properties?: Readonly<Record<string, McpElicitationField>>;
  readonly required?: ReadonlyArray<string> | null;
}

/** What an elicitation request carries (MCP's `elicitation/create` params and the server that sent it). */
export interface McpElicitationRequest {
  readonly serverName?: string;
  readonly mode?: string;
  readonly message?: string;
  readonly requestedSchema?: unknown;
  readonly url?: string;
  readonly elicitationId?: string;
}

export type McpElicitationResponse = { action: 'accept' | 'decline' | 'cancel'; content?: JsonValue; _meta?: JsonValue | null };

type Choice = { value: string; label: string };

/** How a person's answers are read back into the server's content. */
export type ElicitationPlan =
  | { kind: 'form'; fields: Array<{ key: string; field: McpElicitationField; choices: Choice[]; multi: boolean; question: string }>; required: string[] }
  | { kind: 'confirm'; question: string }
  | { kind: 'url'; question: string };

const DONE = 'Done';
const DECLINE = 'Decline';
const ACCEPT = 'Accept';
const YES = 'Yes';
const NO = 'No';
const RECOMMENDED = ' (Recommended)';

function isForm(value: unknown): value is McpElicitationForm {
  return !!value && typeof value === 'object' && !Array.isArray(value) && (!('properties' in value) || typeof (value as { properties?: unknown }).properties === 'object');
}

function listChoices(list: ReadonlyArray<{ const: string; title?: string | null }> | null | undefined): Choice[] {
  return (list ?? []).map(option => ({ value: option.const, label: option.title?.trim() || option.const }));
}

function fieldChoices(field: McpElicitationField): { choices: Choice[]; multi: boolean } {
  if (field.type === 'array' && field.items) {
    const choices = field.items.enum?.length ? field.items.enum.map(value => ({ value, label: value })) : listChoices(field.items.anyOf ?? field.items.oneOf);
    return { choices, multi: true };
  }
  if (field.oneOf?.length || field.anyOf?.length) return { choices: listChoices(field.oneOf ?? field.anyOf), multi: false };
  if (field.enum?.length) return { choices: field.enum.map((value, index) => ({ value, label: field.enumNames?.[index]?.trim() || value })), multi: false };
  if (field.type === 'boolean') return { choices: [{ value: 'true', label: YES }, { value: 'false', label: NO }], multi: false };
  return { choices: [], multi: false };
}

/** The field's default as a choice value, so the card can put it first as the recommendation. */
function defaultValue(field: McpElicitationField): string | undefined {
  if (field.default === undefined || field.default === null) return undefined;
  if (typeof field.default === 'boolean') return String(field.default);
  return typeof field.default === 'string' ? field.default : undefined;
}

/**
 * The question card an elicitation reads as (the `AskUserQuestion` input), and how its answers are
 * read back; `undefined` when a person cannot answer it here (a device-verification challenge).
 */
export function elicitationQuestions(request: McpElicitationRequest): { input: { questions: Array<Record<string, unknown>> }; plan: ElicitationPlan } | undefined {
  const message = request.message?.trim() || `${request.serverName ?? 'An MCP server'} asks for input.`;
  const header = (request.serverName ?? 'MCP').slice(0, 30);
  if (request.mode === 'url') {
    if (!request.url) return undefined;
    const question = `${message}\n\n${request.url}`;
    return {
      input: { questions: [{ id: 'url', header, question, options: [{ label: DONE, description: 'I opened the link and finished there.' }, { label: DECLINE }] }] },
      plan: { kind: 'url', question },
    };
  }
  if (request.mode !== undefined && request.mode !== 'form' && request.mode !== 'openai/form' && request.mode !== 'openaiForm') return undefined;
  const form = isForm(request.requestedSchema) ? request.requestedSchema : undefined;
  const entries = Object.entries(form?.properties ?? {});
  if (entries.length === 0) {
    return {
      input: { questions: [{ id: 'confirm', header, question: message, options: [{ label: ACCEPT }, { label: DECLINE }] }] },
      plan: { kind: 'confirm', question: message },
    };
  }
  const fields = entries.map(([key, field], index) => {
    const { choices, multi } = fieldChoices(field);
    const label = field.description?.trim() || field.title?.trim() || key;
    const question = index === 0 && label !== message ? `${message}\n\n${label}` : label;
    return { key, field, choices, multi, question };
  });
  const questions = fields.map(({ key, field, choices, multi, question }) => {
    const recommended = defaultValue(field);
    // The default leads, marked as the recommendation, as every Factory question card orders them.
    const ordered = recommended !== undefined ? [...choices.filter(choice => choice.value === recommended), ...choices.filter(choice => choice.value !== recommended)] : choices;
    return {
      id: key,
      header: (field.title?.trim() || key).slice(0, 30),
      question,
      ...(ordered.length
        ? { options: ordered.map(choice => ({ label: choice.value === recommended && !multi ? `${choice.label}${RECOMMENDED}` : choice.label })) }
        : {}),
      ...(multi ? { multiSelect: true } : {}),
    };
  });
  return { input: { questions }, plan: { kind: 'form', fields, required: [...(form?.required ?? [])] } };
}

const stripMark = (value: string) => value.replace(/\s*\((?:recommended|рекомендовано)\)\s*$/i, '').trim();

/**
 * Splits one reply to several questions back into each one's answer. The chat sends a card's
 * answers as one text, each under its numbered question (`1. <question>\n   → <answer>`).
 */
export function splitQuestionAnswers(questions: ReadonlyArray<string>, answer: string | ReadonlyArray<string>): string[] {
  if (Array.isArray(answer)) return questions.length <= 1 ? [answer.join('; ')] : questions.map((_, index) => answer[index] ?? '');
  const text = (answer as string).replace(/\r\n/g, '\n');
  if (questions.length <= 1) return [text.trim()];
  const marker = (index: number) => `${index + 1}. ${questions[index]}\n   → `;
  const starts = questions.map((_, index) => text.indexOf(marker(index)));
  if (starts.some(start => start === -1)) return questions.map(() => text.trim());
  return questions.map((_, index) => {
    const from = starts[index]! + marker(index).length;
    const next = starts.slice(index + 1).find(start => start > from);
    return text.slice(from, next === undefined ? undefined : next).trim();
  });
}

function choiceFor(choices: Choice[], answer: string): string | undefined {
  const wanted = stripMark(answer).toLowerCase();
  return choices.find(choice => choice.label.toLowerCase() === wanted || choice.value.toLowerCase() === wanted)?.value;
}

function typedValue(field: McpElicitationField, choices: Choice[], multi: boolean, answer: string): JsonValue | undefined {
  const text = answer.trim();
  if (!text) return undefined;
  if (multi) {
    const parts = text.split(/\s*[;,\n]\s*/).filter(Boolean);
    return parts.map(part => choiceFor(choices, part) ?? stripMark(part));
  }
  if (field.type === 'boolean') {
    const value = choiceFor(choices, text) ?? text.toLowerCase();
    if (['true', 'yes', 'y', 'так'].includes(value)) return true;
    if (['false', 'no', 'n', 'ні'].includes(value)) return false;
    return undefined;
  }
  if (field.type === 'number' || field.type === 'integer') {
    const value = Number(text.replace(',', '.'));
    if (!Number.isFinite(value)) return undefined;
    return field.type === 'integer' ? Math.round(value) : value;
  }
  if (choices.length) return choiceFor(choices, text) ?? stripMark(text);
  return text;
}

/** The server's answer from the person's: typed content, or a decline when they declined or left a required field out. */
export function elicitationResponse(plan: ElicitationPlan, answer: string | ReadonlyArray<string>): McpElicitationResponse {
  if (plan.kind === 'url' || plan.kind === 'confirm') {
    const [only = ''] = splitQuestionAnswers([plan.question], answer);
    const chosen = stripMark(only).toLowerCase();
    if (chosen === DECLINE.toLowerCase() || chosen === '') return { action: 'decline' };
    return plan.kind === 'url' ? { action: 'accept' } : { action: 'accept', content: {} };
  }
  const answers = splitQuestionAnswers(plan.fields.map(field => field.question), answer);
  const content: Record<string, JsonValue> = {};
  plan.fields.forEach(({ key, field, choices, multi }, index) => {
    const value = typedValue(field, choices, multi, answers[index] ?? '');
    if (value !== undefined) content[key] = value;
    else if (field.default !== undefined && field.default !== null) content[key] = field.default;
  });
  if (plan.required.some(key => !Object.hasOwn(content, key))) return { action: 'decline' };
  return { action: 'accept', content };
}
