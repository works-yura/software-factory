/** Test doubles for the assistant's ports, and a storage on in-memory libsql. */
import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalFilesystem, LocalSandbox, Workspace, WORKSPACE_TOOLS } from '@mastra/core/workspace';
import type { WorkspaceToolHooks } from '@mastra/core/workspace';

import type {
  AssistantBlobStore,
  AssistantBrain,
  AssistantMemory,
  AssistantModels,
  AssistantWorkspaceHost,
  BrainTurn,
  FactoryClient,
  FactoryGrant,
  FactoryRef,
  SecretCipher,
  WorkspaceToolApproval,
} from './ports.ts';
import type { AssistantOwner } from './types.ts';

/**
 * A real workspace for tests, on Mastra's local filesystem and sandbox (the server's host uses the
 * Factory sandbox, the agent user and Mastra Code's tools instead): one folder per owner under
 * `root`, the rules from `approval`, every erase recorded.
 */
export class LocalTestWorkspaceHost implements AssistantWorkspaceHost {
  readonly erased: string[] = [];
  readonly #sandboxes = new Map<string, LocalSandbox>();
  readonly root: string;
  rules: (toolName: string) => WorkspaceToolApproval;

  constructor(root: string, rules?: (toolName: string) => WorkspaceToolApproval) {
    this.root = root;
    this.rules =
      rules ??
      (toolName =>
        toolName === WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND || toolName === WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE ? 'ask' : 'allow');
  }

  folder(owner: AssistantOwner): string {
    return join(this.root, owner.orgId, owner.userId, 'workspace');
  }

  approval(toolName: string): WorkspaceToolApproval {
    return this.rules(toolName);
  }

  async open(owner: AssistantOwner, options: { hooks?: WorkspaceToolHooks } = {}): Promise<Workspace> {
    const key = `${owner.orgId}/${owner.userId}`;
    let sandbox = this.#sandboxes.get(key);
    if (!sandbox) {
      sandbox = new LocalSandbox({ id: `assistant-${owner.orgId}-${owner.userId}`, workingDirectory: this.folder(owner) });
      this.#sandboxes.set(key, sandbox);
    }
    await mkdir(this.folder(owner), { recursive: true });
    return new Workspace({
      id: `assistant:${key}`,
      name: 'test assistant workspace',
      filesystem: new LocalFilesystem({ basePath: this.folder(owner) }),
      sandbox,
      tools: options.hooks ? { hooks: options.hooks } : {},
    });
  }

  async erase(owner: AssistantOwner): Promise<void> {
    const key = `${owner.orgId}/${owner.userId}`;
    this.erased.push(key);
    await this.#sandboxes.get(key)?.destroy();
    this.#sandboxes.delete(key);
    await rm(join(this.root, owner.orgId, owner.userId), { recursive: true, force: true });
  }

  async close(): Promise<void> {
    for (const sandbox of this.#sandboxes.values()) await sandbox.destroy();
    this.#sandboxes.clear();
  }
}

export class MemoryBlobStore implements AssistantBlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  readonly deleted: string[] = [];

  async put(body: Uint8Array | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>) {
    const chunks: Uint8Array[] = [];
    if (body instanceof Uint8Array) chunks.push(body);
    else for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    this.blobs.set(sha256, new Uint8Array(bytes));
    return { sha256, size: bytes.length };
  }

  async get(sha256: string) {
    const bytes = this.blobs.get(sha256);
    if (!bytes) return null;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  async delete(sha256: string) {
    this.deleted.push(sha256);
    return this.blobs.delete(sha256);
  }
}

/** A brain that answers from a function, recording every turn. */
export class FakeBrain implements AssistantBrain {
  readonly turns: BrainTurn[] = [];
  answer: (turn: BrainTurn) => string | Promise<string> = turn => `seen: ${turn.input.text}`;

  /** The topic a source request's first turn names; none by default. */
  topic: ((turn: BrainTurn) => string | undefined) | undefined;

  async respond(turn: BrainTurn) {
    this.turns.push(turn);
    const text = await this.answer(turn);
    const topic = turn.first ? this.topic?.(turn) : undefined;
    return topic ? { text, topic } : { text };
  }

