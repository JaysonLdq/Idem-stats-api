import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { gameOrThrow, shouldAutoFinish, computeWinner, RPS_PICKS, rpsBeats } from '../lib/games.js';
import { generateCode } from '../lib/code.js';
import { broadcaster } from '../lib/broadcaster.js';
import { awardMatchCoins } from '../lib/coins.js';
import { computeRewards } from '../lib/rewards.js';

// Helper : push un event "match.update" aux 2 participants (chacun avec son masquage).
function pushMatchUpdate(m, type = 'match.update') {
  if (m.player1Id) broadcaster.send(m.player1Id, type, maskFor(m, m.player1Id));
  if (m.player2Id) broadcaster.send(m.player2Id, type, maskFor(m, m.player2Id));
}

const router = Router();

const PUBLIC_USER = { select: { id: true, pseudo: true, avatarUrl: true, createdAt: true } };
const MATCH_INCLUDE = { player1: PUBLIC_USER, player2: PUBLIC_USER };

// ─── Shifumi : 2 modes ──────────────────────────────────────────────────────
// IRL  : le créateur saisit tout le résultat d'un coup (winnerPseudo + 2 picks).
// REMOTE : le créateur commit son pick (caché), l'opponent commit le sien plus tard
//          via POST /matches/:id/shifumi-pick. Au second pick, le serveur résout.

// "condition" = enjeu posé en début de duel ("celui qui perd paye", "le gagnant choisit
// le prochain bar"…). Optionnelle, ≤ 200 chars. Visible des deux côtés tout le temps.
const shifumiCondition = z.string().trim().max(200).optional().nullable();
const shifumiIrlBlock = z.object({
  mode: z.literal('irl').optional(), // défaut
  winnerPseudo: z.string().trim().min(1).max(24),
  winnerPick: z.enum(RPS_PICKS),
  loserPick: z.enum(RPS_PICKS),
  condition: shifumiCondition,
  // BO1 (défaut), BO3 ou BO5. En IRL c'est une saisie résultat-first : on note
  // juste la série et le pick final (du dernier round) — le score enregistré
  // est ceil(bestOf/2) pour le gagnant, 0 pour le perdant (sweep par défaut).
  bestOf: z.union([z.literal(1), z.literal(3), z.literal(5)]).optional(),
});
const shifumiRemoteBlock = z.object({
  mode: z.literal('remote'),
  myPick: z.enum(RPS_PICKS),
  condition: shifumiCondition,
  // BO1 (défaut) / BO3 / BO5. Premier à ceil(bestOf/2) wins gagne la série.
  bestOf: z.union([z.literal(1), z.literal(3), z.literal(5)]).optional(),
});
const shifumiBlock = z.union([shifumiIrlBlock, shifumiRemoteBlock]);

