import { Router } from 'express';
import { verify } from '../lib/jwt.js';
import { broadcaster } from '../lib/broadcaster.js';
import { HttpError } from '../middleware/error.js';

const router = Router();

// GET /events?token=<JWT>
// SSE. Auth via query (EventSource ne permet pas de set d'header personnalisé).
// La connexion reste ouverte ; le serveur push des events typés au fil de l'eau.
// Heartbeat toutes les 25s pour ne pas se faire couper par proxy/Traefik.
router.get('/', (req, res) => {
  const token = String(req.query.token || '');
  if (!token) throw new HttpError(401, 'missing_token', 'unauthorized');
  let payload;
  try { payload = verify(token); }
  catch { throw new HttpError(401, 'invalid_token', 'unauthorized'); }
  const userId = payload.sub;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // désactive le buffering de proxies
  res.flushHeaders?.();

  // Hello + reset event id (les clients peuvent reconnect-and-replay via Last-Event-ID
  // si on stocke un buffer, ce qu'on ne fait pas — chaque event est éphémère)
  res.write(`retry: 5000\n\n`);
  res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now(), userId })}\n\n`);

  broadcaster.add(userId, res);

  const heartbeat = setInterval(() => {
    try { res.write(`: ping ${Date.now()}\n\n`); }
    catch { /* socket morte, le close handler nettoiera */ }
  }, 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    broadcaster.remove(userId, res);
  });
});

export default router;
