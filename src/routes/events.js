import { Router } from 'express';
import { verify } from '../lib/jwt.js';
import { HttpError } from '../middleware/error.js';
import { addClient, removeClient } from '../lib/sse.js';

const router = Router();

// GET /events?token=JWT — EventSource ne peut pas envoyer d'en-tête Authorization,
// donc le token transit par le query-param.
router.get('/', async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  if (!token) throw new HttpError(401, 'missing_token', 'unauthorized');

  const payload = verify(token); // lance HttpError(401) si invalide
  const userId = payload.sub;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(': connected\n\n');

  addClient(userId, res);

  const ping = setInterval(() => {
    res.write(': ping\n\n');
  }, 30_000);

  req.on('close', () => {
    clearInterval(ping);
    removeClient(userId, res);
  });
});

export default router;
