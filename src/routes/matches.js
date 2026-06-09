import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { gameOrThrow, shouldAutoFinish, computeWinner, RPS_PICKS, rpsBeats } from '../lib/games.js';
import { generateCode } from '../lib/code.js';

const router = Router();

const PUBLIC_USER = { select: { id: true, pseudo: true, avatarUrl: true, createdAt: true } };
const MATCH_INCLUDE = { player1: PUBLIC_USER, player2: PUBLIC_USER };

// ─── Shifumi : 2 modes ──────────────────────────────────────────────────────
// IRL  : le créateur saisit tout le résultat d'un coup (winnerPseudo + 2 picks).
// REMOTE : le créateur commit son pick (caché), l'opponent commit le sien plus tard
//          via POST /matches/:id/shifumi-pick. Au second pick, le serveur résout.

const shifumiIrlBlock = z.object({
  mode: z.literal('irl').optional(), // défaut
  winnerPseudo: z.string().trim().min(1).max(24),
  winnerPick: z.enum(RPS_PICKS),
  loserPick: z.enum(RPS_PICKS),
});
const shifumiRemoteBlock = z.object({
  mode: z.literal('remote'),
  myPick: z.enum(RPS_PICKS),
});
const shifumiBlock = z.union([shifumiIrlBlock, shifumiRemoteBlock]);

const createBody = z.object({
  game: z.string().min(1),
  opponentPseudo: z.string().trim().min(1).max(24).optional().nullable(),
  shifumi: shifumiBlock.optional(),
});

const joinBody = z.object({
  code: z.string().trim().min(4).max(8).transform((s) => s.toUpperCase()),
});

const scoreBody = z.object({
  scoreP1: z.number().int().min(0).max(9999),
  scoreP2: z.number().int().min(0).max(9999),
  source: z.enum(['extension', 'web', 'manual']),
});

const shifumiPickBody = z.object({ pick: z.enum(RPS_PICKS) });

// POST /matches — création
router.post('/', requireAuth, async (req, res) => {
  const body = createBody.parse(req.body);
  gameOrThrow(body.game);

  if (body.game === 'shifumi') return createShifumi(req, res, body);

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
  let match;
  for (let i = 0; i < 5; i++) {
    const code = opponent ? null : generateCode(6);
    try {
      match = await prisma.match.create({ data: { ...base, code }, include: MATCH_INCLUDE });
      break;
    } catch (e) {
      if (e?.code !== 'P2002') throw e;
    }
  }
  if (!match) throw new HttpError(500, 'code_generation_failed', 'internal_error');
  res.status(201).json(maskFor(match, req.userId));
});

async function createShifumi(req, res, body) {
  if (!body.shifumi) throw new HttpError(400, 'shifumi_block_required', 'bad_request');
  if (!body.opponentPseudo) throw new HttpError(400, 'opponent_required_for_shifumi', 'bad_request');
  const opponent = await prisma.user.findUnique({ where: { pseudo: body.opponentPseudo } });
  if (!opponent) throw new HttpError(404, 'opponent_not_found', 'not_found');
  if (opponent.id === req.userId) throw new HttpError(400, 'cannot_play_self', 'bad_request');

  // ── REMOTE ─────────────────────────────────────────────────────────────
  if (body.shifumi.mode === 'remote') {
    const myPick = body.shifumi.myPick;
    const match = await prisma.match.create({
      data: {
        game: 'shifumi',
        player1Id: req.userId,
        player2Id: opponent.id,
        status: 'pending', // en attente du pick adverse
        source: 'web',
        scoreP1: 0,
        scoreP2: 0,
        // creatorPick masqué côté opponent jusqu'à la résolution
        metadata: { mode: 'remote', creatorPick: myPick },
      },
      include: MATCH_INCLUDE,
    });
    return res.status(201).json(maskFor(match, req.userId));
  }

  // ── IRL ────────────────────────────────────────────────────────────────
  const { winnerPseudo, winnerPick, loserPick } = body.shifumi;
  if (!rpsBeats(winnerPick, loserPick)) {
    throw new HttpError(400, 'invalid_shifumi_outcome', 'bad_request');
  }
  const meWon = winnerPseudo === req.pseudo;
  const opponentWon = winnerPseudo === opponent.pseudo;
  if (!meWon && !opponentWon) throw new HttpError(400, 'winner_not_in_match', 'bad_request');
  const winnerId = meWon ? req.userId : opponent.id;
  const match = await prisma.match.create({
    data: {
      game: 'shifumi',
      player1Id: req.userId,
      player2Id: opponent.id,
      status: 'finished',
      finishedAt: new Date(),
      scoreP1: meWon ? 1 : 0,
      scoreP2: meWon ? 0 : 1,
      winnerId,
      source: 'manual',
      metadata: {
        mode: 'irl',
        winnerPseudo: meWon ? req.pseudo : opponent.pseudo,
        loserPseudo: meWon ? opponent.pseudo : req.pseudo,
        winnerPick,
        loserPick,
      },
    },
    include: MATCH_INCLUDE,
  });
  res.status(201).json(maskFor(match, req.userId));
}

