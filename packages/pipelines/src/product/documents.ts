/**
 * The documents a Product card produces, and the checks that gate its moves.
 *
 * A project keeps all its documentation in ONE folder: a separate documentation repository in a
 * multi-repository project, or one folder in the repository of a monorepo. It is never split per
 * component (backend, web, mobile): one design covers every component, so the links between them
 * hold. The layout is the team's spec-driven convention:
 *
 * ```
 * <docs>/raw/                         client sources (PRD, notes, dumps): input, only ever added to
 * <docs>/specify/INDEX.md             feature list, status, cross-feature dependencies
 * <docs>/specify/<feature>/research.md   Research: what the engineer knows, the decisions taken
 * <docs>/specify/<feature>/requirements.md   the client-facing brief
 * <docs>/specify/<feature>/design.md      the technical spec for the team
 * <docs>/specify/<feature>/tasks.md       the phases, as INVEST tasks with a dependency graph
 * <docs>/GLOSSARY.md, <docs>/adr/     domain language and decision records
 * ```
 *
 * The structure check is deterministic and costs no tokens: required sections per document type,
 * the Mermaid diagrams the design must carry, and the fields every task in tasks.md must have.
 * Contradictions with existing documents and decision records are the agent's judgement; it lists
 * them, and the check passes only once every listed contradiction is resolved. The result is
 * stored on the card's metadata, where the board's gates read it.
 */

/**
 * Document types, by the Product phase that writes them: `enrich` is Research, `brief` the
 * client-facing brief, `spec` the technical spec, `tasks` the phases. The ids name the phases (and
 * key the checks stored on cards), the files follow the team's layout.
 */
export const PRODUCT_DOCUMENT_TYPES = ['enrich', 'brief', 'spec', 'tasks'] as const;
export type ProductDocumentType = (typeof PRODUCT_DOCUMENT_TYPES)[number];

/** Each document's file name inside `<docs>/specify/<feature>/`. */
export const PRODUCT_DOCUMENT_FILES: Readonly<Record<ProductDocumentType, string>> = {
  enrich: 'research.md',
  brief: 'requirements.md',
  spec: 'design.md',
  tasks: 'tasks.md',
};

/** Card metadata key holding the latest check per document type. */
export const PRODUCT_DOC_CHECKS_KEY = 'productDocChecks';
/** Card metadata key listing the Work cards a Product card filed. */
export const PRODUCT_CHILDREN_KEY = 'productChildWorkItemIds';

interface RequiredSection {
  /** What the section is called in the report. */
  readonly label: string;
  /** A heading (`#`…`######`) matching any of these, case-insensitive, satisfies it. */
  readonly match: readonly RegExp[];
}

const section = (label: string, ...match: RegExp[]): RequiredSection => ({ label, match });

const OPEN_QUESTIONS = section('Open questions', /open questions?/i, /відкрит/i);

/** The sections each document must have, in the order the templates put them (English or Ukrainian headings). */
export const PRODUCT_DOCUMENT_SECTIONS: Readonly<Record<ProductDocumentType, readonly RequiredSection[]>> = {
  // What the engineer knows, and the decisions the interview settled.
  enrich: [
    section('How the system works', /how .*works/i, /system/i, /як .*працю/i, /систем/i),
    section('Pitfalls', /pitfall/i, /gotcha/i, /підводн/i),
    section('Constraints', /constraint/i, /обмежен/i),
    section('Decisions', /decisions?/i, /рішенн/i),
    OPEN_QUESTIONS,
  ],
  // The client-facing brief: plain language, nothing a client can't read.
  brief: [
    section('Goal', /goal/i, /purpose/i, /context/i, /мета/i, /ціль/i, /контекст/i),
    section('Users', /users?\b(?! stor)/i, /roles?/i, /who uses/i, /користувач/i, /ролі/i),
    section('Use cases', /use cases?/i, /user stor/i, /journeys?/i, /scenarios?/i, /сценарі/i, /історі/i),
    section('Edge cases', /edge cases?/i, /states?/i, /крайов/i, /стан/i),
    section('Acceptance criteria', /acceptance/i, /критері/i),
    section('Not included', /not included/i, /non-goals?/i, /out of scope/i, /не входить/i, /поза межами/i),
    section('Constraints', /constraint/i, /обмежен/i),
    section('Technology', /technolog/i, /stack/i, /технолог/i, /стек/i),
    section('Phases', /phases?/i, /delivery/i, /фази/i, /етапи/i),
    section('Estimate', /estimate/i, /оцінк/i),
    section('Approval gates', /approv/i, /погодж/i),
    section('Done means', /done means/i, /definition of done/i, /готово означає/i),
    OPEN_QUESTIONS,
  ],
  // The technical spec for the team: how the feature fits the system, every component in one place.
  spec: [
    section('Architecture', /architecture/i, /архітектур/i),
    section('Sequences', /sequences?/i, /послідовн/i),
    section('Data flow', /data flow/i, /потік даних/i, /потоки даних/i),
    section('Modules touched', /modules?/i, /components?/i, /модул/i, /компонент/i),
    section('API contract', /contracts?/i, /\bapi\b/i, /контракт/i),
    section('Data model', /data model/i, /модель даних/i),
    section('Security', /security/i, /безпек/i),
    section('Shared resources', /shared/i, /foundation/i, /спільн/i),
    section('Test plan', /test plan/i, /testing/i, /план тест/i, /тестуван/i),
    section('Decisions', /decisions?/i, /\badrs?\b/i, /рішенн/i),
    section('Consult round', /consult/i, /lens/i, /погодження контракт/i, /консульт/i),
    section('Premortem outcome', /pre-?mortem/i, /премортем/i),
    OPEN_QUESTIONS,
  ],
  // The phases: an ordered, checkable backlog the Development board builds.
  tasks: [
    section('Order', /order/i, /порядок/i),
    section('Tasks', /^tasks$/i, /^задачі$/i),
    section('Coverage check', /coverage/i, /покриття/i),
  ],
};

