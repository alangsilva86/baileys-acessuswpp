import type {
  BaileysEventMap,
  proto,
  WAMessage,
  WAMessageUpdate,
  WASocket,
} from '@whiskeysockets/baileys';
import type Long from 'long';
import { createHash } from 'crypto';
import { getAggregateVotesInPollMessage, getKeyAuthor } from '@whiskeysockets/baileys';
import { extractMessageContent, updateMessageWithPollUpdate } from '@whiskeysockets/baileys/lib/Utils/messages.js';
import { decryptPollVote as defaultDecryptPollVote } from '@whiskeysockets/baileys/lib/Utils/process-message.js';
import pino from 'pino';
import { buildContactPayload, mapLeadFromMessage } from '../services/leadMapper.js';
import type { ContactPayload } from '../services/leadMapper.js';
import { WebhookClient } from '../services/webhook.js';
import { getSendTimeoutMs } from '../utils.js';
import { PollMessageStore } from './store.js';
import type { MessageService } from './messageService.js';
import type { BrokerEvent, BrokerEventStore } from '../broker/eventStore.js';
import { toIsoDate } from './time.js';

export interface SendPollOptions {
  selectableCount?: number;
  messageOptions?: Parameters<WASocket['sendMessage']>[2];
}

export interface PollServiceOptions {
  store?: PollMessageStore;
  feedbackTemplate?: string | null;
  messageService?: MessageService;
  eventStore?: BrokerEventStore;
  instanceId?: string;
  aggregateVotesFn?: typeof getAggregateVotesInPollMessage;
  decryptPollVoteFn?: typeof defaultDecryptPollVote;
}

interface PollChoiceEventPayload {
  pollId: string;
  question: string;
  chatId: string | null;
  messageId: string;
  timestamp: string;
  voterJid: string | null;
  selectedOptions: Array<{ id: string | null; text: string | null }>;
  optionsAggregates: Array<{ id: string | null; text: string | null; votes: number }>;
  aggregates: {
    totalVoters: number;
    totalVotes: number;
    optionTotals: Array<{ id: string | null; text: string | null; votes: number }>;
  };
  contact: ContactPayload;
}

type PollUpdateWithCreationKey = proto.IPollUpdate & {
  pollCreationMessageKey?: proto.IMessageKey | null;
};

const DEFAULT_SELECTABLE_COUNT = 1;

interface PollVoteMetadata {
  key?: WAMessage['key'];
  timestampCandidates: Array<number | Long | bigint | null | undefined>;
  update: WAMessageUpdate;
}

interface PollVoteVoterInfo {
  voterKey?: proto.IMessageKey | null;
  voterJid: string | null;
}

function extractPollQuestion(message: WAMessage | undefined): string {
  return (
    message?.message?.pollCreationMessage?.name ||
    message?.message?.pollCreationMessageV2?.name ||
    message?.message?.pollCreationMessageV3?.name ||
    ''
  );
}

function normalizeOptionText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function extractOptionText(option: unknown): string | null {
  if (!option || typeof option !== 'object') return null;
  const withName = option as {
    optionName?: unknown;
    name?: unknown;
  };

  const optionName = withName.optionName;
  if (typeof optionName === 'string') {
    const normalized = normalizeOptionText(optionName);
    if (normalized) return normalized;
  } else if (optionName && typeof optionName === 'object') {
    const text = (optionName as { text?: unknown }).text;
    const normalized = normalizeOptionText(typeof text === 'string' ? text : null);
    if (normalized) return normalized;
  }

  const name = withName.name;
  if (typeof name === 'string') {
    const normalized = normalizeOptionText(name);
    if (normalized) return normalized;
  } else if (name && typeof name === 'object') {
    const text = (name as { text?: unknown }).text;
    const normalized = normalizeOptionText(typeof text === 'string' ? text : null);
    if (normalized) return normalized;
  }

  return null;
}

function computeOptionHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function normalizeOptionHash(value: unknown): string | null {
  if (value == null) return null;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
      return trimmed.toLowerCase();
    }

    const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/;
    if (base64Pattern.test(trimmed)) {
      try {
        const buffer = Buffer.from(trimmed, 'base64');
        if (buffer.length > 0) {
          return buffer.toString('hex');
        }
      } catch {
        // Ignore and fall back to utf-8 encoding below.
      }
    }

    const utf8Buffer = Buffer.from(trimmed, 'utf-8');
    return utf8Buffer.length > 0 ? utf8Buffer.toString('hex') : null;
  }

  if (Buffer.isBuffer(value)) {
    return value.length > 0 ? value.toString('hex') : null;
  }

  if (value instanceof Uint8Array) {
    return value.length > 0 ? Buffer.from(value).toString('hex') : null;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return Buffer.from(value).toString('hex');
  }

  return null;
}

function buildOptionHashMaps(
  pollMessage: WAMessage | undefined,
): {
  hashMap: Map<string, { id: string | null; text: string | null }>;
  textToHash: Map<string, string>;
} {
  const pollCreation =
    pollMessage?.message?.pollCreationMessage ??
    pollMessage?.message?.pollCreationMessageV2 ??
    pollMessage?.message?.pollCreationMessageV3 ??
    undefined;

  const options = (pollCreation?.options ?? []) as unknown[];
  const hashMap = new Map<string, { id: string | null; text: string | null }>();
  const textToHash = new Map<string, string>();

  for (const option of options) {
    const text = extractOptionText(option);
    if (!text) continue;
    const providedHashValue = (option as { optionHash?: unknown }).optionHash;
    const normalizedProvidedHash =
      providedHashValue !== undefined && providedHashValue !== null
        ? normalizeOptionHash(providedHashValue)
        : null;
    const hash = normalizedProvidedHash ?? computeOptionHash(text);
    if (!hashMap.has(hash)) {
      hashMap.set(hash, { id: text, text });
    }
    if (!textToHash.has(text)) {
      textToHash.set(text, hash);
    }
  }

  return { hashMap, textToHash };
}

function buildSyntheticMessageForVoter(
  update: WAMessageUpdate,
  pollMessage: WAMessage | undefined,
  voterKey: proto.IMessageKey | null | undefined,
  voterJid: string | null,
  meId: string | undefined,
): WAMessage {
  const participant =
    voterJid ??
    voterKey?.participant ??
    update.key?.participant ??
    undefined;
  const fromMe =
    voterKey?.fromMe ??
    (meId && voterJid ? voterJid === meId : undefined) ??
    update.key?.fromMe ??
    false;

  return {
    key: {
      remoteJid: pollMessage?.key?.remoteJid,
      fromMe,
      participant,
    },
    pushName: (update as unknown as { pushName?: string }).pushName,
  } as WAMessage;
}

function isPollVoteMessage(
  value: proto.Message.IPollEncValue | proto.Message.IPollVoteMessage | null | undefined,
): value is proto.Message.IPollVoteMessage {
  return !!value && Array.isArray((value as proto.Message.IPollVoteMessage).selectedOptions);
}

export class PollService {
  private readonly store: PollMessageStore;
  private readonly feedbackTemplate?: string | null;
  private readonly messageService?: MessageService;
  private readonly eventStore?: BrokerEventStore;
  private readonly instanceId: string;
  private readonly aggregateVotes: typeof getAggregateVotesInPollMessage;
  private readonly decryptPollVote: typeof defaultDecryptPollVote;

  constructor(
    private readonly sock: WASocket,
    private readonly webhook: WebhookClient,
    private readonly logger: pino.Logger,
    options: PollServiceOptions = {},
  ) {
    this.store = options.store ?? new PollMessageStore();
    this.feedbackTemplate = options.feedbackTemplate ?? process.env.POLL_FEEDBACK_TEMPLATE ?? null;
    this.messageService = options.messageService;
    this.eventStore = options.eventStore;
    this.instanceId = options.instanceId ?? 'default';
    this.aggregateVotes = options.aggregateVotesFn ?? getAggregateVotesInPollMessage;
    this.decryptPollVote = options.decryptPollVoteFn ?? defaultDecryptPollVote;
  }

