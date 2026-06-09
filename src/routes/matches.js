import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { gameOrThrow, shouldAutoFinish, computeWinner } from '../lib/games.js';
import { generateCode } from '../lib/code.js';

const router = Router();

const PUBLIC_USER = { select: { id: true, pseudo: true, avatarUrl: true, createdAt: true } };
const MATCH_INCLUDE = { player1: PUBLIC_USER, player2: PUBLIC_USER };

const createBody = z.object({
  game: z.string().min(1),
  opponentPseudo: z.string().trim().min(1).max(24).optional().nullable(),
});

const joinBody = z.object({
  code: z.string().trim().min(4).max(8).transform((s) => s.toUpperCase()),
});

const scoreBody = z.object({
  scoreP1: z.number().int().min(0).max(9999),
  scoreP2: z.number().int().min(0).max(9999),
  source: z.enum(['extension', 'web', 'manual']),
});

// POST /matches — crée un match. Avec opponentPseudo existant → status active.
// Sinon → pending + code unique généré.
router.post('/', requireAuth, async (req, res) => {
  const body = createBody.parse(req.body);
  const g = gameOrThrow(body.game);
  let opponent = null;
  if (body.opponentPseudo) {
    opponent = await prisma.user.findUnique({ where: { pseudo: body.opponentPseudo } });
    if (!opponent) throw new HttpError(404, 'opponent_not_found', 'not_found');
    if (opponent.id === req.userId) throw new HttpError(400, 'cannot_play_self', 'bad_request');
  }

  const base = {
    game: body.game,
    player1Id: req.userId,
    player2Id: opponent?.id ?? null,
    status: opponent ? 'active' : 'pending',
  };

  // génère un code unique (rare collision : on retente jusqu'à 5 fois)
  let match;
  for (let i = 0; i < 5; i++) {
    const code = opponent ? null : generateCode(6);
    try {
      match = await prisma.match.create({
        data: { ...base, code },
        include: MATCH_INCLUDE,
      });
      break;
    } catch (e) {
      if (e?.code !== 'P2002') throw e; // autre erreur que collision code → on remonte
    }
  }
  if (!match) throw new HttpError(500, 'code_generation_failed', 'internal_error');
  res.status(201).json(toPublic(match, g));
});

// POST /matches/join — un second joueur rejoint via code, status → active
router.post('/join', requireAuth, async (req, res) => {
  const body = joinBody.parse(req.body);
  const m = await prisma.match.findUnique({ where: { code: body.code }, include: MATCH_INCLUDE });
  if (!m) throw new HttpError(404, 'match_not_found', 'not_found');
  if (m.status !== 'pending') throw new HttpError(409, 'match_not_pending', 'conflict');
  if (m.player1Id === req.userId) throw new HttpError(400, 'cannot_join_own_match', 'bad_request');

  const updated = await prisma.match.update({
    where: { id: m.id },
    data: { player2Id: req.userId, status: 'active' },
    include: MATCH_INCLUDE,
  });
  res.json(toPublic(updated));
});

// PATCH /matches/:id/score — réservé aux participants, fin auto si seuil atteint
router.patch('/:id/score', requireAuth, async (req, res) => {
  const body = scoreBody.parse(req.body);
  const m = await prisma.match.findUnique({ where: { id: req.params.id } });
  if (!m) throw new HttpError(404, 'match_not_found', 'not_found');
  ensureParticipant(m, req.userId);
  if (m.status !== 'active') throw new HttpError(409, 'match_not_active', 'conflict');

  const g = gameOrThrow(m.game);
  const scoreP1 = Math.min(body.scoreP1, g.maxScore);
  const scoreP2 = Math.min(body.scoreP2, g.maxScore);
  const autoFinish = shouldAutoFinish(m.game, scoreP1, scoreP2);

  const winnerId = autoFinish
    ? computeWinner({ scoreP1, scoreP2, player1Id: m.player1Id, player2Id: m.player2Id })
    : null;

  const updated = await prisma.match.update({
    where: { id: m.id },
    data: {
      scoreP1,
      scoreP2,
      source: body.source,
      ...(autoFinish
        ? { status: 'finished', finishedAt: new Date(), winnerId }
        : {}),
    },
    include: MATCH_INCLUDE,
  });
  res.json(toPublic(updated));
});

// POST /matches/:id/finish — termine manuellement et calcule winner
router.post('/:id/finish', requireAuth, async (req, res) => {
  const m = await prisma.match.findUnique({ where: { id: req.params.id } });
  if (!m) throw new HttpError(404, 'match_not_found', 'not_found');
  ensureParticipant(m, req.userId);
  if (m.status === 'finished' || m.status === 'cancelled') {
    return res.json(toPublic(await prisma.match.findUnique({ where: { id: m.id }, include: MATCH_INCLUDE })));
  }
  const winnerId = computeWinner({
    scoreP1: m.scoreP1, scoreP2: m.scoreP2,
    player1Id: m.player1Id, player2Id: m.player2Id,
  });
  const updated = await prisma.match.update({
    where: { id: m.id },
    data: { status: 'finished', finishedAt: new Date(), winnerId },
    include: MATCH_INCLUDE,
  });
  res.json(toPublic(updated));
});

// GET /matches?scope=me|all&game=
router.get('/', requireAuth, async (req, res) => {
  const scope = req.query.scope === 'all' ? 'all' : 'me';
  const game = typeof req.query.game === 'string' ? req.query.game : undefined;
  const where = {
    ...(game ? { game } : {}),
    ...(scope === 'me'
      ? { OR: [{ player1Id: req.userId }, { player2Id: req.userId }] }
      : {}),
  };
  const list = await prisma.match.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: MATCH_INCLUDE,
  });
  res.json(list.map((m) => toPublic(m)));
});

// GET /matches/:id — pour polling du score live (côté clients)
router.get('/:id', requireAuth, async (req, res) => {
  const m = await prisma.match.findUnique({
    where: { id: req.params.id },
    include: MATCH_INCLUDE,
  });
  if (!m) throw new HttpError(404, 'match_not_found', 'not_found');
  res.json(toPublic(m));
});

function ensureParticipant(m, userId) {
  if (m.player1Id !== userId && m.player2Id !== userId) {
    throw new HttpError(403, 'not_a_participant', 'forbidden');
  }
}

function toPublic(m) {
  return {
    id: m.id,
    game: m.game,
    code: m.code,
    status: m.status,
    scoreP1: m.scoreP1,
    scoreP2: m.scoreP2,
    source: m.source,
    createdAt: m.createdAt,
    finishedAt: m.finishedAt,
    player1Id: m.player1Id,
    player2Id: m.player2Id,
    winnerId: m.winnerId,
    player1: m.player1 ?? undefined,
    player2: m.player2 ?? undefined,
  };
}

export default router;
