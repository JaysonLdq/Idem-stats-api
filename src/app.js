import express from 'express';
import cors from 'cors';
import { errorHandler, notFound } from './middleware/error.js';

export function buildApp() {
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  const origins = (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim());
  app.use(
    cors({
      origin(origin, cb) {
        if (!origin) return cb(null, true);
        if (origins.includes('*')) return cb(null, true);
        const match = origins.some((o) => {
          if (o === origin) return true;
          if (o.endsWith('*')) return origin.startsWith(o.slice(0, -1));
          return false;
        });
        cb(match ? null : new Error('cors_blocked'), match);
      },
      credentials: false,
    }),
  );

  app.get('/health', (_req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });

  // les autres routes seront branchées au fur et à mesure des features
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
