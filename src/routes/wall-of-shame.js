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

  // Helper de mapping match → entrée breaking-news (loser/winner + meta)
  const toEntry = (m) => ({
    match: { id: m.id, finishedAt: m.finishedAt },
    loser:  m.scoreP1 === 0 ? m.player1 : m.player2,
    winner: m.scoreP1 === 5 ? m.player1 : m.player2,
  });

  // Latest 5-0 (peut être null si personne ne s'est encore pris de fessée)
  const latest = matches[0] ? toEntry(matches[0]) : null;

  // Tous les 5-0 datant de moins d'1h → pour le ticker breaking-news qui
  // tourne en haut du site. Si rien dans la dernière heure, le ticker est
  // masqué côté client.
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recent = matches
    .filter((m) => m.finishedAt && m.finishedAt.getTime() > oneHourAgo)
    .map(toEntry);

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

  res.json({ latest, recent, ranking, totalEvents: matches.length });
});

export default router;
