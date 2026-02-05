import {
  PIPEDRIVE_REDIS_URL,
  PIPEDRIVE_STORE_BACKEND,
  PIPEDRIVE_UI_ENABLED,
} from './config.js';

export type PipedriveStoreBackend = 'file' | 'redis';

export function resolvePipedriveStoreBackend(): PipedriveStoreBackend {
  if (PIPEDRIVE_STORE_BACKEND === 'file') return 'file';
  if (PIPEDRIVE_STORE_BACKEND === 'redis') return 'redis';

  const nodeEnv = (process.env.NODE_ENV || '').toLowerCase();
  const hasRedis = Boolean((PIPEDRIVE_REDIS_URL || '').trim());
  if (nodeEnv === 'production' && hasRedis) return 'redis';
  if (PIPEDRIVE_UI_ENABLED && hasRedis) return 'redis';
  return 'file';
}

export function assertPipedriveRedisConfig(): void {
  const backend = resolvePipedriveStoreBackend();
  if (backend !== 'redis') return;
  if (!(PIPEDRIVE_REDIS_URL || '').trim()) {
    throw new Error('pipedrive_redis_url_required');
  }
}

