import type {
  BaileysEventMap,
  proto,
  WAMessage,
  WAMessageUpdate,
  WASocket,
} from '@whiskeysockets/baileys';
import type Long from 'long';
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
import {
  addObservedPollMetadata,
  buildOptionHashMaps,
  computeOptionHash,
  getPollMetadata,
  normalizeOptionHash,
  normalizeOptionText,
  normalizePollOption,
  recordVoteSelection,
  rememberPollMetadataFromMessage,
} from './pollMetadata.js';

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

function normalizeJid(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const [base] = value.split(':');
  return base || null;
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
    rememberPollMetadataFromMessage(message, { question, options: values });
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
        rememberPollMetadataFromMessage(message);
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

    let pollMetadata = getPollMetadata(pollId);
    if (!pollMetadata) {
      rememberPollMetadataFromMessage(pollMessage);
      pollMetadata = getPollMetadata(pollId);
    }

    const { hashMap: optionHashMap, textToHash } = buildOptionHashMaps(pollMessage);

    if (pollMetadata?.options.length) {
      for (const option of pollMetadata.options) {
        const normalized = normalizePollOption(option);
        if (!normalized) continue;
        if (!optionHashMap.has(normalized.hash)) {
          optionHashMap.set(normalized.hash, { id: normalized.id, text: normalized.text });
        } else {
          const existing = optionHashMap.get(normalized.hash);
          if (existing) {
            existing.id = existing.id ?? normalized.id;
            existing.text = existing.text ?? normalized.text;
          }
        }
        if (!textToHash.has(normalized.text)) {
          textToHash.set(normalized.text, normalized.hash);
        }
      }
    }

    const selectedOptionsMap = new Map<string, { id: string | null; text: string | null }>();
    const observedOptions: Array<{ id: string | null; text: string | null; hash?: string | null }> = [];
    const registerSelectedOption = (
      option: { id: string | null; text: string | null } | undefined,
      hash?: string | null,
    ) => {
      if (!option) return;
      const fallbackKey = option.id ?? option.text ?? `index:${selectedOptionsMap.size}`;
      const key = hash ?? fallbackKey;
      if (!selectedOptionsMap.has(key)) {
        selectedOptionsMap.set(key, option);
        observedOptions.push({ ...option, hash: hash ?? null });
      }
    };

    const selectedOptionHashes = new Set<string>();
    for (const pollUpdateEntry of appliedUpdates) {
      const selected = pollUpdateEntry?.vote?.selectedOptions;
      if (!selected) continue;
      for (const optionHash of selected) {
        if (!optionHash) continue;
        const normalized = normalizeOptionHash(optionHash);
        if (normalized) selectedOptionHashes.add(normalized);
      }

      const optionIdCandidate = (pollUpdateEntry.vote as { pollOptionId?: unknown })?.pollOptionId;
      const normalizedId = normalizeOptionText(
        typeof optionIdCandidate === 'string' ? optionIdCandidate : null,
      );
      if (normalizedId) {
        const hashKey = textToHash.get(normalizedId) ?? computeOptionHash(normalizedId);
        registerSelectedOption(
          optionHashMap.get(hashKey) ?? { id: normalizedId, text: normalizedId },
          hashKey,
        );
      }
    }

    const voterJid = normalizeJid(voterInfo.voterJid);
    const selectedOptionsByVoter =
      voterJid
        ? aggregate
            .filter(
              (opt) =>
                Array.isArray(opt.voters) &&
                opt.voters.some((candidate) => normalizeJid(candidate) === voterJid),
            )
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
      let option = optionHashMap.get(hash) ?? null;

      if (!option || (!option.id && !option.text)) {
        const aggregateMatch = aggregate.find((candidate) => {
          const candidateName = normalizeOptionText(
            typeof candidate.name === 'string' ? candidate.name : null,
          );
          if (!candidateName) return false;
          const candidateHash = textToHash.get(candidateName) ?? computeOptionHash(candidateName);
          return candidateHash === hash;
        });

        if (aggregateMatch) {
          const aggregateName = normalizeOptionText(
            typeof aggregateMatch.name === 'string' ? aggregateMatch.name : null,
          );
          if (aggregateName) {
            option = { id: aggregateName, text: aggregateName };
          }
        }
      }

      if (!option) {
        const fallbackText = hash ? `hash:${hash}` : 'unknown-option';
        option = { id: fallbackText, text: fallbackText };
      }

      registerSelectedOption(option, hash);
    }

    if (selectedOptionHashes.size) {
      for (const aggregateOption of aggregate) {
        const aggregateName = normalizeOptionText(
          typeof aggregateOption.name === 'string' ? aggregateOption.name : null,
        );
        if (!aggregateName) continue;
        const hashKey = textToHash.get(aggregateName) ?? computeOptionHash(aggregateName);
        if (!selectedOptionHashes.has(hashKey)) continue;

        const existing = selectedOptionsMap.get(hashKey);
        if (existing?.text) continue;

        const mapped = optionHashMap.get(hashKey) ?? { id: aggregateName, text: aggregateName };
        selectedOptionsMap.set(hashKey, mapped);
      }
    }

    const selectedOptions = Array.from(selectedOptionsMap.values());

    const question = extractPollQuestion(pollMessage) || pollMetadata?.question || '';

    if (observedOptions.length || question) {
      addObservedPollMetadata(pollId, question, observedOptions);
      pollMetadata = getPollMetadata(pollId) ?? pollMetadata;
    }

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
      question,
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

    if (selectedOptions.length) {
      recordVoteSelection(messageId, {
        pollId,
        question,
        selectedOptions,
      });
    } else {
      recordVoteSelection(messageId, null);
    }
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

    const pollCreatorJid = normalizeJid(this.resolvePollCreatorJid(creationKey, pollMessage));
    const resolvedVoterJid = normalizeJid(
      voterJid ?? this.resolveVoterJid(pollUpdateMessage.pollUpdateMessageKey ?? null, message.key),
    );

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
      const encKey = this.toUint8Array(
        (creation as { encKey?: Uint8Array | string | null })?.encKey,
      );
      if (encKey) return encKey;

      const secret = this.toUint8Array(
        (
          creation?.contextInfo as
            | { messageSecret?: Uint8Array | string | null }
            | null
            | undefined
        )?.messageSecret,
      );
      if (secret) return secret;
    }

    const messageContextSecret = this.toUint8Array(
      (pollMessage as {
        messageContextInfo?:
          | { messageSecret?: Uint8Array | string | null }
          | null
          | undefined;
      })
        ?.messageContextInfo?.messageSecret,
    );
    if (messageContextSecret) return messageContextSecret;

    return null;
  }

  private toUint8Array(
    value: Uint8Array | Buffer | string | null | undefined,
  ): Uint8Array | null {
    if (!value) return null;
    if (value instanceof Uint8Array) return value;
    if (Buffer.isBuffer(value)) return new Uint8Array(value);
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;

      try {
        const base64 = Buffer.from(trimmed, 'base64');
        if (base64.length > 0) return new Uint8Array(base64);
      } catch {
        // ignore invalid base64
      }

      if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
        try {
          const hex = Buffer.from(trimmed, 'hex');
          if (hex.length > 0) return new Uint8Array(hex);
        } catch {
          // ignore invalid hex
        }
      }
    }
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
