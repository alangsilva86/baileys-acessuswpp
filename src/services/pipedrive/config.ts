const truthy = new Set(['1', 'true', 'yes', 'on']);

function isEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return truthy.has(value.toLowerCase());
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseChannelsMode(value: string | undefined): 'dual' | 'channels' | 'v2' {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'channels') return 'channels';
  if (normalized === 'v2') return 'v2';
  return 'dual';
}

export const PIPEDRIVE_ENABLED = isEnabled(process.env.PIPEDRIVE_ENABLED);
export const PIPEDRIVE_SYNC_INBOUND = process.env.PIPEDRIVE_SYNC_INBOUND
  ? isEnabled(process.env.PIPEDRIVE_SYNC_INBOUND)
  : true;
export const PIPEDRIVE_SYNC_OUTBOUND = process.env.PIPEDRIVE_SYNC_OUTBOUND
  ? isEnabled(process.env.PIPEDRIVE_SYNC_OUTBOUND)
  : true;

export const PIPEDRIVE_CLIENT_ID = process.env.PIPEDRIVE_CLIENT_ID ?? '';
export const PIPEDRIVE_CLIENT_SECRET = process.env.PIPEDRIVE_CLIENT_SECRET ?? '';
export const PIPEDRIVE_OAUTH_BASE_URL = process.env.PIPEDRIVE_OAUTH_BASE_URL ?? 'https://oauth.pipedrive.com';
export const PIPEDRIVE_API_BASE_URL_V1 =
  process.env.PIPEDRIVE_API_BASE_URL_V1 ??
  process.env.PIPEDRIVE_API_BASE_URL ??
  'https://api.pipedrive.com/v1';
export const PIPEDRIVE_API_BASE_URL_V2 =
  process.env.PIPEDRIVE_API_BASE_URL_V2 ??
  'https://api.pipedrive.com/api/v2';
export const PIPEDRIVE_PUBLIC_BASE_URL = process.env.PIPEDRIVE_PUBLIC_BASE_URL ?? '';
export const PIPEDRIVE_REDIRECT_URI = process.env.PIPEDRIVE_REDIRECT_URI ?? '';
export const PIPEDRIVE_OAUTH_SCOPE = process.env.PIPEDRIVE_OAUTH_SCOPE ?? '';
export const PIPEDRIVE_PROVIDER_TYPE = process.env.PIPEDRIVE_PROVIDER_TYPE ?? 'whatsapp';
export const PIPEDRIVE_TEMPLATE_SUPPORT = isEnabled(process.env.PIPEDRIVE_TEMPLATE_SUPPORT);
export const PIPEDRIVE_CHANNEL_AVATAR_URL = process.env.PIPEDRIVE_CHANNEL_AVATAR_URL ?? '';
export const PIPEDRIVE_CHANNELS_MODE = parseChannelsMode(process.env.PIPEDRIVE_CHANNELS_MODE);
export const PIPEDRIVE_FALLBACK_NOTES_ENABLED = process.env.PIPEDRIVE_FALLBACK_NOTES_ENABLED
  ? isEnabled(process.env.PIPEDRIVE_FALLBACK_NOTES_ENABLED)
  : true;
export const PIPEDRIVE_FALLBACK_CREATE_PERSON = process.env.PIPEDRIVE_FALLBACK_CREATE_PERSON
  ? isEnabled(process.env.PIPEDRIVE_FALLBACK_CREATE_PERSON)
  : true;
export const PIPEDRIVE_AUTOMATION_INSTANCE_ID = process.env.PIPEDRIVE_AUTOMATION_INSTANCE_ID ?? '';
export const PIPEDRIVE_WEBHOOK_USER = process.env.PIPEDRIVE_WEBHOOK_USER ?? '';
export const PIPEDRIVE_WEBHOOK_PASS = process.env.PIPEDRIVE_WEBHOOK_PASS ?? '';
export const PIPEDRIVE_WEBHOOK_EVENTS = parseCsv(
  process.env.PIPEDRIVE_WEBHOOK_EVENTS ?? 'deal,activity,person,organization',
);
export const PIPEDRIVE_AUTOMATION_TEMPLATE_DEAL_STAGE =
  process.env.PIPEDRIVE_AUTOMATION_TEMPLATE_DEAL_STAGE ?? '';
export const PIPEDRIVE_AUTOMATION_TEMPLATE_ACTIVITY =
  process.env.PIPEDRIVE_AUTOMATION_TEMPLATE_ACTIVITY ?? '';

const MAX_CONVERSATIONS_DEFAULT = 200;
const MAX_MESSAGES_DEFAULT = 200;

function parseLimit(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export const PIPEDRIVE_MAX_CONVERSATIONS = parseLimit(
  process.env.PIPEDRIVE_MAX_CONVERSATIONS,
  MAX_CONVERSATIONS_DEFAULT,
);
export const PIPEDRIVE_MAX_MESSAGES = parseLimit(
  process.env.PIPEDRIVE_MAX_MESSAGES,
  MAX_MESSAGES_DEFAULT,
);