interface RequiredDiagram {
  readonly label: string;
  /** The first line of a Mermaid block (its diagram type) matching any of these. */
  readonly match: readonly RegExp[];
}

/** The Mermaid diagrams a spec must carry: how the feature fits the system, high level. */
export const PRODUCT_SPEC_DIAGRAMS: readonly RequiredDiagram[] = [
  { label: 'C4 context or container diagram', match: [/^C4(Context|Container)\b/] },
  { label: 'sequence diagram', match: [/^sequenceDiagram\b/] },
  { label: 'data flow diagram (flowchart)', match: [/^(flowchart|graph)\b/] },
];

export interface ProductContradiction {
  /** What contradicts what, naming both documents. */
  readonly finding: string;
  readonly resolved: boolean;
  /** How it was resolved, when it was. */
  readonly resolution?: string;
}

export interface ProductDocumentCheck {
  readonly type: ProductDocumentType;
  readonly path: string;
  /** sha256 of the checked content, so a reader can tell the document changed since. */
  readonly sha256: string;
  readonly passed: boolean;
  readonly missingSections: readonly string[];
  readonly missingDiagrams: readonly string[];
  /** tasks.md only: tasks missing a required field, or depending on a task that does not exist. Absent on older checks. */
  readonly taskProblems?: readonly string[];
  readonly contradictions: readonly ProductContradiction[];
  readonly checkedAt: string;
}

function headings(markdown: string): string[] {
  const found: string[] = [];
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) found.push(match[1]!);
  }
  return found;
}

