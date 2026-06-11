import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';

vi.mock('../src/db/prisma.js', async () => {
  const users = new Map();
  const byPseudo = new Map();
  let seq = 0;
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
        async update({ where, data }) {
          const u = users.get(where.id);
          if (!u) return null;
          if (data.pseudo && data.pseudo !== u.pseudo && byPseudo.has(data.pseudo)) {
            const e = new Error('dup'); e.code = 'P2002'; throw e;
          }
          if (data.pseudo && data.pseudo !== u.pseudo) {
            byPseudo.delete(u.pseudo);
            byPseudo.set(data.pseudo, u.id);
          }
          Object.assign(u, data);
          return { ...u };
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

describe('PATCH /me', () => {
  it('change le pseudo et renvoie le user à jour', async () => {
    const r = await request(app).patch('/me').set('Authorization', `Bearer ${tokA}`).send({ pseudo: 'alpha2' });
    expect(r.status).toBe(200);
    expect(r.body.pseudo).toBe('alpha2');
  });
  it('refuse un pseudo invalide (Zod)', async () => {
    const r = await request(app).patch('/me').set('Authorization', `Bearer ${tokA}`).send({ pseudo: 'a b' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('validation_error');
  });
  it('refuse un pseudo trop court', async () => {
    const r = await request(app).patch('/me').set('Authorization', `Bearer ${tokA}`).send({ pseudo: 'ab' });
    expect(r.status).toBe(400);
  });
  it('renvoie 409 si pseudo déjà pris', async () => {
    const r = await request(app).patch('/me').set('Authorization', `Bearer ${tokA}`).send({ pseudo: 'beta_' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('pseudo_taken');
  });
  it('même pseudo = no-op sans toucher la base', async () => {
    const r = await request(app).patch('/me').set('Authorization', `Bearer ${tokB}`).send({ pseudo: 'beta_' });
    expect(r.status).toBe(200);
    expect(r.body.pseudo).toBe('beta_');
  });
  it('body vide → 400', async () => {
    const r = await request(app).patch('/me').set('Authorization', `Bearer ${tokB}`).send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('nothing_to_update');
  });
  it('exige un Bearer valide', async () => {
    const r = await request(app).patch('/me').send({ pseudo: 'x' });
    expect(r.status).toBe(401);
  });
});
