import type {
  BaileysEventMap,
  proto,
  WAMessage,
  WAMessageUpdate,
  WASocket,
} from '@whiskeysockets/baileys';
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

const DEFAULT_SELECTABLE_COUNT = 1;

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

      const pollUpdate = pollUpdates[0] as proto.Message.IPollUpdateMessage | undefined;
      const creationKey = pollUpdate?.pollCreationMessageKey;
      const voterKey = pollUpdate?.pollUpdateMessageKey ?? null;
      const pollId = creationKey?.id;
      const pollMessage = this.store.get(pollId);
      if (!pollId || !pollMessage) continue;

      const aggregate = this.aggregateVotes(
        { message: pollMessage.message, pollUpdates },
        this.sock.user?.id,
      );

      const messageId = update.key?.id ?? pollMessage.key?.id ?? undefined;
      if (!messageId) continue;

      const timestamp = toIsoDate(update.messageTimestamp ?? pollMessage.messageTimestamp);

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

      const selectedOptions = aggregate
        .filter((opt) => (voterJid ? opt.voters.includes(voterJid) : false))
        .map((opt) => ({ id: opt.name || null, text: opt.name || null }));

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
