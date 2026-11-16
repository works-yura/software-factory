/**
 * What the assistant needs from its host, as ports (ADR-0051). The host (the Factory server)
 * supplies them; nothing here reaches into Factory's cards, sessions or harnesses. Factory itself
 * is reached only through {@link FactoryClient}, which speaks Factory's MCP as the person.
 */
import type { Workspace, WorkspaceToolHooks } from '@mastra/core/workspace';

import type {
  AssistantFile,
  AssistantMessage,
  AssistantOwner,
  AssistantRequest,
  FactoryLink,
} from './types.ts';

/** Bytes by content hash: the server's `AttachmentBlobStore`, shared with Factory attachments. */
export interface AssistantBlobStore {
  put(
    body: Uint8Array | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
    options?: { maxBytes?: number },
  ): Promise<{ sha256: string; size: number }>;
  get(sha256: string): Promise<ReadableStream<Uint8Array> | null>;
  delete(sha256: string): Promise<boolean>;
}

/** Encrypts secrets at rest: the server's `secret-encryption` envelope. */
export interface SecretCipher {
  encrypt<T>(value: T): Promise<string>;
  decrypt<T>(value: unknown): Promise<{ value: T; needsReencryption: boolean }>;
}

/** One file of a turn, as the model gets it. */
export interface BrainFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

/**
 * Who the entry a turn answers comes from: the person, a Factory, a source, the digest,
 * `approved` — the result of a call the person approved (a command, a download) — or `resumed`:
 * the server restarted while the agent worked on the request, and it carries on.
 */
export type BrainAuthor = 'person' | 'factory' | 'source' | 'digest' | 'approved' | 'resumed';

/** What one turn of the agent sees: the request and the new entry it answers. */
export interface BrainTurn {
  owner: AssistantOwner;
  request: AssistantRequest;
  /**
   * The new entry to look at: the person's text, a Factory's answer, or a message read from a
   * source (`fromName` wrote it there).
   */
  input: { author: BrainAuthor; text: string; files: BrainFile[]; fromName?: string | null };
  /** The request's first turn: for a request a source made, the agent also names its topic. */
  first?: boolean;
  /** The model the person chose, or `null` for the organization's default. */
  modelId: string | null;
  /** The whole system prompt the service composed (base document, skills index, guard). */
  systemPrompt?: string;
  /** The skills the person picked, by name and description; the agent loads one with a tool. */
  skills?: SkillSummary[];
  /**
   * The agent's tools for this turn (Mastra tools), every one bound to this owner and this
   * request: see `createAssistantTools`.
   */
  tools?: Record<string, unknown>;
  /** Model steps (tool calls and answers) this turn may take. */
  maxSteps?: number;
  /**
   * The owner's workspace for this turn (files and commands, see `AssistantWorkspaceHost`): its tools
   * come with it. Absent when the host has none.
   */
  workspace?: Workspace;
  /** The request's folder in that workspace (`requests/<id>`, relative to the workspace root and the commands’ working directory), where its files are. */
  workspaceFolder?: string;
}

/**
 * The per-person agent: a Mastra Agent with memory under `assistant:<orgId>:<userId>`, thread per
 * request. It reports to the person only.
 */
export interface AssistantBrain {
  /**
   * The report, and — when asked on a source request's first turn — a short topic for it, and the
   * model that actually ran.
   */
  respond(turn: BrainTurn): Promise<{ text: string; topic?: string; modelId?: string }>;
  /** A tiny call to a model («Check the model»): its answer, or a throw with the provider's refusal. */
  probe?(owner: AssistantOwner, modelId: string | null): Promise<{ modelId: string | null; text: string }>;
}

/** The agent's memory: erased per owner. */
export interface AssistantMemory {
  forget(owner: AssistantOwner): Promise<void>;
  forgetThread(owner: AssistantOwner, requestId: string): Promise<void>;
}

/** A model the person can pick for the assistant (the flat list older clients read). */
export interface AssistantModelOption {
  /** What the settings store and the turn resolves: `provider/model`, or `<harness>:<model>` for a sign-in. */
  id: string;
  provider: string;
  modelName: string;
  label: string;
  free: boolean;
  /** The group (`AssistantModelGroup.id`) it is listed under. */
  groupId: string;
}

/**
 * Whether the assistant can run a model now, for the person asking:
 * - `ready`: it runs;
 * - `limited`: every account it may use is out of usage until `until` (it can still be picked);
 * - `no_credentials`: nothing it runs on is connected for this person (`connector` says where);
 * - `sessions_only`: it runs only in Factory sessions, through its harness's CLI (no API path);
 * - `unavailable`: its catalog could not be read now (`reason`).
 */