const createBody = z.object({
  game: z.string().min(1),
  opponentPseudo: z.string().trim().min(1).max(24).optional().nullable(),
  // mode = comment l'opponent est mis en relation avec moi :
  //  - 'local'  : on joue sur le même appareil, status passe direct à 'active' (défaut, compat)
  //  - 'remote' : invitation envoyée, l'opponent doit accepter via POST /matches/:id/accept
  mode: z.enum(['local', 'remote']).optional(),
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

  // Sans opponent → on génère un code et le match attend qu'un joueur rejoigne.
  // Avec opponent + mode 'remote' → invitation : pending, pas de code.
  // Avec opponent + mode 'local' (défaut) → match commence direct sur le même appareil.
  const wantsInvite = body.mode === 'remote';
  const status = !opponent ? 'pending' : (wantsInvite ? 'pending' : 'active');
  const meta = opponent && wantsInvite ? { invite: true } : null;

  const base = {
    game: body.game,
    player1Id: req.userId,
    player2Id: opponent?.id ?? null,
    status,
    ...(meta ? { metadata: meta } : {}),
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
  // SSE : invitation envoyée → notifie player2 ; sinon match local → on broadcast quand même
  // pour rafraîchir sa liste de matchs.
  pushMatchUpdate(match, wantsInvite ? 'match.invite' : 'match.update');
  res.status(201).json(maskFor(match, req.userId));
});

// Acceptation d'une invitation : seul player2 et seulement si status=pending.
router.post('/:id/accept', requireAuth, async (req, res) => {
  const m = await prisma.match.findUnique({ where: { id: req.params.id } });
  if (!m) throw new HttpError(404, 'match_not_found', 'not_found');
  if (m.player2Id !== req.userId) throw new HttpError(403, 'not_invitee', 'forbidden');
  if (m.status !== 'pending') throw new HttpError(409, 'match_not_pending', 'conflict');
  if (m.metadata?.invite !== true) throw new HttpError(400, 'not_an_invitation', 'bad_request');
  const updated = await prisma.match.update({
    where: { id: m.id },
    data: { status: 'active', metadata: { ...(m.metadata || {}), invite: false, acceptedAt: new Date().toISOString() } },
    include: MATCH_INCLUDE,
  });
  pushMatchUpdate(updated, 'match.update');
  res.json(maskFor(updated, req.userId));
});

// Annulation d'un match en cours : n'importe quel participant peut annuler
// tant que le match n'est pas déjà finished/cancelled. Marqué `cancelled` →
// ignoré par le classement, l'historique et les badges. Utile pour ne pas
// pollue les stats avec des matchs démarrés par erreur ou abandonnés.
router.post('/:id/cancel', requireAuth, async (req, res) => {
  const m = await prisma.match.findUnique({ where: { id: req.params.id } });
  if (!m) throw new HttpError(404, 'match_not_found', 'not_found');
  if (m.player1Id !== req.userId && m.player2Id !== req.userId) {
    throw new HttpError(403, 'not_a_participant', 'forbidden');
  }
  if (m.status === 'finished' || m.status === 'cancelled') {
    throw new HttpError(409, 'match_not_cancellable', 'conflict');
  }
  const updated = await prisma.match.update({
    where: { id: m.id },
    data: {
      status: 'cancelled',
      finishedAt: new Date(),
      // Préserve les metadata existants ET note qui a annulé + quand.
      metadata: { ...(m.metadata || {}), cancelledBy: req.userId, cancelledAt: new Date().toISOString() },
    },
    include: MATCH_INCLUDE,
  });
  pushMatchUpdate(updated, 'match.update');
  res.json(maskFor(updated, req.userId));
});

// Refus d'une invitation : player2 ou player1 peut annuler tant que pending+invite.
router.post('/:id/decline', requireAuth, async (req, res) => {
  const m = await prisma.match.findUnique({ where: { id: req.params.id } });
  if (!m) throw new HttpError(404, 'match_not_found', 'not_found');
  if (m.player1Id !== req.userId && m.player2Id !== req.userId) {
    throw new HttpError(403, 'not_a_participant', 'forbidden');
  }
  if (m.status !== 'pending') throw new HttpError(409, 'match_not_pending', 'conflict');
  if (m.metadata?.invite !== true) throw new HttpError(400, 'not_an_invitation', 'bad_request');
  const updated = await prisma.match.update({
    where: { id: m.id },
    data: { status: 'cancelled', finishedAt: new Date() },
    include: MATCH_INCLUDE,
  });
  pushMatchUpdate(updated, 'match.update');
  res.json(maskFor(updated, req.userId));
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
        // creatorPick masqué côté opponent jusqu'à la résolution.
        // round = 1 au départ. history = liste des rounds nul écoulés (pour ré-affichage).
        metadata: {
          mode: 'remote',
          creatorPick: myPick,
          round: 1,
          history: [],
          // BO1 = 1 manche unique (comportement legacy). BO3/BO5 = série en cours.
          bestOf: body.shifumi.bestOf || 1,
          seriesP1: 0,
          seriesP2: 0,
          ...(body.shifumi.condition ? { condition: body.shifumi.condition } : {}),
        },
      },
      include: MATCH_INCLUDE,
    });
    // SSE : challenge shifumi remote envoyé → notifie player2
    pushMatchUpdate(match, 'shifumi.challenge');
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
  const bestOf = body.shifumi.bestOf || 1;
  const targetWins = Math.ceil(bestOf / 2);
  const rewards = await computeRewards(req.userId, opponent.id, 'shifumi', winnerId);
  const match = await prisma.match.create({
    data: {
      game: 'shifumi',
      player1Id: req.userId,
      player2Id: opponent.id,
      status: 'finished',
      finishedAt: new Date(),
      scoreP1: meWon ? targetWins : 0,
      scoreP2: meWon ? 0 : targetWins,
      winnerId,
      source: 'manual',
      metadata: {
        mode: 'irl',
        winnerPseudo: meWon ? req.pseudo : opponent.pseudo,
        loserPseudo: meWon ? opponent.pseudo : req.pseudo,
        winnerPick,
        loserPick,
        bestOf,
        seriesP1: meWon ? targetWins : 0,
        seriesP2: meWon ? 0 : targetWins,
        rewards,
        ...(body.shifumi.condition ? { condition: body.shifumi.condition } : {}),
      },
    },
    include: MATCH_INCLUDE,
  });
  await awardMatchCoins(match.player1Id, match.player2Id, winnerId);
  res.status(201).json(maskFor(match, req.userId));
}

