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
          if (where.id) return users.get(where.id) || null;
          if (where.pseudo) { const id = byPseudo.get(where.pseudo); return id ? users.get(id) : null; }
          return null;
        },
      },
      match: {
        async create({ data, include: _i }) {
          const m = { id: 'm_' + (++seq), scoreP1: 0, scoreP2: 0, ...data, createdAt: new Date() };
          matches.set(m.id, m);
          return hydrate(m);
        },
        async findMany({ where, orderBy: _o, take, include: _i }) {
          let list = [...matches.values()];
          if (where?.OR) {
            list = list.filter((m) => where.OR.some((c) =>
              (c.player1Id && m.player1Id === c.player1Id) || (c.player2Id && m.player2Id === c.player2Id),
            ));
          }
          if (where?.game) list = list.filter((m) => m.game === where.game);
          return list.slice(-(take || 100)).reverse().map(hydrate);
        },
      },
    },
  };
});

let app, tokA, tokB, tokC;
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-test-secret';
  process.env.BCRYPT_ROUNDS = '4';
  const { buildApp } = await import('../src/app.js');
  app = buildApp();
  const ra = await request(app).post('/auth/register').send({ pseudo: 'alpha', password: 'secret1' });
  const rb = await request(app).post('/auth/register').send({ pseudo: 'beta_', password: 'secret1' });
  const rc = await request(app).post('/auth/register').send({ pseudo: 'gamma', password: 'secret1' });
  tokA = ra.body.token; tokB = rb.body.token; tokC = rc.body.token;
  // A bat B en darts ; A bat C en basket
  await request(app).post('/matches').set('Authorization', `Bearer ${tokA}`).send({ game: 'darts', opponentPseudo: 'beta_' });
  await request(app).post('/matches').set('Authorization', `Bearer ${tokA}`).send({ game: 'basket_random', opponentPseudo: 'gamma' });
});

describe('GET /matches?userPseudo=', () => {
  it('liste tous les matchs d\'un user nommé (vue tiers)', async () => {
    const r = await request(app).get('/matches?userPseudo=alpha').set('Authorization', `Bearer ${tokB}`);
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(2);
    expect(r.body.every((m) => m.player1?.pseudo === 'alpha' || m.player2?.pseudo === 'alpha')).toBe(true);
  });
  it('user inexistant → liste vide', async () => {
    const r = await request(app).get('/matches?userPseudo=ghost').set('Authorization', `Bearer ${tokB}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });
  it('filtre cumulable avec game', async () => {
    const r = await request(app).get('/matches?userPseudo=alpha&game=darts').set('Authorization', `Bearer ${tokC}`);
    expect(r.body.length).toBe(1);
    expect(r.body[0].game).toBe('darts');
  });
});

describe('shifumi condition', () => {
  it('IRL : la condition est persistée et renvoyée dans metadata', async () => {
    const r = await request(app).post('/matches').set('Authorization', `Bearer ${tokA}`).send({
      game: 'shifumi', opponentPseudo: 'beta_',
      shifumi: {
        winnerPseudo: 'alpha', winnerPick: 'rock', loserPick: 'scissors',
        condition: 'celui qui perd paye le café',
      },
    });
    expect(r.status).toBe(201);
    expect(r.body.metadata.condition).toBe('celui qui perd paye le café');
  });

  it('Remote : la condition est posée à la création et visible côté opponent', async () => {
    const r = await request(app).post('/matches').set('Authorization', `Bearer ${tokA}`).send({
      game: 'shifumi', opponentPseudo: 'beta_',
      shifumi: { mode: 'remote', myPick: 'paper', condition: 'le perdant range la vaisselle' },
    });
    expect(r.status).toBe(201);
    expect(r.body.metadata.condition).toBe('le perdant range la vaisselle');
    // Côté opponent : creatorPick masqué, condition toujours visible
    const asB = await request(app).get(`/matches/${r.body.id}`).set('Authorization', `Bearer ${tokB}`);
    expect(asB.body.metadata.creatorPick).toBeUndefined();
    expect(asB.body.metadata.condition).toBe('le perdant range la vaisselle');
  });

  it('Condition > 200 chars → 400 validation', async () => {
    const r = await request(app).post('/matches').set('Authorization', `Bearer ${tokA}`).send({
      game: 'shifumi', opponentPseudo: 'beta_',
      shifumi: {
        winnerPseudo: 'alpha', winnerPick: 'rock', loserPick: 'scissors',
        condition: 'x'.repeat(201),
      },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation_error');
  });
});
