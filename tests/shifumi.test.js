import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import { rpsBeats } from '../src/lib/games.js';

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
      },
    },
  };
});

describe('rpsBeats (règles)', () => {
  it('pierre bat ciseaux', () => expect(rpsBeats('rock', 'scissors')).toBe(true));
  it('ciseaux bat papier', () => expect(rpsBeats('scissors', 'paper')).toBe(true));
  it('papier bat pierre', () => expect(rpsBeats('paper', 'rock')).toBe(true));
  it('pierre ne bat pas papier', () => expect(rpsBeats('rock', 'paper')).toBe(false));
  it('égalité refusée', () => expect(rpsBeats('rock', 'rock')).toBe(false));
});

let app, tokenA, tokenB;
beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-test-secret';
  process.env.BCRYPT_ROUNDS = '4';
  const { buildApp } = await import('../src/app.js');
  app = buildApp();
  const a = await request(app).post('/auth/register').send({ pseudo: 'alpha', password: 'secret1' });
  const b = await request(app).post('/auth/register').send({ pseudo: 'beta_', password: 'secret1' });
  tokenA = a.body.token; tokenB = b.body.token;
});

describe('POST /matches (game=shifumi)', () => {
  it('crée un match finished avec score 1-0 quand je gagne', async () => {
    const res = await request(app)
      .post('/matches').set('Authorization', `Bearer ${tokenA}`)
      .send({
        game: 'shifumi',
        opponentPseudo: 'beta_',
        shifumi: { winnerPseudo: 'alpha', winnerPick: 'rock', loserPick: 'scissors' },
      });
    expect(res.status).toBe(201);
    expect(res.body.game).toBe('shifumi');
    expect(res.body.status).toBe('finished');
    expect(res.body.scoreP1).toBe(1);
    expect(res.body.scoreP2).toBe(0);
    expect(res.body.metadata.winnerPick).toBe('rock');
    expect(res.body.metadata.loserPick).toBe('scissors');
    expect(res.body.metadata.winnerPseudo).toBe('alpha');
    expect(res.body.metadata.loserPseudo).toBe('beta_');
  });

  it('score 0-1 quand l\'opponent gagne', async () => {
    const res = await request(app)
      .post('/matches').set('Authorization', `Bearer ${tokenA}`)
      .send({
        game: 'shifumi',
        opponentPseudo: 'beta_',
        shifumi: { winnerPseudo: 'beta_', winnerPick: 'paper', loserPick: 'rock' },
      });
    expect(res.status).toBe(201);
    expect(res.body.scoreP1).toBe(0);
    expect(res.body.scoreP2).toBe(1);
  });

  it('rejette une combinaison invalide (rock vs paper claim win)', async () => {
    const res = await request(app)
      .post('/matches').set('Authorization', `Bearer ${tokenA}`)
      .send({
        game: 'shifumi',
        opponentPseudo: 'beta_',
        shifumi: { winnerPseudo: 'alpha', winnerPick: 'rock', loserPick: 'paper' },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_shifumi_outcome');
  });

  it('rejette l\'égalité (rock vs rock)', async () => {
    const res = await request(app)
      .post('/matches').set('Authorization', `Bearer ${tokenA}`)
      .send({
        game: 'shifumi',
        opponentPseudo: 'beta_',
        shifumi: { winnerPseudo: 'alpha', winnerPick: 'rock', loserPick: 'rock' },
      });
    expect(res.status).toBe(400);
  });

  it('rejette winnerPseudo qui n\'est pas dans le duel', async () => {
    const res = await request(app)
      .post('/matches').set('Authorization', `Bearer ${tokenA}`)
      .send({
        game: 'shifumi',
        opponentPseudo: 'beta_',
        shifumi: { winnerPseudo: 'zelda', winnerPick: 'rock', loserPick: 'scissors' },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('winner_not_in_match');
  });

  it('rejette si opponentPseudo est absent', async () => {
    const res = await request(app)
      .post('/matches').set('Authorization', `Bearer ${tokenA}`)
      .send({
        game: 'shifumi',
        shifumi: { winnerPseudo: 'alpha', winnerPick: 'rock', loserPick: 'scissors' },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('opponent_required_for_shifumi');
  });

  it('rejette si shifumi block manquant pour game=shifumi', async () => {
    const res = await request(app)
      .post('/matches').set('Authorization', `Bearer ${tokenA}`)
      .send({ game: 'shifumi', opponentPseudo: 'beta_' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('shifumi_block_required');
  });
});