// POST /matches/:id/shifumi-pick — pick d'un joueur en mode remote.
// Comportement :
//   - Round 1 : creatorPick est déjà posé à la création, seul l'opponent envoie son pick.
//   - Round 2+ (après une égalité) : les 2 picks ont été reset, chacun re-soumet.
//   - Quand les 2 picks sont commis :
//     - Si rpsBeats() → status=finished, winner calculé.
//     - Si égalité → on push le round à history, on reset les 2 picks, round++,
//       status reste pending. Le client détecte le tie via "lastTieRound" et relance
//       l'UI de pick pour les deux joueurs.
router.post('/:id/shifumi-pick', requireAuth, async (req, res) => {
  const body = shifumiPickBody.parse(req.body);
  const m = await prisma.match.findUnique({ where: { id: req.params.id } });
  if (!m) throw new HttpError(404, 'match_not_found', 'not_found');
  if (m.game !== 'shifumi') throw new HttpError(400, 'not_a_shifumi_match', 'bad_request');
  if (m.status !== 'pending') throw new HttpError(409, 'match_not_pending', 'conflict');
  if (m.metadata?.mode !== 'remote') throw new HttpError(400, 'not_a_remote_shifumi', 'bad_request');

  const isP1 = m.player1Id === req.userId;
  const isP2 = m.player2Id === req.userId;
  if (!isP1 && !isP2) throw new HttpError(403, 'not_a_participant', 'forbidden');

  const meta = { ...(m.metadata || {}) };
  meta.history = meta.history || [];
  meta.round = meta.round || 1;

  // Pose le pick s'il n'est pas déjà posé pour ce round
  if (isP1) {
    if (meta.creatorPick) throw new HttpError(409, 'already_picked_this_round', 'conflict');
    meta.creatorPick = body.pick;
  } else {
    if (meta.opponentPick) throw new HttpError(409, 'already_picked_this_round', 'conflict');
    meta.opponentPick = body.pick;
  }

  // Pas encore les 2 picks → on attend l'autre, on stocke et on rend le match tel quel
  if (!meta.creatorPick || !meta.opponentPick) {
    delete meta.lastTieRound;
    const updated = await prisma.match.update({ where: { id: m.id }, data: { metadata: meta }, include: MATCH_INCLUDE });
    pushMatchUpdate(updated, 'match.update');
    return res.json(maskFor(updated, req.userId));
  }

  // Les 2 picks sont là → on résout ce round
  const { creatorPick, opponentPick } = meta;

  // Égalité → on relance un round
  if (creatorPick === opponentPick) {
    meta.history.push({ round: meta.round, creatorPick, opponentPick, tie: true });
    meta.lastTieRound = meta.round; // le client peut détecter "il vient d'y avoir un tie"
    meta.creatorPick = null;
    meta.opponentPick = null;
    meta.round += 1;
    const updated = await prisma.match.update({ where: { id: m.id }, data: { metadata: meta }, include: MATCH_INCLUDE });
    pushMatchUpdate(updated, 'match.update');
    return res.json(maskFor(updated, req.userId));
  }

  // Sinon : on désigne un gagnant DE LA MANCHE
  let roundWinnerId, winnerPick, loserPick;
  if (rpsBeats(creatorPick, opponentPick)) {
    roundWinnerId = m.player1Id; winnerPick = creatorPick; loserPick = opponentPick;
  } else {
    roundWinnerId = m.player2Id; winnerPick = opponentPick; loserPick = creatorPick;
  }
  const [p1, p2] = await Promise.all([
    prisma.user.findUnique({ where: { id: m.player1Id }, select: { pseudo: true } }),
    prisma.user.findUnique({ where: { id: m.player2Id }, select: { pseudo: true } }),
  ]);
  const roundWinnerPseudo = roundWinnerId === m.player1Id ? p1.pseudo : p2.pseudo;

  // Met à jour le score de la série
  const bestOf = meta.bestOf || 1;
  meta.seriesP1 = (meta.seriesP1 || 0) + (roundWinnerId === m.player1Id ? 1 : 0);
  meta.seriesP2 = (meta.seriesP2 || 0) + (roundWinnerId === m.player2Id ? 1 : 0);
  meta.history.push({ round: meta.round, creatorPick, opponentPick, winnerPseudo: roundWinnerPseudo });
  delete meta.lastTieRound;

  const targetWins = Math.ceil(bestOf / 2);
  const seriesOver = meta.seriesP1 >= targetWins || meta.seriesP2 >= targetWins;

  if (!seriesOver) {
    // Série en cours → on reset les picks et on avance d'un round
    meta.creatorPick = null;
    meta.opponentPick = null;
    meta.round += 1;
    const updated = await prisma.match.update({ where: { id: m.id }, data: { metadata: meta }, include: MATCH_INCLUDE });
    pushMatchUpdate(updated, 'match.update');
    return res.json(maskFor(updated, req.userId));
  }

  // Série terminée → vainqueur de série = vainqueur du match
  const seriesWinnerId = meta.seriesP1 >= targetWins ? m.player1Id : m.player2Id;
  const winnerPseudo = seriesWinnerId === m.player1Id ? p1.pseudo : p2.pseudo;
  const loserPseudo  = seriesWinnerId === m.player1Id ? p2.pseudo : p1.pseudo;
  meta.winnerPseudo = winnerPseudo;
  meta.loserPseudo = loserPseudo;
  meta.winnerPick = winnerPick;
  meta.loserPick = loserPick;

  // Compute rewards BEFORE marking the match as finished (so the "before" state
  // doesn't include this match) and stuff them in metadata.
  const shifumiRewards = await computeRewards(m.player1Id, m.player2Id, 'shifumi', seriesWinnerId);
  meta.rewards = shifumiRewards;
  const updated = await prisma.match.update({
    where: { id: m.id },
    data: {
      status: 'finished',
      finishedAt: new Date(),
      scoreP1: meta.seriesP1,
      scoreP2: meta.seriesP2,
      winnerId: seriesWinnerId,
      metadata: meta,
    },
    include: MATCH_INCLUDE,
  });
  await awardMatchCoins(m.player1Id, m.player2Id, seriesWinnerId);
  pushMatchUpdate(updated, 'shifumi.resolved');
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
  pushMatchUpdate(updated, 'match.update');
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
  const rewards = autoFinish ? await computeRewards(m.player1Id, m.player2Id, m.game, winnerId) : null;
  const updated = await prisma.match.update({
    where: { id: m.id },
    data: {
      scoreP1, scoreP2, source: body.source,
      ...(autoFinish ? {
        status: 'finished', finishedAt: new Date(), winnerId,
        metadata: { ...(m.metadata || {}), rewards },
      } : {}),
    },
    include: MATCH_INCLUDE,
  });
  if (autoFinish) await awardMatchCoins(m.player1Id, m.player2Id, winnerId);
  pushMatchUpdate(updated, 'match.update');
  res.json(maskFor(updated, req.userId));
});

