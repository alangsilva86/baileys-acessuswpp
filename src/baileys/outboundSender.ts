import type { WASocket, WAMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import { getSendTimeoutMs } from '../utils.js';

const HUMANIZE_SENDS = process.env.HUMANIZE_SENDS !== '0';
const TYPING_MS_PER_CHAR = 200;

export function applySpintax(text: string): string {
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

function humanDelay(minMs: number, maxMs: number): Promise<void> {
  const min = Math.max(0, Math.floor(minMs));
  const max = Math.max(min, Math.floor(maxMs));
  const jitter = Math.floor(Math.random() * (max - min + 1) + min);
  return new Promise((resolve) => setTimeout(resolve, jitter));
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

export async function sendWithHumanization(
  sock: WASocket,
  jid: string,
  content: Parameters<WASocket['sendMessage']>[1],
  messageOptions?: Parameters<WASocket['sendMessage']>[2],
  logger: pino.Logger | null = null,
): Promise<WAMessage> {
  if (!HUMANIZE_SENDS) {
    return sock.sendMessage(jid, content, messageOptions);
  }

  try {
    await sock.sendPresenceUpdate('available', jid);
  } catch {}

  await humanDelay(800, 2000);
  const profile = estimatePresenceProfile(content);
  try {
    await sock.sendPresenceUpdate(profile.type, jid);
  } catch {}
  await humanDelay(profile.min, profile.max);
  try {
    await sock.sendPresenceUpdate('paused', jid);
  } catch {}
  await humanDelay(600, 1400);

  const result = await sock.sendMessage(jid, content, messageOptions);
  setTimeout(() => {
    try {
      void sock?.sendPresenceUpdate?.('unavailable', jid);
    } catch (err) {
      logger?.warn?.({ err }, 'presence.cleanup.failed');
    }
  }, 8000);
  return result;
}

export async function sendMessageWithTimeout(
  sock: WASocket,
  jid: string,
  content: Parameters<WASocket['sendMessage']>[1],
  options: { timeoutMs?: number; messageOptions?: Parameters<WASocket['sendMessage']>[2] },
  logger: pino.Logger | null = null,
): Promise<WAMessage> {
  const timeoutMs = options.timeoutMs ?? getSendTimeoutMs();
  const sendPromise = sendWithHumanization(sock, jid, content, options.messageOptions, logger);

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
