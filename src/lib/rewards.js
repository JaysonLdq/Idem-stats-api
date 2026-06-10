// Calcule les rewards (ELO delta + coins delta) d'un match qui va être finalisé.
// À APPELER AVANT de marquer le match en 'finished' (pour que computeElos ne
// l'inclue pas dans le "before"). On stocke ensuite le résultat dans
// match.metadata.rewards pour qu'il soit visible à toutes les lectures
// suivantes (notamment au moment où le front affiche le modal de résultat).

import { prisma } from '../db/prisma.js';
import { computeElos, updateRatings, INITIAL_ELO } from './elo.js';
import { REWARD_WIN, REWARD_LOSS, REWARD_DRAW } from './coins.js';

/**
 * @returns {Promise<{
 *   winnerId: string|null,
 *   p1?: { eloDelta: number, coinsDelta: number, eloBefore: number, eloAfter: number },
 *   p2?: { eloDelta: number, coinsDelta: number, eloBefore: number, eloAfter: number },
 * }>}
 */
export async function computeRewards(player1Id, player2Id, game, winnerId) {
  // Pas de p2 → match local sans adversaire, pas de rewards à calculer.
  if (!player1Id || !player2Id) return { winnerId: winnerId ?? null };

  // Tous les matchs finished SAUF celui-ci (qui n'est pas encore finalisé).
  const others = await prisma.match.findMany({
    where: { status: 'finished' },
    select: { game: true, player1Id: true, player2Id: true, winnerId: true, finishedAt: true },
    orderBy: { finishedAt: 'asc' },
  });
  const ratings = computeElos(others);
  const a = ratings.get(`${player1Id}|${game}`) ?? { rating: INITIAL_ELO, games: 0 };
  const b = ratings.get(`${player2Id}|${game}`) ?? { rating: INITIAL_ELO, games: 0 };

  const scoreA = winnerId === player1Id ? 1 : winnerId === player2Id ? 0 : 0.5;
  const { newA, newB, deltaA, deltaB } = updateRatings(a.rating, b.rating, scoreA, a.games, b.games);

  const drawn = !winnerId;
  const p1Coins = drawn ? REWARD_DRAW : (winnerId === player1Id ? REWARD_WIN : REWARD_LOSS);
  const p2Coins = drawn ? REWARD_DRAW : (winnerId === player2Id ? REWARD_WIN : REWARD_LOSS);

  return {
    winnerId: winnerId ?? null,
    p1: { eloBefore: a.rating, eloAfter: newA, eloDelta: deltaA, coinsDelta: p1Coins },
    p2: { eloBefore: b.rating, eloAfter: newB, eloDelta: deltaB, coinsDelta: p2Coins },
  };
}