  async sendPoll(
    jid: string,
    question: string,
    values: string[],
    options: SendPollOptions = {},
  ): Promise<WAMessage> {
    const selectableCount = options.selectableCount ?? DEFAULT_SELECTABLE_COUNT;
    const payload = {
      poll: {
        name: question,
        values,
        selectableCount,
      },
    } as const;

    const message = await this.sock.sendMessage(jid, payload, options.messageOptions);
    this.store.remember(message);
    return message;
  }

  async onMessageUpsert(event: BaileysEventMap['messages.upsert']): Promise<void> {
    if (!event.messages?.length) return;

    for (const message of event.messages) {
      const content = extractMessageContent(message.message);

      if (
        content?.pollCreationMessage ||
        (content as { pollCreationMessageV2?: proto.Message.IPollCreationMessage | null })
          ?.pollCreationMessageV2 ||
        (content as { pollCreationMessageV3?: proto.Message.IPollCreationMessage | null })
          ?.pollCreationMessageV3
      ) {
        this.store.remember(message);
      }

      const pollUpdateMessage =
        content?.pollUpdateMessage ??
        (content as { pollUpdateMessageV2?: proto.Message.IPollUpdateMessage | null })
          ?.pollUpdateMessageV2 ??
        (content as { pollUpdateMessageV3?: proto.Message.IPollUpdateMessage | null })
          ?.pollUpdateMessageV3 ??
        message.message?.pollUpdateMessage ??
        (message.message as { pollUpdateMessageV2?: proto.Message.IPollUpdateMessage | null })
          ?.pollUpdateMessageV2 ??
        (message.message as { pollUpdateMessageV3?: proto.Message.IPollUpdateMessage | null })
          ?.pollUpdateMessageV3 ??
        null;

      if (!pollUpdateMessage) continue;

      const creationKey = (pollUpdateMessage as PollUpdateWithCreationKey | undefined)
        ?.pollCreationMessageKey;
      const pollMessage = this.store.get(creationKey?.id) ?? this.store.get(message.key?.id);
      if (!pollMessage) continue;

      const voterKey =
        (pollUpdateMessage as PollUpdateWithCreationKey | undefined)?.pollUpdateMessageKey ??
        message.key ??
        null;
      const voterJid = this.resolveVoterJid(voterKey, message.key);

      const pollUpdates = this.buildPollUpdatesFromUpsert(
        pollMessage,
        pollUpdateMessage,
        message,
        voterJid,
      );

      if (!pollUpdates.length) continue;

      const updateLike = {
        key: message.key,
        messageTimestamp: message.messageTimestamp,
        update: { pollUpdates },
      } as WAMessageUpdate;
      (updateLike as unknown as { pushName?: string }).pushName =
        (message as unknown as { pushName?: string }).pushName;

      await this.processPollVote(
        pollMessage,
        pollUpdates,
        {
          key: message.key,
          timestampCandidates: [
            (message as Partial<{ messageTimestamp: number | Long | bigint | null }>).messageTimestamp ?? null,
            pollMessage.messageTimestamp ?? null,
          ],
          update: updateLike,
        },
        {
          voterKey,
          voterJid,
        },
      );
    }
  }

  async onMessageUpdate(updates: BaileysEventMap['messages.update']): Promise<void> {
    if (!updates?.length) return;

    for (const update of updates) {
      const pollUpdates = this.normalizePollUpdates(
        update.update?.pollUpdates as proto.IPollUpdate[] | undefined,
      );
      if (!pollUpdates.length) continue;

      const pollUpdate = pollUpdates[0] as PollUpdateWithCreationKey | undefined;
      const creationKey = pollUpdate?.pollCreationMessageKey ?? undefined;
      const voterKey = pollUpdate?.pollUpdateMessageKey ?? null;
      const pollMessage = this.store.get(creationKey?.id) ?? this.store.get(update.key?.id);
      if (!pollMessage) continue;

      const narrowedUpdate =
        update.update as Partial<{ messageTimestamp: number | Long | bigint | null }> | undefined;
      const voterJid = this.resolveVoterJid(voterKey, update.key);

      await this.processPollVote(
        pollMessage,
        pollUpdates,
        {
          key: update.key,
          timestampCandidates: [
            narrowedUpdate?.messageTimestamp ?? null,
            (update as Partial<{ messageTimestamp: number | Long | bigint | null }>).messageTimestamp ?? null,
            pollMessage.messageTimestamp ?? null,
          ],
          update,
        },
        {
          voterKey,
          voterJid,
        },
      );
    }
  }