export type AssistantModelState = 'ready' | 'limited' | 'no_credentials' | 'sessions_only' | 'unavailable';

export interface AssistantModelAvailability {
  state: AssistantModelState;
  /** `limited`: when the first account comes back (ISO 8601). */
  until?: string;
  /** Why, in the server's words (English); absent when `ready`. */
  reason?: string;
  /** The Settings › Підключення connector that makes it available (`claude-code`, `codex`, `opencode`). */
  connector?: string;
}

/**
 * What a group's models run on in the assistant:
 * - `api_key`, `provider_oauth`, `deployment`: the organization's model credentials (Settings › Моделі), as Mastra runs them;
 * - `claude_login`: the person's Claude sign-ins (Claude Code connection), the Anthropic API with their OAuth token;
 * - `codex_login`: the person's ChatGPT sign-ins (Codex connection), the Codex backend with their OAuth token;
 * - `opencode_account`: the organization's OpenCode accounts (OpenCode connection), OpenCode's API with their key;
 * - `cli_only`: nothing the assistant can call: the harness's CLI alone runs it.
 */
export type AssistantModelCredential = 'api_key' | 'provider_oauth' | 'deployment' | 'claude_login' | 'codex_login' | 'opencode_account' | 'cli_only';

export interface AssistantCatalogModel {
  id: string;
  label: string;
  provider: string;
  modelName: string;
  /** Costs nothing to run (its provider may use what is sent to improve its models). */
  free: boolean;
  /** Kept for old picks; listed after the current ones. */
  legacy: boolean;
  /** Whether the person can pick it for the assistant (`ready` or `limited`). */
  selectable: boolean;
  availability: AssistantModelAvailability;
}

/** One provider (Mastra, by its credential) or one harness's sign-ins, as Factory's model picker groups them. */
export interface AssistantModelGroup {
  /** `mastra/<provider>` or the harness instance (`claude-code`, `codex`, `opencode`). */
  id: string;
  /** The harness Factory runs these on (`mastra`, `claude-code`, …) and its name. */
  harness: string;
  harnessLabel: string;
  provider: string;
  /** "xAI", "Claude Code · Claude sign-in", … */
  label: string;
  credential: AssistantModelCredential;
  /** How Settings names the credential ("xAI API key", "Claude Pro/Max", an account's label), when known. */
  credentialLabel?: string;
  availability: AssistantModelAvailability;
  models: AssistantCatalogModel[];
}

/** The model a person who picked none runs on, and why that one. */
export interface AssistantModelDefault {
  modelId: string;
  label: string;
  /**
   * `factory_default`: the model a new Factory chat of this organization starts on (no Factory default set);
   * `org_preference`: that one cannot run here, so the first runnable model in the organization's catalog order.
   */
  source: 'factory_default' | 'org_preference';
  /** Why, in the server's words (English). */
  reason: string;
}

/** The organization's model catalog as the assistant offers it (`GET /web/assistant/models`). */
export interface AssistantModelCatalog {
  groups: AssistantModelGroup[];
  /** Null when nothing can run; `defaultReason` says why. */
  default: AssistantModelDefault | null;
  defaultReason: string;
}

/** The selectable models of a catalog, flat, in catalog order. */
export function selectableAssistantModels(catalog: AssistantModelCatalog): AssistantModelOption[] {
  return catalog.groups.flatMap(group =>
    group.models
      .filter(model => model.selectable)
      .map(model => ({
        id: model.id,
        provider: model.provider,
        modelName: model.modelName,
        label: model.label,
        free: model.free,
        groupId: group.id,
      })),
  );
}

/**
 * The organization's models (ADR-0032: there are no personal model credentials), as Factory offers
 * them: its model credentials, and the sign-ins and accounts its harnesses run on (Settings › Підключення).
 */
export interface AssistantModels {
  catalog(owner: AssistantOwner): Promise<AssistantModelCatalog>;
}

/** A skill as the settings page lists it: from the Factory catalogue (maybe overridden) or the person's own. */
export interface AssistantSkillEntry extends SkillSummary {
  origin: 'factory' | 'personal';
  /** A catalogue skill the person changed for their assistant only. */
  overridden: boolean;
  /** Picked: the agent sees it. */
  enabled: boolean;
}

/** One skill opened in full, with the catalogue's original when the person overrode it. */
export interface AssistantSkillDetail extends AssistantSkillEntry {
  instructions: string;
  original: { description: string; instructions: string } | null;
  updatedAt: Date | null;
}

