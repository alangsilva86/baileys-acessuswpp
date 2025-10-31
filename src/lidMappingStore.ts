import type Long from 'long';
import {
  jidDecode,
  jidEncode,
  isLidUser,
} from '@whiskeysockets/baileys/lib/WABinary/jid-utils.js';
import type { JidServer } from '@whiskeysockets/baileys/lib/WABinary/jid-utils.js';

const S_WHATSAPP_NET_SERVER: JidServer = 's.whatsapp.net';
const LID_SERVER: JidServer = 'lid';

function toStringId(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value).toString();
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value && typeof value === 'object') {
    if (typeof (value as Long).toString === 'function' && (value as Long).toString !== Object.prototype.toString) {
      const stringValue = (value as Long).toString();
      return typeof stringValue === 'string' && stringValue !== '[object Object]' ? stringValue.trim() : null;
    }
    if ('jid' in (value as Record<string, unknown>)) {
      return toStringId((value as Record<string, unknown>).jid);
    }
    if ('value' in (value as Record<string, unknown>)) {
      return toStringId((value as Record<string, unknown>).value);
    }
    if ('user' in (value as Record<string, unknown>) && 'server' in (value as Record<string, unknown>)) {
      const user = toStringId((value as Record<string, unknown>).user);
      const server = toStringId((value as Record<string, unknown>).server);
      if (user && server) return jidEncode(user, server as JidServer);
    }
  }
  return null;
}

function canonicalizeJid(value: unknown, defaultServer?: JidServer | null): string | null {
  const asString = toStringId(value);
  if (!asString) return null;
  const trimmed = asString.trim();
  if (!trimmed) return null;

  const decoded = jidDecode(trimmed);
  if (decoded?.user) {
    const server = decoded.server ?? defaultServer ?? null;
    if (!server) return null;
    return jidEncode(decoded.user, server, decoded.device);
  }

  if (/^[0-9]+$/.test(trimmed)) {
    if (!defaultServer) return trimmed;
    return jidEncode(trimmed, defaultServer);
  }

  if (defaultServer && /^[0-9]+@[^@]+$/.test(trimmed)) {
    return canonicalizeJid(trimmed, undefined);
  }

  return trimmed;
}

