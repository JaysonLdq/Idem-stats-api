import { describe, it, expect } from 'vitest';
import { shouldAutoFinish, computeWinner, gameOrThrow } from '../src/lib/games.js';

describe('game rules', () => {
  it('basket_random auto-finishes when one side hits 5', () => {
    expect(shouldAutoFinish('basket_random', 5, 3)).toBe(true);
    expect(shouldAutoFinish('basket_random', 4, 4)).toBe(false);
    expect(shouldAutoFinish('basket_random', 3, 5)).toBe(true);
  });

  it('darts never auto-finishes', () => {
    expect(shouldAutoFinish('darts', 501, 0)).toBe(false);
  });

  it('computeWinner returns null on tie, else the leading player id', () => {
    expect(computeWinner({ scoreP1: 3, scoreP2: 3, player1Id: 'a', player2Id: 'b' })).toBeNull();
    expect(computeWinner({ scoreP1: 5, scoreP2: 3, player1Id: 'a', player2Id: 'b' })).toBe('a');
    expect(computeWinner({ scoreP1: 1, scoreP2: 5, player1Id: 'a', player2Id: 'b' })).toBe('b');
  });

  it('gameOrThrow rejects unknown game ids with status 400', () => {
    expect(() => gameOrThrow('not-a-game')).toThrow();
  });
});
