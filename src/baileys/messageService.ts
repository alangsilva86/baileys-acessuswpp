import type {
  AnyMessageContent,
  BaileysEventMap,
  WAMessage,
  WASocket,
} from '@whiskeysockets/baileys';
import type Long from 'long';
import pino from 'pino';
import { mapLeadFromMessage } from '../services/leadMapper.js';
import type { LeadInfo } from '../services/leadMapper.js';
import { WebhookClient } from '../services/webhook.js';
import { getSendTimeoutMs } from '../utils.js';
import {
  extractMessageText,
  extractMessageType,
  filterClientMessages,
} from './messageUtils.js';
import type {
  BrokerEventDirection,
  BrokerEventPayload,
  BrokerEventStore,
} from '../broker/eventStore.js';

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

export const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

export type MediaMessageType = 'image' | 'video' | 'audio' | 'document';

export interface MediaPayload {
  url?: string | null;
  base64?: string | null;
  mimetype?: string | null;
  fileName?: string | null;
  ptt?: boolean | null;
  gifPlayback?: boolean | null;
}

export interface SendMediaOptions extends SendTextOptions {
  caption?: string | null;
  mimetype?: string | null;
  fileName?: string | null;
  ptt?: boolean | null;
  gifPlayback?: boolean | null;
}

export interface BuiltMediaContent {
  content: AnyMessageContent;
  mimetype: string | null;
  fileName: string | null;
  size: number | null;
  source: 'base64' | 'url';
}

interface ContactPayload {
  owner: LeadInfo['owner'];
  remoteJid: string | null;
  participant: string | null;
  phone: string | null;
  displayName: string | null;
  isGroup: boolean;
}

type StructuredMessagePayload = {
  id: string | null;
  messageId: string | null;
  chatId: string | null;
  type: string | null;
  conversation: string | null;
} & Record<string, unknown>;

type EventMetadata = {
  timestamp: string;
  broker: {
    direction: BrokerEventDirection;
    type: string;
  };
} & Record<string, unknown>;

interface StructuredMessageEventPayload extends BrokerEventPayload {
  instanceId: string;
  contact: ContactPayload;
  message: StructuredMessagePayload;
  metadata: EventMetadata;
}

const DEFAULT_DOCUMENT_MIMETYPE = 'application/octet-stream';

function createError(code: string, message?: string): Error {
  const err = new Error(message ?? code);
  (err as Error & { code?: string }).code = code;
  return err;
}

function sanitizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function extractBase64(value: string): { buffer: Buffer; mimetype: string | null } {
  const trimmed = value.trim();
  const match = trimmed.match(/^data:(?<mime>[^;]+);base64,(?<data>.+)$/);
  const base64Data = match?.groups?.data ?? trimmed;
  const mime = match?.groups?.mime ?? null;

  try {
    const buffer = Buffer.from(base64Data, 'base64');
    if (!buffer.length) {
      throw createError('media_base64_invalid', 'base64 payload is empty');
    }
    return { buffer, mimetype: mime };
  } catch (err) {
    throw createError('media_base64_invalid', (err as Error).message);
  }
}

export function buildMediaMessageContent(
  type: MediaMessageType,
  media: MediaPayload,
  options: SendMediaOptions = {},
): BuiltMediaContent {
  const url = sanitizeString(media.url);
  const base64 = sanitizeString(media.base64);

  if (!url && !base64) {
    throw createError('media_source_missing', 'media.url ou media.base64 são obrigatórios');
  }

  let source: Buffer | { url: string };
  let size: number | null = null;
  let detectedMime: string | null = null;

  if (base64) {
    const { buffer, mimetype } = extractBase64(base64);
    if (buffer.length > MAX_MEDIA_BYTES) {
      throw createError('media_too_large', 'arquivo excede o tamanho máximo permitido');
    }
    source = buffer;
    size = buffer.length;
    detectedMime = mimetype;
  } else {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw createError('media_url_invalid', 'apenas URLs http(s) são aceitas');
      }
    } catch (err) {
      if ((err as Error & { code?: string }).code === 'media_url_invalid') {
        throw err;
      }
      throw createError('media_url_invalid', (err as Error).message);
    }
    source = { url };
  }

  const rawMime =
    sanitizeString(options.mimetype) || sanitizeString(media.mimetype) || (detectedMime ?? '');
  let finalMime: string | null = rawMime || null;
  const fileName = sanitizeString(options.fileName) || sanitizeString(media.fileName) || null;
  const caption = sanitizeString(options.caption);
  const ptt = Boolean(options.ptt ?? media.ptt ?? false);
  const gifPlayback = Boolean(options.gifPlayback ?? media.gifPlayback ?? false);

  let content: AnyMessageContent;

  switch (type) {
    case 'image': {
      const image: AnyMessageContent = { image: source };
      if (caption) (image as any).caption = caption;
      if (finalMime) (image as any).mimetype = finalMime;
      content = image;
      break;
    }
    case 'video': {
      const video: AnyMessageContent = { video: source };
      if (caption) (video as any).caption = caption;
      if (finalMime) (video as any).mimetype = finalMime;
      if (gifPlayback) (video as any).gifPlayback = true;
      content = video;
      break;
    }
    case 'audio': {
      const audio: AnyMessageContent = { audio: source };
      if (finalMime) (audio as any).mimetype = finalMime;
      if (ptt) (audio as any).ptt = true;
      content = audio;
      break;
    }
    case 'document': {
      const documentMime = finalMime || DEFAULT_DOCUMENT_MIMETYPE;
      const document: AnyMessageContent = { document: source, mimetype: documentMime } as AnyMessageContent;
      if (caption) (document as any).caption = caption;
      if (fileName) (document as any).fileName = fileName;
      content = document;
      finalMime = documentMime;
      break;
    }
    default:
      throw createError('media_type_unsupported', `tipo de mídia não suportado: ${type}`);
  }

  return {
    content,
    mimetype: finalMime,
    fileName,
    size,
    source: base64 ? 'base64' : 'url',
  };
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

