import crypto from 'node:crypto';
import type { RequestHandler } from 'express';

function timingSafeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufferA, bufferB);
}

export function createApiKeyMiddleware(keys: string[]): RequestHandler {
  const normalizedKeys = keys.map((key) => key.trim()).filter(Boolean);

  const middleware: RequestHandler = (req, res, next) => {
    if (!normalizedKeys.length) {
      return res.status(401).json({ error: 'unauthorized', message: 'API key not configured.' });
    }

    const provided = req.header('x-api-key')?.trim() ?? '';
    if (!provided) {
      return res
        .status(401)
        .json({ error: 'unauthorized', message: 'Missing X-API-Key header.' });
    }

    const isValid = normalizedKeys.some((key) => timingSafeEqual(key, provided));
    if (!isValid) {
      return res
        .status(401)
        .json({ error: 'unauthorized', message: 'Invalid API key provided.' });
    }

    return next();
  };

  return middleware;
}