/** A Factory the person can reach through MCP. */
export interface FactoryRef {
  id: string;
  name: string;
}

/** What asking a Factory started: its side session. */
export interface FactoryQuestion {
  sessionId: string;
  url?: string;
}

/** A side session's answer so far: `null` while it is still working. */
export interface FactoryAnswer {
  text: string | null;
}

/** What handing a request over created. */
export interface FactoryHandover {
  workItemId: string;
  url?: string;
  /** Files the card did not get, with why. The card exists either way. */
  failedFiles: Array<{ name: string; error: string }>;
}

/**
 * The read-only tools of Factory's MCP the assistant's agent may call as the person. Everything
 * else (create a card, start a session) goes through `ask`/`handOver`, after the person confirms.
 */
export const FACTORY_READ_TOOLS = ['factory_list_work_items', 'factory_inspect_work_item', 'factory_list_attention'] as const;
export type FactoryReadTool = (typeof FACTORY_READ_TOOLS)[number];

/**
 * Factory, reached only through its MCP endpoint with the person's own OAuth grant (ADR-0051).
 * The person's role decides what works: a viewer cannot hand a card over.
 */
export interface FactoryClient {
  /** Whether the person has allowed the assistant to reach Factory. */
  connected(owner: AssistantOwner): Promise<boolean>;
  listFactories(owner: AssistantOwner): Promise<FactoryRef[]>;
  ask(owner: AssistantOwner, input: { factoryId: string; question: string; title: string }): Promise<FactoryQuestion>;
  readAnswer(owner: AssistantOwner, input: { factoryId: string; sessionId: string }): Promise<FactoryAnswer>;
  /** One read-only MCP tool of that Factory, with its own arguments and answer shape. */
  read(owner: AssistantOwner, input: { factoryId: string; tool: FactoryReadTool; args: Record<string, unknown> }): Promise<Record<string, unknown>>;
  handOver(
    owner: AssistantOwner,
    input: {
      factoryId: string;
      title: string;
      description: string;
      files: Array<{ name: string; mime: string; bytes: Uint8Array }>;
    },
  ): Promise<FactoryHandover>;
}

/** The person's OAuth grant to Factory's MCP: revoked first when the assistant is erased. */
export interface FactoryGrant {
  revoke(owner: AssistantOwner): Promise<void>;
}

/** An audit entry for an erased assistant: who, which organization, why. Never content. */
export interface AssistantAuditEvent {
  orgId: string;
  userId: string;
  actorId: string;
  reason: string;
  counts: { requests: number; files: number };
}

export type AssistantAudit = (event: AssistantAuditEvent) => Promise<void>;

/** A skill of the Factory skills catalogue, as the settings picker and the agent see it. */
export interface SkillSummary {
  name: string;
  description: string;
}

/**
 * The Factory skills catalogue (the same SKILL.md files Factory sessions load: bundled, the app's
 * `factory-skills/`, `MastraFactory({ skills })`). The host supplies it; the assistant never reads
 * Factory's files itself.
 */
export interface AssistantSkills {
  list(owner: AssistantOwner): Promise<SkillSummary[]>;
  /** The skill's instructions (SKILL.md without its frontmatter), or `null` when there is none. */
  read(owner: AssistantOwner, name: string): Promise<(SkillSummary & { instructions: string }) | null>;
}

/**
 * A chat of a source where the person tagged the assistant (ADR-0051 amendment 2026-11-16), as the
 * agent's tools list it: only such chats can be read on demand.
 */
export interface SourceChannelInfo {
  /** `platform:workspace:channel`: what the agent passes back to read it. */
  ref: string;
  name: string;
  kind: string;
}

/** Recent messages of a channel (or of one thread in it), read on demand with the person's connection. */
export interface SourceChannelMessages {
  channel: SourceChannelInfo;
  messages: Array<{
    id: string;
    from: string | null;
    text: string;
    at: string;
    /** Replies the message has (a thread root). */
    replies: number;
    /** The thread root it replies to, or `null` for a top-level message. */
    threadId: string | null;
    /** Files the message carries (links to the source's file hosts); the agent downloads one with its download tool. */
    attachments?: Array<{ name: string; url: string }>;
  }>;
}

/**
 * A source the person connected personally (ADR-0051: ClickUp Chat, later e-mail). The core erases
 * it first when the assistant is erased; the source owns its connection, channels and cursors.
 */
