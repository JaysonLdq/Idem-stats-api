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
        async findUnique({ where }) {
          if (where.id) return users.get(where.id) || null;
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

let app, tokA, tokB, tokC, idA, idB;
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-test-secret';
  process.env.BCRYPT_ROUNDS = '4';
  const { buildApp } = await import('../src/app.js');
  app = buildApp();
  const ra = await request(app).post('/auth/register').send({ pseudo: 'alpha', password: 'secret1' });
  const rb = await request(app).post('/auth/register').send({ pseudo: 'beta_', password: 'secret1' });
  const rc = await request(app).post('/auth/register').send({ pseudo: 'gamma', password: 'secret1' });
  tokA = ra.body.token; idA = ra.body.user.id;
  tokB = rb.body.token; idB = rb.body.user.id;
  tokC = rc.body.token;
});

describe('duel invitations (mode=remote)', () => {
  it('mode local (défaut) → status active immédiat (compat)', async () => {
    const res = await request(app)
      .post('/matches').set('Authorization', `Bearer ${tokA}`)
      .send({ game: 'basket_random', opponentPseudo: 'beta_' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
  });

  it('mode remote → status pending + metadata.invite=true', async () => {
    const res = await request(app)
      .post('/matches').set('Authorization', `Bearer ${tokA}`)
      .send({ game: 'darts', opponentPseudo: 'beta_', mode: 'remote' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.player2Id).toBe(idB);
    expect(res.body.code).toBeNull();
    expect(res.body.metadata.invite).toBe(true);
  });

  it('player2 accepte → status active', async () => {
    const r = await request(app)
      .post('/matches').set('Authorization', `Bearer ${tokA}`)
      .send({ game: 'darts', opponentPseudo: 'beta_', mode: 'remote' });
    const id = r.body.id;
    const acc = await request(app).post(`/matches/${id}/accept`).set('Authorization', `Bearer ${tokB}`);
    expect(acc.status).toBe(200);
    expect(acc.body.status).toBe('active');
    expect(acc.body.metadata.invite).toBe(false);
  });

  it('player1 ne peut PAS accepter sa propre invitation', async () => {
    const r = await request(app)
      .post('/matches').set('Authorization', `Bearer ${tokA}`)
      .send({ game: 'darts', opponentPseudo: 'beta_', mode: 'remote' });
    const acc = await request(app).post(`/matches/${r.body.id}/accept`).set('Authorization', `Bearer ${tokA}`);
    expect(acc.status).toBe(403);
    expect(acc.body.error).toBe('not_invitee');
  });

  it('un tiers ne peut ni accepter ni décliner', async () => {
    const r = await request(app)
      .post('/matches').set('Authorization', `Bearer ${tokA}`)
      .send({ game: 'darts', opponentPseudo: 'beta_', mode: 'remote' });
    const acc = await request(app).post(`/matches/${r.body.id}/accept`).set('Authorization', `Bearer ${tokC}`);
    expect(acc.status).toBe(403);
    const dec = await request(app).post(`/matches/${r.body.id}/decline`).set('Authorization', `Bearer ${tokC}`);
    expect(dec.status).toBe(403);
  });

  it('player2 ou player1 peuvent décliner → status cancelled', async () => {
    const r = await request(app)
      .post('/matches').set('Authorization', `Bearer ${tokA}`)
      .send({ game: 'darts', opponentPseudo: 'beta_', mode: 'remote' });
    const dec = await request(app).post(`/matches/${r.body.id}/decline`).set('Authorization', `Bearer ${tokB}`);
    expect(dec.status).toBe(200);
    expect(dec.body.status).toBe('cancelled');
  });

  it('accepter un match qui n\'est pas une invitation → 400', async () => {
    // crée un match local (déjà active) puis tente l'accept
    const r = await request(app)
      .post('/matches').set('Authorization', `Bearer ${tokA}`)
      .send({ game: 'basket_random', opponentPseudo: 'beta_' });
    const acc = await request(app).post(`/matches/${r.body.id}/accept`).set('Authorization', `Bearer ${tokB}`);
    expect(acc.status).toBe(409); // pas pending, donc match_not_pending
  });
});
