import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';

// On stubbe Prisma au niveau du module pour que les routes utilisent un client en mémoire.
vi.mock('../src/db/prisma.js', async () => {
  const users = new Map(); // id -> user
  const byPseudo = new Map(); // pseudo -> id
  return {
    prisma: {
      user: {
        async create({ data }) {
          if (byPseudo.has(data.pseudo)) {
            const e = new Error('Unique constraint');
            e.code = 'P2002';
            e.meta = { target: ['pseudo'] };
            throw e;
          }
          const u = { id: 'u_' + (users.size + 1), pseudo: data.pseudo, passwordHash: data.passwordHash, createdAt: new Date() };
          users.set(u.id, u); byPseudo.set(u.pseudo, u.id);
          return u;
        },
        async findUnique({ where }) {
          if (where.id) return users.get(where.id) || null;
          if (where.pseudo) {
            const id = byPseudo.get(where.pseudo);
            return id ? users.get(id) : null;
          }
          return null;
        },
      },
    },
  };
});

let app;
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-test-secret';
  process.env.BCRYPT_ROUNDS = '4'; // tests rapides
  const { buildApp } = await import('../src/app.js');
  app = buildApp();
});

describe('auth flow', () => {
  it('rejects invalid pseudo format', async () => {
    const res = await request(app).post('/auth/register').send({ pseudo: 'a', password: 'secret1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('registers a user and returns a JWT + the public user shape', async () => {
    const res = await request(app).post('/auth/register').send({ pseudo: 'tom', password: 'secret1' });
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^eyJ/);
    expect(res.body.user.pseudo).toBe('tom');
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  it('rejects duplicate pseudo with 409 conflict', async () => {
    await request(app).post('/auth/register').send({ pseudo: 'sarah', password: 'secret1' });
    const dup = await request(app).post('/auth/register').send({ pseudo: 'sarah', password: 'secret1' });
    expect(dup.status).toBe(409);
  });

  it('logs in with correct credentials, rejects wrong password', async () => {
    await request(app).post('/auth/register').send({ pseudo: 'leo', password: 'secret1' });
    const ok = await request(app).post('/auth/login').send({ pseudo: 'leo', password: 'secret1' });
    expect(ok.status).toBe(200);
    const ko = await request(app).post('/auth/login').send({ pseudo: 'leo', password: 'wrongone' });
    expect(ko.status).toBe(401);
  });

  it('GET /me with JWT returns the user, without JWT returns 401', async () => {
    const reg = await request(app).post('/auth/register').send({ pseudo: 'nina', password: 'secret1' });
    const token = reg.body.token;
    const ok = await request(app).get('/me').set('Authorization', `Bearer ${token}`);
    expect(ok.status).toBe(200);
    expect(ok.body.pseudo).toBe('nina');
    const ko = await request(app).get('/me');
    expect(ko.status).toBe(401);
  });
});
