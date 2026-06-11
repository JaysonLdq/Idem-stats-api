import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { HttpError } from '../middleware/error.js';
import { emit } from '../lib/sse.js';

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
router.get('/tasks', requireAuth, requireAdmin, async (req, res) => {
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

router.post('/tasks', requireAuth, requireAdmin, async (req, res) => {
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

router.patch('/tasks/:id', requireAuth, requireAdmin, async (req, res) => {
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
router.delete('/tasks/:id', requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  await tryOr404(() => prisma.adminTask.delete({ where: { id } }));
  await emitToAdmins('admin.task.changed', {});
  res.json({ ok: true });
});

// POST /admin/tasks/:id/comments { text } → AdminTask
const createCommentBody = z.object({
  text: z.string().min(1).max(500),
});

router.post('/tasks/:id/comments', requireAuth, requireAdmin, async (req, res) => {
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
router.delete('/tasks/:id/comments/:commentId', requireAuth, requireAdmin, async (req, res) => {
  const { id, commentId } = req.params;
  await tryOr404(() => prisma.adminComment.delete({ where: { id: commentId, taskId: id } }));
  const task = await prisma.adminTask.findUnique({ where: { id }, include: TASK_INCLUDE });
  await emitToAdmins('admin.task.changed', {});
  res.json(serializeTask(task));
});

export default router;
