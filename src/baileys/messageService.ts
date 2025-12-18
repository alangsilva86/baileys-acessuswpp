import type {
  AnyMessageContent,
  BaileysEventMap,
  WAMessage,
  WASocket,
} from '@whiskeysockets/baileys';
import type Long from 'long';
import axios from 'axios';
import pino from 'pino';
import sharp from 'sharp';

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
import { Buffer } from 'node:buffer';
import type {
  BrokerEvent,
  BrokerEventDirection,
  BrokerEventPayload,
  BrokerEventStore,
} from '../broker/eventStore.js';
import { toIsoDate } from './time.js';
import {
  getPollMetadataFromCache,
  getVoteSelection,
  normalizeJid,
  recordVoteSelection,
} from './pollMetadata.js';
import type { LidMappingStore } from '../lidMappingStore.js';
import { riskGuardian } from '../risk/guardian.js';

export interface SendTextOptions {
  timeoutMs?: number;
  messageOptions?: Parameters<WASocket['sendMessage']>[2];
}

export interface TemplateButtonOption { id: string; title: string; }
export interface SendButtonsPayload {
  text: string;
  footer?: string;
  buttons: TemplateButtonOption[];
}

export interface ListOptionPayload { id: string; title: string; description?: string; }
export interface ListSectionPayload { title?: string; options: ListOptionPayload[]; }
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

interface InteractivePayload { type: string; [k: string]: unknown; }
interface MediaMetadataPayload {
  mediaType: string | null;
  mimetype: string | null;
  fileName: string | null;
  size: number | null;
  caption: string | null;
  [k: string]: unknown;
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

interface PollChoiceMetadata {
  pollId: string | null;
  question: string | null;
  selectedOptions: Array<{ id: string | null; text: string | null }>;
  optionIds: string[];
}

interface EventMetadata {
  timestamp: string;
  broker: { direction: BrokerEventDirection; type: string; };
  source: string;
  pollChoice: PollChoiceMetadata | null;
}

interface StructuredMessageEventPayload extends BrokerEventPayload {
  contact: ContactPayload;
  message: StructuredMessagePayload;
  metadata: EventMetadata;
}

export interface MessageServiceOptions {
  eventStore?: BrokerEventStore;
  instanceId: string;
  mappingStore?: LidMappingStore | null;
}

/* --------------------------------- helpers -------------------------------- */

const DEFAULT_DOCUMENT_MIMETYPE = 'application/octet-stream';
const HUMANIZE_SENDS = process.env.HUMANIZE_SENDS !== '0';
const HASH_BUST_IMAGES = process.env.HASH_BUST_IMAGES !== '0';
const TYPING_MS_PER_CHAR = 200;

function createError(code: string, message?: string): Error {
  const err = new Error(message ?? code);
  (err as any).code = code;
  return err;
}

function sanitizeString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function applySpintax(text: string): string {
  const regex = /\{([^{}]+?)\}/g;
  return text.replace(regex, (_, group) => {
    const variants = String(group)
      .split('|')
      .map((v: string) => v.trim())
      .filter(Boolean);
    if (!variants.length) return group;
    const pick = variants[Math.floor(Math.random() * variants.length)];
    return pick;
  });
}

async function humanDelay(minMs: number, maxMs: number): Promise<void> {
  const min = Math.max(0, Math.floor(minMs));
  const max = Math.max(min, Math.floor(maxMs));
  const jitter = Math.floor(Math.random() * (max - min + 1) + min);
  await new Promise((resolve) => setTimeout(resolve, jitter));
}

function estimatePresenceProfile(content: Parameters<WASocket['sendMessage']>[1]): {
  type: 'composing' | 'recording';
  min: number;
  max: number;
} {
  let textLength = 24;
  if (typeof (content as any)?.text === 'string') {
    textLength = (content as any).text.length || 1;
  } else if (typeof (content as any)?.caption === 'string') {
    textLength = (content as any).caption.length || 1;
  }
  const base = textLength * TYPING_MS_PER_CHAR;
  const extra = 1000 + Math.random() * 2000; // 1-3s extra reação
  const duration = Math.min(20_000, base + extra);
  return {
    type: (content as any)?.audio ? 'recording' : 'composing',
    min: duration * 0.8,
    max: duration * 1.2,
  };
}

async function hashBusterImage(buffer: Buffer): Promise<Buffer> {
  try {
    const brightness = 1 + Math.random() * 0.01;
    const saturation = 1 + Math.random() * 0.01;
    return await sharp(buffer)
      .modulate({ brightness, saturation })
      .withMetadata({
        exif: {
          IFD0: {
            Copyright: `aegis-${Date.now()}-${Math.random()}`,
          },
        },
      })
      .toBuffer();
  } catch {
    return buffer;
  }
}

function extractBase64(value: string): { buffer: Buffer; mimetype: string | null } {
  const trimmed = value.trim();
  const match = trimmed.match(/^data:(?<mime>[^;]+);base64,(?<data>.+)$/);
  const base64Data = match?.groups?.data ?? trimmed;
  const mime = match?.groups?.mime ?? null;

  try {
    const buffer = Buffer.from(base64Data, 'base64');
    if (!buffer.length) throw createError('media_base64_invalid', 'base64 payload is empty');
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

  if (!url && !base64) throw createError('media_source_missing', 'media.url ou media.base64 são obrigatórios');

  let source: Buffer | { url: string };
  let size: number | null = null;
  let detectedMime: string | null = null;

  if (base64) {
    const { buffer, mimetype } = extractBase64(base64);
    if (buffer.length > MAX_MEDIA_BYTES) throw createError('media_too_large', 'arquivo excede o tamanho máximo permitido');
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
      if ((err as any).code === 'media_url_invalid') throw err;
      throw createError('media_url_invalid', (err as Error).message);
    }
    source = { url };
  }

  const rawMime = sanitizeString(options.mimetype) || sanitizeString(media.mimetype) || (detectedMime ?? '');
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
      content = image; break;
    }
    case 'video': {
      const video: AnyMessageContent = { video: source };
      if (caption) (video as any).caption = caption;
      if (finalMime) (video as any).mimetype = finalMime;
      if (gifPlayback) (video as any).gifPlayback = true;
      content = video; break;
    }
    case 'audio': {
      const audio: AnyMessageContent = { audio: source };
      if (finalMime) (audio as any).mimetype = finalMime;
      if (ptt) (audio as any).ptt = true;
      content = audio; break;
    }
    case 'document': {
      const documentMime = finalMime || DEFAULT_DOCUMENT_MIMETYPE;
      const document: AnyMessageContent = { document: source, mimetype: documentMime } as AnyMessageContent;
      if (caption) (document as any).caption = caption;
      if (fileName) (document as any).fileName = fileName;
      content = document; finalMime = documentMime; break;
    }
    default:
      throw createError('media_type_unsupported', `tipo de mídia não suportado: ${type}`);
  }

  return { content, mimetype: finalMime, fileName, size, source: base64 ? 'base64' : 'url' };
}

function toSafeNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') { const n = Number(value); return Number.isFinite(n) ? n : null; }
  if (typeof value === 'bigint') { const n = Number(value); return Number.isFinite(n) ? n : null; }
  if (typeof value === 'object' && value !== null && typeof (value as Long).toNumber === 'function') {
    const n = (value as Long).toNumber(); return Number.isFinite(n) ? n : null;
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
    case 'pollUpdateMessage':
    case 'pollUpdateMessageV2':
    case 'pollUpdateMessageV3':
      return 'poll_update';
    default:
      return rawType;
  }
}

function getOptionalString(src: unknown, key: string): string | null {
  if (!src || typeof src !== 'object') return null;
  const v = (src as Record<string, unknown>)[key];
  if (typeof v !== 'string') return null;
  const t = v.trim(); return t ? t : null;
}

function buildInteractivePayloadFromMessage(message: WAMessage): InteractivePayload | null {
  const content = getNormalizedMessageContent(message);
  if (!content) return null;

  const buttonsResponse = content.buttonsResponseMessage;
  if (buttonsResponse) {
    return { type: 'buttons_response', id: buttonsResponse.selectedButtonId ?? null, title: buttonsResponse.selectedDisplayText ?? null };
  }

  const templateReply = content.templateButtonReplyMessage;
  if (templateReply) {
    return { type: 'buttons_response', id: templateReply.selectedId ?? null, title: templateReply.selectedDisplayText ?? null };
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
    if (listResponse.singleSelectReply?.selectedRowId) interactive.rowId = listResponse.singleSelectReply.selectedRowId;
    return interactive;
  }

  const interactiveResponse = content.interactiveResponseMessage?.nativeFlowResponseMessage;
  if (interactiveResponse) {
    const interactive: InteractivePayload = { type: 'interactive_response' };
    const params = interactiveResponse.paramsJson;
    if (typeof params === 'string') {
      try { interactive.params = JSON.parse(params); } catch { interactive.params = params; }
    }
    if (interactiveResponse.name) interactive.name = interactiveResponse.name;
    const responseId = (interactiveResponse as { id?: string | null }).id;
    if (typeof responseId === 'string' && responseId.trim()) interactive.id = responseId;
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
      caption:
        getOptionalString(location, 'caption') ??
        getOptionalString(location, 'name') ??
        getOptionalString(location, 'address'),
    };
    if (location.degreesLatitude != null) media.latitude = location.degreesLatitude;
    if (location.degreesLongitude != null) media.longitude = location.degreesLongitude;
    if ('accuracyInMeters' in location && location.accuracyInMeters != null) media.accuracy = (location as any).accuracyInMeters;
    return media;
  }

  return null;
}

