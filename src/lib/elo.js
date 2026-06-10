// Système ELO façon échecs, calculé à la volée depuis l'historique des matchs
// (pas de stockage en base, donc pas de migration et toujours cohérent avec
// les matchs annulés / supprimés).
//
// Mécanique :
//   - Tous les joueurs démarrent à INITIAL_ELO (1000) sur chaque jeu
//   - Après un match : E_a = 1 / (1 + 10^((R_b - R_a) / 400))  → score attendu
//                      R'_a = R_a + K * (S_a - E_a)            → nouvelle rating
//   - K-factor décroît avec l'expérience : K=40 pour les <20 matchs, K=24 ensuite.
//     Conséquence naturelle : un débutant progresse vite, un vétéran fluctue
//     moins. Combiné avec E_a, cela donne :
//       * Fort qui bat faible → gain faible (E_a était déjà proche de 1)
//       * Faible qui bat fort → gros gain (upset bien récompensé)
//       * Fort qui perd contre faible → grosse perte
//       * Faible qui perd contre fort → petite perte (le pronostic était attendu)
//
// Global ELO d'un joueur = moyenne arithmétique de ses ELO par jeu joué (un
// joueur qui n'a jamais touché à Snake ne se prend pas 1000 par défaut en
// pénalité — seulement les jeux pratiqués comptent).

export const INITIAL_ELO = 1000;
export const K_NEWBIE = 40;        // < 20 matchs sur le jeu
export const K_ESTABLISHED = 24;   // 20+ matchs

export function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

function kFactor(gamesPlayed) {
  return gamesPlayed < 20 ? K_NEWBIE : K_ESTABLISHED;
}

/** Renvoie {newA, newB, deltaA, deltaB}. scoreA = 1 win, 0 loss, 0.5 draw. */
export function updateRatings(ratingA, ratingB, scoreA, gamesPlayedA = 0, gamesPlayedB = 0) {
  const expA = expectedScore(ratingA, ratingB);
  const expB = 1 - expA;
  const kA = kFactor(gamesPlayedA);
  const kB = kFactor(gamesPlayedB);
  const newA = Math.round(ratingA + kA * (scoreA - expA));
  const newB = Math.round(ratingB + kB * ((1 - scoreA) - expB));
  return { newA, newB, deltaA: newA - ratingA, deltaB: newB - ratingB };
}

/**
 * Replay tous les matchs finished en ordre chrono pour calculer l'ELO actuel
 * de chaque (user, game).
 *
 * @param {Array<{game:string, player1Id:string, player2Id:string|null, winnerId:string|null}>} matches
 *        Matchs déjà triés par finishedAt ASC.
 * @returns {Map<string, { rating: number, games: number }>} clé = `${userId}|${gameId}`
 */
export function computeElos(matches) {
  const ratings = new Map();
  const getKey = (userId, game) => `${userId}|${game}`;
  const getEntry = (userId, game) => {
    const k = getKey(userId, game);
    return ratings.get(k) || { rating: INITIAL_ELO, games: 0 };
  };
  for (const m of matches) {
    if (!m.player2Id) continue; // pas un duel 2-joueurs
    const a = getEntry(m.player1Id, m.game);
    const b = getEntry(m.player2Id, m.game);
    const scoreA = m.winnerId === m.player1Id ? 1
                  : m.winnerId === m.player2Id ? 0
                  : 0.5; // null = nul
    const { newA, newB } = updateRatings(a.rating, b.rating, scoreA, a.games, b.games);
    ratings.set(getKey(m.player1Id, m.game), { rating: newA, games: a.games + 1 });
    ratings.set(getKey(m.player2Id, m.game), { rating: newB, games: b.games + 1 });
  }
  return ratings;
}

/**
 * Agrège les ELO par jeu en un ELO global (moyenne des jeux joués).
 *
 * @returns {Map<string, { global: number, perGame: Record<string, { rating: number, games: number }> }>}
 */
export function computeGlobalElos(ratings) {
  const byUser = new Map();
  for (const [key, entry] of ratings) {
    const [userId, game] = key.split('|');
    const cur = byUser.get(userId) || { sum: 0, count: 0, perGame: {} };
    cur.sum += entry.rating;
    cur.count += 1;
    cur.perGame[game] = entry;
    byUser.set(userId, cur);
  }
  const out = new Map();
  for (const [userId, agg] of byUser) {
    out.set(userId, {
      global: agg.count > 0 ? Math.round(agg.sum / agg.count) : INITIAL_ELO,
      perGame: agg.perGame,
    });
  }
  return out;
}

// Tiers de rank — barème custom maison. Ascending order strictly required.
// Tous les nouveaux joueurs démarrent à 1000 ELO → ils sont Pue sa grand mère
// jusqu'à preuve du contraire. Personne n'est épargné.
const TIERS = [
  { min: 0,    name: 'Pue sa grand mère', color: '#8B5A3C', emoji: '💩' },
  { min: 1100, name: 'Guez Merguez',      color: '#FF8C42', emoji: '🌭' },
  { min: 1250, name: 'Sharknado',         color: '#38B0FF', emoji: '🦈' },
  { min: 1450, name: 'Goat',              color: '#F0F0F0', emoji: '🐐' },
  { min: 1650, name: 'Trigrao',           color: '#B026FF', emoji: '🐅' },
  { min: 1900, name: 'Canigoat',          color: '#FFD700', emoji: '🏆' },
];

/** Retourne { name, color, emoji, min, nextMin } pour un ELO donné. */
export function rankFromElo(elo) {
  let tier = TIERS[0];
  let next = null;
  for (let i = 0; i < TIERS.length; i++) {
    if (elo >= TIERS[i].min) {
      tier = TIERS[i];
      next = TIERS[i + 1] || null;
    } else {
      break;
    }
  }
  return {
    name: tier.name,
    color: tier.color,
    emoji: tier.emoji,
    min: tier.min,
    nextMin: next ? next.min : null,
  };
}
