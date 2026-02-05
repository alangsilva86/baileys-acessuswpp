import { getPipedriveRedis } from './redisClient.js';
import { PipedriveRedisStore } from './redisStore.js';

let store: PipedriveRedisStore | null = null;

export function getPipedriveRedisStore(): PipedriveRedisStore {
  if (store) return store;
  store = new PipedriveRedisStore(getPipedriveRedis());
  return store;
}

