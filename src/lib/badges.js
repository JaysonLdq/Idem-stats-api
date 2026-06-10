// Calcul des badges d'un user. Tout dérivé des matchs finished : pas de table
// dédiée, recompute à chaque appel (volume petit, c'est OK).
//
// Catégories :
//   - global  : superlatifs PAR JEU calculés sur l'ensemble des users
//                ("Monster" = plus de wins, "Pue sa mère à <jeu>" = plus de losses)
//   - perso   : dépendent uniquement des stats du user (winrate tier, streak, volume)
//
// Banter assumé — c'est entre potes, pas un livret scolaire.

import { GAMES } from './games.js';

const MIN_GAMES_FOR_MONSTER = 1;
const MIN_GAMES_FOR_PUE_SA_MERE = 3;

/**
 * Calcule tous les badges d'un user donné.
 *
 * @param {object} input
 * @param {string} input.userId
 * @param {string} input.pseudo
 * @param {Array<{game:string, status:string, player1Id:string, player2Id:string|null, winnerId:string|null, finishedAt:Date|null}>} input.allMatches
 *        Tous les matchs FINISHED de TOUS les users (l'appelant fait la query une fois).
 */
export function computeBadges({ userId, pseudo, allMatches }) {
  const badges = [];

  // ── Stats agrégées par (user, game) ───────────────────────────────────
  // Map<gameId, Map<userId, {wins, losses, played}>>
  const perGame = new Map();
  for (const m of allMatches) {
    if (m.status !== 'finished') continue;
    const g = perGame.get(m.game) || new Map();
    perGame.set(m.game, g);
    bump(g, m.player1Id, 'played');
    if (m.player2Id) bump(g, m.player2Id, 'played');
    if (m.winnerId) {
      bump(g, m.winnerId, 'wins');
      const loserId = m.winnerId === m.player1Id ? m.player2Id : m.player1Id;
      if (loserId) bump(g, loserId, 'losses');
    }
  }

  // ── Superlatifs par jeu ──────────────────────────────────────────────
  // Pour chaque jeu :
  //   - Monster : le user avec le plus de wins (tie-breaker : meilleur winrate)
  //   - Pue sa mère : le user avec le plus de losses ET au moins MIN_GAMES_FOR_PUE_SA_MERE played
  //     (tie-breaker : pire winrate)
  for (const [gameId, stats] of perGame) {
    const display = GAMES[gameId]?.display || gameId;
    const emoji = gameEmoji(gameId);

    // Monster
    const monster = [...stats.entries()]
      .filter(([, s]) => s.wins >= MIN_GAMES_FOR_MONSTER)
      .sort(([, a], [, b]) => (b.wins - a.wins) || (winrate(b) - winrate(a)))[0];
    if (monster && monster[0] === userId) {
      badges.push({
        id: `monster-${gameId}`,
        kind: 'monster',
        label: `${display} Monster`,
        description: `Le plus de victoires sur ${display} (${monster[1].wins}V).`,
        emoji,
        tone: 'accent',
      });
    }

    // Pue sa mère à <jeu>
    const pue = [...stats.entries()]
      .filter(([, s]) => s.played >= MIN_GAMES_FOR_PUE_SA_MERE && s.losses > 0)
      .sort(([, a], [, b]) => (b.losses - a.losses) || (winrate(a) - winrate(b)))[0];
    if (pue && pue[0] === userId) {
      badges.push({
        id: `shame-${gameId}`,
        kind: 'shame',
        label: `Pue sa mère à ${display}`,
        description: `Le plus de défaites sur ${display} (${pue[1].losses}D / ${pue[1].played}P). Courage.`,
        emoji: '💀',
        tone: 'loss',
      });
    }
  }

  // ── Stats globales du user ───────────────────────────────────────────
  let wins = 0, losses = 0, played = 0;
  for (const stats of perGame.values()) {
    const s = stats.get(userId);
    if (!s) continue;
    wins += s.wins; losses += s.losses; played += s.played;
  }
  const wr = played === 0 ? 0 : wins / played;

  // Volume
  if (played >= 200) {
    badges.push({ id: 'volume-veteran', kind: 'volume', label: 'Vétéran', description: `${played} parties au compteur.`, emoji: '🎖️', tone: 'gold' });
  } else if (played >= 50) {
    badges.push({ id: 'volume-regular', kind: 'volume', label: 'Régulier de la maison', description: `${played} parties au compteur.`, emoji: '🍻', tone: 'muted' });
  } else if (played >= 1) {
    badges.push({ id: 'volume-newcomer', kind: 'volume', label: 'Bienvenue', description: 'Premier match joué.', emoji: '🎉', tone: 'muted' });
  }

  // Winrate (seuils par tiers — il faut un minimum de matchs pour éviter le 100% sur 1 partie)
  if (played >= 10 && wr >= 0.9) {
    badges.push({ id: 'wr-sniper', kind: 'winrate', label: 'Sniper', description: `${pct(wr)} de winrate sur ${played} parties. Insolent.`, emoji: '🎯', tone: 'accent' });
  } else if (played >= 5 && wr >= 0.75) {
    badges.push({ id: 'wr-sharpshooter', kind: 'winrate', label: 'Sharpshooter', description: `${pct(wr)} de winrate sur ${played} parties.`, emoji: '🏹', tone: 'accent' });
  } else if (played >= 10 && wr >= 0.6) {
    badges.push({ id: 'wr-regular', kind: 'winrate', label: 'Régulier', description: `${pct(wr)} de winrate sur ${played} parties.`, emoji: '💪', tone: 'win' });
  } else if (played >= 5 && wr <= 0.25) {
    badges.push({ id: 'wr-brave', kind: 'winrate', label: 'Brave petit soldat', description: `${pct(wr)} de winrate. La revanche est proche.`, emoji: '🛡️', tone: 'muted' });
  }

  // Streak — séquence en cours (victoires consécutives, à partir du match le plus récent)
  const userMatches = allMatches
    .filter((m) => m.status === 'finished' && (m.player1Id === userId || m.player2Id === userId))
    .sort((a, b) => (new Date(b.finishedAt || 0)) - (new Date(a.finishedAt || 0)));
  let streak = 0;
  for (const m of userMatches) {
    if (m.winnerId === userId) streak++;
    else break;
  }
  if (streak >= 10) {
    badges.push({ id: 'streak-legend', kind: 'streak', label: 'Légende', description: `${streak} victoires d'affilée. Quelqu'un l'arrête ?`, emoji: '👑', tone: 'gold' });
  } else if (streak >= 5) {
    badges.push({ id: 'streak-on-fire', kind: 'streak', label: 'En feu', description: `${streak} victoires d'affilée.`, emoji: '🔥', tone: 'accent' });
  } else if (streak >= 3) {
    badges.push({ id: 'streak-rolling', kind: 'streak', label: 'Sur une lancée', description: `${streak} victoires d'affilée.`, emoji: '✨', tone: 'win' });
  }

  // ── Badge éphémère : 5-0 au Basket Random ────────────────────────────
  // Si le dernier match joué est un Basket Random perdu 5-0, le badge de
  // honte tient jusqu'au prochain match (peu importe le jeu — joue n'importe
  // quoi pour le faire disparaître).
  const lastMatch = userMatches[0];
  if (
    lastMatch &&
    lastMatch.game === 'basket_random' &&
    lastMatch.winnerId !== userId
  ) {
    const userIsP1 = lastMatch.player1Id === userId;
    const myScore  = userIsP1 ? lastMatch.scoreP1 : lastMatch.scoreP2;
    const oppScore = userIsP1 ? lastMatch.scoreP2 : lastMatch.scoreP1;
    if (myScore === 0 && oppScore === 5) {
      badges.push({
        id: 'shame-basket-5-0',
        kind: 'shame',
        label: "S'est fait mangeave le cul",
        description: "Pris un 5-0 sur Basket Random au dernier match. Disparaît dès que tu rejoues.",
        emoji: '🔞',
        tone: 'loss',
      });
    }
  }

  // ─ Easter egg : si played === 0
  if (played === 0) {
    badges.push({ id: 'volume-ghost', kind: 'volume', label: 'Fantôme', description: 'Inscrit mais jamais joué. Mystérieux.', emoji: '👻', tone: 'muted' });
  }

  return badges;
}

function bump(map, id, key) {
  const s = map.get(id) || { wins: 0, losses: 0, played: 0 };
  s[key] += 1;
  map.set(id, s);
}
function winrate(s) { return s.played === 0 ? 0 : s.wins / s.played; }
function pct(x) { return Math.round(x * 100) + '%'; }

function gameEmoji(gameId) {
  switch (gameId) {
    case 'basket_random': return '🏀';
    case 'darts': return '🎯';
    case 'baby': return '⚽';
    case 'pingpong': return '🏓';
    case 'clicker': return '🖱️';
    case 'snake': return '🐍';
    case 'shifumi': return '🪨';
    default: return '🎮';
  }
}
