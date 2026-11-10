import { describe, expect, it } from 'vitest';

import {
  checkProductDocumentStructure,
  PRODUCT_DOCUMENT_FILES,
  productChildWorkItemIds,
  productDocumentGateFailure,
  productDocumentPassed,
  productTaskProblems,
  recordedProductDocumentCheck,
  withProductChild,
  withProductDocumentCheck,
} from './documents.ts';
import type { ProductDocumentCheck } from './documents.ts';

const RESEARCH = `# Loyalty: research
## How the system works today
## Pitfalls
## Constraints
## Decisions
| Q1 | per user | … |
## Open questions
- None
`;

const BRIEF = `# Loyalty: brief

## Goal
Reward repeat buyers.

## Users
Buyers who order twice a month.

## Use cases
### UC-1 — Earn points
- **Done when:** the buyer sees "You earned 12 points".

## Edge cases
| Situation | What happens |
|---|---|
| The card is declined | "Payment failed" and no access |

## Acceptance criteria
1. A buyer sees their points after checkout.

## Not included
- Gift cards (a later phase)

## Constraints
- No new paid service without approval.

## Technology
Our existing app and server; no new vendor.

## Running costs
None: no paid third-party service.

## External dependencies and risks
None found: no provider review, no new access.

## Phases and estimate
| 1 | points | 3 | 5 | 9 | 5.3 | 9 |

## Decisions that need the client's approval
None.

## Done means
- [ ] every use case walked through

## Open questions
- None
`;

const SPEC = `# Loyalty: design

## Affected areas
| Area | Truth |
|---|---|
| loyalty | features/loyalty/design.md |

## ADDED Requirements — loyalty
### Requirement: Earn points
The system SHALL credit points for every paid order.
#### Scenario: Paid order
- GIVEN a signed-in buyer
- WHEN an order is paid
- THEN points are credited

## Architecture
\`\`\`mermaid
C4Context
  Person(buyer, "Buyer")
\`\`\`

\`\`\`mermaid
%% containers
C4Container
  Container(api, "API")
\`\`\`

## Sequences
\`\`\`mermaid
sequenceDiagram
  buyer->>api: checkout
\`\`\`

## Data flow
\`\`\`mermaid
flowchart LR
  api --> db
\`\`\`

## Modules touched
## API contract
\`POST /points\`
## Data model
## Security
## Shared resources
## Test plan
- Black-box: earn points on checkout.
## Decisions
- Points never expire.
## Consult round
## Premortem outcome
## Open questions
- None
`;

const TASKS = `# Loyalty: tasks

## Order
1. LY-01 → 2. LY-02

## Tasks

### LY-01 — Points schema
- role: backend
- repository: acme/api
- depends-on: none
- acceptance: AC-1
- verify: integration: points are stored per order

### LY-02 — Points on the receipt
- role: mobile
- depends-on: LY-01, auth/AU-02
- acceptance: AC-1
- verify: widget test

## Coverage check
| AC-1 | LY-01, LY-02 |
`;

const clean = { missingSections: [], missingDiagrams: [], taskProblems: [], formatProblems: [] };

