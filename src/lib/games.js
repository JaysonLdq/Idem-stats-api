// Règles par jeu. Le jeu détermine la borne du score et si la fin est automatique.

export const GAMES = {
  // Premier à 5 ou 6 : Basket Random a des balles "double point" qui peuvent
  // faire passer le score de 4 à 6 en une fois. autoFinishAt=5 + helper en ">="
  // → 5 ou 6 déclenchent la victoire. maxScore=6 plafonne le score envoyé.
  basket_random: { display: 'Basket Random', maxScore: 6, autoFinishAt: 5 },
  darts:         { display: 'Fléchettes',    maxScore: 999, autoFinishAt: null },
  baby:          { display: 'Babyfoot',      maxScore: 99,  autoFinishAt: null },
  // Renommé pingpong → pong côté front. On garde 'pingpong' comme alias caché
  // pour ne pas casser les matchs existants en BDD avec game='pingpong'.
  pong:          { display: 'Pong',          maxScore: 21,  autoFinishAt: 10 },
  pingpong:      { display: 'Pong',          maxScore: 21,  autoFinishAt: 10 },
  clicker:       { display: 'Click Battle',  maxScore: 9999, autoFinishAt: null },
  // Snake 1v1 jouable sur même clavier (flèches vs ZQSD). Score = longueur finale.
  snake:         { display: 'Snake 1v1',     maxScore: 999, autoFinishAt: null },
  // Billard 8-ball : 7 solid + 7 stripe + cue + noire. Score envoyé = bonus 100
  // pour le vainqueur (correctement potée par la noire) + boules de son groupe.
  billiards:     { display: 'Billard',       maxScore: 200, autoFinishAt: null },
  // Échecs 1v1 : score envoyé = 1 pour le vainqueur, 0 pour le perdant, 0-0 nul.
  chess:         { display: 'Échecs',        maxScore: 1,   autoFinishAt: null },
  // Shifumi : duel en 1 manche, créé déjà résolu (pas de score qui monte).
  shifumi:       { display: 'Shifumi',       maxScore: 1,   autoFinishAt: null },
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

// ── Shifumi (papier / pierre / ciseaux) ───────────────────────────────
export const RPS_PICKS = ['rock', 'paper', 'scissors'];
export const RPS_LABELS = { rock: 'Pierre', paper: 'Papier', scissors: 'Ciseaux' };

// pierre écrase ciseaux, ciseaux coupe papier, papier emballe pierre.
const RPS_BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

export function rpsBeats(winnerPick, loserPick) {
  return RPS_BEATS[winnerPick] === loserPick;
}
