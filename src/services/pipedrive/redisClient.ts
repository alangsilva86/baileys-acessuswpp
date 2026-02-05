import IORedis from 'ioredis';
import { PIPEDRIVE_REDIS_URL } from './config.js';

let client: IORedis | null = null;

export function getPipedriveRedis(): IORedis {
  if (client) return client;
  const url = (PIPEDRIVE_REDIS_URL || '').trim();
  if (!url) {
    throw new Error('pipedrive_redis_url_missing');
  }
  client = new IORedis(url, { maxRetriesPerRequest: null });
  return client;
}

export async function closePipedriveRedis(): Promise<void> {
  if (!client) return;
  const conn = client;
  client = null;
  try {
    await conn.quit();
  } catch {
    // ignore close errors
  }
}