/* --------------------------------- serviço -------------------------------- */

export class MessageService {
  private readonly eventStore?: BrokerEventStore;
  private readonly instanceId: string;
  private readonly mappingStore: LidMappingStore | null;

  constructor(
    private readonly sock: WASocket,
    private readonly webhook: WebhookClient,
    private readonly logger: pino.Logger,
    options: MessageServiceOptions,
  ) {
    this.eventStore = options.eventStore;
    this.instanceId = options.instanceId;
    this.mappingStore = options.mappingStore ?? null;
  }

  async sendText(jid: string, text: string, options: SendTextOptions = {}): Promise<WAMessage> {
    const risk = riskGuardian.beforeSend(this.instanceId, jid);
    if (!risk.allowed) throw createError('risk_paused', 'envios pausados por risco elevado');
    if (risk.injectSafeJid) {
      await this.sendSafeInterleave(risk.injectSafeJid);
      riskGuardian.afterSend(this.instanceId, risk.injectSafeJid, true);
    }
    const processed = applySpintax(text);
    const message = await this.sendMessageWithTimeout(jid, { text: processed }, options);
    await this.emitOutboundMessage(message, { text: processed, type: 'text' });
    riskGuardian.afterSend(this.instanceId, jid, risk.isKnown);
    return message;
  }

  async sendButtons(jid: string, payload: SendButtonsPayload, options: SendTextOptions = {}): Promise<WAMessage> {
    const risk = riskGuardian.beforeSend(this.instanceId, jid);
    if (!risk.allowed) throw createError('risk_paused', 'envios pausados por risco elevado');
    if (risk.injectSafeJid) {
      await this.sendSafeInterleave(risk.injectSafeJid);
      riskGuardian.afterSend(this.instanceId, risk.injectSafeJid, true);
    }
    const processedText = applySpintax(payload.text);
    const processedFooter = payload.footer ? applySpintax(payload.footer) : undefined;
    const templateButtons = payload.buttons.map((button, i) => ({
      index: i + 1,
      quickReplyButton: { id: button.id, displayText: button.title },
    }));

    const content = { text: processedText, footer: processedFooter, templateButtons } as const;
    const message = await this.sendMessageWithTimeout(jid, content, options);

    const interactive: InteractivePayload = {
      type: 'buttons',
      buttons: payload.buttons.map((b) => ({ ...b })),
      ...(processedFooter ? { footer: processedFooter } : {}),
    };

    await this.emitOutboundMessage(message, { text: processedText, interactive, type: 'buttons' });
    riskGuardian.afterSend(this.instanceId, jid, risk.isKnown);
    return message;
  }

