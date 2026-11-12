/**
 * Conversation channels — one provider-neutral contract for "a person writes to Factory's agent
 * where they already work" (a ClickUp task comment today; a Slack thread, a GitHub or GitLab
 * comment later). Adapters translate a provider's comments into {@link InboundMessage}s and post
 * replies back; {@link ConversationRouter} owns everything the providers share: who the sender is
 * in Factory, voice clips to text, which card's session hears it, dedupe and loop guards.
 */

/** Where a reply goes: the provider's thread, opaque to the core. */
export interface ConversationThreadRef {
  platform: string;
  /** Serialized by the adapter; the core passes it back unchanged. */
  id: string;
}

/** The provider account that wrote a message. */
export interface ConversationSender {
  /** The provider's workspace/team id: a link is per (platform, team, user). */
  teamId: string;
  userId: string;
  /** Display name, for the agent's prompt and the connect card's mention. */
  name: string;
  /** Provider markup that notifies the sender when posted (e.g. a ClickUp `@user`). */
  mention?: string;
}

export interface ConversationAttachment {
  id: string;
  name: string;
  mimeType: string;
  url: string;
}

export interface InboundMessage {
  platform: string;
  /** Unique per platform; the dedupe key. */
  id: string;
  thread: ConversationThreadRef;
  sender: ConversationSender;
  /** True when the message was written by Factory's own provider account. */
  fromBot: boolean;
  /** True when the message mentions Factory's provider account (or is in a thread Factory joined). */
  addressedToBot: boolean;
  text: string;
  attachments: ConversationAttachment[];
  /** The provider object the thread hangs off, e.g. `{ integrationId: 'clickup', type: 'task', externalId }`. */
  subject: { integrationId: string; type: string; externalId: string; url?: string; title?: string };
  createdAt: string;
}

/**
 * Who is replying: the organization of the agent session that called the reply tool. Provider
 * credentials belong to an organization (ADR-0032), so an adapter answers with that organization's
 * account and refuses a thread another organization's account read.
 */
export interface ConversationReplyScope {
  orgId: string;
}

/** Outbound side every adapter implements. */
export interface ConversationChannel {
  readonly platform: string;
  /**
   * Post `text` as a reply in `thread`, visible to everyone in it. `scope` is set when an agent
   * replies (its session's organization); the router's own notes pass none — the thread the
   * adapter wrote says whose account read it.
   */
  reply(thread: ConversationThreadRef, text: string, scope?: ConversationReplyScope): Promise<void>;
  /** Fetch an attachment's bytes (only called for audio the core will transcribe) from the thread it came in. */
  download(attachment: ConversationAttachment, thread: ConversationThreadRef): Promise<Uint8Array>;
}

export interface TranscriptionInput {
  audio: Uint8Array;
  mimeType: string;
  fileName: string;
  /** The Factory whose model and key transcribe: the session's, not the sender's default. */
  orgId: string;
  factoryProjectId: string;
  /** The Factory member the clip is transcribed for. */
  userId: string;
}

/** Thrown by a {@link Transcriber} with the reason the note shows the agent. */
export class TranscriptionError extends Error {}

/** Port to the composer mic's speech-to-text rule. */
export type Transcriber = (input: TranscriptionInput) => Promise<string>;

export const AUDIO_EXTENSIONS = ['m4a', 'mp3', 'mp4', 'ogg', 'oga', 'opus', 'wav', 'webm', 'aac', 'flac'];

export function isAudioAttachment(attachment: Pick<ConversationAttachment, 'name' | 'mimeType'>): boolean {
  if (attachment.mimeType.startsWith('audio/')) return true;
  const extension = attachment.name.split('.').pop()?.toLowerCase() ?? '';
  return AUDIO_EXTENSIONS.includes(extension);
}
