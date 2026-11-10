/**
 * The documents a Product card produces, and the checks that gate its moves.
 *
 * A project keeps all its documentation in ONE folder: a separate documentation repository in a
 * multi-repository project, or one folder in the repository of a monorepo. It is never split per
 * component (backend, web, mobile): one spec covers every component, so the links between them
 * hold. Each feature gets `<docs>/features/<slug>/` with the documents below; decision records
 * live in `<docs>/decisions/`. That layout is the default; a team may change it.
 *
 * The structure check is deterministic and costs no tokens: required sections per document type,
 * and the Mermaid diagrams the (technical) spec must carry. Contradictions with existing documents and
 * decision records are the agent's judgement; it lists them, and the check passes only once every
 * listed contradiction is resolved. The result is stored on the card's metadata, where the board's
 * gates read it.
 */

export const PRODUCT_DOCUMENT_TYPES = ['enrich', 'brief', 'spec'] as const;
export type ProductDocumentType = (typeof PRODUCT_DOCUMENT_TYPES)[number];

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

/** The sections each document must have, in the order the templates put them. */
export const PRODUCT_DOCUMENT_SECTIONS: Readonly<Record<ProductDocumentType, readonly RequiredSection[]>> = {
  enrich: [
    section('How the system works', /how .*works/i, /system/i, /як .*працю/i, /систем/i),
    section('Pitfalls', /pitfall/i, /gotcha/i, /підводн/i, /ризик/i, /risk/i),
    section('Constraints', /constraint/i, /обмежен/i),
    section('Open questions', /open questions?/i, /відкрит/i),
  ],
  // The client-facing document: no technical detail beyond what the client decides on.
  brief: [
    section('Goal', /goal/i, /мета/i, /ціль/i),
    section('Users', /users?/i, /користувач/i),
    section('Use cases', /use cases?/i, /scenarios?/i, /сценарі/i, /варіанти використання/i),
    section('Scope', /scope/i, /обсяг/i, /межі/i),
    section('Acceptance criteria', /acceptance/i, /критері/i),
    section('Phases', /phases?/i, /фази/i, /етапи/i),
    section('Estimate', /estimate/i, /оцінк/i),
    section('Technology', /technolog/i, /stack/i, /технолог/i, /стек/i),
    section('Risks', /risks?/i, /ризик/i),
    section('Open questions', /open questions?/i, /відкрит/i),
  ],
  // The technical document for the team: how the feature fits the system, every component in one place.
  spec: [
    section('Architecture', /architecture/i, /context/i, /архітектур/i, /контекст/i),
    section('Sequences', /sequences?/i, /flows?/i, /послідовн/i, /потоки/i),
    section('Data flow', /data flow/i, /потік даних/i, /потоки даних/i),
    section('Contracts', /contracts?/i, /\bapi\b/i, /interfaces?/i, /контракт/i, /інтерфейс/i),
    section('Data model', /data model/i, /\bdata\b/i, /модел/i, /дані/i),
    section('Components', /components?/i, /changes/i, /компонент/i, /зміни/i),
    section('Test plan', /test plan/i, /testing/i, /план тест/i, /тестуван/i),
    section('Technical risks', /risks?/i, /ризик/i),
    section('Decisions', /decisions?/i, /рішенн/i),
    section('Open questions', /open questions?/i, /відкрит/i),
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

/** Which required sections and diagrams `markdown` lacks for a document of `type`. */
export function checkProductDocumentStructure(
  type: ProductDocumentType,
  markdown: string,
): { missingSections: string[]; missingDiagrams: string[] } {
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
  return { missingSections, missingDiagrams };
}

export function productDocumentPassed(check: {
  missingSections: readonly string[];
  missingDiagrams: readonly string[];
  contradictions: readonly ProductContradiction[];
}): boolean {
  return (
    check.missingSections.length === 0 &&
    check.missingDiagrams.length === 0 &&
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
    return `The ${type} has not been checked. Run factory_check_product_document on ${type}.md in the Product session first.`;
  }
  if (check.passed) return undefined;
  const reasons = [
    ...(check.missingSections.length > 0 ? [`missing sections: ${check.missingSections.join(', ')}`] : []),
    ...(check.missingDiagrams.length > 0 ? [`missing diagrams: ${check.missingDiagrams.join(', ')}`] : []),
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
