import jwt from 'jsonwebtoken';
import { HttpError } from '../middleware/error.js';

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET missing');
  return s;
}

export function sign(user) {
  const expiresIn = process.env.JWT_EXPIRES_IN || '30d';
  return jwt.sign({ sub: user.id, pseudo: user.pseudo }, secret(), { expiresIn });
}

export function verify(token) {
  try {
    return jwt.verify(token, secret());
  } catch {
    throw new HttpError(401, 'invalid_token', 'unauthorized');
  }
}
