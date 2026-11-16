/**
 * What the assistant keeps in its owner's workspace (ADR-0051, «Де живе помічник») and how the
 * agent's workspace tools are gated. The host supplies the folder (`AssistantWorkspaceHost`: the
 * sandbox, the agent user, the sessions' tools and permission rules); this module decides the layout
 * and the gate:
 *
 *   requests/<requestId>/              a request's files: what the person or a source brought
 *   requests/<requestId>/downloads/    what the agent downloaded for it
 *
 * The agent may work anywhere in the workspace; the thread's «Files» show the request's folder.
 * Every tool call passes the gate: what the rules allow runs, what they deny is refused, and what
 * they say to ask becomes a proposal on the request (Confirm / Cancel in the thread), run exactly as
 * proposed once the person confirms. One proposal waits at a time.
 */
import { createWorkspaceTools, getMimeType } from '@mastra/core/workspace';
import type { Workspace, WorkspaceToolBeforeHookResult, WorkspaceToolHookContext, WorkspaceToolHooks } from '@mastra/core/workspace';

import { AssistantError } from './errors.ts';
import { cleanFileName, sniffMime } from './files.ts';
import type { AssistantWorkspaceHost, WorkspaceToolApproval } from './ports.ts';
import type { AssistantOwner, ToolCallRecord } from './types.ts';
import { assertOwner } from './types.ts';

/** The workspace folder that holds one folder per request. */
export const REQUESTS_DIR = 'requests';
/** The request's subfolder downloads go to. */
export const DOWNLOADS_DIR = 'downloads';

const ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
/** At most this many entries are listed for a request's folder. */
const MAX_LISTED = 500;
const MAX_DEPTH = 6;

/** `requests/<id>` (relative to the workspace root): refuses an id that is not a plain path segment. */
export function requestFolder(requestId: string): string {
  if (!ID.test(requestId) || requestId === '.' || requestId === '..') {
    throw new AssistantError('not_found', 'Request not found.', 404);
  }
  return `${REQUESTS_DIR}/${requestId}`;
}

/**
 * A path the person asked for, inside the request's folder: relative segments only, no `..`, no
 * empty or hidden-root tricks. Returns the workspace path.
 */
export function pathInRequest(requestId: string, relativePath: string): string {
  const segments = relativePath.split('/').filter(segment => segment !== '' && segment !== '.');
  if (!segments.length || segments.some(segment => segment === '..' || segment.includes('\\') || segment.includes('\0'))) {
    throw new AssistantError('invalid_path', 'That is not a file in this request.', 400);
  }
  return `${requestFolder(requestId)}/${segments.join('/')}`;
}

/** One entry of a request's folder, as the thread's «Files» shows it. */
export interface WorkspaceEntry {
  /** Relative to the request's folder (`downloads/a.png`). */
  path: string;
  name: string;
  type: 'file' | 'directory';
  size: number;
  mime: string | null;
  modifiedAt: Date | null;
}

/*
 * The Files view's wire shapes. They are those of a session's Files (`WorkspaceTreeListing`,
 * `WorkspaceFile` in `@factory/api/fs`), copied rather than imported because ADR-0051's boundary
 * keeps `@factory/api` out of the assistant; the app draws both with the same components, so a
 * change there must come here too (the app's adapter test reads both through one type).
 */

/** One directory of the request's folder, as a session's Files tree lists one. */
export interface WorkspaceTreeView {
  /** `assistant/<requestId>`: what the app keys its queries by. */
  workspacePath: string;
  path: string;
  available: boolean;
  entries: Array<{ name: string; path: string; type: 'file' | 'directory'; size?: number }>;
}

/** One file, as a session's file view shows it. */
export interface WorkspaceFileView {
  workspacePath: string;
  path: string;
  name: string;
  size: number;
  updatedAt: string;
  contentType: 'text' | 'media' | 'unsupported';
  content?: string;
  mimeType?: string;
  truncated?: boolean;
}

/** What the app keys a request's Files by; never a path on disk. */
export function workspaceViewPath(requestId: string): string {
  return `assistant/${requestId}`;
}

const MAX_TEXT_BYTES = 512 * 1024;
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
};

function mediaTypeOf(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  if (dot === -1 || dot < path.lastIndexOf('/')) return undefined;
  return MEDIA_TYPES[path.slice(dot + 1).toLowerCase()];
}