  async sendList(jid: string, payload: SendListPayload, options: SendTextOptions = {}): Promise<WAMessage> {
    const risk = riskGuardian.beforeSend(this.instanceId, jid);
    if (!risk.allowed) throw createError('risk_paused', 'envios pausados por risco elevado');
    if (risk.injectSafeJid) {
      await this.sendSafeInterleave(risk.injectSafeJid);
      riskGuardian.afterSend(this.instanceId, risk.injectSafeJid, true);
    }
    const processedText = applySpintax(payload.text);
    const processedFooter = payload.footer ? applySpintax(payload.footer) : undefined;
    const processedTitle = payload.title ? applySpintax(payload.title) : undefined;
    const processedButton = applySpintax(payload.buttonText);
    const sections = payload.sections.map((section) => ({
      title: section.title ? applySpintax(section.title) : section.title,
      rows: section.options.map((o) => ({
        rowId: o.id,
        title: applySpintax(o.title),
        description: o.description ? applySpintax(o.description) : o.description,
      })),
    }));

    const content = {
      text: processedText,
      footer: processedFooter,
      list: {
        title: processedTitle,
        buttonText: processedButton,
        description: processedText,
        footer: processedFooter,
        sections,
      },
    } as const;

    const message = await this.sendMessageWithTimeout(jid, content, options);

    const interactive: InteractivePayload = {
      type: 'list',
      buttonText: processedButton,
      ...(processedTitle ? { title: processedTitle } : {}),
      ...(processedFooter ? { footer: processedFooter } : {}),
      sections: payload.sections.map((s) => ({
        ...(s.title ? { title: s.title } : {}),
        options: s.options.map((o) => ({
          id: o.id,
          title: applySpintax(o.title),
          ...(o.description ? { description: applySpintax(o.description) } : {}),
        })),
      })),
    };

    await this.emitOutboundMessage(message, { text: processedText, interactive, type: 'list' });
    riskGuardian.afterSend(this.instanceId, jid, risk.isKnown);
    return message;
  }

  async sendMedia(jid: string, type: MediaMessageType, media: MediaPayload, options: SendMediaOptions = {}): Promise<WAMessage> {
    const risk = riskGuardian.beforeSend(this.instanceId, jid);
    if (!risk.allowed) throw createError('risk_paused', 'envios pausados por risco elevado');
    if (risk.injectSafeJid) {
      await this.sendSafeInterleave(risk.injectSafeJid);
      riskGuardian.afterSend(this.instanceId, risk.injectSafeJid, true);
    }
    const timeoutMs = options.timeoutMs ?? getSendTimeoutMs();
    const caption = sanitizeString(options.caption);
    const processedCaption = caption ? applySpintax(caption) : caption;
    const builtBase = buildMediaMessageContent(type, media, { ...options, caption: processedCaption });
    const built = await this.hashBustIfNeeded(type, builtBase);
    const sendPromise = this.sendWithHumanization(jid, built.content, options.messageOptions);

    let timeoutHandle: NodeJS.Timeout | undefined;
    const message = await (timeoutMs
      ? (Promise.race([
          sendPromise,
          new Promise<WAMessage>((_, reject) => { timeoutHandle = setTimeout(() => reject(new Error('send timeout')), timeoutMs); }),
        ]) as Promise<WAMessage>)
      : sendPromise);

    if (timeoutHandle) clearTimeout(timeoutHandle);

    await this.emitOutboundMessage(message, {
      text: processedCaption || null,
      type: 'media',
      media: { mediaType: type, caption: processedCaption || null, mimetype: built.mimetype, fileName: built.fileName, size: built.size },
    });
    riskGuardian.afterSend(this.instanceId, jid, risk.isKnown);

    return message;
  }

  async onMessagesUpsert(event: BaileysEventMap['messages.upsert']): Promise<void> {
    const inbound = filterClientMessages(event.messages);
    if (inbound.length) await this.onInbound(inbound);
  }

  async onInbound(messages: WAMessage[]): Promise<void> {
    const filtered = filterClientMessages(messages);
    for (const message of filtered) {
      try {
        riskGuardian.registerInbound(this.instanceId, message.key?.remoteJid ?? null);
      } catch (err) {
        this.logger.warn({ err }, 'risk.guardian.register_inbound.failed');
      }
      try {
        const eventPayload = this.createStructuredPayload(message, 'inbound');
        let queued: BrokerEvent | null = null;

        if (this.eventStore) {
          queued = this.eventStore.enqueue({
            instanceId: this.instanceId,
            direction: 'inbound',
            type: 'MESSAGE_INBOUND',
            payload: eventPayload,
            delivery: { state: 'pending', attempts: 0, lastAttemptAt: null },
          });
        }

        await this.webhook.emit('MESSAGE_INBOUND', eventPayload, { eventId: queued?.id });
      } catch (err) {
        this.logger.warn({ err }, 'message.inbound.emit.failed');
      }
    }
  }

  /* -------------------------------- internos -------------------------------- */

  private async sendMessageWithTimeout(
    jid: string,
    content: Parameters<WASocket['sendMessage']>[1],
    options: SendTextOptions,
  ): Promise<WAMessage> {
    const timeoutMs = options.timeoutMs ?? getSendTimeoutMs();
    const sendPromise = this.sendWithHumanization(jid, content, options.messageOptions);

    let timeoutHandle: NodeJS.Timeout | undefined;
    const message = await (timeoutMs
      ? (Promise.race([
          sendPromise,
          new Promise<WAMessage>((_, reject) => { timeoutHandle = setTimeout(() => reject(new Error('send timeout')), timeoutMs); }),
        ]) as Promise<WAMessage>)
      : sendPromise);

    if (timeoutHandle) clearTimeout(timeoutHandle);
    return message;
  }

