import type { WAMessage } from '@whiskeysockets/baileys';

export interface LeadInfo {
  owner: 'device' | 'server' | 'user';
  remoteJid: string | null;
  participant?: string | null;
  phone?: string | null;
  displayName?: string | null;
  isGroup: boolean;
}

export interface ContactPayload {
  owner: LeadInfo['owner'];
  remoteJid: string | null;
  participant: string | null;
  phone: string | null;
  displayName: string | null;
  isGroup: boolean;
}

function normalizePhone(jid?: string | null): string | null {
  if (!jid) return null;
  const atIndex = jid.indexOf('@');
  const value = atIndex >= 0 ? jid.slice(0, atIndex) : jid;
  if (!value) return null;
  return value.startsWith('+') ? value : `+${value}`;
}

export function mapLeadFromMessage(message: WAMessage | null | undefined): LeadInfo {
  const remoteJid = message?.key?.remoteJid ?? null;
  const participant = message?.key?.participant ?? null;
  const isGroup = Boolean(remoteJid && remoteJid.endsWith('@g.us'));
  const fromMe = Boolean(message?.key?.fromMe);

  const owner: LeadInfo['owner'] = fromMe ? 'device' : remoteJid ? 'user' : 'server';

  const phone = normalizePhone(participant || remoteJid);
  const displayName = (message?.pushName && message.pushName.trim()) || phone || remoteJid || null;

  return {
    owner,
    remoteJid,
    participant,
    phone,
    displayName,
    isGroup,
  };
}

export function buildContactPayload(lead: LeadInfo): ContactPayload {
  return {
    owner: lead.owner,
    remoteJid: lead.remoteJid ?? null,
    participant: lead.participant ?? null,
    phone: lead.phone ?? null,
    displayName: lead.displayName ?? null,
    isGroup: lead.isGroup,
  };
}
