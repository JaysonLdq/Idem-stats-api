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

let app, tokA, tokB, idA, idB;
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-test-secret';
  process.env.BCRYPT_ROUNDS = '4';
  const { buildApp } = await import('../src/app.js');
  app = buildApp();
  const ra = await request(app).post('/auth/register').send({ pseudo: 'alpha', password: 'secret1' });
  const rb = await request(app).post('/auth/register').send({ pseudo: 'beta_', password: 'secret1' });
  tokA = ra.body.token; idA = ra.body.user.id;
  tokB = rb.body.token; idB = rb.body.user.id;
});

describe('shifumi remote', () => {
  it('crée un match pending avec creatorPick visible du créateur, masqué de l\'opposant', async () => {
    const create = await request(app)
      .post('/matches').set('Authorization', `Bearer ${tokA}`)
      .send({ game: 'shifumi', opponentPseudo: 'beta_', shifumi: { mode: 'remote', myPick: 'rock' } });
    expect(create.status).toBe(201);
    expect(create.body.status).toBe('pending');
    expect(create.body.metadata.mode).toBe('remote');
    expect(create.body.metadata.creatorPick).toBe('rock');
    expect(create.body.metadata.awaitingOpponentPick).toBe(true);

    // opponent fetch : ne doit pas voir creatorPick
    const fetchedAsB = await request(app).get(`/matches/${create.body.id}`).set('Authorization', `Bearer ${tokB}`);
    expect(fetchedAsB.body.metadata.creatorPick).toBeUndefined();
    expect(fetchedAsB.body.metadata.awaitingMyPick).toBe(true);
  });

  it('opponent pick → résolution + reveal des deux picks', async () => {
    const create = await request(app)
      .post('/matches').set('Authorization', `Bearer ${tokA}`)
      .send({ game: 'shifumi', opponentPseudo: 'beta_', shifumi: { mode: 'remote', myPick: 'paper' } });
    const id = create.body.id;
    const pick = await request(app)
      .post(`/matches/${id}/shifumi-pick`).set('Authorization', `Bearer ${tokB}`)
      .send({ pick: 'rock' });
    expect(pick.status).toBe(200);
    expect(pick.body.status).toBe('finished');
    expect(pick.body.metadata.creatorPick).toBe('paper');
    expect(pick.body.metadata.opponentPick).toBe('rock');
    expect(pick.body.metadata.winnerPseudo).toBe('alpha'); // paper bat rock
    expect(pick.body.scoreP1).toBe(1);
    expect(pick.body.scoreP2).toBe(0);
  });

  it('égalité = match nul (tie=true, winnerId null)', async () => {
    const create = await request(app)
      .post('/matches').set('Authorization', `Bearer ${tokA}`)
      .send({ game: 'shifumi', opponentPseudo: 'beta_', shifumi: { mode: 'remote', myPick: 'rock' } });
    const pick = await request(app)
      .post(`/matches/${create.body.id}/shifumi-pick`).set('Authorization', `Bearer ${tokB}`)
      .send({ pick: 'rock' });
    expect(pick.status).toBe(200);
    expect(pick.body.status).toBe('finished');
    expect(pick.body.winnerId).toBeNull();
    expect(pick.body.metadata.tie).toBe(true);
  });

  it('seul l\'opposant peut soumettre le pick', async () => {
    const create = await request(app)
      .post('/matches').set('Authorization', `Bearer ${tokA}`)
      .send({ game: 'shifumi', opponentPseudo: 'beta_', shifumi: { mode: 'remote', myPick: 'rock' } });
    const wrong = await request(app)
      .post(`/matches/${create.body.id}/shifumi-pick`).set('Authorization', `Bearer ${tokA}`)
      .send({ pick: 'paper' });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toBe('not_opponent');
  });

  it('second pick refusé si déjà finished', async () => {
    const create = await request(app)
      .post('/matches').set('Authorization', `Bearer ${tokA}`)
      .send({ game: 'shifumi', opponentPseudo: 'beta_', shifumi: { mode: 'remote', myPick: 'scissors' } });
    await request(app).post(`/matches/${create.body.id}/shifumi-pick`).set('Authorization', `Bearer ${tokB}`).send({ pick: 'paper' });
    const again = await request(app).post(`/matches/${create.body.id}/shifumi-pick`).set('Authorization', `Bearer ${tokB}`).send({ pick: 'rock' });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('match_not_pending');
  });
});