// POST /matches/:id/shifumi-pick — pick de l'opposant en mode remote ; déclenche la résolution.
router.post('/:id/shifumi-pick', requireAuth, async (req, res) => {
  const body = shifumiPickBody.parse(req.body);
  const m = await prisma.match.findUnique({ where: { id: req.params.id } });
  if (!m) throw new HttpError(404, 'match_not_found', 'not_found');
  if (m.game !== 'shifumi') throw new HttpError(400, 'not_a_shifumi_match', 'bad_request');
  if (m.status !== 'pending') throw new HttpError(409, 'match_not_pending', 'conflict');
  if (m.metadata?.mode !== 'remote') throw new HttpError(400, 'not_a_remote_shifumi', 'bad_request');
  if (m.player2Id !== req.userId) throw new HttpError(403, 'not_opponent', 'forbidden');

  const creatorPick = m.metadata?.creatorPick;
  if (!creatorPick) throw new HttpError(500, 'missing_creator_pick', 'internal_error');
  const opponentPick = body.pick;

  // Égalité ? On laisse pendant — chacun re-pick. Strict tie = on re-met pending sans pick côté
  // opposant (qui devra re-soumettre). On garde simple : si égalité, on rejette le pick et le
  // client peut re-proposer ; ou bien on résout en "match nul". Choix produit : on accepte
  // l'égalité comme match nul (winnerId null, scores 0-0, status finished).
  let scoreP1 = 0;
  let scoreP2 = 0;
  let winnerId = null;
  let winnerPseudo = null;
  let loserPseudo = null;
  let winnerPick = null;
  let loserPick = null;
  if (creatorPick === opponentPick) {
    // Match nul — pas de vainqueur, on ferme proprement.
  } else if (rpsBeats(creatorPick, opponentPick)) {
    scoreP1 = 1;
    winnerId = m.player1Id;
    winnerPick = creatorPick;
    loserPick = opponentPick;
  } else {
    scoreP2 = 1;
    winnerId = m.player2Id;
    winnerPick = opponentPick;
    loserPick = creatorPick;
  }

  // Pseudo lookup (un select court suffit)
  const [p1, p2] = await Promise.all([
    prisma.user.findUnique({ where: { id: m.player1Id }, select: { pseudo: true } }),
    prisma.user.findUnique({ where: { id: m.player2Id }, select: { pseudo: true } }),
  ]);
  if (winnerId === m.player1Id) { winnerPseudo = p1.pseudo; loserPseudo = p2.pseudo; }
  else if (winnerId === m.player2Id) { winnerPseudo = p2.pseudo; loserPseudo = p1.pseudo; }

  const updated = await prisma.match.update({
    where: { id: m.id },
    data: {
      status: 'finished',
      finishedAt: new Date(),
      scoreP1, scoreP2, winnerId,
      metadata: {
        mode: 'remote',
        creatorPick,
        opponentPick,
        ...(winnerPseudo ? { winnerPseudo, loserPseudo, winnerPick, loserPick } : {}),
        tie: winnerPseudo == null,
      },
    },
    include: MATCH_INCLUDE,
  });
  res.json(maskFor(updated, req.userId));
});

// POST /matches/join
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
  res.json(maskFor(updated, req.userId));
});

// PATCH /matches/:id/score
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
      scoreP1, scoreP2, source: body.source,
      ...(autoFinish ? { status: 'finished', finishedAt: new Date(), winnerId } : {}),
    },
    include: MATCH_INCLUDE,
  });
  res.json(maskFor(updated, req.userId));
});

// POST /matches/:id/finish
router.post('/:id/finish', requireAuth, async (req, res) => {
  const m = await prisma.match.findUnique({ where: { id: req.params.id } });
  if (!m) throw new HttpError(404, 'match_not_found', 'not_found');
  ensureParticipant(m, req.userId);
  if (m.status === 'finished' || m.status === 'cancelled') {
    return res.json(maskFor(await prisma.match.findUnique({ where: { id: m.id }, include: MATCH_INCLUDE }), req.userId));
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
  res.json(maskFor(updated, req.userId));
});

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
    where, orderBy: { createdAt: 'desc' }, take: 100, include: MATCH_INCLUDE,
  });
  res.json(list.map((m) => maskFor(m, req.userId)));
});

router.get('/:id', requireAuth, async (req, res) => {
  const m = await prisma.match.findUnique({ where: { id: req.params.id }, include: MATCH_INCLUDE });
  if (!m) throw new HttpError(404, 'match_not_found', 'not_found');
  res.json(maskFor(m, req.userId));
});

function ensureParticipant(m, userId) {
  if (m.player1Id !== userId && m.player2Id !== userId) {
    throw new HttpError(403, 'not_a_participant', 'forbidden');
  }
}

// Sérialise un match pour un viewer donné. Masque le pick adverse en mode shifumi-remote-pending.
function maskFor(m, viewerId) {
  const out = {
    id: m.id,
    game: m.game,
    code: m.code,
    status: m.status,
    scoreP1: m.scoreP1,
    scoreP2: m.scoreP2,
    source: m.source,
    metadata: m.metadata ?? null,
    createdAt: m.createdAt,
    finishedAt: m.finishedAt,
    player1Id: m.player1Id,
    player2Id: m.player2Id,
    winnerId: m.winnerId,
    player1: m.player1 ?? undefined,
    player2: m.player2 ?? undefined,
  };
  if (
    out.game === 'shifumi'
    && out.status === 'pending'
    && out.metadata?.mode === 'remote'
  ) {
    const isCreator = m.player1Id === viewerId;
    const meta = { ...out.metadata };
    if (!isCreator) {
      // L'opponent ne voit pas le pick du créateur tant qu'il n'a pas répondu.
      delete meta.creatorPick;
      meta.awaitingMyPick = true;
    } else {
      meta.awaitingOpponentPick = true;
    }
    out.metadata = meta;
  }
  return out;
}

export default router;
