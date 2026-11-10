import { RequestContext } from '@mastra/core/request-context';
import { describe, expect, it, vi } from 'vitest';

import {
  PRODUCT_CHANGE_KEY,
  PRODUCT_CHILDREN_KEY,
  PRODUCT_DOC_CHECKS_KEY,
  PRODUCT_DOCS_SYNC_KEY,
  withProductDocumentCheck,
} from '@factory/pipelines';
import type { WorkItemsStorage } from '@factory/store';
import { createBoardRegistry, createFactoryStorageForTests, FactoryTransitionService } from '@factory/testing';
import type { ProductToolDependencies } from './product-tools.ts';
import { createFactoryTransitionTools } from './tools.ts';

vi.mock('../tools/work-item-tools.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../tools/work-item-tools.ts')>()),
  // The linked repositories come from source control; here `acme/api` is the one linked.
  requireLinkedRepository: async ({ slug }: { slug: string }) => {
    if (slug !== 'acme/api') throw new Error(`${slug} is not linked to this Factory. Linked repositories: acme/api.`);
  },
}));

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';

type ExecutableTool = { execute: (input: unknown, context: unknown) => Promise<unknown> };

function requestContext() {
  const context = new RequestContext();
  context.set('user', { id: 'user-1', organizationId: 'org-1' });
  context.set('controller', {
    resourceId: 'resource-1',
    threadId: 'thread-1',
    sessionId: 'resource-1',
    session: { id: 'session-1', ownerId: 'code', modeId: 'build' },
    getState: () => ({ factoryProjectId: PROJECT_ID }),
  });
  return context;
}

const SPEC = `# Loyalty: specification
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
## Data model
## Security
## Shared resources
## Test plan
## Decisions
## Consult round
## Premortem outcome
## Open questions
`;

async function setup({ board = 'product', role = 'product', stage = 'spec' } = {}) {
  const storage: WorkItemsStorage = (await createFactoryStorageForTests()).workItems;
  const boards = createBoardRegistry();
  const transitionService = new FactoryTransitionService({ storage, configVersion: 'product-v1', boards });
  const prepared = await storage.prepareRunStart({
    orgId: 'org-1',
    userId: 'user-1',
    factoryProjectId: PROJECT_ID,
    workItem: { input: { board, title: 'Loyalty', stages: [stage], sessions: {}, metadata: {} } },
    role,
    session: { sessionId: 'resource-1', branch: 'factory/item', threadId: 'thread-1' },
    resourceId: 'resource-1',
    kickoffKey: 'kickoff-1',
    kickoffMessage: null,
  });
  const comments: unknown[] = [];
  const product: ProductToolDependencies = {
    feed: {
      createComment: async input => {
        comments.push(input);
        return { status: 'created' } as never;
      },
    },
    auditRecorder: { record: vi.fn(async () => {}) } as never,
    sessions: {
      getBySessionId: async () => ({ userId: 'user-1' }) as never,
      getSourceControlBySessionId: async () => null,
    },
  };
  const context = requestContext();
  const tools = await createFactoryTransitionTools({
    requestContext: context,
    storage,
    transitionService,
    boards,
    product,
  });
  return { storage, transitionService, prepared, tools, context, comments };
}

function workspace(files: Record<string, string>) {
  return {
    sandbox: {
      executeCommand: async (command: string, args: string[]) => {
        const path = args.at(-1)!;
        return command === 'cat' && path in files
          ? { exitCode: 0, stdout: files[path]!, stderr: '' }
          : { exitCode: 1, stdout: '', stderr: `cat: ${path}: No such file or directory` };
      },
    },
  };
}