  private async emitOutboundMessage(message: WAMessage, extras: StructuredMessageOverrides = {}): Promise<void> {
    const overrides: StructuredMessageOverrides = {};
    if ('text' in extras) {
      const text = extras.text;
      overrides.text = typeof text === 'string' ? text : text == null ? null : String(text);
    }
    if ('interactive' in extras) overrides.interactive = extras.interactive ?? null;
    if ('media' in extras) overrides.media = extras.media ?? null;
    if ('type' in extras) overrides.type = extras.type ?? null;

    const eventPayload = this.createStructuredPayload(message, 'outbound', overrides);

    let queued: BrokerEvent | null = null;
    if (this.eventStore) {
      queued = this.eventStore.enqueue({
        instanceId: this.instanceId,
        direction: 'outbound',
        type: 'MESSAGE_OUTBOUND',
        payload: eventPayload,
        delivery: { state: 'pending', attempts: 0, lastAttemptAt: null },
      });
    }

    await this.webhook.emit('MESSAGE_OUTBOUND', eventPayload, { eventId: queued?.id });
  }

  private async sendSafeInterleave(jid: string): Promise<void> {
    const pingText = applySpintax('{Oi|Olá|E aí}, conferindo conexão.');
    try {
      await this.sendWithHumanization(jid, { text: pingText });
    } catch (err) {
      this.logger.warn({ jid, err }, 'risk.safe_contact.send.failed');
    }
  }

  private async sendWithHumanization(
    jid: string,
    content: Parameters<WASocket['sendMessage']>[1],
    messageOptions?: Parameters<WASocket['sendMessage']>[2],
  ): Promise<WAMessage> {
    if (!HUMANIZE_SENDS) {
      return this.sock.sendMessage(jid, content, messageOptions);
    }

    try {
      await this.sock.sendPresenceUpdate('available', jid);
    } catch {}

    await humanDelay(800, 2000);
    const profile = estimatePresenceProfile(content);
    try {
      await this.sock.sendPresenceUpdate(profile.type, jid);
    } catch {}
    await humanDelay(profile.min, profile.max);
    try {
      await this.sock.sendPresenceUpdate('paused', jid);
    } catch {}
    await humanDelay(600, 1400);

    const result = await this.sock.sendMessage(jid, content, messageOptions);
    setTimeout(() => {
      try {
        void this.sock?.sendPresenceUpdate?.('unavailable', jid);
      } catch {
        // ignore presence cleanup errors
      }
    }, 8000);
    return result;
  }

