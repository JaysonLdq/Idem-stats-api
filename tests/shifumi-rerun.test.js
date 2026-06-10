import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';

vi.mock('../src/db/prisma.js', async () => {
  const users = new Map();
  const byPseudo = new Map();
  const matches = new Map();
  let seq = 0;
  function rel(id) { return id == null ? null : users.get(id) || null; }
  function hydrate(m) { return { ...m, player1: rel(m.player1Id), player2: rel(m.player2Id) }; }
  return {
    prisma: {
      user: {
        async create({ data }) {
          if (byPseudo.has(data.pseudo)) { const e = new Error('dup'); e.code = 'P2002'; throw e; }
          const u = { id: 'u_' + (++seq), pseudo: data.pseudo, passwordHash: data.passwordHash, avatarUrl: null, createdAt: new Date() };
          users.set(u.id, u); byPseudo.set(u.pseudo, u.id);
          return u;
        },
        async findUnique({ where, select: _s }) {
          if (where.id) {
            const u = users.get(where.id) || null;
            return u ? { pseudo: u.pseudo, ...u } : null;
          }
          if (where.pseudo) { const id = byPseudo.get(where.pseudo); return id ? users.get(id) : null; }
          return null;
        },
      },
      match: {
        async create({ data }) {
          const m = { id: 'm_' + (++seq), scoreP1: 0, scoreP2: 0, ...data, createdAt: new Date() };
          matches.set(m.id, m);
          return hydrate(m);
        },
        async findUnique({ where, include: _i }) {
          if (where.id) { const m = matches.get(where.id); return m ? hydrate(m) : null; }
          return null;
        },
        async update({ where, data, include: _i }) {
          const m = matches.get(where.id);
          if (!m) return null;
          Object.assign(m, data);
          return hydrate(m);
        },
      },
    },
  };
});

let app, tokA, tokB;
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-test-secret';
  process.env.BCRYPT_ROUNDS = '4';
  const { buildApp } = await import('../src/app.js');
  app = buildApp();
  const a = await request(app).post('/auth/register').send({ pseudo: 'alpha', password: 'secret1' });
  const b = await request(app).post('/auth/register').send({ pseudo: 'beta_', password: 'secret1' });
  tokA = a.body.token; tokB = b.body.token;
});

async function createMatch(myPick = 'rock') {
  return request(app).post('/matches').set('Authorization', `Bearer ${tokA}`)
    .send({ game: 'shifumi', opponentPseudo: 'beta_', shifumi: { mode: 'remote', myPick } });
}

describe('shifumi remote — re-run sur égalité', () => {
  it('round 1 → égalité → status reste pending + round=2 + history=1', async () => {
    const create = await createMatch('rock');
    const id = create.body.id;
    expect(create.body.metadata.round).toBe(1);
    const pick = await request(app).post(`/matches/${id}/shifumi-pick`).set('Authorization', `Bearer ${tokB}`).send({ pick: 'rock' });
    expect(pick.status).toBe(200);
    expect(pick.body.status).toBe('pending');         // PAS finished
    expect(pick.body.metadata.round).toBe(2);
    expect(pick.body.metadata.history.length).toBe(1);
    expect(pick.body.metadata.history[0]).toMatchObject({ round: 1, creatorPick: 'rock', opponentPick: 'rock', tie: true });
    expect(pick.body.metadata.lastTieRound).toBe(1);
    // Les picks ont été reset
    expect(pick.body.metadata.opponentPick).toBeUndefined();
    expect(pick.body.metadata.creatorPick).toBeUndefined(); // mais caché par maskFor pour tokB
  });

  it('après le tie, les 2 joueurs peuvent re-pick', async () => {
    const create = await createMatch('paper');
    const id = create.body.id;
    // Round 1 : égalité (paper vs paper)
    await request(app).post(`/matches/${id}/shifumi-pick`).set('Authorization', `Bearer ${tokB}`).send({ pick: 'paper' });
    // Round 2 : alpha (creator) re-pick
    const r2a = await request(app).post(`/matches/${id}/shifumi-pick`).set('Authorization', `Bearer ${tokA}`).send({ pick: 'rock' });
    expect(r2a.status).toBe(200);
    expect(r2a.body.status).toBe('pending');
    // Côté alpha : son pick est visible (creatorPick), opponent en attente
    expect(r2a.body.metadata.creatorPick).toBe('rock');
    expect(r2a.body.metadata.awaitingOpponentPick).toBe(true);
    // Côté beta : pas encore picked, ne voit pas creatorPick
    const asB = await request(app).get(`/matches/${id}`).set('Authorization', `Bearer ${tokB}`);
    expect(asB.body.metadata.creatorPick).toBeUndefined();
    expect(asB.body.metadata.awaitingMyPick).toBe(true);
    // beta pick → fin
    const r2b = await request(app).post(`/matches/${id}/shifumi-pick`).set('Authorization', `Bearer ${tokB}`).send({ pick: 'scissors' });
    expect(r2b.body.status).toBe('finished');
    expect(r2b.body.metadata.winnerPseudo).toBe('alpha'); // rock bat scissors
    expect(r2b.body.metadata.history.length).toBe(2);
    expect(r2b.body.metadata.history[0].tie).toBe(true);
    expect(r2b.body.metadata.history[1].winnerPseudo).toBe('alpha');
  });

  it('déjà-pické ce round → 409 already_picked_this_round', async () => {
    const create = await createMatch('rock');
    const id = create.body.id;
    // creator a déjà posé son pick à la création, re-poster → conflit
    const r = await request(app).post(`/matches/${id}/shifumi-pick`).set('Authorization', `Bearer ${tokA}`).send({ pick: 'paper' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('already_picked_this_round');
  });

  it('un tiers ne peut pas pick', async () => {
    const create = await createMatch('rock');
    const tokC = (await request(app).post('/auth/register').send({ pseudo: 'gamma', password: 'secret1' })).body.token;
    const r = await request(app).post(`/matches/${create.body.id}/shifumi-pick`).set('Authorization', `Bearer ${tokC}`).send({ pick: 'paper' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('not_a_participant');
  });

  it('plusieurs ties d\'affilée → round s\'incrémente, history accumule', async () => {
    const create = await createMatch('rock');
    const id = create.body.id;
    // T1 rock-rock
    await request(app).post(`/matches/${id}/shifumi-pick`).set('Authorization', `Bearer ${tokB}`).send({ pick: 'rock' });
    // T2 paper-paper
    await request(app).post(`/matches/${id}/shifumi-pick`).set('Authorization', `Bearer ${tokA}`).send({ pick: 'paper' });
    const t2 = await request(app).post(`/matches/${id}/shifumi-pick`).set('Authorization', `Bearer ${tokB}`).send({ pick: 'paper' });
    expect(t2.body.status).toBe('pending');
    expect(t2.body.metadata.round).toBe(3);
    expect(t2.body.metadata.history.length).toBe(2);
    expect(t2.body.metadata.history.every((h) => h.tie)).toBe(true);
  });
});