describe('Product session tools', () => {
  it('are offered to the product seat of a Product card only', async () => {
    const product = await setup();
    expect(Object.keys(product.tools).sort()).toEqual([
      'factory_check_product_document',
      'factory_create_work_item',
      'factory_transition_work_item',
    ]);
    const work = await setup({ board: 'work', role: 'work', stage: 'execute' });
    expect(Object.keys(work.tools)).toEqual(['factory_transition_work_item']);
  });

  it('files a phase as a Development card under the Product card, once per title', async () => {
    const { tools, context, storage, prepared, comments } = await setup({ stage: 'phases' });
    const create = tools.factory_create_work_item as ExecutableTool;
    const input = { title: 'Points API', brief: 'Implements spec.md#contracts.', repository: 'acme/api' };

    const filed = (await create.execute(input, { requestContext: context })) as { id: string; parentWorkItemId: string };

    const child = (await storage.get({ orgId: 'org-1', id: filed.id }))!;
    expect(child).toMatchObject({ board: 'work', stages: ['intake'], parentWorkItemId: prepared.item.id });
    expect(child.metadata).toMatchObject({ repository: 'acme/api' });
    const parent = (await storage.get({ orgId: 'org-1', id: prepared.item.id }))!;
    expect(parent.metadata?.[PRODUCT_CHILDREN_KEY]).toEqual([filed.id]);
    expect(comments).toEqual([expect.objectContaining({ workItemId: filed.id, body: input.brief })]);

    await expect(create.execute({ ...input, title: 'points api' }, { requestContext: context })).resolves.toMatchObject({
      id: filed.id,
      reused: true,
    });
    await expect(
      create.execute({ ...input, title: 'Points screen', repository: 'acme/mobile' }, { requestContext: context }),
    ).rejects.toThrow('acme/mobile is not linked to this Factory');
  });

  it("files the docs-sync task with the change folder, and refuses it before the change's tasks were checked", async () => {
    const { tools, context, storage, prepared } = await setup({ stage: 'phases' });
    const create = tools.factory_create_work_item as ExecutableTool;
    const docsSync = { title: 'LY-DOCS — Merge into features', brief: 'Cards: LY-01.', repository: 'acme/api', docsSync: true };

    await expect(create.execute(docsSync, { requestContext: context })).rejects.toThrow(
      'run factory_check_product_document',
    );

    const card = (await storage.get({ orgId: 'org-1', id: prepared.item.id }))!;
    await storage.update({
      orgId: 'org-1',
      id: card.id,
      userId: 'user-1',
      expectedRevision: card.revision,
      patch: {
        metadata: withProductDocumentCheck(card.metadata, {
          type: 'tasks',
          path: 'docs/changes/2026-11-10-loyalty/tasks.md',
          passed: true,
          sha256: 'a'.repeat(64),
          checkedAt: new Date().toISOString(),
          missingSections: [],
          missingDiagrams: [],
          taskProblems: [],
          contradictions: [],
        } as never),
      },
    } as never);

    const task = (await create.execute(
      { title: 'LY-01 — Points API', brief: 'Implements tasks.md#ly-01.', repository: 'acme/api' },
      { requestContext: context },
    )) as { id: string };
    expect((await storage.get({ orgId: 'org-1', id: task.id }))!.metadata).toEqual({
      repository: 'acme/api',
      [PRODUCT_CHANGE_KEY]: 'docs/changes/2026-11-10-loyalty',
    });
    const sync = (await create.execute(docsSync, { requestContext: context })) as { id: string };
    expect((await storage.get({ orgId: 'org-1', id: sync.id }))!.metadata).toMatchObject({
      [PRODUCT_CHANGE_KEY]: 'docs/changes/2026-11-10-loyalty',
      [PRODUCT_DOCS_SYNC_KEY]: true,
    });
  });

  it('records the spec check on the card, and the gate lets the card on to Phases only once it passed', async () => {
    const { tools, context, storage, prepared, transitionService } = await setup({ stage: 'spec' });
    const check = tools.factory_check_product_document as ExecutableTool;
    const path = 'docs/changes/2026-11-10-loyalty/design.md';

    const failed = await check.execute(
      { type: 'spec', path, contradictions: [] },
      { requestContext: context, workspace: workspace({ [path]: SPEC.replace('## Test plan', '') }) },
    );
    expect(failed).toMatchObject({
      passed: false,
      missingSections: ['Test plan'],
      missingDiagrams: [],
      taskProblems: [],
    });
    await expect(
      check.execute(
        { type: 'spec', path: 'docs/missing.md', contradictions: [] },
        { requestContext: context, workspace: workspace({}) },
      ),
    ).rejects.toThrow('Could not read docs/missing.md');
    await expect(check.execute({ type: 'spec', path, contradictions: [] }, { requestContext: context })).rejects.toThrow(
      'no workspace sandbox',
    );

    const move = async (stage: string) => {
      const item = (await storage.get({ orgId: 'org-1', id: prepared.item.id }))!;
      return transitionService.transition({
        orgId: 'org-1',
        factoryProjectId: PROJECT_ID,
        workItemId: item.id,
        board: 'product',
        stage,
        expectedRevision: item.revision,
        actor: { type: 'human', id: 'user-1' },
        ingress: { type: 'human', identity: `test:${stage}:${item.revision}` },
        cause: 'test',
      });
    };
    await expect(move('spec-review')).resolves.toMatchObject({ status: 'accepted' });
    await expect(move('phases')).resolves.toMatchObject({ status: 'rejected', code: 'invalid_transition' });

    const passed = await check.execute(
      { type: 'spec', path, contradictions: [{ finding: 'caches vs ADR 3', resolved: true, resolution: 'ADR 7' }] },
      { requestContext: context, workspace: workspace({ [path]: SPEC }) },
    );
    expect(passed).toMatchObject({ passed: true, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const card = (await storage.get({ orgId: 'org-1', id: prepared.item.id }))!;
    expect(card.metadata?.[PRODUCT_DOC_CHECKS_KEY]).toMatchObject({ spec: { passed: true, path } });
    await expect(move('phases')).resolves.toMatchObject({ status: 'accepted' });
  });
});
