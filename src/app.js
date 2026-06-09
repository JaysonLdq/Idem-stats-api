import express from 'express';
import cors from 'cors';
import { errorHandler, notFound } from './middleware/error.js';
import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import matchesRoutes from './routes/matches.js';

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

  app.use('/auth', wrapAsync(authRoutes));
  app.use('/me', wrapAsync(meRoutes));
  app.use('/matches', wrapAsync(matchesRoutes));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

// Bridge entre nos handlers async (await) et Express 4 (qui n'attrape pas les promesses rejetées par défaut).
// On enveloppe le routeur pour relayer toute exception vers next().
function wrapAsync(router) {
  router.stack.forEach((layer) => {
    if (!layer.route) return;
    layer.route.stack.forEach((s) => {
      if (s.handle.length !== 4) {
        const fn = s.handle;
        s.handle = (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
      }
    });
  });
  return router;
}

