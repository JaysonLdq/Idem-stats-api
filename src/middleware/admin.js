export function requireAdmin(req, res, next) {
  const pseudos = new Set(
    (process.env.ADMIN_PSEUDOS || '').split(',').map((s) => s.trim()).filter(Boolean),
  );
  if (!pseudos.has(req.pseudo)) {
    return res.status(403).json({ error: 'not_admin' });
  }
  next();
}
