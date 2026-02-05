import {
  PIPEDRIVE_NOTES_BLOCK_BASE_WINDOW_MINUTES,
  PIPEDRIVE_NOTES_BLOCK_MAX_WINDOW_MINUTES,
  PIPEDRIVE_NOTES_BLOCK_MIN_WINDOW_MINUTES,
} from './config.js';

export type PipedriveNoteDirection = 'inbound' | 'outbound';

export interface PipedrivePendingNoteEvent {
  message_id: string;
  ts_ms: number;
  direction: PipedriveNoteDirection;
  text: string;
  instance_id?: string | null;
  wa_link?: string | null;
  created_at_iso?: string | null;
  contact_name?: string | null;
  contact_phone?: string | null;
}

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

export function computeAdaptiveWindowMinutes(options: {
  startedAtIso: string;
  messageCount: number;
  bytes: number;
}): number {
  const started = new Date(options.startedAtIso);
  const startedMs = Number.isNaN(started.getTime()) ? Date.now() : started.getTime();
  const minutes = Math.max(0.01, (Date.now() - startedMs) / 60_000);

  const msgRate = Math.max(0, options.messageCount) / minutes;
  const bytesRate = Math.max(0, options.bytes) / minutes;

  let windowMinutes = PIPEDRIVE_NOTES_BLOCK_BASE_WINDOW_MINUTES;
  if (msgRate >= 10 || bytesRate >= 15_000) windowMinutes = 5;
  else if (msgRate >= 3 || bytesRate >= 5_000) windowMinutes = 10;
  else if (msgRate < 1 && bytesRate < 2_000) windowMinutes = 30;
  else windowMinutes = PIPEDRIVE_NOTES_BLOCK_BASE_WINDOW_MINUTES;

  windowMinutes = Math.max(PIPEDRIVE_NOTES_BLOCK_MIN_WINDOW_MINUTES, windowMinutes);
  windowMinutes = Math.min(PIPEDRIVE_NOTES_BLOCK_MAX_WINDOW_MINUTES, windowMinutes);
  return Math.floor(windowMinutes);
}

export function buildNoteHeaderHtml(options: {
  conversationKey: string;
  startedAtIso: string;
}): string {
  const started = toIso(options.startedAtIso);
  const thread = escapeHtml(options.conversationKey);
  return [
    `<p><strong>WhatsApp — Log de conversa</strong></p>`,
    `<p><small>thread: ${thread}</small><br/><small>started_at: ${escapeHtml(started)}</small></p>`,
    '<hr/>',
  ].join('\n');
}

export function buildNoteAppendHtml(events: PipedrivePendingNoteEvent[]): string {
  const lines: string[] = [];
  for (const ev of events) {
    const iso = ev.created_at_iso ? toIso(ev.created_at_iso) : toIso(ev.ts_ms);
    const dirLabel = ev.direction === 'inbound' ? 'in' : 'out';
    const msg = escapeHtml(ev.text || 'Mensagem sem texto');
    const meta: string[] = [];
    meta.push(`${escapeHtml(iso)} • ${escapeHtml(dirLabel)}`);
    if (ev.instance_id) meta.push(`inst: ${escapeHtml(ev.instance_id)}`);
    if (ev.wa_link) meta.push(`<a href="${escapeHtml(ev.wa_link)}">wa</a>`);

    // Idempotency marker
    lines.push(`<!--mid:${escapeHtml(ev.message_id)}-->`);
    lines.push(`<p><small>${meta.join(' • ')}</small><br/>${msg}</p>`);
  }
  return lines.join('\n');
}

export function estimateHtmlBytes(html: string): number {
  return Buffer.byteLength(html || '', 'utf8');
}

export function shouldStartNewBlockByWindow(options: {
  startedAtIso: string;
  windowMinutes: number;
  nowMs?: number;
}): boolean {
  const started = new Date(options.startedAtIso);
  const startedMs = Number.isNaN(started.getTime()) ? 0 : started.getTime();
  if (!startedMs) return false;
  const now = options.nowMs ?? Date.now();
  const minutes = (now - startedMs) / 60_000;
  return minutes >= Math.max(1, options.windowMinutes);
}

