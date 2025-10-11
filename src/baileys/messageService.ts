import type { BaileysEventMap, WAMessage, WASocket } from '@whiskeysockets/baileys';
import type Long from 'long';
import pino from 'pino';
import { mapLeadFromMessage } from '../services/leadMapper.js';
import { WebhookClient } from '../services/webhook.js';
import { getSendTimeoutMs } from '../utils.js';
import type { BrokerEventStore } from '../broker/eventStore.js';

export interface SendTextOptions {
  timeoutMs?: number;
  messageOptions?: Parameters<WASocket['sendMessage']>[2];
}

export interface TemplateButtonOption {
  id: string;
  title: string;
}

export interface SendButtonsPayload {
  text: string;
  footer?: string;
  buttons: TemplateButtonOption[];
}

export interface ListOptionPayload {
  id: string;
  title: string;
  description?: string;
}

export interface ListSectionPayload {
  title?: string;
  options: ListOptionPayload[];
}

export interface SendListPayload {
  text: string;
  buttonText: string;
  title?: string;
  footer?: string;
  sections: ListSectionPayload[];
}

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

export interface MessageServiceOptions {
  eventStore?: BrokerEventStore;
  instanceId: string;
}

export class MessageService {
  private readonly eventStore?: BrokerEventStore;
  private readonly instanceId: string;

  constructor(
    private readonly sock: WASocket,
    private readonly webhook: WebhookClient,
    private readonly logger: pino.Logger,
    options: MessageServiceOptions,
  ) {
    this.eventStore = options.eventStore;
    this.instanceId = options.instanceId;
  }

  async sendText(jid: string, text: string, options: SendTextOptions = {}): Promise<WAMessage> {
    const message = await this.sendMessageWithTimeout(jid, { text }, options);
    await this.emitOutboundMessage(message, { text });
    return message;
  }

  async sendButtons(
    jid: string,
    payload: SendButtonsPayload,
    options: SendTextOptions = {},
  ): Promise<WAMessage> {
    const templateButtons = payload.buttons.map((button, index) => ({
      index: index + 1,
      quickReplyButton: {
        id: button.id,
        displayText: button.title,
      },
    }));

    const content = {
      text: payload.text,
      footer: payload.footer,
      templateButtons,
    } as const;

    const message = await this.sendMessageWithTimeout(jid, content, options);

    const interactive: Record<string, unknown> = {
      type: 'buttons',
      buttons: payload.buttons.map((button) => ({ ...button })),
    };
    if (payload.footer) {
      interactive.footer = payload.footer;
    }

    await this.emitOutboundMessage(message, { text: payload.text, interactive });
    return message;
  }

  async sendList(
    jid: string,
    payload: SendListPayload,
    options: SendTextOptions = {},
  ): Promise<WAMessage> {
    const sections = payload.sections.map((section) => ({
      title: section.title,
      rows: section.options.map((option) => ({
        rowId: option.id,
        title: option.title,
        description: option.description,
      })),
    }));

    const content = {
      text: payload.text,
      footer: payload.footer,
      list: {
        title: payload.title,
        buttonText: payload.buttonText,
        description: payload.text,
        footer: payload.footer,
        sections,
      },
    } as const;

    const message = await this.sendMessageWithTimeout(jid, content, options);

    const interactive: Record<string, unknown> = {
      type: 'list',
      buttonText: payload.buttonText,
      sections: payload.sections.map((section) => ({
        ...(section.title ? { title: section.title } : {}),
        options: section.options.map((option) => ({
          id: option.id,
          title: option.title,
          ...(option.description ? { description: option.description } : {}),
        })),
      })),
    };

    if (payload.title) {
      interactive.title = payload.title;
    }
    if (payload.footer) {
      interactive.footer = payload.footer;
    }

    await this.emitOutboundMessage(message, { text: payload.text, interactive });
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
        const eventPayload = {
          messageId: message.key?.id,
          chatId: message.key?.remoteJid,
          text: extractMessageText(message),
          type: extractMessageType(message),
          lead,
          timestamp: toIsoDate(message.messageTimestamp),
        } as const;

        if (this.eventStore) {
          this.eventStore.enqueue({
            instanceId: this.instanceId,
            direction: 'inbound',
            type: 'MESSAGE_INBOUND',
            payload: { ...eventPayload },
          });
        }

        await this.webhook.emit('MESSAGE_INBOUND', eventPayload);
      } catch (err) {
        this.logger.warn({ err }, 'message.inbound.emit.failed');
      }
    }
  }

  private async sendMessageWithTimeout(
    jid: string,
    content: Parameters<WASocket['sendMessage']>[1],
    options: SendTextOptions,
  ): Promise<WAMessage> {
    const timeoutMs = options.timeoutMs ?? getSendTimeoutMs();
    const sendPromise = this.sock.sendMessage(jid, content, options.messageOptions);

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

    return message;
  }

  private async emitOutboundMessage(
    message: WAMessage,
    extras: Record<string, unknown> = {},
  ): Promise<void> {
    const lead = mapLeadFromMessage(message);
    const eventPayload: Record<string, unknown> = {
      messageId: message.key?.id,
      chatId: message.key?.remoteJid,
      type: extractMessageType(message),
      timestamp: toIsoDate(message.messageTimestamp),
      lead,
      ...extras,
    };

    if (!('text' in eventPayload)) {
      const extracted = extractMessageText(message);
      if (extracted) {
        eventPayload.text = extracted;
      }
    }

    if (this.eventStore) {
      this.eventStore.enqueue({
        instanceId: this.instanceId,
        direction: 'outbound',
        type: 'MESSAGE_OUTBOUND',
        payload: { ...eventPayload },
      });
    }

    await this.webhook.emit('MESSAGE_OUTBOUND', eventPayload);
  }
}