  private resolveVoterJid(
    voterKey: proto.IMessageKey | null | undefined,
    fallbackKey?: WAMessage['key'],
  ): string | null {
    if (voterKey) {
      const author = getKeyAuthor(voterKey, this.sock.user?.id);
      if (author) return author;
    }

    return fallbackKey?.participant ?? fallbackKey?.remoteJid ?? null;
  }

  private async processPollVote(
    pollMessage: WAMessage,
    pollUpdates: proto.IPollUpdate[],
    metadata: PollVoteMetadata,
    voterInfo: PollVoteVoterInfo,
  ): Promise<void> {
    const pollId = pollMessage.key?.id;
    if (!pollId) return;

    const appliedUpdates = this.applyPollUpdatesToMessage(pollMessage, pollUpdates);
    if (!appliedUpdates.length) return;

    const aggregate = this.aggregateVotes(
      { message: pollMessage.message, pollUpdates: pollMessage.pollUpdates },
      this.sock.user?.id,
    );

    const messageId = metadata.key?.id ?? pollMessage.key?.id ?? undefined;
    if (!messageId) return;

    const timestampSource =
      metadata.timestampCandidates.find((candidate) => candidate != null) ?? undefined;
    const timestamp = toIsoDate(timestampSource);

    const meId = this.sock.user?.id;
    const lead = mapLeadFromMessage(
      buildSyntheticMessageForVoter(
        metadata.update,
        pollMessage,
        voterInfo.voterKey ?? null,
        voterInfo.voterJid,
        meId,
      ),
    );
    const contact = buildContactPayload(lead);

    const { hashMap: optionHashMap, textToHash } = buildOptionHashMaps(pollMessage);

    const selectedOptionHashes = new Set<string>();
    for (const pollUpdateEntry of appliedUpdates) {
      const selected = pollUpdateEntry?.vote?.selectedOptions;
      if (!selected) continue;
      for (const optionHash of selected) {
        if (!optionHash) continue;
        const normalized = normalizeOptionHash(optionHash);
        if (normalized) selectedOptionHashes.add(normalized);
      }
    }

    const voterJid = voterInfo.voterJid;
    const selectedOptionsByVoter =
      voterJid
        ? aggregate
            .filter((opt) => Array.isArray(opt.voters) && opt.voters.includes(voterJid))
            .map((opt) => {
              const normalizedName = normalizeOptionText(
                typeof opt.name === 'string' ? opt.name : null,
              );
              if (normalizedName) {
                const optionHash = textToHash.get(normalizedName) ?? computeOptionHash(normalizedName);
                const mapped = optionHashMap.get(optionHash);
                if (mapped) return mapped;
                return { id: normalizedName, text: normalizedName };
              }
              const name = typeof opt.name === 'string' ? opt.name : null;
              return { id: name, text: name };
            })
        : [];

    const selectedOptionsMap = new Map<string, { id: string | null; text: string | null }>();
    const registerSelectedOption = (
      option: { id: string | null; text: string | null } | undefined,
      hash?: string | null,
    ) => {
      if (!option) return;
      const fallbackKey = option.id ?? option.text ?? `index:${selectedOptionsMap.size}`;
      const key = hash ?? fallbackKey;
      if (!selectedOptionsMap.has(key)) {
        selectedOptionsMap.set(key, option);
      }
    };

    for (const option of selectedOptionsByVoter) {
      const hashKey =
        option.text && textToHash.has(option.text)
          ? textToHash.get(option.text) ?? null
          : option.text
            ? computeOptionHash(option.text)
            : null;
      registerSelectedOption(option, hashKey);
    }

    for (const hash of selectedOptionHashes) {
      const option = optionHashMap.get(hash) ?? { id: null, text: null };
      registerSelectedOption(option, hash);
    }
    const selectedOptions = Array.from(selectedOptionsMap.values());

    const uniqueVoters = new Set<string>();
    const optionTotals = aggregate.map((opt) => {
      const votes = Array.isArray(opt.voters) ? opt.voters.length : 0;
      if (Array.isArray(opt.voters)) {
        for (const voter of opt.voters) {
          if (typeof voter === 'string' && voter) uniqueVoters.add(voter);
        }
      }
      return {
        id: opt.name || null,
        text: opt.name || null,
        votes,
      };
    });

    const totalVotes = optionTotals.reduce((sum, option) => sum + option.votes, 0);
    const totalVoters = uniqueVoters.size;

    const payload: PollChoiceEventPayload = {
      pollId,
      question: extractPollQuestion(pollMessage),
      chatId: pollMessage.key?.remoteJid ?? null,
      messageId,
      timestamp,
      voterJid,
      selectedOptions,
      optionsAggregates: optionTotals,
      aggregates: {
        totalVoters,
        totalVotes,
        optionTotals,
      },
      contact,
    };

    let queued: BrokerEvent | null = null;
    if (this.eventStore) {
      queued = this.eventStore.enqueue({
        instanceId: this.instanceId,
        direction: 'inbound',
        type: 'POLL_CHOICE',
        payload: { ...payload },
        delivery: {
          state: 'pending',
          attempts: 0,
          lastAttemptAt: null,
        },
      });
    }

    await this.webhook.emit('POLL_CHOICE', payload, {
      eventId: queued?.id,
    });
    await this.maybeSendFeedback(voterJid, payload);
  }

