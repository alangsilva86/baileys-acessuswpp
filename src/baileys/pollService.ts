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

export class PollService {
  private readonly store: PollMessageStore;
  private readonly feedbackTemplate?: string | null;
  private readonly messageService?: MessageService;
  private readonly eventStore?: BrokerEventStore;
  private readonly instanceId: string;
  private readonly aggregateVotes: typeof getAggregateVotesInPollMessage;

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
      if (
        message.message?.pollCreationMessage ||
        message.message?.pollCreationMessageV2 ||
        message.message?.pollCreationMessageV3
      ) {
        this.store.remember(message);
      }
    }
  }

  async onMessageUpdate(updates: BaileysEventMap['messages.update']): Promise<void> {
    if (!updates?.length) return;

    for (const update of updates) {
      const pollUpdates = update.update?.pollUpdates;
      if (!pollUpdates?.length) continue;

      const pollUpdate = pollUpdates[0] as PollUpdateWithCreationKey | undefined;
      const creationKey = pollUpdate?.pollCreationMessageKey ?? undefined;
      const voterKey = pollUpdate?.pollUpdateMessageKey ?? null;
      const pollMessage = this.store.get(creationKey?.id) ?? this.store.get(update.key?.id);
      const pollId = pollMessage?.key?.id;
      if (!pollId || !pollMessage) continue;

      const aggregate = this.aggregateVotes(
        { message: pollMessage.message, pollUpdates },
        this.sock.user?.id,
      );

      const messageId = update.key?.id ?? pollMessage.key?.id ?? undefined;
      if (!messageId) continue;

      const narrowedUpdate =
        update.update as Partial<{ messageTimestamp: number | Long | bigint | null }> | undefined;
      const timestampSource =
        narrowedUpdate?.messageTimestamp ??
        (update as Partial<{ messageTimestamp: number | Long | bigint | null }>).messageTimestamp ??
        pollMessage.messageTimestamp ??
        undefined;
      const timestamp = toIsoDate(timestampSource);

      const meId = this.sock.user?.id;
      const voterJid = voterKey
        ? ((): string | null => {
            const author = getKeyAuthor(voterKey, meId);
            return author ? author : null;
          })()
        : update.key?.participant ?? update.key?.remoteJid ?? null;

      const lead = mapLeadFromMessage(
        buildSyntheticMessageForVoter(update, pollMessage, voterKey, voterJid, meId),
      );
      const contact = buildContactPayload(lead);

      const { hashMap: optionHashMap, textToHash } = buildOptionHashMaps(pollMessage);

      const selectedOptionHashes = new Set<string>();
      for (const pollUpdateEntry of pollUpdates) {
        const selected = pollUpdateEntry?.vote?.selectedOptions;
        if (!selected) continue;
        for (const optionHash of selected) {
          if (!optionHash) continue;
          const normalized = normalizeOptionHash(optionHash);
          if (normalized) selectedOptionHashes.add(normalized);
        }
      }

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
}