  /** What a model check answers: a reply, or a throw (a provider's refusal). */
  probeAnswer: (modelId: string | null) => string | Promise<string> = () => 'OK';
  readonly probes: Array<string | null> = [];

  async probe(_owner: AssistantOwner, modelId: string | null) {
    this.probes.push(modelId);
    const id = modelId ?? 'test/default-model';
    return { modelId: id, text: await this.probeAnswer(id) };
  }
}

export class FakeMemory implements AssistantMemory {
  readonly calls: string[] = [];
  async forget(owner: AssistantOwner) {
    this.calls.push(`forget:${owner.orgId}:${owner.userId}`);
  }
  async forgetThread(owner: AssistantOwner, requestId: string) {
    this.calls.push(`forgetThread:${owner.orgId}:${owner.userId}:${requestId}`);
  }
}

export class FakeFactory implements FactoryClient, FactoryGrant {
  connectedOwners = new Set<string>();
  factories: FactoryRef[] = [{ id: 'f-1', name: 'Shop' }];
  answer: string | null = null;
  readonly asked: Array<{ factoryId: string; question: string }> = [];
  readonly handed: Array<{ factoryId: string; title: string; description: string; files: string[] }> = [];
  readonly revoked: string[] = [];

  static key(owner: AssistantOwner) {
    return `${owner.orgId}:${owner.userId}`;
  }
  connect(owner: AssistantOwner) {
    this.connectedOwners.add(FakeFactory.key(owner));
  }
  async connected(owner: AssistantOwner) {
    return this.connectedOwners.has(FakeFactory.key(owner));
  }
  async listFactories() {
    return this.factories;
  }
  async ask(_owner: AssistantOwner, input: { factoryId: string; question: string }) {
    this.asked.push(input);
    return { sessionId: 'side-1', url: `/factories/${input.factoryId}/workspaces/side-1` };
  }
  async readAnswer() {
    return { text: this.answer };
  }
  readonly reads: Array<{ owner: string; factoryId: string; tool: string; args: Record<string, unknown> }> = [];
  async read(owner: AssistantOwner, input: { factoryId: string; tool: string; args: Record<string, unknown> }) {
    this.reads.push({ owner: FakeFactory.key(owner), ...input });
    return { tool: input.tool, items: [{ id: 'card-9', title: 'Checkout bug' }] };
  }
  async handOver(
    _owner: AssistantOwner,
    input: { factoryId: string; title: string; description: string; files: Array<{ name: string }> },
  ) {
    this.handed.push({ ...input, files: input.files.map(file => file.name) });
    return { workItemId: 'card-1', url: `/factories/${input.factoryId}/work?item=card-1`, failedFiles: [] };
  }
  async revoke(owner: AssistantOwner) {
    this.revoked.push(FakeFactory.key(owner));
  }
}

export const fakeModels: AssistantModels = {
  async catalog() {
    return {
      groups: [
        {
          id: 'mastra/anthropic',
          harness: 'mastra',
          harnessLabel: 'Mastra',
          provider: 'anthropic',
          label: 'Anthropic',
          credential: 'api_key',
          availability: { state: 'ready' },
          models: [
            {
              id: 'anthropic/claude-sonnet-4-5',
              label: 'claude-sonnet-4-5',
              provider: 'anthropic',
              modelName: 'claude-sonnet-4-5',
              free: false,
              legacy: false,
              selectable: true,
              availability: { state: 'ready' },
            },
          ],
        },
      ],
      default: { modelId: 'anthropic/claude-sonnet-4-5', label: 'claude-sonnet-4-5', source: 'factory_default', reason: 'Test default.' },
      defaultReason: 'Test default.',
    };
  },
};

/** No encryption, but a visible envelope, so tests see the stored text is not the raw token. */
export const testCipher: SecretCipher = {
  async encrypt(value) {
    return `enc:${Buffer.from(JSON.stringify(value)).toString('base64')}`;
  },
  async decrypt<T>(value: unknown) {
    const text = String(value);
    if (!text.startsWith('enc:')) throw new Error('not an envelope');
    return { value: JSON.parse(Buffer.from(text.slice(4), 'base64').toString()) as T, needsReencryption: false };
  },
};
