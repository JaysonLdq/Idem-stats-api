import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Prisma mocké : un user en mémoire, update propage avatarUrl.
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
          Object.assign(u, data);
          return { ...u };
        },
      },
    },
  };
});

let app;
let token;
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-test-secret';
  process.env.BCRYPT_ROUNDS = '4';
  const { buildApp } = await import('../src/app.js');
  app = buildApp();
  const reg = await request(app).post('/auth/register').send({ pseudo: 'avatar1', password: 'secret1' });
  token = reg.body.token;
});

afterAll(async () => {
  // nettoyage des avatars créés par les tests
  const { AVATARS_DIR } = await import('../src/lib/avatar-storage.js');
  await rm(AVATARS_DIR, { recursive: true, force: true });
});

describe('POST /me/avatar', () => {
  it('rejette si pas de fichier', async () => {
    const res = await request(app).post('/me/avatar').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_file');
  });

  it('rejette les types non-image (mime)', async () => {
    const res = await request(app)
      .post('/me/avatar').set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('not an image'), { filename: 'a.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_image_type');
  });

  it('accepte un PNG et renvoie l\'utilisateur avec avatarUrl', async () => {
    const fakePng = Buffer.from('\x89PNG\r\n\x1a\nfake-bytes');
    const res = await request(app)
      .post('/me/avatar').set('Authorization', `Bearer ${token}`)
      .attach('file', fakePng, { filename: 'me.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.avatarUrl).toMatch(/^\/uploads\/avatars\/u_\d+-\d+\.png$/);
    // le fichier existe vraiment sur disque
    const { AVATARS_DIR } = await import('../src/lib/avatar-storage.js');
    const filename = res.body.avatarUrl.split('/').pop();
    expect(existsSync(join(AVATARS_DIR, filename))).toBe(true);
  });

  it('DELETE /me/avatar remet à null', async () => {
    const res = await request(app).delete('/me/avatar').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.avatarUrl).toBeNull();
  });

  it('exige un Bearer valide', async () => {
    const res = await request(app).post('/me/avatar');
    expect(res.status).toBe(401);
  });
});
