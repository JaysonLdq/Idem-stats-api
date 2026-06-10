// Système de monnaie : gains des matchs 1v1 + dépenses casino.
// Modèle simple "friend trust" : pas de signature serveur, le client peut
// envoyer un payout truqué — c'est entre potes, on assume.

import { prisma } from '../db/prisma.js';

// Récompenses d'un match finished. Appelée à la fin de finishMatch +
// auto-finish dans patchScore. Idempotente sur les nuls (on crédite quand
// même les 10 jetons de participation à chacun).
export const REWARD_WIN = 50;
export const REWARD_LOSS = 10;
export const REWARD_DRAW = 25;

/**
 * Crédite les jetons d'un match qui vient d'être finalisé. winnerId peut
 * être null (nul) auquel cas chaque joueur reçoit REWARD_DRAW.
 *
 * @param {string} player1Id
 * @param {string|null} player2Id
 * @param {string|null} winnerId
 */
export async function awardMatchCoins(player1Id, player2Id, winnerId) {
  if (!player1Id) return;
  const updates = [];
  if (!winnerId) {
    // Nul : les deux empochent REWARD_DRAW
    updates.push(prisma.user.update({ where: { id: player1Id }, data: { coins: { increment: REWARD_DRAW } } }));
    if (player2Id) updates.push(prisma.user.update({ where: { id: player2Id }, data: { coins: { increment: REWARD_DRAW } } }));
  } else {
    const loserId = winnerId === player1Id ? player2Id : player1Id;
    updates.push(prisma.user.update({ where: { id: winnerId }, data: { coins: { increment: REWARD_WIN } } }));
    if (loserId) updates.push(prisma.user.update({ where: { id: loserId }, data: { coins: { increment: REWARD_LOSS } } }));
  }
  await Promise.all(updates);
}
