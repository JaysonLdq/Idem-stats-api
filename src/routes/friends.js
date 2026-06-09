import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';

const router = Router();

const PUBLIC_USER_SELECT = { id: true, pseudo: true, avatarUrl: true, createdAt: true };

// POST /friends { pseudo } — envoie une demande à un utilisateur. Si une demande
// inverse existe déjà (l'autre m'a déjà demandé), on l'accepte directement.
const sendBody = z.object({ pseudo: z.string().trim().min(3).max(24) });

router.post('/', requireAuth, async (req, res) => {
  const body = sendBody.parse(req.body);
  if (body.pseudo === req.pseudo) throw new HttpError(400, 'cannot_friend_self', 'bad_request');
  const other = await prisma.user.findUnique({ where: { pseudo: body.pseudo } });
  if (!other) throw new HttpError(404, 'user_not_found', 'not_found');

  // Une demande inverse déjà pending → on l'accepte directement (raccourci classique).
  const reverse = await prisma.friendship.findUnique({
    where: { requesterId_addresseeId: { requesterId: other.id, addresseeId: req.userId } },
  });
  if (reverse?.status === 'pending') {
    const accepted = await prisma.friendship.update({
      where: { id: reverse.id },
      data: { status: 'accepted', acceptedAt: new Date() },
      include: { requester: { select: PUBLIC_USER_SELECT }, addressee: { select: PUBLIC_USER_SELECT } },
    });
    return res.json(toPublic(accepted, req.userId));
  }
  if (reverse?.status === 'accepted') return res.json(toPublic(reverse, req.userId));

  // Sinon on crée une nouvelle demande (ou renvoie l'existante si elle est déjà pending).
  try {
    const created = await prisma.friendship.create({
      data: { requesterId: req.userId, addresseeId: other.id },
      include: { requester: { select: PUBLIC_USER_SELECT }, addressee: { select: PUBLIC_USER_SELECT } },
    });
    res.status(201).json(toPublic(created, req.userId));
  } catch (e) {
    if (e?.code === 'P2002') {
      // demande déjà existante du même côté → 409, le front peut afficher "déjà demandé"
      throw new HttpError(409, 'friend_request_already_sent', 'conflict');
    }
    throw e;
  }
});

// GET /friends → { friends: [{relation, user}], incoming: [...], outgoing: [...] }
router.get('/', requireAuth, async (req, res) => {
  const rows = await prisma.friendship.findMany({
    where: { OR: [{ requesterId: req.userId }, { addresseeId: req.userId }] },
    include: { requester: { select: PUBLIC_USER_SELECT }, addressee: { select: PUBLIC_USER_SELECT } },
    orderBy: { createdAt: 'desc' },
  });
  const friends = [];
  const incoming = [];
  const outgoing = [];
  for (const r of rows) {
    const pub = toPublic(r, req.userId);
    if (r.status === 'accepted') friends.push(pub);
    else if (r.requesterId === req.userId) outgoing.push(pub);
    else incoming.push(pub);
  }
  res.json({ friends, incoming, outgoing });
});

// POST /friends/:id/accept — réservé à l'addressee, transition pending → accepted
router.post('/:id/accept', requireAuth, async (req, res) => {
  const fr = await prisma.friendship.findUnique({ where: { id: req.params.id } });
  if (!fr) throw new HttpError(404, 'request_not_found', 'not_found');
  if (fr.addresseeId !== req.userId) throw new HttpError(403, 'not_addressee', 'forbidden');
  if (fr.status === 'accepted') {
    const full = await prisma.friendship.findUnique({
      where: { id: fr.id },
      include: { requester: { select: PUBLIC_USER_SELECT }, addressee: { select: PUBLIC_USER_SELECT } },
    });
    return res.json(toPublic(full, req.userId));
  }
  const accepted = await prisma.friendship.update({
    where: { id: fr.id },
    data: { status: 'accepted', acceptedAt: new Date() },
    include: { requester: { select: PUBLIC_USER_SELECT }, addressee: { select: PUBLIC_USER_SELECT } },
  });
  res.json(toPublic(accepted, req.userId));
});

// DELETE /friends/:id — refuse une demande OU supprime une amitié. Réservé aux participants.
router.delete('/:id', requireAuth, async (req, res) => {
  const fr = await prisma.friendship.findUnique({ where: { id: req.params.id } });
  if (!fr) return res.status(204).end();
  if (fr.requesterId !== req.userId && fr.addresseeId !== req.userId) {
    throw new HttpError(403, 'not_participant', 'forbidden');
  }
  await prisma.friendship.delete({ where: { id: fr.id } });
  res.status(204).end();
});

// Forme publique : on présente toujours "user" = l'autre personne (de mon point de vue).
function toPublic(fr, viewerId) {
  const otherIsAddressee = fr.requesterId === viewerId;
  const other = otherIsAddressee ? fr.addressee : fr.requester;
  return {
    id: fr.id,
    status: fr.status,
    direction: fr.requesterId === viewerId ? 'outgoing' : 'incoming',
    createdAt: fr.createdAt,
    acceptedAt: fr.acceptedAt,
    user: other,
  };
}

export default router;
