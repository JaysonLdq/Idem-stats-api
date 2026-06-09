import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';

// Prisma mocké : users + matches en mémoire, comportements minimums utilisés par les routes.
vi.mock('../src/db/prisma.js', async () => {
  const users = new Map();
  const byPseudo = new Map();
  const matches = new Map();
  const byCode = new Map();
  let seq = 0;
  function rel(id, map = users) { return id == null ? null : map.get(id) || null; }
  function hydrate(m) {
    return {
      ...m,
      player1: rel(m.player1Id),
      player2: rel(m.player2Id),
    };
  }
  return {
    prisma: {
      user: {
        async create({ data }) {
          if (byPseudo.has(data.pseudo)) { const e = new Error('dup'); e.code = 'P2002'; throw e; }
          const u = { id: 'u_' + (++seq), pseudo: data.pseudo, passwordHash: data.passwordHash, createdAt: new Date() };
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
        async create({ data, include: _i }) {
          if (data.code && byCode.has(data.code)) { const e = new Error('dup'); e.code = 'P2002'; throw e; }
          const m = {
            id: 'm_' + (++seq),
            scoreP1: 0, scoreP2: 0,
            source: null, winnerId: null, finishedAt: null,
            createdAt: new Date(),
            ...data,
          };
          matches.set(m.id, m);
          if (m.code) byCode.set(m.code, m.id);
          return hydrate(m);
        },
        async findUnique({ where, include: _i }) {
          if (where.id) { const m = matches.get(where.id); return m ? hydrate(m) : null; }
          if (where.code) { const id = byCode.get(where.code); const m = id ? matches.get(id) : null; return m ? hydrate(m) : null; }
          return null;
        },
        async update({ where, data, include: _i }) {
          const m = matches.get(where.id);
          if (!m) return null;
          Object.assign(m, data);
          return hydrate(m);
        },
        async findMany({ where, take, orderBy: _o, include: _i }) {
          const all = [...matches.values()].sort((a, b) => b.createdAt - a.createdAt);
          const filtered = all.filter((m) => {
            if (where?.game && m.game !== where.game) return false;
            if (where?.OR) {
              return where.OR.some((c) =>
                (c.player1Id && m.player1Id === c.player1Id) ||
                (c.player2Id && m.player2Id === c.player2Id),
              );
            }
            return true;
          });
          return filtered.slice(0, take || 100).map(hydrate);
        },
      },
    },
  };
});

let app;
let tokenA, tokenB, idA, idB;
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-test-secret';
  process.env.BCRYPT_ROUNDS = '4';
  const { buildApp } = await import('../src/app.js');
  app = buildApp();
  const a = await request(app).post('/auth/register').send({ pseudo: 'alice', password: 'secret1' });
  const b = await request(app).post('/auth/register').send({ pseudo: 'bobby', password: 'secret1' });
  tokenA = a.body.token; idA = a.body.user.id;
  tokenB = b.body.token; idB = b.body.user.id;
});

describe('matches', () => {
  it('rejects unknown game id with 400', async () => {
    const res = await request(app).post('/matches').set('Authorization', `Bearer ${tokenA}`).send({ game: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unknown_game');
  });

  it('creates a pending match with a code when no opponent', async () => {
    const res = await request(app).post('/matches').set('Authorization', `Bearer ${tokenA}`).send({ game: 'basket_random' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.code).toMatch(/^[A-Z0-9]{6}$/);
    expect(res.body.player2Id).toBeNull();
  });

  it('creates an active match when opponent pseudo is given', async () => {
    const res = await request(app)
      .post('/matches').set('Authorization', `Bearer ${tokenA}`)
      .send({ game: 'basket_random', opponentPseudo: 'bobby' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('active');
    expect(res.body.player2Id).toBe(idB);
    expect(res.body.code).toBeNull();
  });

  it('forbids playing against yourself', async () => {
    const res = await request(app)
      .post('/matches').set('Authorization', `Bearer ${tokenA}`)
      .send({ game: 'basket_random', opponentPseudo: 'alice' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('cannot_play_self');
  });

  it('lets a second player join via code', async () => {
    const created = await request(app).post('/matches').set('Authorization', `Bearer ${tokenA}`).send({ game: 'basket_random' });
    const join = await request(app)
      .post('/matches/join').set('Authorization', `Bearer ${tokenB}`)
      .send({ code: created.body.code });
    expect(join.status).toBe(200);
    expect(join.body.status).toBe('active');
    expect(join.body.player2Id).toBe(idB);
  });

  it('basket_random PATCH score auto-finishes at 5 and computes winner', async () => {
    const created = await request(app)
      .post('/matches').set('Authorization', `Bearer ${tokenA}`)
      .send({ game: 'basket_random', opponentPseudo: 'bobby' });
    const id = created.body.id;
    const patched = await request(app)
      .patch(`/matches/${id}/score`).set('Authorization', `Bearer ${tokenA}`)
      .send({ scoreP1: 5, scoreP2: 3, source: 'extension' });
    expect(patched.status).toBe(200);
    expect(patched.body.status).toBe('finished');
    expect(patched.body.winnerId).toBe(idA);
    expect(patched.body.source).toBe('extension');
  });

  it('non-participant cannot post score (403)', async () => {
    const created = await request(app)
      .post('/matches').set('Authorization', `Bearer ${tokenA}`)
      .send({ game: 'basket_random', opponentPseudo: 'bobby' });
    // crée un 3e user
    const carl = await request(app).post('/auth/register').send({ pseudo: 'carl_', password: 'secret1' });
    const res = await request(app)
      .patch(`/matches/${created.body.id}/score`).set('Authorization', `Bearer ${carl.body.token}`)
      .send({ scoreP1: 1, scoreP2: 0, source: 'manual' });
    expect(res.status).toBe(403);
  });

  it('manual finish computes winner when no auto-finish', async () => {
    const created = await request(app)
      .post('/matches').set('Authorization', `Bearer ${tokenA}`)
      .send({ game: 'darts', opponentPseudo: 'bobby' });
    await request(app)
      .patch(`/matches/${created.body.id}/score`).set('Authorization', `Bearer ${tokenA}`)
      .send({ scoreP1: 3, scoreP2: 1, source: 'manual' });
    const fin = await request(app).post(`/matches/${created.body.id}/finish`).set('Authorization', `Bearer ${tokenA}`);
    expect(fin.status).toBe(200);
    expect(fin.body.status).toBe('finished');
    expect(fin.body.winnerId).toBe(idA);
  });

  it('GET /matches?scope=me returns the user\'s matches', async () => {
    const res = await request(app).get('/matches?scope=me').set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    // Tous les matchs renvoyés impliquent alice
    expect(res.body.every((m) => m.player1Id === idA || m.player2Id === idA)).toBe(true);
  });
});
