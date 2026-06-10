import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';

const router = Router();

// POST /blackjack/round
// Modèle friend-trust : le client envoie le résultat de la manche (bet +
// payout calculé localement par les règles du blackjack), le serveur
// valide juste que l'user a la mise et applique le delta sur ses coins.
//
// Payout attendu :
//   - Lost       : 0
//   - Push (nul) : bet
//   - Win        : bet × 2
//   - Blackjack  : bet × 2.5 (arrondi à l'entier)
//   - Surrender  : bet / 2 (si on l'ajoute plus tard)
//
// Le serveur ne re-simule pas le jeu — c'est entre potes, pas un casino
// légalement régulé. On pourra durcir (rng serveur + signature) si abus.
const roundBody = z.object({
  bet:    z.number().int().min(1).max(10000),
  payout: z.number().int().min(0).max(50000),
  // Métadonnée libre pour debug / replay (mains, etc.) — non utilisée côté serveur.
  meta:   z.any().optional(),
});

router.post('/round', requireAuth, async (req, res) => {
  const body = roundBody.parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { coins: true } });
  if (!user) throw new HttpError(401, 'user_gone', 'unauthorized');
  if (user.coins < body.bet) throw new HttpError(400, 'insufficient_coins', 'bad_request');
  // Borne payout max raisonnable : 3 × bet (blackjack arrondi). Au-delà = triche.
  if (body.payout > body.bet * 3) throw new HttpError(400, 'payout_too_high', 'bad_request');
  const delta = -body.bet + body.payout;
  const updated = await prisma.user.update({
    where: { id: req.userId },
    data: { coins: { increment: delta } },
    select: { coins: true },
  });
  res.json({ coins: updated.coins, delta });
});

export default router;
