import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';

vi.mock('../src/db/prisma.js', async () => {
  const users = new Map();
  const byPseudo = new Map();
  const friendships = new Map();
  let seq = 0;
  function pub(u) { return u ? { id: u.id, pseudo: u.pseudo, avatarUrl: null, createdAt: u.createdAt } : null; }
  function hydrate(f) { return { ...f, requester: pub(users.get(f.requesterId)), addressee: pub(users.get(f.addresseeId)) }; }
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
      friendship: {
        async findUnique({ where }) {
          if (where.id) return friendships.get(where.id) || null;
          if (where.requesterId_addresseeId) {
            const key = `${where.requesterId_addresseeId.requesterId}|${where.requesterId_addresseeId.addresseeId}`;
            for (const f of friendships.values()) if (`${f.requesterId}|${f.addresseeId}` === key) return f;
            return null;
          }
          return null;
        },
        async findMany({ where, include: _i }) {
          let list = [...friendships.values()];
          if (where?.OR) {
            list = list.filter((f) => where.OR.some((c) => (c.requesterId && f.requesterId === c.requesterId) || (c.addresseeId && f.addresseeId === c.addresseeId)));
          }
          return list.map(hydrate);
        },
        async create({ data, include: _i }) {
          const key = `${data.requesterId}|${data.addresseeId}`;
          for (const f of friendships.values()) if (`${f.requesterId}|${f.addresseeId}` === key) { const e = new Error('dup'); e.code = 'P2002'; throw e; }
          const f = { id: 'f_' + (++seq), status: 'pending', acceptedAt: null, createdAt: new Date(), ...data };
          friendships.set(f.id, f);
          return hydrate(f);
        },
        async update({ where, data, include: _i }) {
          const f = friendships.get(where.id);
          if (!f) return null;
          Object.assign(f, data);
          return hydrate(f);
        },
        async delete({ where }) {
          friendships.delete(where.id);
          return null;
        },
      },
    },
  };
});

let app;
let tokA, tokB, tokC, idA, idB;
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

describe('friends', () => {
  it('refuse une demande à soi-même', async () => {
    const r = await request(app).post('/friends').set('Authorization', `Bearer ${tokA}`).send({ pseudo: 'alpha' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('cannot_friend_self');
  });

  it('envoie une demande, la voit en outgoing/incoming', async () => {
    const r = await request(app).post('/friends').set('Authorization', `Bearer ${tokA}`).send({ pseudo: 'beta_' });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('pending');
    expect(r.body.direction).toBe('outgoing');
    expect(r.body.user.pseudo).toBe('beta_');

    const listA = await request(app).get('/friends').set('Authorization', `Bearer ${tokA}`);
    expect(listA.body.outgoing.length).toBe(1);
    expect(listA.body.incoming.length).toBe(0);

    const listB = await request(app).get('/friends').set('Authorization', `Bearer ${tokB}`);
    expect(listB.body.incoming.length).toBe(1);
    expect(listB.body.incoming[0].user.pseudo).toBe('alpha');
  });

  it('addressee accepte → status accepted des deux côtés', async () => {
    const listB = await request(app).get('/friends').set('Authorization', `Bearer ${tokB}`);
    const id = listB.body.incoming[0].id;
    const ok = await request(app).post(`/friends/${id}/accept`).set('Authorization', `Bearer ${tokB}`);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('accepted');

    const listA = await request(app).get('/friends').set('Authorization', `Bearer ${tokA}`);
    expect(listA.body.friends.length).toBe(1);
    expect(listA.body.friends[0].user.pseudo).toBe('beta_');
  });

  it('requester ne peut pas accepter sa propre demande', async () => {
    const r1 = await request(app).post('/friends').set('Authorization', `Bearer ${tokA}`).send({ pseudo: 'gamma' });
    const id = r1.body.id;
    const r = await request(app).post(`/friends/${id}/accept`).set('Authorization', `Bearer ${tokA}`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('not_addressee');
  });

  it('DELETE = refuser une demande / supprimer un ami', async () => {
    const listC = await request(app).get('/friends').set('Authorization', `Bearer ${tokC}`);
    const reqId = listC.body.incoming[0].id;
    const del = await request(app).delete(`/friends/${reqId}`).set('Authorization', `Bearer ${tokC}`);
    expect(del.status).toBe(204);
    const refresh = await request(app).get('/friends').set('Authorization', `Bearer ${tokC}`);
    expect(refresh.body.incoming.length).toBe(0);
  });

  it('demande inverse pending → acceptation directe', async () => {
    // delta envoie d'abord
    const delta = await request(app).post('/auth/register').send({ pseudo: 'delta', password: 'secret1' });
    const tokD = delta.body.token;
    await request(app).post('/friends').set('Authorization', `Bearer ${tokD}`).send({ pseudo: 'alpha' });
    // alpha envoie en retour → l'API doit accepter directement
    const r = await request(app).post('/friends').set('Authorization', `Bearer ${tokA}`).send({ pseudo: 'delta' });
    expect(r.body.status).toBe('accepted');
  });
});
