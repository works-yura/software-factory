/**
 * {@link FactoryClient} over Factory's MCP (ADR-0051): every call carries the person's own OAuth
 * access token and names their organization, exactly as any MCP client of theirs would. Nothing
 * here imports Factory's cards, sessions or harnesses.
 *
 * - Factories: the MCP discovery document `GET /web/factory/mcp` (ADR-0051 (а)).
 * - Ask: `factory_start_session` with the question, then `factory_thread_read` on that session
 *   until its agent has answered (ADR-0051 (б) — `factory_ask` — is not there yet).
 * - Hand over: `factory_create_work_item`, then each file to the card's attachments with the
 *   same bearer token (ADR-0051 (в)).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { FactoryAnswer, FactoryClient, FactoryHandover, FactoryQuestion, FactoryRef } from './ports.ts';
import type { AssistantOwner } from './types.ts';

/** The path of the discovery document listing a person's Factories and their MCP endpoints. */
export const FACTORY_MCP_DISCOVERY_PATH = '/web/factory/mcp';
/** The header that names which of the person's organizations a call acts in. */
const ORGANIZATION_HEADER = 'X-Mastra-Organization-Id';

export interface McpFactoryClientOptions {
  publicOrigin: string;
  /** The person's access token (renewed as needed), or a 409 when they never allowed it. */
  accessToken: (owner: AssistantOwner) => Promise<string>;
  connected: (owner: AssistantOwner) => Promise<boolean>;
  fetch?: typeof fetch;
}

interface DiscoveredFactory {
  id: string;
  name: string;
  mcpUrl: string;
}

type ToolResult = { isError?: boolean; structuredContent?: unknown; content?: Array<{ type: string; text?: string }> };

function toolPayload(name: string, result: ToolResult): Record<string, unknown> {
  const text = (result.content ?? []).flatMap(part => (part.type === 'text' && part.text ? [part.text] : [])).join('\n');
  if (result.isError) throw new Error(text || `${name} failed.`);
  if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent as Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    // Not JSON: the text is the answer.
  }
  return { text };
}

interface ThreadItem {
  type: string;
  status?: string;
  text?: string | null;
}

/**
 * The side session's answer: its agent's messages after the last question it got, once nothing
 * after them is still running. `null` while it works.
 */
export function answerFromThread(items: ThreadItem[]): string | null {
  const lastQuestion = items.map(item => item.type).lastIndexOf('user_message');
  const after = items.slice(lastQuestion + 1);
  if (after.some(item => item.status === 'running' || item.status === 'pending' || item.status === 'waiting')) return null;
  const answers = after.filter(item => item.type === 'assistant_message' && item.text?.trim()).map(item => item.text!.trim());
  return answers.length ? answers[answers.length - 1]! : null;
}

export class McpFactoryClient implements FactoryClient {
  readonly #options: McpFactoryClientOptions;
  readonly #origin: string;
  readonly #fetch: typeof fetch;

  constructor(options: McpFactoryClientOptions) {
    this.#options = options;
    this.#origin = options.publicOrigin.replace(/\/+$/, '');
    this.#fetch = options.fetch ?? fetch;
  }

  connected(owner: AssistantOwner): Promise<boolean> {
    return this.#options.connected(owner);
  }

  async #headers(owner: AssistantOwner): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await this.#options.accessToken(owner)}`,
      [ORGANIZATION_HEADER]: owner.orgId,
    };
  }

  async #discover(owner: AssistantOwner): Promise<DiscoveredFactory[]> {
    const response = await this.#fetch(`${this.#origin}${FACTORY_MCP_DISCOVERY_PATH}`, { headers: await this.#headers(owner) });
    if (!response.ok) throw new Error(`listing Factories answered ${response.status}`);
    const body = (await response.json()) as { factories?: DiscoveredFactory[] };
    return body.factories ?? [];
  }

  async listFactories(owner: AssistantOwner): Promise<FactoryRef[]> {
    return (await this.#discover(owner)).map(({ id, name }) => ({ id, name }));
  }

  async #callTool(owner: AssistantOwner, factoryId: string, name: string, args: Record<string, unknown>) {
    const factory = (await this.#discover(owner)).find(candidate => candidate.id === factoryId);
    if (!factory) throw new Error('That Factory is not one you can reach.');
    const transport = new StreamableHTTPClientTransport(new URL(factory.mcpUrl), {
      requestInit: { headers: await this.#headers(owner) },
      fetch: this.#fetch,
    });
    const client = new Client({ name: 'factory-assistant', version: '1.0.0' });
    await client.connect(transport);
    try {
      const result = (await client.callTool({ name, arguments: args })) as ToolResult;
      return toolPayload(name, result);
    } finally {
      await client.close();
    }
  }

  async ask(owner: AssistantOwner, input: { factoryId: string; question: string; title: string }): Promise<FactoryQuestion> {
    const started = await this.#callTool(owner, input.factoryId, 'factory_start_session', {
      prompt: input.question,
      ...(input.title ? { title: input.title } : {}),
    });
    const sessionId = typeof started.sessionId === 'string' ? started.sessionId : undefined;
    if (!sessionId) throw new Error('Factory started no session for the question.');
    return { sessionId, url: `/factories/${encodeURIComponent(input.factoryId)}/workspaces/${encodeURIComponent(sessionId)}` };
  }

  async readAnswer(owner: AssistantOwner, input: { factoryId: string; sessionId: string }): Promise<FactoryAnswer> {
    const items: ThreadItem[] = [];
    let afterPosition: number | undefined;
    for (let page = 0; page < 20; page += 1) {
      const read = await this.#callTool(owner, input.factoryId, 'factory_thread_read', {
        threadId: input.sessionId,
        view: 'messages',
        limit: 100,
        ...(afterPosition !== undefined ? { afterPosition } : {}),
      });
      items.push(...((read.items as ThreadItem[] | undefined) ?? []));
      if (!read.hasMore || typeof read.nextPosition !== 'number') break;
      afterPosition = read.nextPosition;
    }
    return { text: answerFromThread(items) };
  }

  async handOver(
    owner: AssistantOwner,
    input: { factoryId: string; title: string; description: string; files: Array<{ name: string; mime: string; bytes: Uint8Array }> },
  ): Promise<FactoryHandover> {
    const created = await this.#callTool(owner, input.factoryId, 'factory_create_work_item', {
      title: input.title,
      description: input.description,
    });
    const workItemId = typeof created.id === 'string' ? created.id : undefined;
    if (!workItemId) throw new Error('Factory created no work item.');
    const failedFiles: FactoryHandover['failedFiles'] = [];
    for (const file of input.files) {
      try {
        const query = new URLSearchParams({ name: file.name, source: 'upload' });
        const response = await this.#fetch(
          `${this.#origin}/web/factory/work-items/${encodeURIComponent(workItemId)}/attachments?${query}`,
          {
            method: 'POST',
            headers: { ...(await this.#headers(owner)), 'content-type': file.mime },
            body: file.bytes as unknown as RequestInit["body"],
          },
        );
        if (!response.ok) failedFiles.push({ name: file.name, error: `upload answered ${response.status}` });
      } catch (error) {
        failedFiles.push({ name: file.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return {
      workItemId,
      // A path in this server's web app: the card opened on its Factory's board.
      url: `/factories/${encodeURIComponent(input.factoryId)}/work?item=${encodeURIComponent(workItemId)}`,
      failedFiles,
    };
  }
}