function bytesOf(content: string | Buffer | Uint8Array): Uint8Array {
  return typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
}

const SUMMARY_LIMIT = 500;

function clip(text: string, limit = SUMMARY_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** What the person reads in a proposal: the command line for a command, the target path for a file tool. */
export function describeToolCall(toolName: string, args: Record<string, unknown>): string {
  const command = typeof args.command === 'string' ? args.command : undefined;
  if (command) {
    const description = typeof args.description === 'string' && args.description.trim() ? `${args.description.trim()}\n` : '';
    return clip(`${description}$ ${command}`);
  }
  const path = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : undefined;
  return clip(path ? `${toolName} ${path}` : `${toolName} ${JSON.stringify(args)}`);
}

/** How a gated call is put to the person: a proposal on the request, or why there can be none. */
export type ProposeToolCall = (input: { toolName: string; args: Record<string, unknown>; summary: string }) => Promise<void>;

/**
 * Records every workspace tool call of a turn for «Turn details» (name, arguments and answer as
 * short JSON, failure, duration), the way `recordToolCalls` records the assistant's own tools.
 */
export function recordWorkspaceCalls(calls: ToolCallRecord[], summarize: (value: unknown) => string, now: () => number = Date.now) {
  const started = new Map<string, number[]>();
  return {
    before(toolName: string) {
      const list = started.get(toolName) ?? [];
      list.push(now());
      started.set(toolName, list);
    },
    after(context: { toolName: string; input: unknown; output?: unknown; error?: unknown }) {
      const at = started.get(context.toolName)?.shift() ?? now();
      const record: ToolCallRecord = { name: context.toolName, args: summarize(context.input ?? {}), durationMs: now() - at };
      if (context.error !== undefined) record.error = context.error instanceof Error ? context.error.message : String(context.error);
      else record.result = summarize(context.output);
      calls.push(record);
    },
  };
}

export interface WorkspaceGateOptions {
  approval: (toolName: string) => WorkspaceToolApproval;
  propose: ProposeToolCall;
  /** Records each call for «Turn details». */
  record?: ReturnType<typeof recordWorkspaceCalls>;
}

/**
 * The hooks every workspace tool call of a turn passes: rules first, then the proposal for what
 * asks. A turn proposes at most one call; later asking calls are told one already waits.
 */
export function workspaceGate(options: WorkspaceGateOptions): WorkspaceToolHooks {
  let proposed = false;
  return {
    beforeToolCall: async ({ toolName, input }: WorkspaceToolHookContext): Promise<void | WorkspaceToolBeforeHookResult> => {
      options.record?.before(toolName);
      const decision = options.approval(toolName);
      if (decision === 'allow') return;
      if (decision === 'deny') {
        return { proceed: false, output: { error: `${toolName} is not allowed for the assistant.` } };
      }
      if (proposed) {
        return {
          proceed: false,
          output: { error: 'Another call already waits for the person’s approval. Stop and tell the person what you want to do next.' },
        };
      }
      const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
      await options.propose({ toolName, args, summary: describeToolCall(toolName, args) });
      proposed = true;
      return {
        proceed: false,
        output: {
          status: 'awaiting_approval',
          message:
            'This call needs the person’s approval. It is shown to them with Confirm / Cancel and runs exactly as you called it once they confirm; you will get its result then. Do not try another way around it: tell the person what you want to run and why, and stop.',
        },
      };
    },
    afterToolCall: async context => {
      options.record?.after(context);
    },
  };
}

/** The owner's workspace as the assistant uses it: request folders, listing, reading, writing, erasing. */
export class AssistantWorkspaces {
  readonly #host: AssistantWorkspaceHost;

  constructor(host: AssistantWorkspaceHost) {
    this.#host = host;
  }

  /** What the rules say about a workspace tool. */
  approval(toolName: string): WorkspaceToolApproval {
    return this.#host.approval(toolName);
  }

  /** The workspace for a turn, its tools gated by `hooks`; the request's folder exists with its files. */
  async forTurn(
    owner: AssistantOwner,
    input: { requestId: string; files: Array<{ name: string; bytes: Uint8Array }>; hooks: WorkspaceToolHooks },
  ): Promise<{ workspace: Workspace; folder: string }> {
    assertOwner(owner);
    const workspace = await this.#host.open(owner, { hooks: input.hooks });
    const folder = await this.#materialize(workspace, input.requestId, input.files);
    return { workspace, folder };
  }

  /** The tool descriptions «What the agent sees» lists, without starting anything. */
  async describeTools(owner: AssistantOwner): Promise<Array<{ name: string; description: string; approval: WorkspaceToolApproval }>> {
    const workspace = await this.#host.open(owner);
    const tools = await createWorkspaceTools(workspace);
    return Object.entries(tools).map(([name, tool]) => ({
      name,
      description: String((tool as { description?: unknown }).description ?? ''),
      approval: this.#host.approval(name),
    }));
  }

  /**
   * Runs one call the person approved, exactly as proposed: the gate lets that one call through and
   * nothing else. Returns the tool's answer.
   */
  async runApproved(owner: AssistantOwner, requestId: string, call: { toolName: string; args: Record<string, unknown> }): Promise<unknown> {
    let used = false;
    const workspace = await this.#host.open(owner, {
      hooks: {
        beforeToolCall: ({ toolName }) => {
          if (toolName === call.toolName && !used) {
            used = true;
            return;
          }
          return { proceed: false, output: { error: 'Only the approved call runs here.' } };
        },
      },
    });
    await this.#materialize(workspace, requestId, []);
    const tools = await createWorkspaceTools(workspace);
    const tool = tools[call.toolName] as { execute?: (input: unknown, context: unknown) => Promise<unknown> } | undefined;
    if (!tool?.execute) throw new AssistantError('unknown_tool', `The workspace has no tool ${call.toolName}.`, 409);
    return tool.execute(call.args, {});
  }

  /** Files of a request's folder (recursively, at most 500), folders first. */
  async list(owner: AssistantOwner, requestId: string): Promise<WorkspaceEntry[]> {
    const workspace = await this.#host.open(owner);
    const filesystem = this.#filesystem(workspace);
    const root = requestFolder(requestId);
    if (!(await filesystem.exists(root))) return [];
    const out: WorkspaceEntry[] = [];
    const walk = async (dir: string, prefix: string, depth: number) => {
      if (depth > MAX_DEPTH) return;
      const entries = await filesystem.readdir(dir);
      entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
      for (const entry of entries) {
        if (out.length >= MAX_LISTED) return;
        if (entry.isSymlink) continue;
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        const stat = await filesystem.stat(`${dir}/${entry.name}`).catch(() => null);
        out.push({
          path,
          name: entry.name,
          type: entry.type,
          size: stat?.size ?? entry.size ?? 0,
          mime: entry.type === 'file' ? (stat?.mimeType ?? getMimeType(entry.name) ?? null) : null,
          modifiedAt: stat?.modifiedAt ?? null,
        });
        if (entry.type === 'directory') await walk(`${dir}/${entry.name}`, path, depth + 1);
      }
    };
    await walk(root, '', 0);
    return out;
  }

  /** One file of a request's folder, its bytes and the type its bytes show. */
  async read(owner: AssistantOwner, requestId: string, relativePath: string): Promise<{ name: string; mime: string; bytes: Uint8Array }> {
    const workspace = await this.#host.open(owner);
    const filesystem = this.#filesystem(workspace);
    const path = pathInRequest(requestId, relativePath);
    const stat = await filesystem.stat(path).catch(() => null);
    if (!stat || stat.type !== 'file') throw new AssistantError('not_found', 'File not found.', 404);
    const bytes = bytesOf(await filesystem.readFile(path));
    const name = path.split('/').pop()!;
    return { name, mime: sniffMime(bytes, getMimeType(name) ?? null), bytes };
  }

  /**
   * One directory of the request's folder (`''` its top), in the wire shape of a session's Files tree
   * (`/web/workspace/tree`), so the app draws it with the sessions' own file browser.
   */
  async tree(owner: AssistantOwner, requestId: string, relativePath: string): Promise<WorkspaceTreeView> {
    const workspace = await this.#host.open(owner);
    const filesystem = this.#filesystem(workspace);
    const root = requestFolder(requestId);
    const path = relativePath.trim() ? pathInRequest(requestId, relativePath).slice(root.length + 1) : '';
    const dir = path ? `${root}/${path}` : root;
    const listing = { workspacePath: workspaceViewPath(requestId), path };
    if (!(await filesystem.exists(dir))) return { ...listing, available: true, entries: [] };
    const entries = (await filesystem.readdir(dir))
      .filter(entry => !entry.isSymlink)
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1))
      .slice(0, MAX_LISTED)
      .map(entry => ({
        name: entry.name,
        path: path ? `${path}/${entry.name}` : entry.name,
        type: entry.type,
        ...(entry.type === 'file' && entry.size !== undefined ? { size: entry.size } : {}),
      }));
    return { ...listing, available: true, entries };
  }

  /**
   * One file of the request's folder in the wire shape of a session's file view (`/web/workspace/file`):
   * images and PDFs as media, text (its first 512 KiB), anything else unsupported.
   */
  async fileView(owner: AssistantOwner, requestId: string, relativePath: string): Promise<WorkspaceFileView> {
    const workspace = await this.#host.open(owner);
    const filesystem = this.#filesystem(workspace);
    const full = pathInRequest(requestId, relativePath);
    const path = full.slice(requestFolder(requestId).length + 1);
    const stat = await filesystem.stat(full).catch(() => null);
    if (!stat || stat.type !== 'file') throw new AssistantError('not_found', 'File not found.', 404);
    const base = { workspacePath: workspaceViewPath(requestId), path, name: path.split('/').pop()!, size: stat.size, updatedAt: stat.modifiedAt.toISOString() };
    const mimeType = mediaTypeOf(path);
    if (mimeType) {
      if (stat.size > MAX_MEDIA_BYTES) return { ...base, contentType: 'unsupported' };
      return { ...base, contentType: 'media', mimeType, content: Buffer.from(bytesOf(await filesystem.readFile(full))).toString('base64') };
    }
    const bytes = bytesOf(await filesystem.readFile(full));
    const truncated = bytes.byteLength > MAX_TEXT_BYTES;
    try {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(truncated ? bytes.subarray(0, MAX_TEXT_BYTES) : bytes);
      return { ...base, contentType: 'text', content, truncated };
    } catch {
      return { ...base, contentType: 'unsupported' };
    }
  }

  /** Writes a file into the request's folder (a download, a source's attachment); a taken name gets a suffix. */
  async write(owner: AssistantOwner, requestId: string, input: { dir?: string; name: string; bytes: Uint8Array }): Promise<string> {
    const workspace = await this.#host.open(owner);
    await this.#materialize(workspace, requestId, []);
    const filesystem = this.#filesystem(workspace);
    const name = cleanFileName(input.name);
    const base = input.dir ? pathInRequest(requestId, input.dir) : requestFolder(requestId);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    let path = `${base}/${name}`;
    for (let n = 2; await filesystem.exists(path); n += 1) path = `${base}/${stem} (${n})${ext}`;
    await filesystem.writeFile(path, Buffer.from(input.bytes), { recursive: true });
    return path.slice(requestFolder(requestId).length + 1);
  }

  /** Removes one request's folder (its request was deleted). */
  async removeRequest(owner: AssistantOwner, requestId: string): Promise<void> {
    const workspace = await this.#host.open(owner);
    const filesystem = this.#filesystem(workspace);
    const folder = requestFolder(requestId);
    if (await filesystem.exists(folder)) await filesystem.rmdir(folder, { recursive: true });
  }

  /** The whole workspace, last in the ADR's erase order. */
  async erase(owner: AssistantOwner): Promise<void> {
    assertOwner(owner);
    await this.#host.erase(owner);
  }

  #filesystem(workspace: Workspace) {
    const filesystem = workspace.filesystem;
    if (!filesystem) throw new Error('The assistant workspace has no filesystem.');
    return filesystem;
  }

  /** The request's folder with the request's files in it (written once; the agent may change them after). */
  async #materialize(workspace: Workspace, requestId: string, files: Array<{ name: string; bytes: Uint8Array }>): Promise<string> {
    const filesystem = this.#filesystem(workspace);
    const folder = requestFolder(requestId);
    await filesystem.mkdir(folder, { recursive: true });
    for (const file of files) {
      const path = `${folder}/${cleanFileName(file.name)}`;
      if (await filesystem.exists(path)) continue;
      await filesystem.writeFile(path, Buffer.from(file.bytes), { recursive: true });
    }
    return folder;
  }
}
