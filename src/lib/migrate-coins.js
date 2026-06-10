// Mise à niveau des soldes existants : tout user avec moins de BASELINE jetons
// est remonté à BASELINE. Appelée une fois au démarrage du serveur.
// Idempotente : si tout le monde est déjà au-dessus, ne touche à rien.

import { prisma } from '../db/prisma.js';

const BASELINE = 500;

export async function bumpCoinsBaseline() {
  try {
    const r = await prisma.user.updateMany({
      where: { coins: { lt: BASELINE } },
      data:  { coins: BASELINE },
    });
    if (r.count > 0) {
      // eslint-disable-next-line no-console
      console.log(`[startup] coins baseline → ${BASELINE} appliqué à ${r.count} user(s)`);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[startup] bumpCoinsBaseline failed:', e?.message ?? e);
  }
}