export interface AssistantSource {
  readonly platform: string;
  /** Forgets the person's connection (the encrypted token), its tag settings and cursors. */
  disconnect(owner: AssistantOwner): Promise<void>;
  /** Organizations a person has a connection of this source in (for erasing a deleted account). */
  organizationsOf(userId: string): Promise<string[]>;
  /** The chats where the person tagged the assistant, for the agent's tools. */
  taggedChannels?(owner: AssistantOwner): Promise<SourceChannelInfo[]>;
  /**
   * Recent messages of one chat where the person tagged the assistant (or one thread in it), read
   * now with the person's own connection; any other chat is refused.
   */
  readChannel?(owner: AssistantOwner, input: { ref: string; threadId?: string; limit?: number }): Promise<SourceChannelMessages>;
  /**
   * A file at `url` when it is on this source's hosts, fetched with the person's own connection;
   * `null` when the URL is not this source's (the core then asks the person before fetching it
   * without credentials). Throws when it is the source's but cannot be fetched (`maxBytes` included).
   */
  download?(owner: AssistantOwner, url: string, maxBytes: number): Promise<SourceDownload | null>;
}

/** One message of the conversation a tag points at. */
export interface SourceContextMessage {
  /** Who wrote it, as the source names them; `null` when the source does not know. */
  fromName: string | null;
  text: string;
  /** ISO time it was written. */
  at: string;
}

/**
 * A tag a source found (ADR-0051 amendment 2026-11-16): a message in the person's chat that carries
 * their tag (`#помічник` …), detected by a pattern, never by a model. It is the only way a source
 * makes a request; ordinary chat traffic never does.
 */
export interface SourceMessage {
  platform: 'clickup';
  /**
   * The thread it belongs to: `platform:workspace:channel:thread` (thread = the root message id). A
   * later tag in the same thread joins the open request from it.
   */
  sourceKey: string;
  /** The tagged message's own id at the source: `platform:workspace:message`. Taking it in twice is a no-op. */
  messageKey: string;
  /** What the tagger wrote besides the tag (the tag stripped): their instruction; may be empty. */
  text: string;
  /** Who tagged, as the source names them. */
  fromName: string | null;
  /** A link to the chat at the source. */
  sourceUrl: string | null;
  /**
   * What the tag points at, oldest first: in a thread, its root and replies (since the previous tag
   * there); in a flat chat, the messages before it (up to the person's count, or since the
   * previous tag).
   */
  context: SourceContextMessage[];
  /** `thread` or `chat`: where the context comes from. */
  contextKind: 'thread' | 'chat';
  /** Attachments of the tagged message and its context, already downloaded. */
  files: Array<{ name: string; declaredMime: string | null; bytes: Uint8Array }>;
  /** False when the person's limit on agent turns is spent: the request is kept, the agent skips it. */
  analyse: boolean;
  /** Where the source thread lives, for the agent (`#general`, `DM`). */
  where?: string;
}

export type IngestOutcome = 'duplicate' | 'created' | 'appended' | 'reopened';

/** What a request and its thread look like to the panel. */
export interface RequestView {
  request: AssistantRequest;
  messages: AssistantMessage[];
  files: AssistantFile[];
}

export type { FactoryLink };

/** What the permission rules say about one workspace tool call. */
export type WorkspaceToolApproval = 'allow' | 'ask' | 'deny';

/**
 * The owner's workspace (ADR-0051, «Де живе помічник»): one persistent folder per `(orgId, userId)`
 * in the host's sandbox, with no repository. The host makes it on first use with the same sandbox,
 * agent user (ADR-0041) and Seatbelt profile (ADR-0050) Factory sessions run in, and gives the
 * agent the same workspace tools sessions have. The core decides what is in it (a folder per
 * request) and gates the tools; the host only supplies the folder and the rules.
 */
export interface AssistantWorkspaceHost {
  /**
   * The owner's workspace: files through its sandbox (paths never leave the folder, symlinks
   * included), commands in it, and the sessions' workspace tools with `hooks` around every call.
   * Opening does not start anything; the first file operation or command does.
   */
  open(owner: AssistantOwner, options?: { hooks?: WorkspaceToolHooks }): Promise<Workspace>;
  /** What a workspace tool call needs under the rules personal Factory sessions run with. */
  approval(toolName: string): WorkspaceToolApproval;
  /** Stops what runs in the owner's folder and removes it. A folder that is not there is fine. */
  erase(owner: AssistantOwner): Promise<void>;
}

/** A file a source fetched for the person (an attachment link), with what the server said it is. */
export interface SourceDownload {
  bytes: Uint8Array;
  mime: string | null;
}
