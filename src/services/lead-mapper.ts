import type { WAMessage } from '@whiskeysockets/baileys';

export interface LeadInfo {
  owner: 'agent' | 'customer' | 'group' | 'unknown';
  remoteJid: string | null;
  participant?: string | null;
  phone?: string | null;
  displayName?: string | null;
  isGroup: boolean;
}

function normalizePhone(jid?: string | null): string | null {
  if (!jid) {
    return null;
  }
  const atIndex = jid.indexOf('@');
  const value = atIndex >= 0 ? jid.slice(0, atIndex) : jid;
  return value || null;
}

export function mapLeadFromMessage(message: WAMessage | null | undefined): LeadInfo {
  const remoteJid = message?.key?.remoteJid ?? null;
  const participant = message?.key?.participant ?? null;
  const isGroup = Boolean(remoteJid && remoteJid.endsWith('@g.us'));
  const fromMe = Boolean(message?.key?.fromMe);

  let owner: LeadInfo['owner'] = 'unknown';
  if (fromMe) {
    owner = 'agent';
  } else if (isGroup) {
    owner = 'group';
  } else if (remoteJid) {
    owner = 'customer';
  }

  return {
    owner,
    remoteJid,
    participant,
    phone: normalizePhone(participant || remoteJid),
    displayName: message?.pushName ?? null,
    isGroup,
  };
}

