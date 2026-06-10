import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { broadcaster } from '../lib/broadcaster.js';

const router = Router();

const PUBLIC_USER_SELECT = { id: true, pseudo: true, avatarUrl: true, createdAt: true };

// Vérifie qu'on est ami avec l'autre user (status = accepted). Retourne l'autre
// user public ou jette 403/404. On exige une amitié pour ouvrir/lire un fil :
// pas de DM aux inconnus.
async function requireFriend(meId, otherId) {
  if (meId === otherId) throw new HttpError(400, 'cannot_message_self', 'bad_request');
  const other = await prisma.user.findUnique({
    where: { id: otherId },
    select: PUBLIC_USER_SELECT,
  });
  if (!other) throw new HttpError(404, 'user_not_found', 'not_found');
  const friendship = await prisma.friendship.findFirst({
    where: {
      status: 'accepted',
      OR: [
        { requesterId: meId, addresseeId: otherId },
        { requesterId: otherId, addresseeId: meId },
      ],
    },
    select: { id: true },
  });
  if (!friendship) throw new HttpError(403, 'not_friends', 'forbidden');
  return other;
}

// Forme renvoyée au front (calque exact de Message côté TS).
function toPublicMessage(m) {
  return {
    id: m.id,
    senderId: m.senderId,
    recipientId: m.recipientId,
    body: m.body,
    createdAt: m.createdAt,
    readAt: m.readAt,
  };
}

// GET /messages/conversations
// Retourne une ligne par ami avec status=accepted, contenant le dernier message
// échangé (s'il existe) et le nombre de messages non lus reçus de cet ami.
router.get('/conversations', requireAuth, async (req, res) => {
  const meId = req.userId;

  // Tous mes amis (status accepted)
  const friendships = await prisma.friendship.findMany({
    where: {
      status: 'accepted',
      OR: [{ requesterId: meId }, { addresseeId: meId }],
    },
    include: {
      requester: { select: PUBLIC_USER_SELECT },
      addressee: { select: PUBLIC_USER_SELECT },
    },
  });
  const friends = friendships.map((f) => (f.requesterId === meId ? f.addressee : f.requester));
  if (friends.length === 0) return res.json([]);

  const friendIds = friends.map((f) => f.id);

  // Dernier message par fil — on tire les N derniers messages échangés avec
  // chaque ami puis on prend le tout récent côté JS (Prisma n'a pas de
  // distinct-on standard ; pour quelques dizaines d'amis c'est largement OK).
  const recentMessages = await prisma.message.findMany({
    where: {
      OR: [
        { senderId: meId, recipientId: { in: friendIds } },
        { recipientId: meId, senderId: { in: friendIds } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  const lastByFriend = new Map();
  for (const m of recentMessages) {
    const otherId = m.senderId === meId ? m.recipientId : m.senderId;
    if (!lastByFriend.has(otherId)) lastByFriend.set(otherId, m);
  }

  // Non-lus : messages que l'autre m'a envoyés et qui n'ont pas readAt
  const unreadRows = await prisma.message.groupBy({
    by: ['senderId'],
    where: { recipientId: meId, senderId: { in: friendIds }, readAt: null },
    _count: { _all: true },
  });
  const unreadByFriend = new Map(unreadRows.map((r) => [r.senderId, r._count._all]));

  const summaries = friends.map((u) => ({
    user: u,
    lastMessage: lastByFriend.has(u.id) ? toPublicMessage(lastByFriend.get(u.id)) : null,
    unread: unreadByFriend.get(u.id) ?? 0,
  }));

  // Tri : conversations avec un dernier message en haut (récent d'abord),
  // puis les fils sans message (par pseudo).
  summaries.sort((a, b) => {
    if (a.lastMessage && b.lastMessage) {
      return new Date(b.lastMessage.createdAt).getTime() - new Date(a.lastMessage.createdAt).getTime();
    }
    if (a.lastMessage) return -1;
    if (b.lastMessage) return 1;
    return a.user.pseudo.localeCompare(b.user.pseudo);
  });

  res.json(summaries);
});

// GET /messages/:friendId — fil de discussion ordre ASC (plus ancien d'abord)
router.get('/:friendId', requireAuth, async (req, res) => {
  await requireFriend(req.userId, req.params.friendId);
  const messages = await prisma.message.findMany({
    where: {
      OR: [
        { senderId: req.userId, recipientId: req.params.friendId },
        { senderId: req.params.friendId, recipientId: req.userId },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  res.json(messages.map(toPublicMessage));
});

// POST /messages/:friendId { body }
const sendBody = z.object({ body: z.string().trim().min(1).max(2000) });
router.post('/:friendId', requireAuth, async (req, res) => {
  await requireFriend(req.userId, req.params.friendId);
  const parsed = sendBody.parse(req.body);
  const created = await prisma.message.create({
    data: {
      senderId: req.userId,
      recipientId: req.params.friendId,
      body: parsed.body,
    },
  });
  const pub = toPublicMessage(created);
  // Notifie le destinataire en temps réel (le front invalide ['conversations']
  // et ['messages'] sur message.*, cf. useEvents.ts).
  broadcaster.send(req.params.friendId, 'message.new', pub);
  // Et notifie aussi mes autres sessions ouvertes (multi-onglets / mobile)
  broadcaster.send(req.userId, 'message.new', pub);
  res.status(201).json(pub);
});

// POST /messages/:friendId/read — marque tous les messages reçus de cet ami
// comme lus à maintenant.
router.post('/:friendId/read', requireAuth, async (req, res) => {
  await requireFriend(req.userId, req.params.friendId);
  await prisma.message.updateMany({
    where: { senderId: req.params.friendId, recipientId: req.userId, readAt: null },
    data: { readAt: new Date() },
  });
  // L'expéditeur peut vouloir refléter "vu" un jour — pour l'instant on n'émet
  // pas d'event spécifique, la pastille de l'expéditeur n'utilise pas readAt.
  res.json({ ok: true });
});

export default router;
