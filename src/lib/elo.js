// Système ELO façon échecs, calculé à la volée depuis l'historique des matchs
// (pas de stockage en base, donc pas de migration et toujours cohérent avec
// les matchs annulés / supprimés).
//
// Mécanique :
//   - Tous les joueurs démarrent à INITIAL_ELO (1300) sur chaque jeu — milieu
//     de la fourchette Sharknado, ce qui leur laisse de la marge pour monter
//     ou dégringoler sans casser leur expérience d'arrivée.
//   - Après un match : E_a = 1 / (1 + 10^((R_b - R_a) / 400))  → score attendu
//                      R'_a = R_a + K * (S_a - E_a)            → nouvelle rating
//   - K-factor décroît avec l'expérience : K=40 pour les <20 matchs sur ce
//     jeu précis, K=24 ensuite. Conséquence : un débutant progresse vite,
//     un vétéran fluctue moins.
//   - Combiné avec E_a, cela donne :
//       * Fort qui bat faible → gain faible (E_a était déjà proche de 1)
//       * Faible qui bat fort → gros gain (upset bien récompensé)
//       * Fort qui perd contre faible → grosse perte
//       * Faible qui perd contre fort → petite perte
//
// Global ELO d'un joueur = moyenne POND ÉRÉE par games_played de ses ELO
// par jeu pratiqué. Un joueur qui a 50 parties de Pong à 1500 et 1 partie de
// Snake gagnée à 1320 → global tiré vers Pong (50/(50+1) = 98%), pas 50/50.

export const INITIAL_ELO = 1300;
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
 * @param {Array<{game:string, player1Id:string, player2Id:string|null, winnerId:string|null, status?:string}>} matches
 *        Matchs déjà triés par finishedAt ASC. Idéalement déjà filtrés sur
 *        status='finished' par le caller — on le re-vérifie quand même ici.
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
    // Garde-fous : on ignore tout match qui ne peut pas légitimement
    // contribuer au calcul, plutôt que d'introduire des biais silencieux.
    if (!m.player1Id || !m.player2Id) continue;          // pas un duel 2-joueurs
    if (m.status && m.status !== 'finished') continue;    // sécurité si caller oublie le filtre
    // Si winnerId est défini, il DOIT être l'un des deux participants —
    // sinon c'est un état corrompu (ref morte ?), on skip plutôt que de
    // traiter en "égalité silencieuse" comme l'ancien code.
    if (m.winnerId != null
        && m.winnerId !== m.player1Id
        && m.winnerId !== m.player2Id) {
      continue;
    }
    const a = getEntry(m.player1Id, m.game);
    const b = getEntry(m.player2Id, m.game);
    const scoreA = m.winnerId === m.player1Id ? 1
                  : m.winnerId === m.player2Id ? 0
                  : 0.5; // winnerId = null → vraie égalité
    const { newA, newB } = updateRatings(a.rating, b.rating, scoreA, a.games, b.games);
    ratings.set(getKey(m.player1Id, m.game), { rating: newA, games: a.games + 1 });
    ratings.set(getKey(m.player2Id, m.game), { rating: newB, games: b.games + 1 });
  }
  return ratings;
}

/**
 * Agrège les ELO par jeu en un ELO global PONDÉRÉ par games_played.
 *
 * L'ancienne version faisait une moyenne arithmétique simple → 1 partie de
 * Snake gagnée par chance pesait autant que 50 parties de Pong honnêtes.
 * On corrige : chaque ELO par jeu est pondéré par sqrt(games) — sqrt plutôt
 * que games linéaire pour ne pas étouffer complètement les jeux peu joués
 * (le random walk de l'ELO se stabilise en sqrt(n)).
 *
 * @returns {Map<string, { global: number, perGame: Record<string, { rating: number, games: number }> }>}
 */
export function computeGlobalElos(ratings) {
  const byUser = new Map();
  for (const [key, entry] of ratings) {
    const [userId, game] = key.split('|');
    const cur = byUser.get(userId) || { weightedSum: 0, totalWeight: 0, perGame: {} };
    // sqrt(games) — donne plus de poids aux jeux qu'on a vraiment travaillé,
    // mais ne nullifie pas un jeu peu joué.
    const weight = Math.sqrt(Math.max(1, entry.games));
    cur.weightedSum += entry.rating * weight;
    cur.totalWeight += weight;
    cur.perGame[game] = entry;
    byUser.set(userId, cur);
  }
  const out = new Map();
  for (const [userId, agg] of byUser) {
    out.set(userId, {
      global: agg.totalWeight > 0 ? Math.round(agg.weightedSum / agg.totalWeight) : INITIAL_ELO,
      perGame: agg.perGame,
    });
  }
  return out;
}

// Tiers de rank — barème custom maison. Ascending order strictly required.
// Paliers resserrés (~150-200 pts) pour qu'on passe d'un rank à l'autre
// en ~6-10 victoires (avec K=32, ~15-20 ELO/win net). Spawn = INITIAL_ELO
// (1300) → MILIEU du tier Sharknado, le "joueur lambda". Pour monter c'est
// Goat → Tigrao → Canigoat. Pour descendre c'est Guez Merguez → Pue sa GM.
const TIERS = [
  { min: 0,    name: 'Pue sa grand mère', color: '#8B5A3C', emoji: '💩' },
  { min: 1000, name: 'Guez Merguez',      color: '#FF8C42', emoji: '🌭' },
  { min: 1200, name: 'Sharknado',         color: '#38B0FF', emoji: '🦈' }, // spawn 1300 ici
  { min: 1400, name: 'Goat',              color: '#F0F0F0', emoji: '🐐' },
  { min: 1550, name: 'Tigrao',            color: '#B026FF', emoji: '🐅' },
  { min: 1700, name: 'Canigoat',          color: '#FFD700', emoji: '🏆' },
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
