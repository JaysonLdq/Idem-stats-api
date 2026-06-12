import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { HttpError } from '../middleware/error.js';
import { emit } from '../lib/sse.js';
import { computeElos, computeGlobalElos } from '../lib/elo.js';

const router = Router();

const PUBLIC_USER_SELECT = { id: true, pseudo: true, avatarUrl: true };

const TASK_INCLUDE = {
  comments: {
    include: { author: { select: { pseudo: true } } },
    orderBy: { createdAt: 'asc' },
  },
};

function getAdminPseudos() {
  return (process.env.ADMIN_PSEUDOS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

async function emitToAdmins(event, data) {
  const pseudos = getAdminPseudos();
  if (pseudos.length === 0) return;
  const admins = await prisma.user.findMany({
    where: { pseudo: { in: pseudos } },
    select: { id: true },
  });
  for (const a of admins) emit(a.id, event, data);
}

async function assertAdminAssignee(assigneeId) {
  const pseudos = getAdminPseudos();
  const user = await prisma.user.findUnique({
    where: { id: assigneeId },
    select: { pseudo: true },
  });
  if (!user || !pseudos.includes(user.pseudo)) {
    throw new HttpError(400, 'invalid_input', 'invalid_input');
  }
}

async function tryOr404(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e?.code === 'P2025') throw new HttpError(404, 'not_found', 'not_found');
    throw e;
  }
}

function serializeTask(task) {
  return {
    id: task.id,
    title: task.title,
    assigneeId: task.assigneeId,
    done: task.done,
    createdAt: task.createdAt.toISOString(),
    comments: task.comments.map((c) => ({
      id: c.id,
      authorId: c.authorId,
      authorPseudo: c.author.pseudo,
      text: c.text,
      createdAt: c.createdAt.toISOString(),
    })),
  };
}

// GET /admin/tasks → { admins: User[], tasks: AdminTask[] }
router.get('/tasks', requireAdmin, async (req, res) => {
  const pseudos = getAdminPseudos();
  const [admins, tasks] = await Promise.all([
    prisma.user.findMany({ where: { pseudo: { in: pseudos } }, select: PUBLIC_USER_SELECT }),
    prisma.adminTask.findMany({ include: TASK_INCLUDE, orderBy: { createdAt: 'asc' } }),
  ]);
  res.json({ admins, tasks: tasks.map(serializeTask) });
});

// POST /admin/tasks { title, assigneeId } → AdminTask
const createTaskBody = z.object({
  title: z.string().min(1).max(200),
  assigneeId: z.string().min(1),
});

router.post('/tasks', requireAdmin, async (req, res) => {
  const parsed = createTaskBody.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, 'invalid_input', 'invalid_input');
  const { title, assigneeId } = parsed.data;
  await assertAdminAssignee(assigneeId);
  const task = await prisma.adminTask.create({
    data: { title, assigneeId },
    include: TASK_INCLUDE,
  });
  await emitToAdmins('admin.task.changed', {});
  res.status(201).json(serializeTask(task));
});

// PATCH /admin/tasks/:id { title?, done?, assigneeId? } → AdminTask
const updateTaskBody = z.object({
  title: z.string().min(1).max(200).optional(),
  done: z.boolean().optional(),
  assigneeId: z.string().min(1).optional(),
});

router.patch('/tasks/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const parsed = updateTaskBody.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, 'invalid_input', 'invalid_input');
  const data = parsed.data;
  if (data.assigneeId) await assertAdminAssignee(data.assigneeId);
  const task = await tryOr404(() =>
    prisma.adminTask.update({ where: { id }, data, include: TASK_INCLUDE }),
  );
  await emitToAdmins('admin.task.changed', {});
  res.json(serializeTask(task));
});

// DELETE /admin/tasks/:id → { ok: true }
router.delete('/tasks/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  await tryOr404(() => prisma.adminTask.delete({ where: { id } }));
  await emitToAdmins('admin.task.changed', {});
  res.json({ ok: true });
});

// POST /admin/tasks/:id/comments { text } → AdminTask
const createCommentBody = z.object({
  text: z.string().min(1).max(500),
});

