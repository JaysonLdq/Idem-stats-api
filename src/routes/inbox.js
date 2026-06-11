import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const PUBLIC_USER = { id: true, pseudo: true, avatarUrl: true, createdAt: true };

// GET /me/inbox
// Aggrège tout ce qui réclame l'attention de l'utilisateur :
//   - demandes d'amis reçues (pending)
//   - invitations à un duel (status pending + metadata.invite=true et je suis player2)
//   - duels shifumi remote où c'est à moi de pioche
// Renvoie {friendRequests, matchInvites, shifumiPendingPicks, total}
router.get('/', requireAuth, async (req, res) => {
  const [friendRequests, allPending] = await Promise.all([
    prisma.friendship.findMany({
      where: { addresseeId: req.userId, status: 'pending' },
      include: { requester: { select: PUBLIC_USER } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.match.findMany({
      where: {
        OR: [{ player1Id: req.userId }, { player2Id: req.userId }],
        status: 'pending',
      },
      include: {
        player1: { select: PUBLIC_USER },
        player2: { select: PUBLIC_USER },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  const matchInvites = [];
  const shifumiPendingPicks = [];
  for (const m of allPending) {
    const meta = m.metadata || {};
    const isP2 = m.player2Id === req.userId;
    const isP1 = m.player1Id === req.userId;
    // Invitation reçue
    if (isP2 && meta.invite === true) {
      matchInvites.push(publicMatch(m, req.userId));
      continue;
    }
    // Shifumi remote : c'est à moi de pioche (mon pick n'est pas posé)
    if (m.game === 'shifumi' && meta.mode === 'remote') {
      const myPickPosed = isP1 ? !!meta.creatorPick : !!meta.opponentPick;
      if (!myPickPosed) shifumiPendingPicks.push(publicMatch(m, req.userId));
    }
  }

  const total = friendRequests.length + matchInvites.length + shifumiPendingPicks.length;
  res.json({
    friendRequests: friendRequests.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      user: r.requester,
    })),
    matchInvites,
    shifumiPendingPicks,
    total,
  });
});

function publicMatch(m, viewerId) {
  // Masquage shifumi (cohérent avec maskFor dans matches.js)
  const out = {
    id: m.id, game: m.game, status: m.status, code: m.code,
    scoreP1: m.scoreP1, scoreP2: m.scoreP2,
    metadata: m.metadata ?? null,
    createdAt: m.createdAt,
    player1Id: m.player1Id, player2Id: m.player2Id,
    player1: m.player1 ?? undefined, player2: m.player2 ?? undefined,
  };
  if (out.game === 'shifumi' && out.metadata?.mode === 'remote') {
    const isCreator = m.player1Id === viewerId;
    const meta = { ...out.metadata };
    if (isCreator) delete meta.opponentPick;
    else delete meta.creatorPick;
    out.metadata = meta;
  }
  return out;
}

export default router;
