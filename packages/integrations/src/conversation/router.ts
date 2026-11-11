import type { ChannelIdentityStorage, WorkItemRow, WorkItemsStorage } from '@factory/store';

import { ConnectCodes } from './connect-codes.ts';
import { isAudioAttachment, TranscriptionError } from './types.ts';
import type { ConversationAttachment, ConversationChannel, InboundMessage, Transcriber } from './types.ts';

/** The card a message's thread belongs to, as the adapter finds it from the message's subject. */
export interface ConversationCard {
  orgId: string;
  factoryProjectId: string;
  card: WorkItemRow;
}

export interface ConversationRouterOptions {
  channel: ConversationChannel;
  identities: Pick<ChannelIdentityStorage, 'getAccountLink' | 'saveAccountLink'>;
  codes: ConnectCodes;
  /** Finds the card for the message's subject; `null` when Factory doesn't track it. */
  findCard(message: InboundMessage): Promise<ConversationCard | null>;
  workItems: Pick<WorkItemsStorage, 'commitRuleEvaluation'>;
  /** The page a sender opens to get a connect code (no identity in it). */
  connectUrl: string;
  configVersion: string;
  /** Speech-to-text; absent means voice clips reach the agent with a note saying so. */
  transcriber?: Transcriber;
  maxAudioBytes?: number;
  now?: () => Date;
}

export type ConversationOutcome =
  | 'own-message'
  | 'not-addressed'
  | 'duplicate'
  | 'connect-card'
  | 'linked'
  | 'invalid-code'
  | 'no-card'
  | 'other-organization'
  | 'no-session'
  | 'delivered';

const DEFAULT_MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const SEEN_LIMIT = 5_000;

/**
 * The provider-neutral half of a conversation channel. Given a message an adapter read, it
 * decides whether Factory answers, resolves the sender to a Factory member (or asks them to
 * connect), turns voice clips into text, and hands the message to the card's live session as a
 * rule message — the same dispatcher path every other provider event takes, so replays dedupe on
 * the message id.
 */
export class ConversationRouter {
  readonly #options: ConversationRouterOptions;
  readonly #seen = new Set<string>();
  /** Threads where the connect card was already posted for a sender. */
  readonly #prompted = new Set<string>();

  constructor(options: ConversationRouterOptions) {
    this.#options = options;
  }

  get platform(): string {
    return this.#options.channel.platform;
  }

