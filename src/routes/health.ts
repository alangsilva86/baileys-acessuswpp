import { Router, type Request, type Response } from 'express';

import type { RuntimeContext } from '../context';

export function createHealthRouter(ctx: RuntimeContext): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    const uptime = process.uptime();
    const connected = Boolean(ctx.instance.sock?.user);
    res.json({
      status: 'ok',
      uptime,
      instance: {
        id: ctx.instance.id,
        connected,
      },
    });
  });

  return router;
}

export default createHealthRouter;
