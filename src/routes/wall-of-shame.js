import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const PUBLIC_USER = { select: { id: true, pseudo: true, avatarUrl: true } };

// GET /wall-of-shame — répertoire des 5-0 au Basket Random.
//   - latest : le plus récent 5-0 (pour la breaking news en haut du classement)
//   - ranking: chaque joueur ayant pris au moins un 5-0, trié par nb pris desc
// On considère strictement les matchs basket_random finished avec un score
// 5-0 (côté indifférent : on regarde scoreP1/scoreP2). Les 6-0 (balle double
// point gagnante) ne comptent PAS — c'est spécifiquement le perfect 5-0.
router.get('/', requireAuth, async (_req, res) => {
  const matches = await prisma.match.findMany({
    where: {
      game: 'basket_random',
      status: 'finished',
      OR: [
        { AND: [{ scoreP1: 5 }, { scoreP2: 0 }] },
        { AND: [{ scoreP1: 0 }, { scoreP2: 5 }] },
      ],
    },
    include: { player1: PUBLIC_USER, player2: PUBLIC_USER },
    orderBy: { finishedAt: 'desc' },
  });

  // Latest 5-0 (peut être null si personne ne s'est encore pris de fessée)
  const latestMatch = matches[0] ?? null;
  const latest = latestMatch
    ? {
        match: { id: latestMatch.id, finishedAt: latestMatch.finishedAt },
        loser:  latestMatch.scoreP1 === 0 ? latestMatch.player1 : latestMatch.player2,
        winner: latestMatch.scoreP1 === 5 ? latestMatch.player1 : latestMatch.player2,
      }
    : null;

  // Ranking : compte les 5-0 pris par chaque user
  const byUser = new Map();
  for (const m of matches) {
    const loser = m.scoreP1 === 0 ? m.player1 : m.player2;
    if (!loser) continue;
    const cur = byUser.get(loser.id) || { user: loser, count: 0, lastAt: null };
    cur.count += 1;
    if (!cur.lastAt || (m.finishedAt && m.finishedAt > cur.lastAt)) cur.lastAt = m.finishedAt;
    byUser.set(loser.id, cur);
  }
  const ranking = [...byUser.values()].sort((a, b) => b.count - a.count || (b.lastAt - a.lastAt));

  res.json({ latest, ranking, totalEvents: matches.length });
});

export default router;