function isMeaningfulJid(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function resolveJidInternal(
  primary: string | null | undefined,
  alternate: string | null | undefined,
  store: LidMappingStore | null | undefined,
  defaultServer: JidServer | null,
): string | null {
  const primaryNormalized = canonicalizeJid(primary ?? undefined, defaultServer);
  const alternateNormalized = canonicalizeJid(alternate ?? undefined, defaultServer);

  if (isMeaningfulJid(alternateNormalized) && !isLidUser(alternateNormalized)) {
    return alternateNormalized;
  }
  if (isMeaningfulJid(primaryNormalized) && !isLidUser(primaryNormalized)) {
    return primaryNormalized;
  }

  if (isMeaningfulJid(alternateNormalized) && isLidUser(alternateNormalized)) {
    const mapped = store?.getPnForLid(alternateNormalized);
    if (mapped) return mapped;
  }
  if (isMeaningfulJid(primaryNormalized) && isLidUser(primaryNormalized)) {
    const mapped = store?.getPnForLid(primaryNormalized);
    if (mapped) return mapped;
  }

  if (isMeaningfulJid(alternateNormalized)) return alternateNormalized;
  if (isMeaningfulJid(primaryNormalized)) return primaryNormalized;
  return null;
}

const PN_KEYS = [
  'pnJid',
  'pnWid',
  'pn',
  'jid',
  'userJid',
  'pn_jid',
  'phoneJid',
  'primaryJid',
  'jidPn',
];
const LID_KEYS = [
  'lidJid',
  'lidWid',
  'lid',
  'lid_jid',
  'lidValue',
  'assignedLid',
  'latestLid',
  'lidPn',
  'consumerLid',
  'lidUser',
];

function extractFromObject(entry: Record<string, unknown>): Array<{ pn: unknown; lid: unknown }> {
  const pairs: Array<{ pn: unknown; lid: unknown }> = [];

  const pnCandidates: unknown[] = [];
  const lidCandidates: unknown[] = [];

  for (const key of PN_KEYS) {
    if (key in entry) pnCandidates.push(entry[key]);
  }
  for (const key of LID_KEYS) {
    if (key in entry) lidCandidates.push(entry[key]);
  }

  if (entry?.pn && typeof entry.pn === 'object') {
    const asRecord = entry.pn as Record<string, unknown>;
    if ('jid' in asRecord) pnCandidates.push(asRecord.jid);
    if ('value' in asRecord) pnCandidates.push(asRecord.value);
  }
  if (entry?.lid && typeof entry.lid === 'object') {
    const asRecord = entry.lid as Record<string, unknown>;
    if ('jid' in asRecord) lidCandidates.push(asRecord.jid);
    if ('value' in asRecord) lidCandidates.push(asRecord.value);
  }

  const pnCandidate = pnCandidates
    .map((candidate) => canonicalizeJid(candidate, S_WHATSAPP_NET_SERVER))
    .find(isMeaningfulJid);
  const lidCandidate = lidCandidates
    .map((candidate) => canonicalizeJid(candidate, LID_SERVER))
    .find(isMeaningfulJid);

  if (pnCandidate && lidCandidate) {
    pairs.push({ pn: pnCandidate, lid: lidCandidate });
  }

  return pairs;
}

export class LidMappingStore {
  private readonly pnToLid = new Map<string, string>();
  private readonly lidToPn = new Map<string, string>();

  rememberMapping(pnJid: unknown, lidJid: unknown): boolean {
    const pn = canonicalizeJid(pnJid, S_WHATSAPP_NET_SERVER);
    const lid = canonicalizeJid(lidJid, LID_SERVER);
    if (!pn || !lid) return false;
    this.pnToLid.set(pn, lid);
    this.lidToPn.set(lid, pn);
    return true;
  }

  ingestUpdate(update: unknown): number {
    const queue: unknown[] = [update];
    let applied = 0;

    while (queue.length) {
      const current = queue.shift();
      if (Array.isArray(current)) {
        queue.push(...current);
        continue;
      }
      if (!current || typeof current !== 'object') continue;

      const record = current as Record<string, unknown>;
      for (const key of ['mappings', 'updates', 'pnToLidMappings', 'results', 'entries']) {
        const nested = record[key];
        if (Array.isArray(nested)) queue.push(...nested);
      }

      const pairs = extractFromObject(record);
      for (const pair of pairs) {
        if (this.rememberMapping(pair.pn, pair.lid)) applied += 1;
      }
    }

    return applied;
  }

  getPnForLid(lidJid: unknown): string | null {
    const normalized = canonicalizeJid(lidJid, LID_SERVER);
    if (!normalized) return null;
    return this.lidToPn.get(normalized) ?? null;
  }

  getLidForPn(pnJid: unknown): string | null {
    const normalized = canonicalizeJid(pnJid, S_WHATSAPP_NET_SERVER);
    if (!normalized) return null;
    return this.pnToLid.get(normalized) ?? null;
  }

  resolveRemoteJid(primary: string | null | undefined, alternate?: string | null | undefined): string | null {
    return resolveJidInternal(primary, alternate, this, S_WHATSAPP_NET_SERVER);
  }

  resolveParticipantJid(primary: string | null | undefined, alternate?: string | null | undefined): string | null {
    return resolveJidInternal(primary, alternate, this, S_WHATSAPP_NET_SERVER);
  }
}

export function resolveJid(
  primary: string | null | undefined,
  alternate: string | null | undefined,
  store: LidMappingStore | null | undefined,
  defaultServer: JidServer | null = S_WHATSAPP_NET_SERVER,
): string | null {
  return resolveJidInternal(primary, alternate, store ?? null, defaultServer);
}

export function isLidJid(value: string | null | undefined): boolean {
  return typeof value === 'string' ? Boolean(isLidUser(value)) : false;
}