// ─── Sync temps réel pour les jeux jouables en remote ─────────────────────
// Architecture host-authoritative :
//   - player1 (créateur) = HOST → fait tourner la game loop, broadcast l'état
//     à player2 via SSE event 'match.play.state'
//   - player2 (joiner)   = GUEST → envoie ses inputs au host via SSE event
//     'match.play.input' (clavier → direction canonique)
// Les 2 endpoints ci-dessous sont juste des relais : le serveur n'a aucune
// connaissance du jeu, il fait juste passer JSON arbitraire entre les 2
// participants. Sécurité : seuls les participants du match peuvent écrire.

const playInputBody = z.object({
  // Payload libre — chaque jeu définit son propre schéma. Limité 1ko côté
  // express.json() pour éviter les abus.
  payload: z.any(),
});

router.post('/:id/play/input', requireAuth, async (req, res) => {
  const body = playInputBody.parse(req.body);
  const m = await prisma.match.findUnique({
    where: { id: req.params.id },
    select: { id: true, player1Id: true, player2Id: true, status: true },
  });
  if (!m) throw new HttpError(404, 'match_not_found', 'not_found');
  if (m.player1Id !== req.userId && m.player2Id !== req.userId) {
    throw new HttpError(403, 'not_a_participant', 'forbidden');
  }
  if (m.status !== 'active') throw new HttpError(409, 'match_not_active', 'conflict');
  // L'input va à l'autre participant
  const otherId = m.player1Id === req.userId ? m.player2Id : m.player1Id;
  if (otherId) broadcaster.send(otherId, 'match.play.input', { matchId: m.id, from: req.userId, payload: body.payload });
  res.json({ ok: true });
});

