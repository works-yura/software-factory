/** Test doubles for the assistant's ports, and a storage on in-memory libsql. */
import { createHash } from 'node:crypto';

import type {
  AssistantBlobStore,
  AssistantBrain,
  AssistantMemory,
  AssistantModels,
  BrainTurn,
  FactoryClient,
  FactoryGrant,
  FactoryRef,
  SecretCipher,
} from './ports.ts';
import type { AssistantOwner } from './types.ts';

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
  async list() {
    return [{ id: 'anthropic/claude-sonnet-4-5', provider: 'anthropic', modelName: 'claude-sonnet-4-5' }];
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