router.post('/tasks/:id/comments', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const parsed = createCommentBody.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, 'invalid_input', 'invalid_input');
  const exists = await prisma.adminTask.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw new HttpError(404, 'not_found', 'not_found');
  await prisma.adminComment.create({
    data: { taskId: id, authorId: req.userId, text: parsed.data.text },
  });
  const task = await prisma.adminTask.findUnique({ where: { id }, include: TASK_INCLUDE });
  await emitToAdmins('admin.task.changed', {});
  res.status(201).json(serializeTask(task));
});

// DELETE /admin/tasks/:id/comments/:commentId → AdminTask
router.delete('/tasks/:id/comments/:commentId', requireAdmin, async (req, res) => {
  const { id, commentId } = req.params;
  await tryOr404(() => prisma.adminComment.delete({ where: { id: commentId, taskId: id } }));
  const task = await prisma.adminTask.findUnique({ where: { id }, include: TASK_INCLUDE });
  await emitToAdmins('admin.task.changed', {});
  res.json(serializeTask(task));
});

// ─ USERS ──────────────────────────────────────────────────────────────
// GET /admin/users — liste tous les comptes avec filtres optionnels.
//   ?q=         filtre sur le pseudo (contains, insensible casse)
//   ?banned=true|false
//   ?role=admin|user
// Tri par création desc.
router.get('/users', requireAdmin, async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const where = {};
  if (q) where.pseudo = { contains: q, mode: 'insensitive' };
  if (req.query.banned === 'true') where.banned = true;
  if (req.query.banned === 'false') where.banned = false;
  if (req.query.role === 'admin' || req.query.role === 'user') where.role = req.query.role;

  const users = await prisma.user.findMany({
    where,
    select: {
      id: true, pseudo: true, avatarUrl: true, coins: true,
      banned: true, bannedAt: true, banReason: true, createdAt: true,
      role: true,
      _count: { select: { matchesAsP1: true, matchesAsP2: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  // Pour chaque user on calcule l'ELO par jeu à la volée. Comme cette
  // route est admin-only et appelée de temps en temps, on accepte
  // l'overhead du recompute global (parcours unique en O(matches)).
  const allMatches = await prisma.match.findMany({
    where: { status: 'finished' },
    select: { game: true, player1Id: true, player2Id: true, winnerId: true, finishedAt: true, status: true },
    orderBy: { finishedAt: 'asc' },
  });
  const ratings = computeElos(allMatches);
  const globalElos = computeGlobalElos(ratings);

  res.json(users.map((u) => {
    const entry = globalElos.get(u.id);
    const perGame = {};
    if (entry) {
      for (const [g, e] of Object.entries(entry.perGame)) {
        perGame[g] = { rating: e.rating, games: e.games };
      }
    }
    return {
      id: u.id,
      pseudo: u.pseudo,
      avatarUrl: u.avatarUrl,
      coins: u.coins,
      banned: u.banned,
      bannedAt: u.bannedAt,
      banReason: u.banReason,
      role: u.role,
      createdAt: u.createdAt,
      matchCount: u._count.matchesAsP1 + u._count.matchesAsP2,
      globalElo: entry?.global ?? null,
      perGame,
    };
  }));
});

const banBody = z.object({ reason: z.string().trim().max(200).optional() });
router.post('/users/:id/ban', requireAdmin, async (req, res) => {
  const parsed = banBody.parse(req.body ?? {});
  await tryOr404(() => prisma.user.update({
    where: { id: req.params.id },
    data: { banned: true, bannedAt: new Date(), banReason: parsed.reason ?? null },
  }));
  res.json({ ok: true });
});

router.post('/users/:id/unban', requireAdmin, async (req, res) => {
  await tryOr404(() => prisma.user.update({
    where: { id: req.params.id },
    data: { banned: false, bannedAt: null, banReason: null },
  }));
  res.json({ ok: true });
});

// POST /admin/users/:id/reset-elo[?game=pong] — supprime les matches
// finished du user. Sans filtre game → reset complet (tous les jeux).
// Avec game → supprime juste les matches finished de ce jeu pour ce
// user. L'ELO étant calculé à la volée par computeElos depuis
// l'historique, suppression = retombe à INITIAL_ELO sur ce périmètre.
router.post('/users/:id/reset-elo', requireAdmin, async (req, res) => {
  const userId = req.params.id;
  const game = typeof req.query.game === 'string' ? req.query.game : null;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw new HttpError(404, 'user_not_found', 'not_found');
  const where = {
    status: 'finished',
    OR: [{ player1Id: userId }, { player2Id: userId }],
  };
  if (game) where.game = game;
  const result = await prisma.match.deleteMany({ where });
  res.json({ ok: true, deleted: result.count });
});

// POST /admin/users/:id/role { role } — promeut/rétrograde un user.
// RÉSERVÉ à la voie clé API : un admin ne peut pas en créer d'autres
// depuis un compte JWT — il faut la clé de prod pour ça (évite les
// escalations entre admins). Si l'appelant n'a pas req.isAdminKey,
// on rejette 403.
const roleBody = z.object({ role: z.enum(['user', 'admin']) });
router.post('/users/:id/role', requireAdmin, async (req, res) => {
  if (!req.isAdminKey) {
    throw new HttpError(403, 'role_change_requires_api_key', 'forbidden');
  }
  const parsed = roleBody.parse(req.body ?? {});
  await tryOr404(() => prisma.user.update({
    where: { id: req.params.id },
    data: { role: parsed.role },
  }));
  res.json({ ok: true });
});

// ─ MATCHES ────────────────────────────────────────────────────────────
// GET /admin/matches — derniers matches finished/cancelled avec filtres.
//   ?q=pseudo (filtre sur P1 ou P2)
//   ?game=pong
//   ?status=finished|cancelled (par défaut les deux)
router.get('/matches', requireAdmin, async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const game = typeof req.query.game === 'string' ? req.query.game : '';
  const status = req.query.status === 'finished' || req.query.status === 'cancelled'
    ? [req.query.status]
    : ['finished', 'cancelled'];

  const where = { status: { in: status } };
  if (game) where.game = game;
  if (q) {
    where.OR = [
      { player1: { pseudo: { contains: q, mode: 'insensitive' } } },
      { player2: { pseudo: { contains: q, mode: 'insensitive' } } },
    ];
  }

  const matches = await prisma.match.findMany({
    where,
    include: {
      player1: { select: PUBLIC_USER_SELECT },
      player2: { select: PUBLIC_USER_SELECT },
    },
    orderBy: { finishedAt: 'desc' },
    take: 100,
  });
  res.json(matches.map((m) => ({
    id: m.id,
    game: m.game,
    status: m.status,
    scoreP1: m.scoreP1,
    scoreP2: m.scoreP2,
    winnerId: m.winnerId,
    player1: m.player1,
    player2: m.player2,
    finishedAt: m.finishedAt,
  })));
});

// GET /admin/stats — petit résumé chiffré pour la bannière du panneau.
router.get('/stats', requireAdmin, async (_req, res) => {
  const [usersTotal, usersBanned, usersAdmin, matchesTotal, matchesFinished] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { banned: true } }),
    prisma.user.count({ where: { role: 'admin' } }),
    prisma.match.count(),
    prisma.match.count({ where: { status: 'finished' } }),
  ]);
  res.json({ usersTotal, usersBanned, usersAdmin, matchesTotal, matchesFinished });
});

// DELETE /admin/matches/:id — supprime un match. L'ELO étant calculé à
// la volée depuis l'historique, ça rembourse mécaniquement l'ELO perdu
// au perdant et retire celui gagné au gagnant (sans avoir besoin d'un
// snapshot). Aucune compensation coins (les gains de jetons reposent
// sur le delta réel à l'historique, donc partent avec le match).
router.delete('/matches/:id', requireAdmin, async (req, res) => {
  await tryOr404(() => prisma.match.delete({ where: { id: req.params.id } }));
  res.json({ ok: true });
});

export default router;