function buildContactPayload(lead: LeadInfo): ContactPayload {
  return {
    owner: lead.owner,
    remoteJid: lead.remoteJid,
    participant: lead.participant ?? null,
    phone: lead.phone ?? null,
    displayName: lead.displayName ?? null,
    isGroup: lead.isGroup,
  };
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

  async sendMedia(
    jid: string,
    type: MediaMessageType,
    media: MediaPayload,
    options: SendMediaOptions = {},
  ): Promise<WAMessage> {
    const timeoutMs = options.timeoutMs ?? getSendTimeoutMs();
    const built = buildMediaMessageContent(type, media, options);

    const sendPromise = this.sock.sendMessage(jid, built.content, options.messageOptions);

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

    const caption = sanitizeString(options.caption);

    const eventPayload = this.createStructuredPayload(
      message,
      'outbound',
      'MESSAGE_OUTBOUND',
      {
        conversation: caption || null,
        media: {
          type,
          caption: caption || null,
          mimetype: built.mimetype,
          fileName: built.fileName,
          source: built.source,
          size: built.size,
        },
      },
    );

    if (this.eventStore) {
      this.eventStore.enqueue({
        instanceId: this.instanceId,
        direction: 'outbound',
        type: 'MESSAGE_OUTBOUND',
        payload: eventPayload,
      });
    }

    await this.webhook.emit('MESSAGE_OUTBOUND', eventPayload);

    return message;
  }

  async onMessagesUpsert(event: BaileysEventMap['messages.upsert']): Promise<void> {
    const inbound = filterClientMessages(event.messages);
    if (inbound.length) {
      await this.onInbound(inbound);
    }
  }

  async onInbound(messages: WAMessage[]): Promise<void> {
    const filtered = filterClientMessages(messages);
    for (const message of filtered) {
      try {
        const eventPayload = this.createStructuredPayload(
          message,
          'inbound',
          'MESSAGE_INBOUND',
        );

        if (this.eventStore) {
          this.eventStore.enqueue({
            instanceId: this.instanceId,
            direction: 'inbound',
            type: 'MESSAGE_INBOUND',
            payload: eventPayload,
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
    const overrides: Record<string, unknown> = {};

    if ('text' in extras) {
      overrides.conversation = typeof extras.text === 'string' ? extras.text : null;
    }

    if ('interactive' in extras) {
      overrides.interactive = extras.interactive;
    }

    const eventPayload = this.createStructuredPayload(
      message,
      'outbound',
      'MESSAGE_OUTBOUND',
      overrides,
    );

    if (this.eventStore) {
      this.eventStore.enqueue({
        instanceId: this.instanceId,
        direction: 'outbound',
        type: 'MESSAGE_OUTBOUND',
        payload: eventPayload,
      });
    }

    await this.webhook.emit('MESSAGE_OUTBOUND', eventPayload);
  }

  private createStructuredPayload(
    message: WAMessage,
    direction: BrokerEventDirection,
    eventType: string,
    messageOverrides: Record<string, unknown> = {},
  ): StructuredMessageEventPayload {
    const lead = mapLeadFromMessage(message);
    const contact = buildContactPayload(lead);
    const messageId = message.key?.id ?? null;
    const chatId = message.key?.remoteJid ?? null;
    const conversationFromMessage = extractMessageText(message);

    const baseMessage: StructuredMessagePayload = {
      id: messageId,
      messageId,
      chatId,
      type: extractMessageType(message),
      conversation: conversationFromMessage,
    };

    const structuredMessage = {
      ...baseMessage,
      ...messageOverrides,
    } as StructuredMessagePayload;

    if (structuredMessage.conversation == null) {
      structuredMessage.conversation = conversationFromMessage;
    }

    const metadata: EventMetadata = {
      timestamp: toIsoDate(message.messageTimestamp),
      broker: {
        direction,
        type: eventType,
      },
    };

    return {
      instanceId: this.instanceId,
      contact,
      message: structuredMessage,
      metadata,
    };
  }
}
