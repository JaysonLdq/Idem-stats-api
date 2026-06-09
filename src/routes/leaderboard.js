import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// GET /leaderboard?game=
// Renvoie [{ user, wins, losses, played, winrate }] trié par victoires desc.
// Compte sur tous les matchs finished : winnerId = nb de victoires côté ce user, le second
// joueur compte une défaite. Match nul (winnerId = null) : compte en played pour les deux,
// mais ni V ni D.
router.get('/', requireAuth, async (req, res) => {
  const game = typeof req.query.game === 'string' ? req.query.game : undefined;
  const finished = await prisma.match.findMany({
    where: { status: 'finished', ...(game ? { game } : {}) },
    select: { player1Id: true, player2Id: true, winnerId: true },
  });

  const stats = new Map(); // userId -> { wins, losses, played }
  const bump = (id, key) => {
    if (!id) return;
    const s = stats.get(id) || { wins: 0, losses: 0, played: 0 };
    s[key] += 1;
    stats.set(id, s);
  };
  for (const m of finished) {
    bump(m.player1Id, 'played');
    bump(m.player2Id, 'played');
    if (m.winnerId) {
      bump(m.winnerId, 'wins');
      const loserId = m.winnerId === m.player1Id ? m.player2Id : m.player1Id;
      bump(loserId, 'losses');
    }
  }

  // On enrichit avec les pseudos. Quand aucun jeu n'est filtré, on inclut aussi les users
  // sans match pour qu'ils apparaissent à 0 dans le classement.
  const includeIdleUsers = !game;
  const users = await prisma.user.findMany({
    where: includeIdleUsers ? undefined : { id: { in: [...stats.keys()] } },
    select: { id: true, pseudo: true, avatarUrl: true, createdAt: true },
  });

  const entries = users.map((u) => {
    const s = stats.get(u.id) || { wins: 0, losses: 0, played: 0 };
    const winrate = s.played === 0 ? 0 : s.wins / s.played;
    return { user: u, wins: s.wins, losses: s.losses, played: s.played, winrate };
  });

  entries.sort((a, b) => b.wins - a.wins || b.winrate - a.winrate || a.user.pseudo.localeCompare(b.user.pseudo));
  res.json(entries);
});

export default router;