function mermaidKinds(markdown: string): string[] {
  const kinds: string[] = [];
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (!/^\s*(```|~~~)\s*mermaid\b/i.test(lines[index]!)) continue;
    // The diagram type is the first non-empty line that is not a front-matter fence or a comment.
    for (let next = index + 1; next < lines.length; next++) {
      const line = lines[next]!.trim();
      if (line === '' || line.startsWith('%%') || line === '---') continue;
      kinds.push(line);
      break;
    }
  }
  return kinds;
}

/** The fields every task in tasks.md carries, as `- <field>: …` lines under its heading. */
export const PRODUCT_TASK_FIELDS = ['role', 'depends-on', 'acceptance', 'verify'] as const;

const TASK_ID = /^([A-Z][A-Z0-9]*-\d+[a-z]?)\b/;
const NO_DEPENDENCY = /^(none|—|-|немає|нема)$/i;

/**
 * Problems with the tasks under tasks.md's `## Tasks`: each `### <ID> — <title>` must carry every
 * field in {@link PRODUCT_TASK_FIELDS}, and every `depends-on` id must be a task of this file
 * (a cross-feature dependency is written `<feature>/<ID>` and is not resolved here).
 */
export function productTaskProblems(markdown: string): string[] {
  const tasks = new Map<string, Set<string>>();
  const dependencies = new Map<string, string[]>();
  let inTasks = false;
  let current: string | undefined;
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!;
      if (level <= 2) {
        inTasks = /^(tasks|задачі)$/i.test(text);
        current = undefined;
      } else if (inTasks && level === 3) {
        current = TASK_ID.exec(text)?.[1];
        if (current) tasks.set(current, new Set());
      }
      continue;
    }
    if (!current) continue;
    const field = /^\s*[-*]\s*([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!field) continue;
    const name = field[1]!.toLowerCase();
    tasks.get(current)!.add(name);
    if (name === 'depends-on') {
      dependencies.set(
        current,
        field[2]!
          .split(/[,\s]+/)
          .map(value => value.replace(/[`*]/g, '').trim())
          .filter(value => value !== '' && !NO_DEPENDENCY.test(value)),
      );
    }
  }
  if (tasks.size === 0) return ['no tasks: write each as "### <ID> — <title>" under "## Tasks"'];
  const problems: string[] = [];
  for (const [id, fields] of tasks) {
    const missing = PRODUCT_TASK_FIELDS.filter(name => !fields.has(name));
    if (missing.length > 0) problems.push(`${id} has no ${missing.join(', ')}`);
    for (const dependency of dependencies.get(id) ?? []) {
      if (dependency.includes('/')) continue;
      if (!tasks.has(dependency)) problems.push(`${id} depends on ${dependency}, which is not a task in this file`);
    }
  }
  return problems;
}

/** Which required sections, diagrams and task fields `markdown` lacks for a document of `type`. */
export function checkProductDocumentStructure(
  type: ProductDocumentType,
  markdown: string,
): { missingSections: string[]; missingDiagrams: string[]; taskProblems: string[] } {
  const found = headings(markdown);
  const missingSections = PRODUCT_DOCUMENT_SECTIONS[type]
    .filter(required => !found.some(heading => required.match.some(pattern => pattern.test(heading))))
    .map(required => required.label);
  const kinds = type === 'spec' ? mermaidKinds(markdown) : [];
  const missingDiagrams =
    type === 'spec'
      ? PRODUCT_SPEC_DIAGRAMS.filter(
          required => !kinds.some(kind => required.match.some(pattern => pattern.test(kind))),
        ).map(required => required.label)
      : [];
  const taskProblems = type === 'tasks' ? productTaskProblems(markdown) : [];
  return { missingSections, missingDiagrams, taskProblems };
}

export function productDocumentPassed(check: {
  missingSections: readonly string[];
  missingDiagrams: readonly string[];
  taskProblems?: readonly string[];
  contradictions: readonly ProductContradiction[];
}): boolean {
  return (
    check.missingSections.length === 0 &&
    check.missingDiagrams.length === 0 &&
    (check.taskProblems ?? []).length === 0 &&
    check.contradictions.every(contradiction => contradiction.resolved)
  );
}

type Metadata = Record<string, unknown> | null | undefined;

/** The latest recorded check of `type` on a card, or undefined when none was recorded. */
export function recordedProductDocumentCheck(
  metadata: Metadata,
  type: ProductDocumentType,
): ProductDocumentCheck | undefined {
  const checks = metadata?.[PRODUCT_DOC_CHECKS_KEY];
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) return undefined;
  const check = (checks as Record<string, unknown>)[type];
  if (!check || typeof check !== 'object' || Array.isArray(check)) return undefined;
  const value = check as Partial<ProductDocumentCheck>;
  return typeof value.passed === 'boolean' && typeof value.path === 'string'
    ? (value as ProductDocumentCheck)
    : undefined;
}

/** The card's metadata with `check` recorded as its latest check of that type. */
export function withProductDocumentCheck(metadata: Metadata, check: ProductDocumentCheck): Record<string, unknown> {
  const current = metadata?.[PRODUCT_DOC_CHECKS_KEY];
  const checks = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  return { ...(metadata ?? {}), [PRODUCT_DOC_CHECKS_KEY]: { ...checks, [check.type]: check } };
}

/** The Work cards a Product card filed. */
export function productChildWorkItemIds(metadata: Metadata): string[] {
  const ids = metadata?.[PRODUCT_CHILDREN_KEY];
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

/** The card's metadata with `childId` added to the Work cards it filed. */
export function withProductChild(metadata: Metadata, childId: string): Record<string, unknown> {
  const ids = productChildWorkItemIds(metadata);
  return { ...(metadata ?? {}), [PRODUCT_CHILDREN_KEY]: ids.includes(childId) ? ids : [...ids, childId] };
}

/** Why a card can't leave a review phase for the next working one; undefined when it can. */
export function productDocumentGateFailure(metadata: Metadata, type: ProductDocumentType): string | undefined {
  const check = recordedProductDocumentCheck(metadata, type);
  if (!check) {
    return `The ${type} (${PRODUCT_DOCUMENT_FILES[type]}) has not been checked. Run factory_check_product_document on it in the Product session first.`;
  }
  if (check.passed) return undefined;
  const reasons = [
    ...(check.missingSections.length > 0 ? [`missing sections: ${check.missingSections.join(', ')}`] : []),
    ...(check.missingDiagrams.length > 0 ? [`missing diagrams: ${check.missingDiagrams.join(', ')}`] : []),
    ...(check.taskProblems && check.taskProblems.length > 0 ? [`task problems: ${check.taskProblems.join('; ')}`] : []),
    ...(check.contradictions.some(contradiction => !contradiction.resolved)
      ? [
          `unresolved contradictions: ${check.contradictions
            .filter(contradiction => !contradiction.resolved)
            .map(contradiction => contradiction.finding)
            .join('; ')}`,
        ]
      : []),
  ];
  return `The last check of ${check.path} failed (${reasons.join('; ')}). Fix the document and run factory_check_product_document again.`;
}
