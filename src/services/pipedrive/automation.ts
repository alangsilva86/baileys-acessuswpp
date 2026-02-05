import pino from 'pino';
import {
  ensureInstanceStarted,
  getInstance,
} from '../../instanceManager.js';
import { allowSend, getSendTimeoutMs, normalizeToE164BR } from '../../utils.js';
import {
  PIPEDRIVE_AUTOMATION_INSTANCE_ID,
  PIPEDRIVE_AUTOMATION_TEMPLATE_ACTIVITY,
  PIPEDRIVE_AUTOMATION_TEMPLATE_DEAL_STAGE,
} from './config.js';
import { pipedriveV2Client } from './v2Client.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info', base: { service: 'pipedrive-automation' } });

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === 'object') {
    const inner = (value as any).value;
    return parseNumber(inner);
  }
  return null;
}

function pickWebhookObject(payload: any): string | null {
  if (typeof payload?.event_object === 'string' && payload.event_object.trim()) return payload.event_object.trim();
  if (typeof payload?.meta?.object === 'string' && payload.meta.object.trim()) return payload.meta.object.trim();
  if (typeof payload?.event === 'string' && payload.event.includes('.')) {
    const [, obj] = payload.event.split('.', 2);
    return obj?.trim() || null;
  }
  return null;
}

function pickWebhookAction(payload: any): string | null {
  if (typeof payload?.event_action === 'string' && payload.event_action.trim()) return payload.event_action.trim();
  if (typeof payload?.meta?.action === 'string' && payload.meta.action.trim()) return payload.meta.action.trim();
  if (typeof payload?.event === 'string' && payload.event.includes('.')) {
    const [action] = payload.event.split('.', 1);
    return action?.trim() || null;
  }
  return null;
}

function extractPersonId(payload: any): number | null {
  return (
    parseNumber(payload?.person_id) ??
    parseNumber(payload?.current?.person_id) ??
    parseNumber(payload?.current?.person) ??
    parseNumber(payload?.current?.person_id?.value) ??
    parseNumber(payload?.meta?.person_id) ??
    null
  );
}

function normalizeWhatsAppDigits(raw: string): string | null {
  const digits = raw.replace(/\D+/g, '');
  if (!digits) return null;
  const e164 = normalizeToE164BR(digits);
  if (e164) return e164;
  if (digits.length >= 10 && digits.length <= 15) return digits;
  return null;
}

function pickPersonPhone(person: any): string | null {
  const list = Array.isArray(person?.phone)
    ? person.phone
    : Array.isArray(person?.phones)
    ? person.phones
    : null;
  if (!list || !list.length) return null;
  const primary = list.find((entry: any) => entry && typeof entry === 'object' && entry.primary) ?? list[0];
  if (typeof primary === 'string') return primary;
  if (primary && typeof primary.value === 'string') return primary.value;
  return null;
}

function getPath(obj: any, path: string): unknown {
  const parts = path.split('.');
  let current: any = obj;
  for (const part of parts) {
    if (current == null) return null;
    current = current[part];
  }
  return current;
}

function renderTemplate(template: string, data: any): string {
  return template.replace(/{{\s*([^}\s]+)\s*}}/g, (_match, keyRaw: string) => {
    const key = String(keyRaw || '').trim();
    if (!key) return '';
    const value = getPath(data, key);
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  });
}

async function sendAutomationText(options: { instanceId: string; jid: string; text: string }): Promise<{ messageId: string | null }> {
  if (!options.instanceId) {
    throw new Error('pipedrive_automation_instance_missing');
  }
  const instance = await ensureInstanceStarted(options.instanceId, { name: options.instanceId });
  if (!instance.sock || !instance.context?.messageService) {
    throw new Error('pipedrive_automation_instance_unavailable');
  }
  if (!allowSend(instance)) {
    throw new Error('rate_limit_exceeded');
  }
  const timeoutMs = getSendTimeoutMs();
  const sent = await instance.context.messageService.sendText(options.jid, options.text, { timeoutMs });
  const messageId = sent?.key?.id ?? null;
  const inst = getInstance(options.instanceId);
  if (inst) {
    inst.metrics.sent += 1;
    inst.metrics.sent_by_type.text += 1;
    if (messageId) inst.metrics.last.sentId = messageId;
  }
  return { messageId };
}

export async function maybeRunPipedriveAutomation(
  payload: unknown,
  deps: {
    instanceId?: string;
    templates?: { deal?: string; activity?: string };
    getPerson?: (id: number) => Promise<any | null>;
    sendText?: (options: { instanceId: string; jid: string; text: string }) => Promise<{ messageId: string | null }>;
  } = {},
): Promise<{ sent: boolean; skippedReason?: string; jid?: string; messageId?: string | null }> {
  const body = payload as any;
  const object = pickWebhookObject(body);
  if (!object) return { sent: false, skippedReason: 'unknown_object' };

  const templates = deps.templates ?? {};
  const template =
    object === 'deal'
      ? (templates.deal ?? PIPEDRIVE_AUTOMATION_TEMPLATE_DEAL_STAGE)
      : object === 'activity'
      ? (templates.activity ?? PIPEDRIVE_AUTOMATION_TEMPLATE_ACTIVITY)
      : '';

  if (!template || !template.trim()) return { sent: false, skippedReason: 'template_missing' };
  const instanceId = deps.instanceId ?? PIPEDRIVE_AUTOMATION_INSTANCE_ID;
  if (!instanceId) return { sent: false, skippedReason: 'instance_missing' };

  const personId = extractPersonId(body);
  if (!personId) return { sent: false, skippedReason: 'person_id_missing' };

  const getPerson = deps.getPerson ?? ((id: number) => pipedriveV2Client.getPerson({ id }));
  const person = await getPerson(personId);
  if (!person) return { sent: false, skippedReason: 'person_not_found' };
  const phoneRaw = pickPersonPhone(person);
  if (!phoneRaw) return { sent: false, skippedReason: 'person_phone_missing' };
  const digits = normalizeWhatsAppDigits(phoneRaw);
  if (!digits) return { sent: false, skippedReason: 'person_phone_invalid' };
  const jid = `${digits}@s.whatsapp.net`;

  const action = pickWebhookAction(body);
  const data = {
    object,
    action,
    current: body?.current ?? null,
    previous: body?.previous ?? null,
    meta: body?.meta ?? null,
    person: {
      id: person.id,
      name: person.name,
      phone: phoneRaw,
      whatsapp_digits: digits,
    },
  };

  const message = renderTemplate(template, data).trim();
  if (!message) return { sent: false, skippedReason: 'rendered_empty' };

  logger.info({ object, action, personId: person.id, jid }, 'automation.send.start');
  const sendText = deps.sendText ?? sendAutomationText;
  const { messageId } = await sendText({ instanceId, jid, text: message });
  logger.info({ object, action, personId: person.id, jid, messageId }, 'automation.send.ok');

  return { sent: true, jid, messageId };
}
