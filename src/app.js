import express from 'express';
import cors from 'cors';
import { errorHandler, notFound } from './middleware/error.js';
import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import matchesRoutes from './routes/matches.js';
import leaderboardRoutes from './routes/leaderboard.js';

export function buildApp() {
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  const origins = (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const allowAll = origins.length === 0 || origins.includes('*');

  app.use(
    cors({
      // IMPORTANT : on ne JETTE JAMAIS d'erreur ici. Si l'origin n'est pas autorisée,
      // on appelle cb(null, false) → la réponse part SANS les headers CORS, et le
      // navigateur affiche un vrai "missing CORS header" (pas un 500 sans header).
      origin(origin, cb) {
        if (!origin) return cb(null, true); // requêtes serveur-à-serveur, curl, etc.
        if (allowAll) return cb(null, true);
        const ok = origins.some((o) => matchOrigin(o, origin));
        cb(null, ok);
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
  app.use('/leaderboard', wrapAsync(leaderboardRoutes));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

// Match d'une origine vs un motif. Supporte :
//   - exact            : "https://idem.example.com"
//   - suffix wildcard  : "chrome-extension://*"   → matche "chrome-extension://abc"
//   - prefix wildcard  : "*.docker.localhost"     → matche "http(s)://x.docker.localhost"
//   - "*" tout seul    : tout autoriser (géré en amont via allowAll)
function matchOrigin(pattern, origin) {
  if (pattern === origin) return true;
  if (pattern.endsWith('*')) return origin.startsWith(pattern.slice(0, -1));
  if (pattern.startsWith('*.')) {
    const host = pattern.slice(2);
    try {
      const u = new URL(origin);
      return u.hostname === host || u.hostname.endsWith('.' + host);
    } catch {
      return false;
    }
  }
  return false;
}

// Bridge entre nos handlers async (await) et Express 4 (qui n'attrape pas les promesses rejetées par défaut).
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
