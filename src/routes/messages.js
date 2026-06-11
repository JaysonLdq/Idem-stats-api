import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import { emit } from '../lib/sse.js';

const router = Router();

const PUBLIC_USER_SELECT = { id: true, pseudo: true, avatarUrl: true };

const sendBody = z.object({
  body: z.string().trim().min(1).max(2000),
});

// Vérifie qu'une amitié acceptée existe entre les deux utilisateurs.
async function assertFriends(userId1, userId2) {
  const fr = await prisma.friendship.findFirst({
    where: {
      status: 'accepted',
      OR: [
        { requesterId: userId1, addresseeId: userId2 },
        { requesterId: userId2, addresseeId: userId1 },
      ],
    },
  });
  if (!fr) throw new HttpError(403, 'not_friends', 'not_friends');
}

function serializeMessage(msg) {
  return {
    id: msg.id,
    senderId: msg.senderId,
    recipientId: msg.recipientId,
    body: msg.body,
    createdAt: msg.createdAt.toISOString(),
    readAt: msg.readAt ? msg.readAt.toISOString() : null,
  };
}

// GET /messages/conversations → ConversationSummary[]
router.get('/conversations', requireAuth, async (req, res) => {
  const myId = req.userId;

  const messages = await prisma.message.findMany({
    where: { OR: [{ senderId: myId }, { recipientId: myId }] },
    orderBy: { createdAt: 'asc' },
    include: {
      sender: { select: PUBLIC_USER_SELECT },
      recipient: { select: PUBLIC_USER_SELECT },
    },
  });

  // Groupe par ami (l'autre participant du fil).
  const convMap = new Map(); // friendId → { user, messages[] }
  for (const msg of messages) {
    const isMe = msg.senderId === myId;
    const friendId = isMe ? msg.recipientId : msg.senderId;
    const friend = isMe ? msg.recipient : msg.sender;
    if (!convMap.has(friendId)) convMap.set(friendId, { user: friend, msgs: [] });
    convMap.get(friendId).msgs.push(msg);
  }

  const conversations = [];
  for (const { user, msgs } of convMap.values()) {
    const lastMessage = serializeMessage(msgs[msgs.length - 1]);
    const unread = msgs.filter((m) => m.recipientId === myId && !m.readAt).length;
    conversations.push({ user, lastMessage, unread });
  }

  // Tri : conversation la plus récente en premier.
  conversations.sort((a, b) => (a.lastMessage.createdAt < b.lastMessage.createdAt ? 1 : -1));

  res.json(conversations);
});

// GET /messages/:friendId → Message[] (ordre chronologique)
router.get('/:friendId', requireAuth, async (req, res) => {
  const { friendId } = req.params;
  const myId = req.userId;

  if (friendId === myId) throw new HttpError(400, 'cannot_message_self', 'cannot_message_self');

  await assertFriends(myId, friendId);

  const messages = await prisma.message.findMany({
    where: {
      OR: [
        { senderId: myId, recipientId: friendId },
        { senderId: friendId, recipientId: myId },
      ],
    },
    orderBy: { createdAt: 'asc' },
  });

  res.json(messages.map(serializeMessage));
});

// POST /messages/:friendId { body } → Message
router.post('/:friendId', requireAuth, async (req, res) => {
  const { friendId } = req.params;
  const myId = req.userId;

  if (friendId === myId) throw new HttpError(400, 'cannot_message_self', 'cannot_message_self');

  const parsed = sendBody.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, 'invalid_body', 'invalid_body');

  await assertFriends(myId, friendId);

  const message = await prisma.message.create({
    data: { senderId: myId, recipientId: friendId, body: parsed.data.body },
  });

  emit(friendId, 'message.new', { id: message.id, from: myId });

  res.status(201).json(serializeMessage(message));
});

// POST /messages/:friendId/read → { ok: true }
router.post('/:friendId/read', requireAuth, async (req, res) => {
  const { friendId } = req.params;
  const myId = req.userId;

  if (friendId === myId) throw new HttpError(400, 'cannot_message_self', 'cannot_message_self');

  await assertFriends(myId, friendId);

  await prisma.message.updateMany({
    where: { senderId: friendId, recipientId: myId, readAt: null },
    data: { readAt: new Date() },
  });

  res.json({ ok: true });
});

export default router;
