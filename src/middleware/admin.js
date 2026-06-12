import { verify } from '../lib/jwt.js';

// Garde-fou admin. Deux voies d'accès :
//   1. Header `x-admin-key` égal à process.env.ADMIN_API_KEY → bypass
//      complet sans avoir besoin d'un compte. Utile pour les scripts
//      d'ops ou un reset d'urgence. Désactivé si la variable d'env est
//      absente côté serveur.
//   2. JWT Bearer dont le `pseudo` est dans process.env.ADMIN_PSEUDOS
//      (séparateur virgule). C'est la voie normale depuis l'app web.
//
// Quand on passe par l'API key, req.isAdminKey = true et req.userId =
// null. Sinon req.userId et req.pseudo sont posés comme requireAuth.
//
// Ce middleware remplace l'enchaînement requireAuth → requireAdmin :
// un seul tour suffit, et il accepte les deux voies de façon homogène.

export function requireAdmin(req, res, next) {
  // Voie API key
  const provided = req.header('x-admin-key');
  const expected = process.env.ADMIN_API_KEY;
  if (provided && expected && safeEq(provided, expected)) {
    req.isAdminKey = true;
    req.userId = null;
    req.pseudo = null;
    return next();
  }

  // Voie JWT
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

  const pseudos = new Set(
    (process.env.ADMIN_PSEUDOS || '').split(',').map((s) => s.trim()).filter(Boolean),
  );
  if (!req.pseudo || !pseudos.has(req.pseudo)) {
    return res.status(403).json({ error: 'not_admin' });
  }
  next();
}

function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
