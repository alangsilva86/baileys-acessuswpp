import type { BaileysEventMap, WAMessage, WAMessageUpdate, WASocket, proto } from '@whiskeysockets/baileys';
import { getAggregateVotesInPollMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { mapLeadFromMessage } from '../services/lead-mapper';
import { WebhookClient } from '../services/webhook';
import { PollMessageStore } from './store';

export interface SendPollOptions {
  selectableCount?: number;
  messageOptions?: Parameters<WASocket['sendMessage']>[2];
}

export interface PollServiceOptions {
  store?: PollMessageStore;
  feedbackTemplate?: string | null;
}

interface PollChoiceEventPayload {
  pollId: string;
  question: string;
  chatId?: string | null;
  voterJid?: string | null;
  selectedOptions: string[];
  aggregate: ReturnType<typeof getAggregateVotesInPollMessage>;
  lead: ReturnType<typeof mapLeadFromMessage>;
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

function buildSyntheticMessageForVoter(update: WAMessageUpdate, pollMessage: WAMessage | undefined): WAMessage {
  return {
    key: {
      remoteJid: pollMessage?.key?.remoteJid,
      fromMe: update.key?.fromMe ?? false,
      participant: update.key?.participant ?? undefined,
    },
    pushName: (update as unknown as { pushName?: string }).pushName,
  } as WAMessage;
}

export class PollService {
  private readonly store: PollMessageStore;

  private readonly feedbackTemplate?: string | null;

  constructor(
    private readonly sock: WASocket,
    private readonly webhook: WebhookClient,
    private readonly logger: pino.Logger,
    options: PollServiceOptions = {}
  ) {
    this.store = options.store ?? new PollMessageStore();
    this.feedbackTemplate = options.feedbackTemplate ?? process.env.POLL_FEEDBACK_TEMPLATE ?? null;
  }

  async sendPoll(
    jid: string,
    question: string,
    values: string[],
    options: SendPollOptions = {}
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
    if (!event.messages?.length) {
      return;
    }

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
    if (!updates?.length) {
      return;
    }

    for (const update of updates) {
      const pollUpdates = update.update?.pollUpdates;
      if (!pollUpdates?.length) {
        continue;
      }

      const pollUpdate = pollUpdates[0] as proto.Message.IPollUpdateMessage | undefined;
      const creationKey = pollUpdate?.pollCreationMessageKey;
      const pollId = creationKey?.id;
      const pollMessage = this.store.get(pollId);
      if (!pollId || !pollMessage) {
        continue;
      }

      const aggregate = getAggregateVotesInPollMessage(
        { message: pollMessage.message, pollUpdates },
        this.sock.user?.id
      );

      const voterJid = update.key?.participant ?? update.key?.remoteJid ?? null;
      const selectedOptions = aggregate
        .filter((opt) => (voterJid ? opt.voters.includes(voterJid) : false))
        .map((opt) => opt.name);

      const lead = mapLeadFromMessage(buildSyntheticMessageForVoter(update, pollMessage));

      const payload: PollChoiceEventPayload = {
        pollId,
        question: extractPollQuestion(pollMessage),
        chatId: pollMessage.key?.remoteJid,
        voterJid,
        selectedOptions,
        aggregate,
        lead,
      };

      await this.webhook.emit('POLL_CHOICE', payload);

      await this.maybeSendFeedback(voterJid, payload);
    }
  }

  private async maybeSendFeedback(voterJid: string | null | undefined, payload: PollChoiceEventPayload) {
    if (!this.feedbackTemplate || !voterJid || !payload.selectedOptions.length) {
      return;
    }

    if (this.sock.user?.id && this.sock.user.id === voterJid) {
      return;
    }

    const text = this.feedbackTemplate
      .replace('{question}', payload.question)
      .replace('{option}', payload.selectedOptions.join(', '));

    try {
      await this.sock.sendMessage(voterJid, { text });
    } catch (err) {
      this.logger.warn(
        { err, voterJid, pollId: payload.pollId },
        'poll.feedback.send.failed'
      );
    }
  }
}

