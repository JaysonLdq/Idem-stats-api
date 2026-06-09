import { verify } from '../lib/jwt.js';
import { HttpError } from './error.js';

export function requireAuth(req, _res, next) {
  const h = req.header('authorization') || '';
  if (!h.startsWith('Bearer ')) throw new HttpError(401, 'missing_token', 'unauthorized');
  const payload = verify(h.slice('Bearer '.length).trim());
  req.userId = payload.sub;
  req.pseudo = payload.pseudo;
  next();
}