  private async hashBustIfNeeded(type: MediaMessageType, built: BuiltMediaContent): Promise<BuiltMediaContent> {
    if (!HASH_BUST_IMAGES || type !== 'image') return built;
    const clone: BuiltMediaContent = { ...built, content: { ...(built.content as any) } };
    const imagePayload = (clone.content as any).image;
    let buffer: Buffer | null = null;

    if (Buffer.isBuffer(imagePayload)) {
      buffer = imagePayload;
    } else if (imagePayload && typeof imagePayload === 'object' && typeof (imagePayload as any).url === 'string') {
      const url = (imagePayload as { url: string }).url;
      try {
        const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 10_000 });
        buffer = Buffer.from(resp.data);
      } catch (err: any) {
        this.logger.warn({ err: err?.message }, 'hashbust.image.download.failed');
      }
    }

    if (!buffer) return built;

    try {
      const busted = await hashBusterImage(buffer);
      (clone.content as any).image = busted;
      clone.size = busted.length;
      return clone;
    } catch (err: any) {
      this.logger.warn({ err: err?.message }, 'hashbust.image.failed');
      return built;
    }
  }

  private createStructuredPayload(
    message: WAMessage,
    direction: BrokerEventDirection,
    messageOverrides: StructuredMessageOverrides = {},
  ): StructuredMessageEventPayload {
    const lead = mapLeadFromMessage(message, { mappingStore: this.mappingStore });
    const contact = buildContactPayload(lead);

    const messageId = message.key?.id ?? null;
    const chatId = lead.remoteJid ?? message.key?.remoteJid ?? null;

    const extractedText = extractMessageText(message);

    // Voto decifrado pelo PollService (cache)
    const voteSelection = getVoteSelection(messageId);
    let pollChoice: PollChoiceMetadata | null = null;
    let normalizedSelectedOptions: Array<{ id: string | null; text: string | null }> = [];
    if (voteSelection) {
      normalizedSelectedOptions = (voteSelection.selectedOptions ?? []).map((opt) => ({
        id: opt?.id ?? null,
        text: opt?.text ?? null,
      }));
    }
    let voteText: string | null = null;
    if (normalizedSelectedOptions.length) {
      const parts = normalizedSelectedOptions
        .map((opt) =>
          (typeof opt.text === 'string' && opt.text.trim()) ||
          (typeof opt.id === 'string' && opt.id.trim()) ||
          '',
        )
        .filter(Boolean);
      if (parts.length) voteText = parts.join(', ');
    }
    if (voteSelection) {
      const optionIds = normalizedSelectedOptions
        .map((opt) => (typeof opt.id === 'string' ? opt.id.trim() : ''))
        .filter((id): id is string => Boolean(id));
      pollChoice = {
        pollId: typeof voteSelection.pollId === 'string' ? voteSelection.pollId : null,
        question: typeof voteSelection.question === 'string' ? voteSelection.question : null,
        selectedOptions: normalizedSelectedOptions,
        optionIds,
      };
    }
    if (!voteText) {
      const pollUpdate = message.message?.pollUpdateMessage;
      if (pollUpdate?.vote?.encPayload && pollUpdate.vote.encIv) {
        const pollId = pollUpdate.pollCreationMessageKey?.id ?? null;
        const pollRemoteRaw =
          pollUpdate.pollCreationMessageKey?.remoteJid ?? message.key?.remoteJid ?? null;
        const pollRemoteAlt =
          (pollUpdate.pollCreationMessageKey as any)?.remoteJidAlt ??
          (message.key as any)?.remoteJidAlt ??
          null;
        const normalizedRemote =
          this.mappingStore?.resolveRemoteJid(pollRemoteRaw, pollRemoteAlt) ?? normalizeJid(pollRemoteRaw);
        const metadata =
          (pollId ? getPollMetadataFromCache(pollId, normalizedRemote) : null) ?? null;

        if (!metadata) {
          this.logger.info(
            {
              messageId,
              pollId,
              pollUpdateMessageId: pollUpdate.pollUpdateMessageKey?.id ?? null,
              remoteJid: pollRemoteRaw ?? null,
              clue: 'sem metadados, estamos sem mapa do tesouro — talvez a criação não tenha sido vista',
            },
            'poll.vote.metadata.missing',
          );
        } else {
          this.logger.info(
            {
              messageId,
              pollId,
              optionsCount: metadata.options.length,
              hasEncKey: Boolean(metadata.encKeyHex),
              encKeyPreview: metadata.encKeyHex
                ? `${metadata.encKeyHex.slice(0, 8)}…${metadata.encKeyHex.slice(-8)}`
                : null,
              clue: 'metadados recuperados — hora de traduzir o voto',
            },
            'poll.vote.metadata.ready',
          );
        }
      }

      if (!voteText) {
        this.logger.warn(
          {
            messageId,
            clue: 'voto recebido mas nenhum texto decifrado — confira logs do PollService',
          },
          'poll.vote.text.missing',
        );
      }
    }

    const text =
      Object.prototype.hasOwnProperty.call(messageOverrides, 'text')
        ? messageOverrides.text ?? null
        : voteText ?? extractedText ?? null;

    const pickedTextFromVote =
      !Object.prototype.hasOwnProperty.call(messageOverrides, 'text') && !!voteText;
    if (pickedTextFromVote && direction === 'inbound' && messageId) {
      recordVoteSelection(messageId, null);
    }

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
      if (media) type = media.mediaType ?? 'media';
      else if (interactive) type = typeof interactive.type === 'string' ? interactive.type : 'interactive';
      else if (text) type = 'text';
    }

    const structuredMessage: StructuredMessagePayload = { id: messageId, chatId, type, text };
    if (interactive) structuredMessage.interactive = interactive;
    if (media) structuredMessage.media = media;

    const metadata: EventMetadata = {
      timestamp: toIsoDate(message.messageTimestamp),
      broker: { direction, type: 'baileys' },
      source: 'baileys-acessus',
      pollChoice,
    };

    return { contact, message: structuredMessage, metadata };
  }
}
