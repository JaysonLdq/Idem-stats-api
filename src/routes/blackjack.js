import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { broadcaster } from '../lib/broadcaster.js';
import * as rooms from '../lib/blackjack-rooms.js';

const router = Router();

// ─ Wiring du module rooms ──────────────────────────────────────────────
// On branche le broadcaster SSE et l'application des coins via callbacks
// pour éviter une dépendance circulaire (rooms ne connaît pas prisma).
rooms.setBroadcaster((userId, type, data) => broadcaster.send(userId, type, data));
rooms.setApplyCoins(async (userId, delta) => {
  if (delta === 0) return;
  await prisma.user.update({
    where: { id: userId },
    data: { coins: { increment: delta } },
  });
});

// Cleanup périodique des rooms vides / seats idle. Sentinelle globalThis
// pour ne pas re-créer le timer au hot-reload côté dev.
if (!globalThis.__blackjackCleanupStarted) {
  globalThis.__blackjackCleanupStarted = true;
  setInterval(() => rooms.tickCleanup(), 30_000);
}

// ─ Legacy : /round (solo trust-mode) ───────────────────────────────────
// Gardé pour ne pas casser l'ancienne page solo en attendant que tous les
// clients aient migré. Le nouveau client passe par /rooms/*.
const roundBody = z.object({
  bet:    z.number().int().min(1).max(10000),
  payout: z.number().int().min(0).max(50000),
  meta:   z.any().optional(),
});
router.post('/round', requireAuth, async (req, res) => {
  const body = roundBody.parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { coins: true } });
  if (!user) throw new HttpError(401, 'user_gone', 'unauthorized');
  if (user.coins < body.bet) throw new HttpError(400, 'insufficient_coins', 'bad_request');
  if (body.payout > body.bet * 3) throw new HttpError(400, 'payout_too_high', 'bad_request');
  const delta = -body.bet + body.payout;
  const updated = await prisma.user.update({
    where: { id: req.userId },
    data: { coins: { increment: delta } },
    select: { coins: true },
  });
  res.json({ coins: updated.coins, delta });
});

// ─ ROOMS ───────────────────────────────────────────────────────────────
// POST /blackjack/rooms/join — rejoint une room dispo (ou en crée une si
// toutes pleines) et renvoie le snapshot initial pour l'utilisateur.
router.post('/rooms/join', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { id: true, pseudo: true, avatarUrl: true },
  });
  if (!user) throw new HttpError(401, 'user_gone', 'unauthorized');
  const { room, seatIndex } = rooms.joinPlayer(user);
  res.json({ seatIndex, room: rooms.snapshotRoom(room, user.id) });
});

router.post('/rooms/leave', requireAuth, async (req, res) => {
  rooms.leaveByUserId(req.userId);
  res.json({ ok: true });
});

router.get('/rooms', requireAuth, async (_req, res) => {
  res.json({ rooms: rooms.listRooms() });
});

router.post('/rooms/heartbeat', requireAuth, async (req, res) => {
  const ok = rooms.heartbeat(req.userId);
  res.json({ ok });
});

// ─ Actions de gameplay ────────────────────────────────────────────────
const betBody = z.object({ bet: z.number().int().min(1).max(10000) });
router.post('/rooms/bet', requireAuth, async (req, res) => {
  const { bet } = betBody.parse(req.body);
  // Prélève le bet sur les coins. Si pas assez → 400.
  const u = await prisma.user.findUnique({ where: { id: req.userId }, select: { coins: true } });
  if (!u) throw new HttpError(401, 'user_gone', 'unauthorized');
  if (u.coins < bet) throw new HttpError(400, 'insufficient_coins', 'bad_request');
  await prisma.user.update({ where: { id: req.userId }, data: { coins: { decrement: bet } } });
  try {
    rooms.placeBet(req.userId, bet);
  } catch (e) {
    // Rollback du débit en cas d'erreur métier (rare).
    await prisma.user.update({ where: { id: req.userId }, data: { coins: { increment: bet } } });
    throw new HttpError(400, e.message, 'bad_request');
  }
  res.json({ ok: true });
});

router.post('/rooms/hit', requireAuth, async (req, res) => {
  try { rooms.hit(req.userId); } catch (e) { throw new HttpError(400, e.message, 'bad_request'); }
  res.json({ ok: true });
});

router.post('/rooms/stand', requireAuth, async (req, res) => {
  try { rooms.stand(req.userId); } catch (e) { throw new HttpError(400, e.message, 'bad_request'); }
  res.json({ ok: true });
});

// /double et /split prélèvent un bet supplémentaire avant l'appel. On
// passe un callback pour rester dans la même transaction logique :
// si la lib jette (pas splittable / hand done), on n'a rien débité.
router.post('/rooms/double', requireAuth, async (req, res) => {
  const userId = req.userId;
  let charged = 0;
  try {
    await rooms.doubleDown(userId, async (uid, extra) => {
      const u = await prisma.user.findUnique({ where: { id: uid }, select: { coins: true } });
      if (!u || u.coins < extra) throw new Error('insufficient_coins');
      await prisma.user.update({ where: { id: uid }, data: { coins: { decrement: extra } } });
      charged = extra;
    });
  } catch (e) {
    if (charged > 0) {
      await prisma.user.update({ where: { id: userId }, data: { coins: { increment: charged } } });
    }
    throw new HttpError(400, e.message, 'bad_request');
  }
  res.json({ ok: true });
});

router.post('/rooms/split', requireAuth, async (req, res) => {
  const userId = req.userId;
  let charged = 0;
  try {
    await rooms.split(userId, async (uid, extra) => {
      const u = await prisma.user.findUnique({ where: { id: uid }, select: { coins: true } });
      if (!u || u.coins < extra) throw new Error('insufficient_coins');
      await prisma.user.update({ where: { id: uid }, data: { coins: { decrement: extra } } });
      charged = extra;
    });
  } catch (e) {
    if (charged > 0) {
      await prisma.user.update({ where: { id: userId }, data: { coins: { increment: charged } } });
    }
    throw new HttpError(400, e.message, 'bad_request');
  }
  res.json({ ok: true });
});

export default router;
