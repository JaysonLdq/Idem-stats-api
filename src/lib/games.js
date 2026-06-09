// Règles par jeu. Le jeu détermine la borne du score et si la fin est automatique.

export const GAMES = {
  basket_random: { display: 'Basket Random', maxScore: 5, autoFinishAt: 5 },
  darts:         { display: 'Fléchettes',    maxScore: 999, autoFinishAt: null },
  baby:          { display: 'Babyfoot',      maxScore: 99,  autoFinishAt: null },
  pingpong:      { display: 'Ping-pong',     maxScore: 21,  autoFinishAt: 11 },
  clicker:       { display: 'Click Battle',  maxScore: 9999, autoFinishAt: null },
};

export function gameOrThrow(id) {
  const g = GAMES[id];
  if (!g) {
    const e = new Error('unknown_game');
    e.status = 400;
    e.code = 'unknown_game';
    throw e;
  }
  return g;
}

// premier à autoFinishAt → terminé auto
export function shouldAutoFinish(gameId, scoreP1, scoreP2) {
  const g = GAMES[gameId];
  if (!g?.autoFinishAt) return false;
  return scoreP1 >= g.autoFinishAt || scoreP2 >= g.autoFinishAt;
}

// winner null si nul, sinon player1Id / player2Id
export function computeWinner({ scoreP1, scoreP2, player1Id, player2Id }) {
  if (scoreP1 === scoreP2) return null;
  return scoreP1 > scoreP2 ? player1Id : player2Id;
}
