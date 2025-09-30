import type { RequestHandler } from 'express';

import type { RateLimitConfig } from '../env';

type Bucket = {
  count: number;
  expiresAt: number;
};

export function createRateLimitMiddleware(config: RateLimitConfig): RequestHandler | null {
  if (!config.enabled) {
    return null;
  }

  const buckets = new Map<string, Bucket>();

  const middleware: RequestHandler = (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.connection.remoteAddress || 'unknown';
    const existing = buckets.get(key);

    if (!existing || existing.expiresAt <= now) {
      buckets.set(key, { count: 1, expiresAt: now + config.windowMs });
      return next();
    }

    if (existing.count >= config.max) {
      return res.status(429).json({ error: 'rate_limit_exceeded', message: config.message });
    }

    existing.count += 1;
    buckets.set(key, existing);
    return next();
  };

  return middleware;
}
