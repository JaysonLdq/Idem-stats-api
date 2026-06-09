import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';

// Le leaderboard agrège les matchs finished. On stocke des matchs déjà terminés.
vi.mock('../src/db/prisma.js', async () => {
  const users = new Map();
  const byPseudo = new Map();
  const matches = new Map();
  let seq = 0;
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
        async findMany({ where, select: _s }) {
          let list = [...users.values()];
          if (where?.id?.in) list = list.filter((u) => where.id.in.includes(u.id));
          return list.map(({ id, pseudo, createdAt }) => ({ id, pseudo, createdAt }));
        },
      },
      match: {
        async findMany({ where, select: _s }) {
          let list = [...matches.values()];
          if (where?.status) list = list.filter((m) => m.status === where.status);
          if (where?.game) list = list.filter((m) => m.game === where.game);
          return list;
        },
      },
    },
    __seed: { users, matches, byPseudo, seq: () => ++seq },
  };
});

let app;
let A, B, C, tokenA;
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-test-secret';
  process.env.BCRYPT_ROUNDS = '4';
  const mod = await import('../src/db/prisma.js');
  const { buildApp } = await import('../src/app.js');
  app = buildApp();

  // Crée 3 users
  const ra = await request(app).post('/auth/register').send({ pseudo: 'alpha', password: 'secret1' });
  const rb = await request(app).post('/auth/register').send({ pseudo: 'beta_', password: 'secret1' });
  const rc = await request(app).post('/auth/register').send({ pseudo: 'gamma', password: 'secret1' });
  A = ra.body.user.id; B = rb.body.user.id; C = rc.body.user.id;
  tokenA = ra.body.token;

  // Seed direct des matchs : A bat B en darts (1), A bat C en basket (1),
  // B bat C en darts (1), match nul A vs B en basket
  const seed = (data) => {
    const m = { id: 'm_' + mod.__seed.seq(), status: 'finished', ...data };
    mod.__seed.matches.set(m.id, m);
  };
  seed({ game: 'darts',         player1Id: A, player2Id: B, winnerId: A });
  seed({ game: 'basket_random', player1Id: A, player2Id: C, winnerId: A });
  seed({ game: 'darts',         player1Id: B, player2Id: C, winnerId: B });
  seed({ game: 'basket_random', player1Id: A, player2Id: B, winnerId: null }); // nul
});

describe('GET /leaderboard', () => {
  it('global → trié par victoires desc, A en tête (2 wins)', async () => {
    const res = await request(app).get('/leaderboard').set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    const top = res.body[0];
    expect(top.user.pseudo).toBe('alpha');
    expect(top.wins).toBe(2);
    expect(top.played).toBe(3); // A a joué darts (V), basket (V), basket (nul)
    expect(top.losses).toBe(0);
    expect(top.winrate).toBeCloseTo(2 / 3, 3);
  });

  it('global → user sans match présent à 0', async () => {
    // ajoute un user "ghost" sans matchs
    await request(app).post('/auth/register').send({ pseudo: 'ghost', password: 'secret1' });
    const res = await request(app).get('/leaderboard').set('Authorization', `Bearer ${tokenA}`);
    const ghost = res.body.find((e) => e.user.pseudo === 'ghost');
    expect(ghost).toBeDefined();
    expect(ghost.wins + ghost.losses + ghost.played).toBe(0);
  });

  it('filtré par jeu → uniquement les stats sur ce jeu', async () => {
    const res = await request(app).get('/leaderboard?game=darts').set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    const map = Object.fromEntries(res.body.map((e) => [e.user.pseudo, e]));
    expect(map.alpha.wins).toBe(1);
    expect(map.beta_.wins).toBe(1);
    expect(map.gamma.wins).toBe(0);
    expect(map.gamma.losses).toBe(1);
  });
});
