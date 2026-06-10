import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { computeBadges } from '../lib/badges.js';

const router = Router();

// GET /badges/:pseudo
// Renvoie les badges du user nommé. Computation à la volée (volume petit).
router.get('/:pseudo', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { pseudo: req.params.pseudo },
    select: { id: true, pseudo: true, avatarUrl: true, createdAt: true },
  });
  if (!user) throw new HttpError(404, 'user_not_found', 'not_found');

  // On a besoin de TOUS les matchs finished pour calculer les superlatifs par jeu
  // (Monster / Pue sa mère). Pour les badges perso (winrate, streak), un filtre suffirait,
  // mais on évite la double-query : on récupère tout.
  const allMatches = await prisma.match.findMany({
    where: { status: 'finished' },
    select: {
      game: true, status: true,
      player1Id: true, player2Id: true, winnerId: true,
      finishedAt: true,
    },
  });

  const badges = computeBadges({ userId: user.id, pseudo: user.pseudo, allMatches });
  res.json({ user, badges });
});

export default router;
