import pino from 'pino';
import { normalizeToE164BR } from '../../utils.js';
import {
  PIPEDRIVE_FALLBACK_CREATE_PERSON,
  PIPEDRIVE_FALLBACK_NOTES_ENABLED,
} from './config.js';
import { pipedriveClient } from './client.js';
import { pipedriveV2Client } from './v2Client.js';
import {
  buildFallbackMessageKey,
  getFallbackNoteId,
  upsertFallbackNoteMapping,
} from './fallbackStore.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', base: { service: 'pipedrive-fallback-notes' } });

export type PipedriveMessageDirection = 'inbound' | 'outbound';

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function toIso(value: string | number | Date | null | undefined): string {
  if (value == null) return new Date().toISOString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? new Date().toISOString() : value.toISOString();
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function extractPhoneDigits(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  let target = raw;
  const atIndex = raw.indexOf('@');
  if (atIndex >= 0) {
    target = raw.slice(0, atIndex);
    const colonIndex = target.indexOf(':');
    if (colonIndex >= 0) target = target.slice(0, colonIndex);
  }
  const digits = target.replace(/\D+/g, '');
  return digits ? digits : null;
}

function extractPhoneCandidates(options: { conversationId?: string | null; phone?: string | null }): string[] {
  const candidates = new Set<string>();
  for (const raw of [options.phone ?? null, options.conversationId ?? null]) {
    if (!raw) continue;
    const digits = extractPhoneDigits(raw);
    if (!digits) continue;
    const e164br = normalizeToE164BR(digits);
    if (e164br) {
      candidates.add(e164br);
      candidates.add(`+${e164br}`);
    }
    candidates.add(digits);
    candidates.add(`+${digits}`);
  }
  return Array.from(candidates).filter(Boolean);
}

function buildConversationLink(conversationId: string, phoneDigits: string | null): string | null {
  const digits = phoneDigits ?? extractPhoneDigits(conversationId);
  if (!digits) return null;
  return `https://wa.me/${digits}`;
}

function buildNoteContent(options: {
  instanceId: string;
  direction: PipedriveMessageDirection;
  messageId: string;
  conversationId: string;
  conversationLink?: string | null;
  createdAtIso: string;
  messageText: string;
}): string {
  const title = options.direction === 'inbound' ? 'Mensagem recebida (WhatsApp)' : 'Mensagem enviada (WhatsApp)';
  const lines = [
    `<p><strong>${escapeHtml(title)}</strong></p>`,
    `<p>${escapeHtml(options.messageText || 'Mensagem sem texto')}</p>`,
    '<hr/>',
    `<p><small>instance: ${escapeHtml(options.instanceId)}</small><br/>`,
    `<small>direction: ${escapeHtml(options.direction)}</small><br/>`,
    `<small>message_id: ${escapeHtml(options.messageId)}</small><br/>`,
    `<small>conversation_id: ${escapeHtml(options.conversationId)}</small><br/>`,
    options.conversationLink ? `<small>wa_link: <a href="${escapeHtml(options.conversationLink)}">${escapeHtml(options.conversationLink)}</a></small><br/>` : '',
    `<small>created_at: ${escapeHtml(options.createdAtIso)}</small></p>`,
  ].filter(Boolean);
  return lines.join('\n');
}

export async function createFallbackNote(options: {
  instanceId: string;
  direction: PipedriveMessageDirection;
  messageId: string;
  conversationId: string;
  messageText: string;
  contactPhone?: string | null;
  contactName?: string | null;
  createdAt?: string | number | Date | null;
  companyId?: number | null;
  apiDomain?: string | null;
}, deps: {
  v1Client?: Pick<typeof pipedriveClient, 'createNote'>;
  v2Client?: Pick<typeof pipedriveV2Client, 'findPersonByPhone' | 'createPerson'>;
} = {}): Promise<{ noteId: number; reused: boolean; personId: number | null }> {
  if (!PIPEDRIVE_FALLBACK_NOTES_ENABLED) {
    throw new Error('pipedrive_fallback_notes_disabled');
  }

  const v1 = deps.v1Client ?? pipedriveClient;
  const v2 = deps.v2Client ?? pipedriveV2Client;

  const messageKey = buildFallbackMessageKey({ instanceId: options.instanceId, messageId: options.messageId });
  const existingNoteId = await getFallbackNoteId(messageKey);
  if (existingNoteId) {
    return { noteId: existingNoteId, reused: true, personId: null };
  }

  const createdAtIso = toIso(options.createdAt ?? null);
  const phoneCandidates = extractPhoneCandidates({
    conversationId: options.conversationId,
    phone: options.contactPhone ?? null,
  });
  if (!phoneCandidates.length) {
    throw new Error('pipedrive_fallback_phone_missing');
  }

  let person = null as Awaited<ReturnType<typeof pipedriveV2Client.findPersonByPhone>> | null;
  for (const candidate of phoneCandidates) {
    person = await v2.findPersonByPhone({
      phone: candidate,
      companyId: options.companyId ?? null,
      apiDomain: options.apiDomain ?? null,
    });
    if (person) break;
  }

  if (!person && PIPEDRIVE_FALLBACK_CREATE_PERSON) {
    const primaryPhone = phoneCandidates.find((c) => c.startsWith('+')) ?? phoneCandidates[0]!;
    person = await v2.createPerson({
      name: options.contactName?.trim() || primaryPhone,
      phone: primaryPhone,
      companyId: options.companyId ?? null,
      apiDomain: options.apiDomain ?? null,
    });
  }

  if (!person) {
    throw new Error('pipedrive_person_not_found');
  }

  const linkDigitsRaw =
    extractPhoneDigits(options.contactPhone ?? '') ??
    extractPhoneDigits(options.conversationId) ??
    null;
  const linkDigits = linkDigitsRaw ? normalizeToE164BR(linkDigitsRaw) ?? linkDigitsRaw : null;
  const conversationLink = buildConversationLink(options.conversationId, linkDigits);
  const content = buildNoteContent({
    instanceId: options.instanceId,
    direction: options.direction,
    messageId: options.messageId,
    conversationId: options.conversationId,
    conversationLink,
    createdAtIso,
    messageText: options.messageText,
  });

  const note = await v1.createNote({
    content,
    personId: person.id,
    companyId: options.companyId ?? null,
    apiDomain: options.apiDomain ?? null,
  });

  await upsertFallbackNoteMapping({ messageKey, noteId: note.id });
  logger.info({ noteId: note.id, personId: person.id, messageId: options.messageId }, 'fallback.note.created');

  return { noteId: note.id, reused: false, personId: person.id };
}
