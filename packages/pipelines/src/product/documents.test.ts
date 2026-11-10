import { describe, expect, it } from 'vitest';

import {
  checkProductDocumentStructure,
  productChildWorkItemIds,
  productDocumentGateFailure,
  productDocumentPassed,
  recordedProductDocumentCheck,
  withProductChild,
  withProductDocumentCheck,
} from './documents.ts';
import type { ProductDocumentCheck } from './documents.ts';

const BRIEF = `# Loyalty

## Goal
Reward repeat buyers.

## Users
Buyers who order twice a month.

## Use cases
- A buyer earns points at checkout.

## Scope
### In
- Points
### Out
- Gift cards

## Acceptance criteria
- A buyer sees their points after checkout.

## Phases
| 1 | points | 5 days |

## Estimate assumptions
- …

## Technology
Our existing app and server; no new vendor.

## Risks
- …

## Open questions
- none
`;

const SPEC = `# Loyalty: specification

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

## Contracts
\`POST /points\`

## Data model
points table

## Components
Server, mobile, landing.

## Test plan
- Black-box: earn points on checkout.

## Technical risks
- Double crediting on retries.

## Decisions
- Points never expire.

## Open questions
- none
`;

describe('product document checks', () => {
  it('passes a client-facing brief with its use cases and acceptance criteria', () => {
    expect(checkProductDocumentStructure('brief', BRIEF)).toEqual({ missingSections: [], missingDiagrams: [] });
    expect(checkProductDocumentStructure('brief', BRIEF.replace('## Use cases', 'Use cases')).missingSections).toEqual(
      ['Use cases'],
    );
  });

  it('accepts Ukrainian headings', () => {
    const uk = `# Бриф\n## Мета\n## Користувачі\n## Сценарії використання\n## Обсяг\n## Критерії прийняття\n## Фази\n## Оцінка\n## Технології\n## Ризики\n## Відкриті питання\n`;
    expect(checkProductDocumentStructure('brief', uk).missingSections).toEqual([]);
  });

  it('passes a technical spec with every section and diagram, its test plan included', () => {
    expect(checkProductDocumentStructure('spec', SPEC)).toEqual({ missingSections: [], missingDiagrams: [] });
  });

  it('names the sections a spec lacks, and ignores headings inside code blocks', () => {
    const withoutTestPlan = SPEC.replace('## Test plan', 'Test plan').replace(
      '## Technical risks',
      '```md\n## Technical risks\n```',
    );
    expect(checkProductDocumentStructure('spec', withoutTestPlan).missingSections).toEqual([
      'Test plan',
      'Technical risks',
    ]);
  });

  it('requires the C4, sequence and data-flow diagrams in the spec, and none in the brief', () => {
    const noSequence = SPEC.replace('sequenceDiagram', 'stateDiagram-v2');
    expect(checkProductDocumentStructure('spec', noSequence).missingDiagrams).toEqual(['sequence diagram']);
    const plainCode = SPEC.replaceAll('```mermaid', '```text');
    expect(checkProductDocumentStructure('spec', plainCode).missingDiagrams).toHaveLength(3);
    expect(checkProductDocumentStructure('brief', BRIEF).missingDiagrams).toEqual([]);
  });

  it('fails while any listed contradiction is unresolved', () => {
    const structure = { missingSections: [], missingDiagrams: [] };
    expect(productDocumentPassed({ ...structure, contradictions: [] })).toBe(true);
    expect(
      productDocumentPassed({ ...structure, contradictions: [{ finding: 'a vs b', resolved: true, resolution: 'b' }] }),
    ).toBe(true);
    expect(productDocumentPassed({ ...structure, contradictions: [{ finding: 'a vs b', resolved: false }] })).toBe(
      false,
    );
  });

  it('records checks and children on the card metadata without dropping other keys', () => {
    const check: ProductDocumentCheck = {
      type: 'spec',
      path: 'docs/features/loyalty/spec.md',
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
    expect(productDocumentGateFailure(metadata, 'brief')).toContain('has not been checked');
  });
});
