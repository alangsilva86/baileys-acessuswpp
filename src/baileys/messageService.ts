import type { BaileysEventMap, WAMessage, WASocket } from '@whiskeysockets/baileys';
import type Long from 'long';
import pino from 'pino';
import { mapLeadFromMessage } from '../services/leadMapper.js';
import { WebhookClient } from '../services/webhook.js';

export interface SendTextOptions {
  timeoutMs?: number;
  messageOptions?: Parameters<WASocket['sendMessage']>[2];
}

const DEFAULT_SEND_TIMEOUT_MS = Number(process.env.SEND_TIMEOUT_MS ?? 25_000);

function extractMessageType(message: WAMessage): string | null {
  const keys = Object.keys(message.message || {});
  return keys.length ? keys[0] : null;
}

function extractMessageText(message: WAMessage): string | null {
  const content = message.message;
  if (!content) return null;
  if ('conversation' in content && content.conversation) return content.conversation;
  if (content.extendedTextMessage?.text) return content.extendedTextMessage.text;
  if (content.pollCreationMessage?.name) return content.pollCreationMessage.name;
  if (content.pollCreationMessageV2?.name) return content.pollCreationMessageV2.name;
  if (content.pollCreationMessageV3?.name) return content.pollCreationMessageV3.name;
  return null;
}

function toIsoDate(timestamp?: number | Long | bigint | null): string {
  if (timestamp == null) return new Date().toISOString();

  let millis: number | null = null;

  if (typeof timestamp === 'number') {
    if (Number.isFinite(timestamp)) {
      millis = timestamp > 1e12 ? timestamp : timestamp * 1000;
    }
  } else if (typeof timestamp === 'bigint') {
    const asNumber = Number(timestamp);
    if (Number.isFinite(asNumber)) {
      millis = asNumber > 1e12 ? asNumber : asNumber * 1000;
    }
  } else if (typeof timestamp === 'object' && timestamp !== null) {
    const longValue = timestamp as Long;
    if (typeof longValue.toNumber === 'function') {
      const candidate = longValue.toNumber();
      if (Number.isFinite(candidate)) {
        millis = candidate > 1e12 ? candidate : candidate * 1000;
      }
    }
  }

  if (millis == null) return new Date().toISOString();
  return new Date(millis).toISOString();
}

export class MessageService {
  constructor(
    private readonly sock: WASocket,
    private readonly webhook: WebhookClient,
    private readonly logger: pino.Logger,
  ) {}

  async sendText(jid: string, text: string, options: SendTextOptions = {}): Promise<WAMessage> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
    const payload = { text } as const;

    const sendPromise = this.sock.sendMessage(jid, payload, options.messageOptions);

    let timeoutHandle: NodeJS.Timeout | undefined;
    const message = await (timeoutMs
      ? (Promise.race([
          sendPromise,
          new Promise<WAMessage>((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error('send timeout')), timeoutMs);
          }),
        ]) as Promise<WAMessage>)
      : sendPromise);

    if (timeoutHandle) clearTimeout(timeoutHandle);

    const lead = mapLeadFromMessage(message);

    await this.webhook.emit('MESSAGE_OUTBOUND', {
      messageId: message.key?.id,
      chatId: message.key?.remoteJid,
      text,
      type: extractMessageType(message),
      lead,
      timestamp: toIsoDate(message.messageTimestamp),
    });

    return message;
  }

  async onMessagesUpsert(event: BaileysEventMap['messages.upsert']): Promise<void> {
    if (!event.messages?.length) return;

    const inbound = event.messages.filter((message) => !message.key?.fromMe);
    if (inbound.length) {
      await this.onInbound(inbound);
    }
  }

  async onInbound(messages: WAMessage[]): Promise<void> {
    for (const message of messages) {
      try {
        const lead = mapLeadFromMessage(message);
        await this.webhook.emit('MESSAGE_INBOUND', {
          messageId: message.key?.id,
          chatId: message.key?.remoteJid,
          text: extractMessageText(message),
          type: extractMessageType(message),
          lead,
          timestamp: toIsoDate(message.messageTimestamp),
        });
      } catch (err) {
        this.logger.warn({ err }, 'message.inbound.emit.failed');
      }
    }
  }
}
