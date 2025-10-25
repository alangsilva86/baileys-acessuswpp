import type { WAMessage } from '@whiskeysockets/baileys';

export function filterClientMessages(messages: WAMessage[]): WAMessage[] {
  return (messages || []).filter((m) => !m.key.fromMe);
}

export function getNormalizedMessageContent(message: WAMessage): any {
  return message?.message ?? null;
}

export function extractMessageType(message: WAMessage): string | null {
  const c = getNormalizedMessageContent(message);
  if (!c) return null;

  if (c.pollUpdateMessage || c.pollUpdateMessageV2 || c.pollUpdateMessageV3) return 'pollUpdateMessage';
  if (c.pollCreationMessage || c.pollCreationMessageV2 || c.pollCreationMessageV3) return 'pollCreationMessage';
  if (c.buttonsResponseMessage || c.templateButtonReplyMessage) return 'buttonsResponseMessage';
  if (c.listResponseMessage) return 'listResponseMessage';
  if (c.interactiveResponseMessage) return 'interactiveResponseMessage';

  if (c.conversation || c.extendedTextMessage) return 'extendedTextMessage';
  if (c.imageMessage) return 'imageMessage';
  if (c.videoMessage) return 'videoMessage';
  if (c.audioMessage) return 'audioMessage';
  if (c.documentMessage || c.documentWithCaptionMessage) return 'documentMessage';
  if (c.stickerMessage) return 'stickerMessage';
  if (c.locationMessage || c.liveLocationMessage) return 'locationMessage';
  if (c.contactMessage || c.contactsArrayMessage) return 'contactMessage';

  return null;
}

export function extractMessageText(message: WAMessage): string | null {
  const c = getNormalizedMessageContent(message);
  if (!c) return null;
  if (typeof c.conversation === 'string' && c.conversation.trim()) return c.conversation.trim();
  if (c.extendedTextMessage?.text) return String(c.extendedTextMessage.text).trim() || null;
  if (c.imageMessage?.caption) return String(c.imageMessage.caption).trim() || null;
  if (c.videoMessage?.caption) return String(c.videoMessage.caption).trim() || null;
  return null;
}