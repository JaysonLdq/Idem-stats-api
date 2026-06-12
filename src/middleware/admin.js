import { verify } from '../lib/jwt.js';
import { prisma } from '../db/prisma.js';

// Garde-fou admin. Trois voies d'accès :
//   1. Header `x-admin-key` égal à process.env.ADMIN_API_KEY → bypass
//      complet sans avoir besoin d'un compte. Utile pour les scripts
//      d'ops ou un reset d'urgence. Désactivé si la variable d'env est
//      absente côté serveur.
//   2. JWT Bearer dont le `pseudo` est dans process.env.ADMIN_PSEUDOS
//      (séparateur virgule). Voie historique.
//   3. JWT Bearer d'un user dont user.role === 'admin' en DB. Permet
//      de promouvoir des admins sans toucher au .env de prod (set via
//      la voie clé API uniquement, cf. routes/admin.js).
//
// Quand on passe par l'API key, req.isAdminKey = true et req.userId =
// null. Sinon req.userId et req.pseudo sont posés comme requireAuth.

export async function requireAdmin(req, res, next) {
  // 1) Voie API key
  const provided = req.header('x-admin-key');
  const expected = process.env.ADMIN_API_KEY;
  if (provided && expected && safeEq(provided, expected)) {
    req.isAdminKey = true;
    req.userId = null;
    req.pseudo = null;
    return next();
  }

  // 2/3) Voies JWT — on extrait le token, puis on check pseudo env OU role DB
  const h = req.header('authorization') || '';
  if (!h.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing_token' });
  }
  let payload;
  try {
    payload = verify(h.slice('Bearer '.length).trim());
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
  req.userId = payload.sub;
  req.pseudo = payload.pseudo;

  const envPseudos = new Set(
    (process.env.ADMIN_PSEUDOS || '').split(',').map((s) => s.trim()).filter(Boolean),
  );
  if (req.pseudo && envPseudos.has(req.pseudo)) return next();

  // Sinon, check role DB (1 query par requête admin — c'est rare).
  if (req.userId) {
    try {
      const u = await prisma.user.findUnique({ where: { id: req.userId }, select: { role: true, banned: true } });
      if (u && !u.banned && u.role === 'admin') return next();
    } catch { /* tombe en 403 ci-dessous */ }
  }
  return res.status(403).json({ error: 'not_admin' });
}

function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
