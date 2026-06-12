import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { sign } from '../lib/jwt.js';
import { HttpError } from '../middleware/error.js';

const router = Router();

const credentials = z.object({
  pseudo: z.string().trim().min(3).max(24).regex(/^[A-Za-z0-9_.-]+$/, 'pseudo_format'),
  password: z.string().min(6).max(128),
});

function publicUser(u) {
  return { id: u.id, pseudo: u.pseudo, avatarUrl: u.avatarUrl ?? null, createdAt: u.createdAt };
}

router.post('/register', async (req, res) => {
  const body = credentials.parse(req.body);
  const rounds = Number(process.env.BCRYPT_ROUNDS || 10);
  const passwordHash = await bcrypt.hash(body.password, rounds);
  const user = await prisma.user.create({
    data: { pseudo: body.pseudo, passwordHash },
  });
  res.status(201).json({ token: sign(user), user: publicUser(user) });
});

router.post('/login', async (req, res) => {
  const body = credentials.parse(req.body);
  const user = await prisma.user.findUnique({ where: { pseudo: body.pseudo } });
  if (!user) throw new HttpError(401, 'invalid_credentials', 'unauthorized');
  const ok = await bcrypt.compare(body.password, user.passwordHash);
  if (!ok) throw new HttpError(401, 'invalid_credentials', 'unauthorized');
  // Compte banni → on rejette à la connexion. L'utilisateur voit un
  // message dédié côté front (cf. humanize() dans LoginPage).
  if (user.banned) throw new HttpError(403, 'banned', 'forbidden');
  res.json({ token: sign(user), user: publicUser(user) });
});

export default router;
