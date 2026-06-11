import { describe, it, expect } from 'vitest';
import { computeBadges } from '../src/lib/badges.js';

// Helpers d'arrangement
function m(game, p1, p2, winner, daysAgo = 0, scoreP1 = 0, scoreP2 = 0) {
  return {
    game, status: 'finished',
    player1Id: p1, player2Id: p2, winnerId: winner,
    scoreP1, scoreP2,
    finishedAt: new Date(Date.now() - daysAgo * 86_400_000),
  };
}

describe('computeBadges', () => {
  it('décerne <Game> Monster au user avec le plus de wins', () => {
    const matches = [
      m('darts', 'a', 'b', 'a'), m('darts', 'a', 'b', 'a'), m('darts', 'a', 'b', 'a'),
      m('darts', 'b', 'c', 'b'),
    ];
    const aBadges = computeBadges({ userId: 'a', pseudo: 'a', allMatches: matches });
    expect(aBadges.find((b) => b.id === 'monster-darts')).toBeDefined();
    const bBadges = computeBadges({ userId: 'b', pseudo: 'b', allMatches: matches });
    expect(bBadges.find((b) => b.id === 'monster-darts')).toBeUndefined();
  });

  it('décerne Pue sa mère à <Game> au user avec le plus de défaites (min 3 played)', () => {
    const matches = [
      m('darts', 'a', 'b', 'a'), // b L1
      m('darts', 'c', 'b', 'c'), // b L2
      m('darts', 'a', 'b', 'a'), // b L3
    ];
    const bBadges = computeBadges({ userId: 'b', pseudo: 'b', allMatches: matches });
    expect(bBadges.find((x) => x.id === 'shame-darts')).toBeDefined();
    expect(bBadges.find((x) => x.id === 'shame-darts').label).toBe('Pue sa mère à Fléchettes');
  });

  it('Pue sa mère exige >= 3 played (sinon pas de badge "shame")', () => {
    const matches = [m('darts', 'a', 'b', 'a')]; // b a 1 défaite uniquement
    const bBadges = computeBadges({ userId: 'b', pseudo: 'b', allMatches: matches });
    expect(bBadges.find((x) => x.kind === 'shame')).toBeUndefined();
  });

  it('Sniper : >= 90% winrate sur >= 10 parties', () => {
    const matches = [];
    for (let i = 0; i < 10; i++) matches.push(m('darts', 'a', 'b', 'a'));
    matches.push(m('darts', 'a', 'b', 'b')); // a : 10W 1L = 90.9%
    const a = computeBadges({ userId: 'a', pseudo: 'a', allMatches: matches });
    expect(a.find((x) => x.id === 'wr-sniper')).toBeDefined();
  });

  it('streak compte les victoires consécutives les plus récentes uniquement', () => {
    const matches = [
      m('darts', 'a', 'b', 'a', 5),
      m('darts', 'a', 'b', 'b', 4), // défaite intermédiaire
      m('darts', 'a', 'b', 'a', 3),
      m('darts', 'a', 'b', 'a', 2),
      m('darts', 'a', 'b', 'a', 1),
      m('darts', 'a', 'b', 'a', 0), // dernier match : 4 wins d'affilée → "En feu"
    ];
    // Wait : compte les 4 derniers où 'a' a gagné → 4. Sous le seuil de 5.
    // Donc "Sur une lancée" (>=3) attendu, pas "En feu".
    const a = computeBadges({ userId: 'a', pseudo: 'a', allMatches: matches });
    const streak = a.find((x) => x.kind === 'streak');
    expect(streak).toBeDefined();
    expect(streak.id).toBe('streak-rolling');
  });

  it('Brave petit soldat : <= 25% winrate sur >= 5 parties', () => {
    const matches = [];
    for (let i = 0; i < 4; i++) matches.push(m('darts', 'a', 'b', 'a'));
    matches.push(m('darts', 'a', 'b', 'b')); // b : 1W 4L = 20%
    const b = computeBadges({ userId: 'b', pseudo: 'b', allMatches: matches });
    expect(b.find((x) => x.id === 'wr-brave')).toBeDefined();
  });

  it('Fantôme si jamais joué', () => {
    const z = computeBadges({ userId: 'z', pseudo: 'z', allMatches: [] });
    expect(z.find((x) => x.id === 'volume-ghost')).toBeDefined();
  });

  it("5-0 au Basket Random : badge éphémère décerné au perdant", () => {
    const matches = [m('basket_random', 'a', 'b', 'a', 0, 5, 0)];
    const b = computeBadges({ userId: 'b', pseudo: 'b', allMatches: matches });
    expect(b.find((x) => x.id === 'shame-basket-5-0')).toBeDefined();
    const a = computeBadges({ userId: 'a', pseudo: 'a', allMatches: matches });
    expect(a.find((x) => x.id === 'shame-basket-5-0')).toBeUndefined();
  });

  it("5-0 Basket : le badge disparaît dès que le perdant rejoue (quel que soit le jeu)", () => {
    const matches = [
      m('basket_random', 'a', 'b', 'a', 2, 5, 0), // ancien : 5-0 sur b
      m('darts',         'b', 'c', 'b', 0, 7, 4), // dernier match de b : autre jeu → badge nettoyé
    ];
    const b = computeBadges({ userId: 'b', pseudo: 'b', allMatches: matches });
    expect(b.find((x) => x.id === 'shame-basket-5-0')).toBeUndefined();
  });

  it("Score 5-1 au Basket : pas de badge mangeave (perfect game requis)", () => {
    const matches = [m('basket_random', 'a', 'b', 'a', 0, 5, 1)];
    const b = computeBadges({ userId: 'b', pseudo: 'b', allMatches: matches });
    expect(b.find((x) => x.id === 'shame-basket-5-0')).toBeUndefined();
  });

  it('Monster par jeu : un user peut être Monster sur jeu X et Pue sa mère sur jeu Y', () => {
    const matches = [
      m('darts',   'a', 'b', 'a'), m('darts', 'a', 'b', 'a'), m('darts', 'a', 'b', 'a'),
      m('snake',   'a', 'b', 'b'), m('snake', 'a', 'b', 'b'), m('snake', 'a', 'b', 'b'),
      m('snake',   'a', 'c', 'c'),
    ];
    const a = computeBadges({ userId: 'a', pseudo: 'a', allMatches: matches });
    expect(a.find((x) => x.id === 'monster-darts')).toBeDefined();
    expect(a.find((x) => x.id === 'shame-snake')).toBeDefined();
  });
});
