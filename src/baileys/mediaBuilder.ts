import axios from 'axios';
import sharp from 'sharp';
import type { AnyMessageContent, WASocket } from '@whiskeysockets/baileys';
import { Buffer } from 'node:buffer';
import { createError } from './messageErrors.js';

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

export interface SendMediaOptions {
  caption?: string | null;
  mimetype?: string | null;
  fileName?: string | null;
  ptt?: boolean | null;
  gifPlayback?: boolean | null;
  timeoutMs?: number;
  messageOptions?: Parameters<WASocket['sendMessage']>[2];
}

export interface BuiltMediaContent {
  content: AnyMessageContent;
  mimetype: string | null;
  fileName: string | null;
  size: number | null;
  source: 'base64' | 'url';
}

const DEFAULT_DOCUMENT_MIMETYPE = 'application/octet-stream';

function sanitizeString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
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

export async function hashBusterImage(buffer: Buffer): Promise<Buffer> {
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

export async function fetchBufferFromUrl(url: string): Promise<Buffer | null> {
  try {
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 10_000 });
    return Buffer.from(resp.data);
  } catch {
    return null;
  }
}