  private async maybeSendFeedback(
    voterJid: string | null | undefined,
    payload: PollChoiceEventPayload,
  ) {
    if (!this.feedbackTemplate || !voterJid || !payload.selectedOptions.length) return;

    if (this.sock.user?.id && this.sock.user.id === voterJid) return;

    const optionText = payload.selectedOptions
      .map((opt) => opt.text || opt.id || '')
      .filter((value) => value)
      .join(', ');

    const text = this.feedbackTemplate
      .replace('{question}', payload.question)
      .replace('{option}', optionText);

    try {
      if (this.messageService) {
        await this.messageService.sendText(voterJid, text, {
          timeoutMs: getSendTimeoutMs(),
        });
      } else {
        await this.sock.sendMessage(voterJid, { text });
      }
    } catch (err) {
      this.logger.warn({ err, voterJid, pollId: payload.pollId }, 'poll.feedback.send.failed');
    }
  }

  private applyPollUpdatesToMessage(
    pollMessage: WAMessage,
    pollUpdates: proto.IPollUpdate[],
  ): proto.IPollUpdate[] {
    const applied: proto.IPollUpdate[] = [];

    for (const update of pollUpdates) {
      if (!update?.vote?.selectedOptions?.length) continue;
      updateMessageWithPollUpdate(pollMessage as Pick<WAMessage, 'pollUpdates'>, update);
      applied.push(update);
    }

    return applied;
  }

  private buildPollUpdatesFromUpsert(
    pollMessage: WAMessage,
    pollUpdateMessage: proto.Message.IPollUpdateMessage,
    message: WAMessage,
    voterJid: string | null,
  ): proto.IPollUpdate[] {
    const nestedUpdates = (pollUpdateMessage as { pollUpdates?: proto.IPollUpdate[] | null }).pollUpdates;
    if (Array.isArray(nestedUpdates) && nestedUpdates.length) {
      return this.normalizePollUpdates(nestedUpdates);
    }

    const selectedOptions = isPollVoteMessage(pollUpdateMessage.vote)
      ? pollUpdateMessage.vote.selectedOptions
      : null;
    if (Array.isArray(selectedOptions) && selectedOptions.length) {
      return this.normalizePollUpdates([pollUpdateMessage as proto.IPollUpdate]);
    }

    const decrypted = this.decryptPollUpdate(pollMessage, pollUpdateMessage, message, voterJid);
    if (!decrypted) return [];

    return this.normalizePollUpdates([decrypted]);
  }