// Relay emote — un participant déclenche un emote, on broadcast aux autres.
// Très permissif sur l'état du match (active OU pending OU finished) : un
// emote victoire/défaite peut tomber juste après la fin. Limité à des clés
// connues pour éviter d'injecter du HTML/un nom long via SSE.
const emoteBody = z.object({
  key: z.string().min(1).max(32).regex(/^[a-z0-9_-]+$/i),
});
router.post('/:id/emote', requireAuth, async (req, res) => {
  const body = emoteBody.parse(req.body);
  const m = await prisma.match.findUnique({
    where: { id: req.params.id },
    select: { id: true, player1Id: true, player2Id: true },
  });
  if (!m) throw new HttpError(404, 'match_not_found', 'not_found');
  if (m.player1Id !== req.userId && m.player2Id !== req.userId) {
    throw new HttpError(403, 'not_a_participant', 'forbidden');
  }
  const otherId = m.player1Id === req.userId ? m.player2Id : m.player1Id;
  if (otherId) {
    broadcaster.send(otherId, 'match.emote', {
      matchId: m.id, from: req.userId, key: body.key,
    });
  }
  res.json({ ok: true });
});

router.post('/:id/play/state', requireAuth, async (req, res) => {
  const body = playInputBody.parse(req.body);
  const m = await prisma.match.findUnique({
    where: { id: req.params.id },
    select: { id: true, player1Id: true, player2Id: true, status: true },
  });
  if (!m) throw new HttpError(404, 'match_not_found', 'not_found');
  if (m.player1Id !== req.userId && m.player2Id !== req.userId) {
    throw new HttpError(403, 'not_a_participant', 'forbidden');
  }
  if (m.status !== 'active') throw new HttpError(409, 'match_not_active', 'conflict');
  // L'état va à l'autre participant
  const otherId = m.player1Id === req.userId ? m.player2Id : m.player1Id;
  if (otherId) broadcaster.send(otherId, 'match.play.state', { matchId: m.id, payload: body.payload });
  res.json({ ok: true });
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
  const rewards = await computeRewards(m.player1Id, m.player2Id, m.game, winnerId);
  const updated = await prisma.match.update({
    where: { id: m.id },
    data: {
      status: 'finished', finishedAt: new Date(), winnerId,
      metadata: { ...(m.metadata || {}), rewards },
    },
    include: MATCH_INCLUDE,
  });
  await awardMatchCoins(m.player1Id, m.player2Id, winnerId);
  pushMatchUpdate(updated, 'match.update');
  res.json(maskFor(updated, req.userId));
});

router.get('/', requireAuth, async (req, res) => {
  const scope = req.query.scope === 'all' ? 'all' : 'me';
  const game = typeof req.query.game === 'string' ? req.query.game : undefined;
  const userPseudo = typeof req.query.userPseudo === 'string' ? req.query.userPseudo : undefined;

  // userPseudo override scope=me : "donne-moi les matchs de N'IMPORTE QUEL joueur".
  // Sert au front pour afficher l'historique d'autres profils.
  let participantFilter = null;
  if (userPseudo) {
    const target = await prisma.user.findUnique({ where: { pseudo: userPseudo }, select: { id: true } });
    if (!target) return res.json([]); // user inexistant → liste vide, pas 404
    participantFilter = { OR: [{ player1Id: target.id }, { player2Id: target.id }] };
  } else if (scope === 'me') {
    participantFilter = { OR: [{ player1Id: req.userId }, { player2Id: req.userId }] };
  }

  const where = {
    ...(game ? { game } : {}),
    ...(participantFilter ?? {}),
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
    // Masquage symétrique : chacun ne voit que son propre pick tant que les 2 ne sont pas
    // posés. Round 1 : creatorPick était toujours là côté creator, opponentPick côté opponent.
    // Round 2+ après un tie : pareil — round réinitialisé, chacun pose à nouveau.
    if (isCreator) {
      // Côté créateur : on cache son éventuel adversaire (toujours null en round-pending,
      // mais on durcit au cas où) et on annonce "en attente de l'adversaire" si lui a posé.
      delete meta.opponentPick;
      if (meta.creatorPick && !out.metadata.opponentPick) meta.awaitingOpponentPick = true;
      if (!meta.creatorPick) meta.awaitingMyPick = true;
    } else {
      delete meta.creatorPick;
      if (meta.opponentPick && !out.metadata.creatorPick) meta.awaitingOpponentPick = true;
      if (!meta.opponentPick) meta.awaitingMyPick = true;
    }
    out.metadata = meta;
  }
  return out;
}

export default router;
