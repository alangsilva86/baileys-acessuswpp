import type {
  AnyMessageContent,
  BaileysEventMap,
  WAMessage,
  WASocket,
} from '@whiskeysockets/baileys';
import type Long from 'long';
import pino from 'pino';
import { buildContactPayload, mapLeadFromMessage } from '../services/leadMapper.js';
import type { ContactPayload } from '../services/leadMapper.js';
import { WebhookClient } from '../services/webhook.js';
import { getSendTimeoutMs } from '../utils.js';
import {
  extractMessageText,
  extractMessageType,
  filterClientMessages,
  getNormalizedMessageContent,
} from './messageUtils.js';
import type {
  BrokerEvent,
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

interface InteractivePayload {
  type: string;
  [key: string]: unknown;
}

interface MediaMetadataPayload {
  mediaType: string | null;
  mimetype: string | null;
  fileName: string | null;
  size: number | null;
  caption: string | null;
  [key: string]: unknown;
}

interface StructuredMessagePayload {
  id: string | null;
  chatId: string | null;
  type: string | null;
  text: string | null;
  interactive?: InteractivePayload | null;
  media?: MediaMetadataPayload | null;
}

type StructuredMessageOverrides = Partial<Omit<StructuredMessagePayload, 'id' | 'chatId'>>;

interface EventMetadata {
  timestamp: string;
  broker: {
    direction: BrokerEventDirection;
    type: string;
  };
  source: string;
}

interface StructuredMessageEventPayload extends BrokerEventPayload {
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

function toSafeNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'bigint') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object' && value !== null && typeof (value as Long).toNumber === 'function') {
    const parsed = (value as Long).toNumber();
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeMessageType(rawType: string | null): string | null {
  if (!rawType) return null;
  switch (rawType) {
    case 'conversation':
    case 'extendedTextMessage':
      return 'text';
    case 'buttonsMessage':
      return 'buttons';
    case 'listMessage':
      return 'list';
    case 'templateButtonReplyMessage':
    case 'buttonsResponseMessage':
      return 'buttons_response';
    case 'listResponseMessage':
      return 'list_response';
    case 'interactiveResponseMessage':
      return 'interactive';
    case 'imageMessage':
    case 'videoMessage':
    case 'audioMessage':
    case 'documentMessage':
    case 'documentWithCaptionMessage':
    case 'stickerMessage':
      return 'media';
    case 'locationMessage':
    case 'liveLocationMessage':
      return 'location';
    case 'contactMessage':
    case 'contactsArrayMessage':
      return 'contact';
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      return 'poll';
    default:
      return rawType;
  }
}

function getOptionalString(source: unknown, key: string): string | null {
  if (!source || typeof source !== 'object') return null;
  const value = (source as Record<string, unknown>)[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function buildInteractivePayloadFromMessage(message: WAMessage): InteractivePayload | null {
  const content = getNormalizedMessageContent(message);
  if (!content) return null;

  const buttonsResponse = content.buttonsResponseMessage;
  if (buttonsResponse) {
    return {
      type: 'buttons_response',
      id: buttonsResponse.selectedButtonId ?? null,
      title: buttonsResponse.selectedDisplayText ?? null,
    };
  }

  const templateReply = content.templateButtonReplyMessage;
  if (templateReply) {
    return {
      type: 'buttons_response',
      id: templateReply.selectedId ?? null,
      title: templateReply.selectedDisplayText ?? null,
    };
  }

  const listResponse = content.listResponseMessage;
  if (listResponse) {
    const interactive: InteractivePayload = {
      type: 'list_response',
      id: listResponse.singleSelectReply?.selectedRowId ?? null,
    };
    const title = listResponse.title ?? listResponse.singleSelectReply?.selectedRowId ?? null;
    if (title) interactive.title = title;
    if (listResponse.description) interactive.description = listResponse.description;
    if (listResponse.singleSelectReply?.selectedRowId) {
      interactive.rowId = listResponse.singleSelectReply.selectedRowId;
    }
    return interactive;
  }

  const interactiveResponse = content.interactiveResponseMessage?.nativeFlowResponseMessage;
  if (interactiveResponse) {
    const interactive: InteractivePayload = {
      type: 'interactive_response',
    };
    const params = interactiveResponse.paramsJson;
    if (typeof params === 'string') {
      try {
        interactive.params = JSON.parse(params);
      } catch (_err) {
        interactive.params = params;
      }
    }
    if (interactiveResponse.name) {
      interactive.name = interactiveResponse.name;
    }
    const responseId = (interactiveResponse as { id?: string | null }).id;
    if (typeof responseId === 'string' && responseId.trim()) {
      interactive.id = responseId;
    }
    return interactive;
  }

  return null;
}

function buildMediaPayloadFromMessage(message: WAMessage): MediaMetadataPayload | null {
  const content = getNormalizedMessageContent(message);
  if (!content) return null;

  const image = content.imageMessage;
  if (image) {
    const media: MediaMetadataPayload = {
      mediaType: 'image',
      mimetype: image.mimetype ?? null,
      fileName: getOptionalString(image, 'fileName'),
      size: toSafeNumber(image.fileLength),
      caption: image.caption ?? null,
    };
    if (image.width) media.width = image.width;
    if (image.height) media.height = image.height;
    return media;
  }

  const video = content.videoMessage;
  if (video) {
    const media: MediaMetadataPayload = {
      mediaType: 'video',
      mimetype: video.mimetype ?? null,
      fileName: getOptionalString(video, 'fileName'),
      size: toSafeNumber(video.fileLength),
      caption: video.caption ?? null,
    };
    if (video.seconds != null) media.seconds = video.seconds;
    if (video.gifPlayback != null) media.gifPlayback = video.gifPlayback;
    return media;
  }

  const document = content.documentMessage;
  if (document) {
    return {
      mediaType: 'document',
      mimetype: document.mimetype ?? null,
      fileName: document.fileName ?? null,
      size: toSafeNumber(document.fileLength),
      caption: document.caption ?? null,
    };
  }

  const audio = content.audioMessage;
  if (audio) {
    const media: MediaMetadataPayload = {
      mediaType: 'audio',
      mimetype: audio.mimetype ?? null,
      fileName: getOptionalString(audio, 'fileName'),
      size: toSafeNumber(audio.fileLength),
      caption: null,
    };
    if (audio.seconds != null) media.seconds = audio.seconds;
    if (audio.ptt != null) media.ptt = audio.ptt;
    return media;
  }

  const sticker = content.stickerMessage;
  if (sticker) {
    return {
      mediaType: 'sticker',
      mimetype: sticker.mimetype ?? null,
      fileName: getOptionalString(sticker, 'fileName'),
      size: toSafeNumber(sticker.fileLength),
      caption: null,
    };
  }

  const location = content.liveLocationMessage ?? content.locationMessage;
  if (location) {
    const media: MediaMetadataPayload = {
      mediaType: 'location',
      mimetype: null,
      fileName: null,
      size: null,
      caption: getOptionalString(location, 'caption')
        ?? getOptionalString(location, 'name')
        ?? getOptionalString(location, 'address'),
    };
    if (location.degreesLatitude != null) media.latitude = location.degreesLatitude;
    if (location.degreesLongitude != null) media.longitude = location.degreesLongitude;
    if ('accuracyInMeters' in location && location.accuracyInMeters != null) {
      media.accuracy = location.accuracyInMeters;
    }
    return media;
  }

  return null;
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
    await this.emitOutboundMessage(message, { text, type: 'text' });
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

    const interactive: InteractivePayload = {
      type: 'buttons',
      buttons: payload.buttons.map((button) => ({ ...button })),
    };
    if (payload.footer) {
      interactive.footer = payload.footer;
    }

    await this.emitOutboundMessage(message, { text: payload.text, interactive, type: 'buttons' });
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

    const interactive: InteractivePayload = {
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

    await this.emitOutboundMessage(message, { text: payload.text, interactive, type: 'list' });
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

    await this.emitOutboundMessage(message, {
      text: caption || null,
      type: 'media',
      media: {
        mediaType: type,
        caption: caption || null,
        mimetype: built.mimetype,
        fileName: built.fileName,
        size: built.size,
      },
    });

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
        const eventPayload = this.createStructuredPayload(message, 'inbound');

        let queued: BrokerEvent | null = null;
        if (this.eventStore) {
          queued = this.eventStore.enqueue({
            instanceId: this.instanceId,
            direction: 'inbound',
            type: 'MESSAGE_INBOUND',
            payload: eventPayload,
            delivery: {
              state: 'pending',
              attempts: 0,
              lastAttemptAt: null,
            },
          });
        }

        await this.webhook.emit('MESSAGE_INBOUND', eventPayload, {
          eventId: queued?.id,
        });
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
    extras: StructuredMessageOverrides = {},
  ): Promise<void> {
    const overrides: StructuredMessageOverrides = {};

    if ('text' in extras) {
      const text = extras.text;
      overrides.text = typeof text === 'string' ? text : text == null ? null : String(text);
    }

    if ('interactive' in extras) {
      overrides.interactive = extras.interactive ?? null;
    }

    if ('media' in extras) {
      overrides.media = extras.media ?? null;
    }

    if ('type' in extras) {
      overrides.type = extras.type ?? null;
    }

    const eventPayload = this.createStructuredPayload(message, 'outbound', overrides);

    let queued: BrokerEvent | null = null;
    if (this.eventStore) {
      queued = this.eventStore.enqueue({
        instanceId: this.instanceId,
        direction: 'outbound',
        type: 'MESSAGE_OUTBOUND',
        payload: eventPayload,
        delivery: {
          state: 'pending',
          attempts: 0,
          lastAttemptAt: null,
        },
      });
    }

    await this.webhook.emit('MESSAGE_OUTBOUND', eventPayload, {
      eventId: queued?.id,
    });
  }

  private createStructuredPayload(
    message: WAMessage,
    direction: BrokerEventDirection,
    messageOverrides: StructuredMessageOverrides = {},
  ): StructuredMessageEventPayload {
    const lead = mapLeadFromMessage(message);
    const contact = buildContactPayload(lead);
    const messageId = message.key?.id ?? null;
    const chatId = message.key?.remoteJid ?? null;
    const extractedText = extractMessageText(message);

    const text =
      Object.prototype.hasOwnProperty.call(messageOverrides, 'text')
        ? messageOverrides.text ?? null
        : extractedText ?? null;

    const interactive =
      Object.prototype.hasOwnProperty.call(messageOverrides, 'interactive')
        ? messageOverrides.interactive ?? null
        : buildInteractivePayloadFromMessage(message);

    const media =
      Object.prototype.hasOwnProperty.call(messageOverrides, 'media')
        ? messageOverrides.media ?? null
        : buildMediaPayloadFromMessage(message);

    let type: string | null;
    if (Object.prototype.hasOwnProperty.call(messageOverrides, 'type')) {
      type = messageOverrides.type ?? null;
    } else {
      type = normalizeMessageType(extractMessageType(message));
    }

    if (!type) {
      if (media) {
        type = media.mediaType ?? 'media';
      } else if (interactive) {
        type = typeof interactive.type === 'string' ? interactive.type : 'interactive';
      } else if (text) {
        type = 'text';
      }
    }

    const structuredMessage: StructuredMessagePayload = {
      id: messageId,
      chatId,
      type,
      text,
    };

    if (interactive) {
      structuredMessage.interactive = interactive;
    }

    if (media) {
      structuredMessage.media = media;
    }

    const metadata: EventMetadata = {
      timestamp: toIsoDate(message.messageTimestamp),
      broker: {
        direction,
        type: 'baileys',
      },
      source: 'baileys-acessus',
    };

    return {
      contact,
      message: structuredMessage,
      metadata,
    };
  }
}
