import express from 'express';
import cors from 'cors';
import { errorHandler, notFound } from './middleware/error.js';
import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import matchesRoutes from './routes/matches.js';
import leaderboardRoutes from './routes/leaderboard.js';
import friendsRoutes from './routes/friends.js';
import { UPLOAD_ROOT, ensureAvatarsDir } from './lib/avatar-storage.js';

export function buildApp() {
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  const origins = (process.env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
  const allowAll = origins.length === 0 || origins.includes('*');
  const isTest = process.env.NODE_ENV === 'test';

  // Log d'effective au démarrage (silencieux en test) — utile pour diagnostiquer
  // "pourquoi mon front se prend du CORS ?"
  if (!isTest) {
    // eslint-disable-next-line no-console
    console.log(`[idem-stats-api] CORS = ${allowAll ? '* (allow all)' : origins.join(' , ')}`);
  }

  app.use(
    cors({
      // On ne JETTE JAMAIS d'erreur ici (sinon Express renvoie 500 sans header CORS,
      // ce qui empile les erreurs côté navigateur). On répond cb(null, false) → la
      // réponse part sans Access-Control-Allow-Origin et le navigateur affiche le
      // vrai message CORS attendu.
      origin(origin, cb) {
        if (!origin) return cb(null, true); // requêtes serveur-à-serveur, curl, etc.
        if (allowAll) return cb(null, true);
        const ok = origins.some((o) => matchOrigin(o, origin));
        if (!ok && !isTest) {
          // eslint-disable-next-line no-console
          console.warn(`[idem-stats-api] CORS REJECT origin="${origin}" — not in [${origins.join(', ')}]`);
        }
        cb(null, ok);
      },
      credentials: false,
    }),
  );

  // Servir les avatars uploadés. On crée le dossier si besoin (idempotent).
  ensureAvatarsDir().catch(() => {});
  app.use(
    '/uploads',
    // cache simple : 7 jours, immutable (les filenames contiennent un timestamp donc jamais réutilisés)
    express.static(UPLOAD_ROOT, { maxAge: '7d', immutable: true, fallthrough: false }),
  );

  app.get('/health', (_req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });

  app.use('/auth', wrapAsync(authRoutes));
  app.use('/me', wrapAsync(meRoutes));
  app.use('/matches', wrapAsync(matchesRoutes));
  app.use('/leaderboard', wrapAsync(leaderboardRoutes));
  app.use('/friends', wrapAsync(friendsRoutes));

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

// Match d'une origine vs un motif. Supporte :
//   - exact            : "https://idem.example.com"
//   - suffix wildcard  : "chrome-extension://*"   → matche "chrome-extension://abc"
//   - prefix wildcard  : "*.docker.localhost"     → matche n'importe quel sous-domaine
//                                                   en http ou https
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