  private normalizePollUpdates(pollUpdates: proto.IPollUpdate[] | null | undefined): proto.IPollUpdate[] {
    if (!Array.isArray(pollUpdates)) return [];

    return pollUpdates.filter((update) => update?.vote?.selectedOptions?.length);
  }

  private decryptPollUpdate(
    pollMessage: WAMessage,
    pollUpdateMessage: proto.Message.IPollUpdateMessage,
    message: WAMessage,
    voterJid: string | null,
  ): proto.IPollUpdate | null {
    const encVote = pollUpdateMessage.vote;
    if (!encVote?.encPayload || !encVote.encIv) return null;

    const creationKey = pollUpdateMessage.pollCreationMessageKey ?? message.key ?? pollMessage.key;
    const pollMsgId = creationKey?.id ?? pollMessage.key?.id;
    if (!pollMsgId) return null;

    const pollEncKey = this.extractPollEncKey(pollMessage);
    if (!pollEncKey) {
      this.logger.warn({ pollId: pollMsgId }, 'poll.vote.decrypt.missingKey');
      return null;
    }

    const pollCreatorJid = this.resolvePollCreatorJid(creationKey, pollMessage);
    const resolvedVoterJid = voterJid ?? this.resolveVoterJid(pollUpdateMessage.pollUpdateMessageKey ?? null, message.key);

    if (!pollCreatorJid || !resolvedVoterJid) {
      this.logger.warn({ pollId: pollMsgId }, 'poll.vote.decrypt.missingParticipants');
      return null;
    }

    try {
      const vote = this.decryptPollVote(encVote, {
        pollCreatorJid,
        pollMsgId,
        pollEncKey,
        voterJid: resolvedVoterJid,
      });

      return {
        pollUpdateMessageKey: pollUpdateMessage.pollUpdateMessageKey ?? message.key ?? undefined,
        vote,
        senderTimestampMs: pollUpdateMessage.senderTimestampMs ?? undefined,
        serverTimestampMs: pollUpdateMessage.metadata?.serverTimestampMs ?? undefined,
      } as proto.IPollUpdate;
    } catch (err) {
      this.logger.warn({ err, pollId: pollMsgId }, 'poll.vote.decrypt.failed');
      return null;
    }
  }

  private extractPollEncKey(pollMessage: WAMessage): Uint8Array | null {
    const pollCreations = [
      pollMessage.message?.pollCreationMessage,
      (pollMessage.message as { pollCreationMessageV2?: proto.Message.IPollCreationMessage | null })
        ?.pollCreationMessageV2 ?? undefined,
      (pollMessage.message as { pollCreationMessageV3?: proto.Message.IPollCreationMessage | null })
        ?.pollCreationMessageV3 ?? undefined,
    ];

    for (const creation of pollCreations) {
      const encKey = this.toUint8Array((creation as { encKey?: Uint8Array | null })?.encKey);
      if (encKey) return encKey;

      const secret = this.toUint8Array(creation?.contextInfo?.messageSecret);
      if (secret) return secret;
    }

    const messageContextSecret = this.toUint8Array(
      (pollMessage as { messageContextInfo?: { messageSecret?: Uint8Array | null } | null | undefined })
        ?.messageContextInfo?.messageSecret,
    );
    if (messageContextSecret) return messageContextSecret;

    return null;
  }

  private toUint8Array(value: Uint8Array | Buffer | null | undefined): Uint8Array | null {
    if (!value) return null;
    if (value instanceof Uint8Array) return value;
    if (Buffer.isBuffer(value)) return new Uint8Array(value);
    return null;
  }

  private resolvePollCreatorJid(
    creationKey: proto.IMessageKey | null | undefined,
    pollMessage: WAMessage,
  ): string | null {
    if (creationKey) {
      const author = getKeyAuthor(creationKey, this.sock.user?.id);
      if (author) return author;
    }

    return pollMessage.key?.participant ?? pollMessage.key?.remoteJid ?? null;
  }
}