  async handle(message: InboundMessage): Promise<ConversationOutcome> {
    const key = `${message.platform}:${message.id}`;
    // Factory's own replies would otherwise wake the agent that wrote them.
    if (message.fromBot) return 'own-message';
    if (this.#seen.has(key)) return 'duplicate';
    const outcome = await this.#route(message);
    this.#remember(key);
    return outcome;
  }

  async #route(message: InboundMessage): Promise<ConversationOutcome> {
    const { channel, identities, codes } = this.#options;
    const code = ConnectCodes.find(message.text);
    if (code) {
      const owner = codes.redeem(message.platform, code);
      if (!owner) {
        await channel.reply(message.thread, `${this.#who(message)} that code is unknown or expired. Open ${this.#options.connectUrl} for a new one.`);
        return 'invalid-code';
      }
      await identities.saveAccountLink({
        platform: message.platform,
        externalTeamId: message.sender.teamId,
        externalUserId: message.sender.userId,
        orgId: owner.orgId,
        userId: owner.userId,
        externalUserName: message.sender.name,
      });
      await channel.reply(message.thread, `${this.#who(message)} your account is connected to Factory. Mention me to talk to the agent.`);
      return 'linked';
    }
    if (!message.addressedToBot) return 'not-addressed';

    const link = await identities.getAccountLink({
      platform: message.platform,
      externalTeamId: message.sender.teamId,
      externalUserId: message.sender.userId,
    });
    if (!link) {
      const prompted = `${message.thread.id}:${message.sender.userId}`;
      if (!this.#prompted.has(prompted)) {
        this.#prompted.add(prompted);
        await channel.reply(
          message.thread,
          `${this.#who(message)} connect your Factory account so the agent can act for you: open ${this.#options.connectUrl}, then reply here with the code it shows (\`connect FCT-…\`).`,
        );
      }
      return 'connect-card';
    }

    const found = await this.#options.findCard(message);
    if (!found) {
      await channel.reply(message.thread, `${this.#who(message)} this isn't a card Factory tracks, so no agent can pick this up here.`);
      return 'no-card';
    }
    if (link.orgId !== undefined && link.orgId !== found.orgId) {
      await channel.reply(message.thread, `${this.#who(message)} your Factory account isn't in the organization that owns this card.`);
      return 'other-organization';
    }
    if (Object.keys(found.card.sessions ?? {}).length === 0) {
      await channel.reply(
        message.thread,
        `${this.#who(message)} no agent is working on this card yet, so nothing was sent. Start it from the card in Factory, then mention me again.`,
      );
      return 'no-session';
    }

    const body = await this.#body(message, { ...found, userId: link.userId });
    const prompt = [
      `${message.sender.name} wrote on ${message.platform} (${message.subject.title ?? message.subject.externalId}${message.subject.url ? `, ${message.subject.url}` : ''}):`,
      '',
      body,
      '',
      `Answer them in that thread with \`factory_conversation_reply\` and thread "${message.thread.id}" (platform "${message.platform}").`,
    ].join('\n');
    const identity = `${message.platform}:message:${message.id}`;
    const commit = await this.#options.workItems.commitRuleEvaluation({
      orgId: found.orgId,
      factoryProjectId: found.factoryProjectId,
      workItemId: found.card.id,
      ingress: { identity, triggerType: `${message.platform}.message` },
      configVersion: this.#options.configVersion,
      expectedRevision: found.card.revision,
      actor: { type: 'human', id: link.userId },
      outcome: { status: 'accepted' },
      decisions: [{ type: 'sendMessage', idempotencyKey: `${identity}:message`, message: prompt, idleBehavior: 'wake' }],
      causalChain: [],
      now: (this.#options.now ?? (() => new Date()))(),
    });
    if (commit.status === 'stale') throw new Error(`Card ${found.card.id} changed while a ${message.platform} message was delivered; retrying.`);
    if (commit.status === 'missing') throw new Error(`Card ${found.card.id} disappeared before a ${message.platform} message was delivered.`);
    return 'delivered';
  }

  /** The text the agent reads: voice clips replaced by their transcript, or kept with a note. */
  async #body(message: InboundMessage, scope: { orgId: string; factoryProjectId: string; userId: string }): Promise<string> {
    const parts = message.text.trim() ? [message.text.trim()] : [];
    for (const attachment of message.attachments) {
      if (!isAudioAttachment(attachment)) {
        parts.push(`[Attachment: ${attachment.name} — ${attachment.url}]`);
        continue;
      }
      const transcript = await this.#transcribe(attachment, scope);
      parts.push(
        'text' in transcript
          ? `[Voice clip ${attachment.name}, transcribed:] ${transcript.text}`
          : `[Voice clip ${attachment.name} — ${attachment.url} — couldn't be transcribed: ${transcript.reason}]`,
      );
    }
    return parts.join('\n\n');
  }

  async #transcribe(
    attachment: ConversationAttachment,
    scope: { orgId: string; factoryProjectId: string; userId: string },
  ): Promise<{ text: string } | { reason: string }> {
    const { transcriber } = this.#options;
    if (!transcriber) return { reason: 'voice transcription is not set up on this Factory' };
    try {
      const audio = await this.#options.channel.download(attachment);
      const limit = this.#options.maxAudioBytes ?? DEFAULT_MAX_AUDIO_BYTES;
      if (audio.byteLength > limit) return { reason: `it is longer than the ${Math.round(limit / 1024 / 1024)} MB limit` };
      const text = (await transcriber({ audio, mimeType: attachment.mimeType, fileName: attachment.name, ...scope })).trim();
      return text ? { text } : { reason: 'no speech was recognized' };
    } catch (error) {
      if (error instanceof TranscriptionError) return { reason: error.message };
      return { reason: `the transcription failed (${error instanceof Error ? error.message : String(error)})` };
    }
  }

  #who(message: InboundMessage): string {
    return message.sender.mention ?? message.sender.name;
  }

  #remember(key: string): void {
    this.#seen.add(key);
    if (this.#seen.size > SEEN_LIMIT) this.#seen.delete(this.#seen.values().next().value!);
  }
}
