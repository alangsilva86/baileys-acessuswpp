import { config as loadEnv } from 'dotenv';
import path from 'node:path';

type RateLimitConfig = {
  enabled: boolean;
  windowMs: number;
  max: number;
  message: string;
};

type Env = {
  port: number;
  apiKeys: string[];
  webhookUrl: string | null;
  webhookApiKey: string | null;
  instanceId: string;
  authDir: string;
  serviceName: string;
  logLevel: string;
  rateLimit: RateLimitConfig;
};

loadEnv();

const errors: string[] = [];

function readRequired(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    errors.push(`Environment variable ${name} is required.`);
    return '';
  }
  return value.trim();
}

function readNumber(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min) {
    errors.push(`Environment variable ${name} must be a number >= ${min}.`);
    return fallback;
  }
  return parsed;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  errors.push(`Environment variable ${name} must be a boolean value.`);
  return fallback;
}

const port = readNumber('PORT', 3000, 1);

const apiKeyRaw = readRequired('API_KEY');
const apiKeys = apiKeyRaw
  .split(',')
  .map((key) => key.trim())
  .filter(Boolean);
if (!apiKeys.length) {
  errors.push('API_KEY must contain at least one key.');
}

const webhookUrlRaw = process.env.WEBHOOK_URL?.trim() ?? '';
let webhookUrl: string | null = null;
if (webhookUrlRaw) {
  try {
    const parsed = new URL(webhookUrlRaw);
    webhookUrl = parsed.toString();
  } catch {
    errors.push('WEBHOOK_URL must be a valid URL if provided.');
  }
}

const webhookApiKeyRaw = process.env.WEBHOOK_API_KEY?.trim() ?? '';
const webhookApiKey = webhookApiKeyRaw || null;

const instanceId = readRequired('INSTANCE_ID');

const authDirRaw = readRequired('AUTH_DIR');
const authDir = path.resolve(authDirRaw);

const serviceName = (process.env.SERVICE_NAME ?? 'baileys-api').trim();
const logLevel = (process.env.LOG_LEVEL ?? 'info').trim();

const rateLimitEnabled = readBoolean('RATE_LIMIT_ENABLED', false);
const rateLimitWindowMs = readNumber('RATE_LIMIT_WINDOW_MS', 60_000, 1);
const rateLimitMax = readNumber('RATE_LIMIT_MAX', 120, 1);
const rateLimitMessage =
  process.env.RATE_LIMIT_MESSAGE?.trim() ?? 'Too many requests. Please slow down.';

if (errors.length) {
  throw new Error(errors.join('\n'));
}

export const env: Env = {
  port,
  apiKeys,
  webhookUrl,
  webhookApiKey,
  instanceId,
  authDir,
  serviceName,
  logLevel,
  rateLimit: {
    enabled: rateLimitEnabled,
    windowMs: rateLimitWindowMs,
    max: rateLimitMax,
    message: rateLimitMessage,
  },
};

export type { RateLimitConfig, Env };