describe('product document checks', () => {
  it('names the team layout files per document type', () => {
    expect(PRODUCT_DOCUMENT_FILES).toEqual({
      enrich: 'research.md',
      brief: 'requirements.md',
      spec: 'design.md',
      tasks: 'tasks.md',
    });
  });

  it('passes research notes that record the decisions taken', () => {
    expect(checkProductDocumentStructure('enrich', RESEARCH)).toEqual(clean);
    expect(checkProductDocumentStructure('enrich', RESEARCH.replace('## Decisions', 'Decisions')).missingSections).toEqual(
      ['Decisions'],
    );
  });

  it('passes a client-facing brief with its use cases, edge cases, gates and done means', () => {
    expect(checkProductDocumentStructure('brief', BRIEF)).toEqual(clean);
    expect(checkProductDocumentStructure('brief', BRIEF.replace('## Use cases', 'Use cases')).missingSections).toEqual(
      ['Use cases'],
    );
    expect(
      checkProductDocumentStructure('brief', BRIEF.replace('## Not included', 'Not included').replace('## Done means', ''))
        .missingSections,
    ).toEqual(['Out of scope', 'Done means']);
  });

  it('reads task ids with Cyrillic prefixes and the docs-sync task', () => {
    const tasks = [
      '## Tasks',
      '### ОП-01 — API сповіщень',
      '- role: backend',
      '- depends-on: none',
      '- acceptance: …',
      '- verify: …',
      '### ОП-DOCS — синхронізація документації',
      '- role: docs',
      '- depends-on: ОП-01, 2026-11-01-billing/BL-03',
      '- acceptance: …',
    ].join('\n');
    expect(productTaskProblems(tasks)).toEqual(['ОП-DOCS has no verify']);
  });

  it('requires the brief to list its external dependencies and risks', () => {
    const without = BRIEF.replace('## External dependencies and risks', 'External dependencies and risks');
    expect(checkProductDocumentStructure('brief', without).missingSections).toEqual(['External dependencies and risks']);
  });

  it('requires the brief to state its running costs', () => {
    const without = BRIEF.replace('## Running costs', 'Running costs');
    expect(checkProductDocumentStructure('brief', without).missingSections).toEqual(['Running costs']);
  });

  it('does not require acceptance criteria in the client brief: they live in the spec', () => {
    const without = BRIEF.replace('## Acceptance criteria', 'Acceptance criteria');
    expect(checkProductDocumentStructure('brief', without).missingSections).toEqual([]);
  });

  it('requires the edge cases as a table of what the user sees', () => {
    const asList = BRIEF.replace(/## Edge cases[\s\S]*?(?=\n## )/, '## Edge cases\n- The card is declined: "Payment failed".\n');
    expect(checkProductDocumentStructure('brief', asList).formatProblems).toHaveLength(1);
    expect(checkProductDocumentStructure('brief', BRIEF).formatProblems).toEqual([]);
    const ukrainian = BRIEF.replace('## Edge cases', '## Особливі випадки');
    expect(checkProductDocumentStructure('brief', ukrainian)).toMatchObject({ missingSections: [], formatProblems: [] });
  });

  it('does not require Open questions in the brief: only questions the person left for the client go there', () => {
    const without = BRIEF.replace('## Open questions', 'Open questions');
    expect(checkProductDocumentStructure('brief', without).missingSections).toEqual([]);
  });

  it('accepts Ukrainian headings', () => {
    const uk = [
      '# Бриф',
      '## Мета',
      '## Користувачі',
      '## Сценарії',
      '## Крайові випадки',
      '## Критерії приймання',
      '## Межі оцінки',
      '## Обмеження',
      '## Технології',
      '## Витрати на експлуатацію',
      '## Зовнішні залежності й ризики',
      '## Фази та оцінка',
      '## Рішення, що потребують погодження клієнта',
      '## Готово означає',
      '## Відкриті питання',
    ].join('\n');
    expect(checkProductDocumentStructure('brief', uk).missingSections).toEqual([]);
  });

  it('passes a technical design with every section and diagram, its consult round and pre-mortem included', () => {
    expect(checkProductDocumentStructure('spec', SPEC)).toEqual(clean);
  });

  it('names the sections a design lacks, and ignores headings inside code blocks', () => {
    const withoutTestPlan = SPEC.replace('## Test plan', 'Test plan').replace(
      '## Premortem outcome',
      '```md\n## Premortem outcome\n```',
    );
    expect(checkProductDocumentStructure('spec', withoutTestPlan).missingSections).toEqual([
      'Test plan',
      'Premortem outcome',
    ]);
  });

  it('requires the design to be a delta against the areas: affected areas and at least one ADDED / MODIFIED / REMOVED block', () => {
    const noDelta = SPEC.replace('## ADDED Requirements — loyalty', '## Notes');
    expect(checkProductDocumentStructure('spec', noDelta).missingSections).toEqual([
      'Delta (ADDED / MODIFIED / REMOVED Requirements)',
    ]);
    const modifiedOnly = SPEC.replace('## ADDED Requirements — loyalty', '## MODIFIED Requirements — loyalty');
    expect(checkProductDocumentStructure('spec', modifiedOnly).missingSections).toEqual([]);
    const ukrainian = SPEC.replace('## ADDED Requirements — loyalty', '## ВИЛУЧЕНО вимоги — loyalty').replace(
      '## Affected areas',
      '## Зачеплені області',
    );
    expect(checkProductDocumentStructure('spec', ukrainian).missingSections).toEqual([]);
    expect(checkProductDocumentStructure('spec', SPEC.replace('## Affected areas', '## Areas list')).missingSections).toEqual([
      'Affected areas',
    ]);
  });

  it('requires the C4, sequence and data-flow diagrams in the design, and none in the brief', () => {
    const noSequence = SPEC.replace('sequenceDiagram', 'stateDiagram-v2');
    expect(checkProductDocumentStructure('spec', noSequence).missingDiagrams).toEqual(['sequence diagram']);
    const plainCode = SPEC.replaceAll('```mermaid', '```text');
    expect(checkProductDocumentStructure('spec', plainCode).missingDiagrams).toHaveLength(3);
    expect(checkProductDocumentStructure('brief', BRIEF).missingDiagrams).toEqual([]);
  });

  describe('tasks.md', () => {
    it('passes tasks that carry their fields and depend on tasks that exist', () => {
      expect(checkProductDocumentStructure('tasks', TASKS)).toEqual(clean);
    });

    it('names a task missing a field and a dependency on a task that does not exist', () => {
      const broken = TASKS.replace('- verify: widget test\n', '').replace('LY-01, auth/AU-02', 'LY-01, LY-09');
      expect(productTaskProblems(broken)).toEqual([
        'LY-02 has no verify',
        'LY-02 depends on LY-09, which is not a task in this file',
      ]);
    });

    it('fails a tasks file with no task headings under Tasks', () => {
      expect(productTaskProblems('# x\n## Order\n## Tasks\nnothing yet\n## Coverage check\n')).toEqual([
        'no tasks: write each as "### <ID> — <title>" under "## Tasks"',
      ]);
      // Task headings outside ## Tasks don't count.
      expect(productTaskProblems('## Order\n### LY-01 — x\n- role: a\n')).toHaveLength(1);
    });

    it('reads Ukrainian section headings and ignores task fields inside code blocks', () => {
      const uk = TASKS.replace('## Tasks', '## Задачі').replace(
        '- verify: widget test',
        '```\n- verify: widget test\n```',
      );
      expect(productTaskProblems(uk)).toEqual(['LY-02 has no verify']);
    });
  });

  it('fails while any listed contradiction or task problem is unresolved', () => {
    const structure = { missingSections: [], missingDiagrams: [] };
    expect(productDocumentPassed({ ...structure, contradictions: [] })).toBe(true);
    expect(
      productDocumentPassed({ ...structure, contradictions: [{ finding: 'a vs b', resolved: true, resolution: 'b' }] }),
    ).toBe(true);
    expect(productDocumentPassed({ ...structure, contradictions: [{ finding: 'a vs b', resolved: false }] })).toBe(
      false,
    );
    expect(productDocumentPassed({ ...structure, taskProblems: ['LY-02 has no verify'], contradictions: [] })).toBe(
      false,
    );
  });

  it('records checks and children on the card metadata without dropping other keys', () => {
    const check: ProductDocumentCheck = {
      type: 'spec',
      path: 'docs/changes/2026-11-10-loyalty/design.md',
      sha256: 'b'.repeat(64),
      passed: true,
      missingSections: [],
      missingDiagrams: [],
      contradictions: [],
      checkedAt: '2026-11-10T00:00:00.000Z',
    };
    const metadata = withProductChild(withProductDocumentCheck({ repository: 'acme/docs' }, check), 'child-1');
    expect(metadata.repository).toBe('acme/docs');
    expect(recordedProductDocumentCheck(metadata, 'spec')).toEqual(check);
    expect(recordedProductDocumentCheck(metadata, 'brief')).toBeUndefined();
    expect(productChildWorkItemIds(withProductChild(metadata, 'child-1'))).toEqual(['child-1']);
    expect(productDocumentGateFailure(metadata, 'spec')).toBeUndefined();
    expect(productDocumentGateFailure(metadata, 'brief')).toContain('requirements.md');
    expect(productDocumentGateFailure(metadata, 'brief')).toContain('has not been checked');
  });

  it('explains a failed tasks check', () => {
    const metadata = withProductDocumentCheck(undefined, {
      type: 'tasks',
      path: 'docs/changes/2026-11-10-loyalty/tasks.md',
      sha256: 'c'.repeat(64),
      passed: false,
      missingSections: [],
      missingDiagrams: [],
      taskProblems: ['LY-02 has no verify'],
      contradictions: [],
      checkedAt: '2026-11-10T00:00:00.000Z',
    });
    expect(productDocumentGateFailure(metadata, 'tasks')).toContain('task problems: LY-02 has no verify');
  });
});
