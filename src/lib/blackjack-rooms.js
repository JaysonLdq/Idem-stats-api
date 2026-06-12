// Système de rooms Blackjack en mémoire — multi-joueurs casual.
//
// MODÈLE :
//   - Une room = jusqu'à 6 sièges. Quand toutes les rooms sont pleines,
//     un nouvel arrivant crée une nouvelle room. Quand une room se vide,
//     elle est supprimée.
//   - Chaque joueur joue sa propre main contre un dealer commun. Pas de
//     tour-par-tour : les actions hit/stand/double/split sont libres
//     pendant la phase 'playing'.
//   - Le dealer joue dès que TOUT le monde a fini (stand/bust/blackjack).
//
// CYCLE DE ROUND :
//   waiting → betting (15s) → playing (libre) → dealer → result (5s) → waiting
//
//   - waiting : pas de round en cours, on attend assez de joueurs pour
//     démarrer (au moins 1).
//   - betting : phase de mise. Les joueurs qui n'ont pas bet à la fin
//     du timer sont "sit-out" pour la manche (skip).
//   - playing : cartes distribuées, chacun joue. Si tous BJ ou tous bust
//     dès le deal, on saute la phase dealer.
//   - dealer : dealer pioche jusqu'à 17. Résultats résolus.
//   - result : affichage 5s puis re-boucle vers betting.
//
// COINS :
//   - Bet prélevé sur le solde Prisma au moment du bet (atomicité gérée
//     par le caller — voir routes/blackjack.js).
//   - Payout rendu en bloc au passage en phase 'result'.
//
// CLEANUP :
//   - tickCleanup() à appeler périodiquement (cron interne) pour
//     supprimer les rooms vides ET les seats déconnectés (last activity
//     > 60s sans heartbeat).

import { randomUUID } from 'crypto';

const MAX_SEATS = 6;
const BETTING_MS = 15_000;
const RESULT_MS = 5_000;
const SEAT_IDLE_TIMEOUT_MS = 60_000;

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

/** @type {Map<string, Room>} */
const rooms = new Map();

// Callback de broadcast SSE — injecté par le caller (routes/blackjack.js)
// pour éviter une dépendance circulaire avec le module SSE.
let broadcaster = null;
export function setBroadcaster(fn) { broadcaster = fn; }

// Callback pour appliquer les deltas de coins en BDD — injecté pareil.
let applyCoins = null;
export function setApplyCoins(fn) { applyCoins = fn; }

// ─ helpers cartes ──────────────────────────────────────────────────────
function makeDeck() {
  const deck = [];
  // 4 jeux de cartes mélangés — sabot type casino.
  for (let n = 0; n < 4; n++) {
    for (const s of SUITS) for (const r of RANKS) deck.push({ rank: r, suit: s });
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function handValue(hand) {
  let total = 0;
  let aces = 0;
  for (const c of hand) {
    if (c.hidden) continue;
    if (c.rank === 'A') { aces += 1; total += 11; }
    else if (c.rank === 'K' || c.rank === 'Q' || c.rank === 'J') total += 10;
    else total += parseInt(c.rank, 10);
  }
  while (total > 21 && aces > 0) { total -= 10; aces -= 1; }
  return total;
}

function isNaturalBlackjack(hand) {
  if (hand.length !== 2) return false;
  const isTen = (c) => c.rank === '10' || c.rank === 'J' || c.rank === 'Q' || c.rank === 'K';
  const [a, b] = hand;
  return (a.rank === 'A' && isTen(b)) || (b.rank === 'A' && isTen(a));
}

// ─ création / lookup ───────────────────────────────────────────────────
function newRoom() {
  const id = randomUUID().slice(0, 8);
  const room = {
    id,
    seats: Array.from({ length: MAX_SEATS }, () => null),
    dealer: { hand: [], total: 0 },
    phase: 'waiting', // waiting | betting | playing | dealer | result
    deck: [],
    roundId: 0,
    bettingDeadline: 0,
    resultDeadline: 0,
    createdAt: Date.now(),
  };
  rooms.set(id, room);
  return room;
}

/** Récupère le premier slot libre dans une room. Renvoie l'index ou -1. */
function firstFreeSeat(room) {
  return room.seats.findIndex((s) => s === null);
}

/** Cherche une room non pleine, sinon en crée une nouvelle. */
export function findOrCreateRoomForJoin() {
  for (const room of rooms.values()) {
    if (firstFreeSeat(room) >= 0) return room;
  }
  return newRoom();
}

export function getRoom(id) { return rooms.get(id) || null; }
export function listRooms() {
  return [...rooms.values()].map((r) => ({
    id: r.id,
    players: r.seats.filter((s) => s).length,
    maxSeats: MAX_SEATS,
    phase: r.phase,
  }));
}

// ─ join / leave ────────────────────────────────────────────────────────
/** Ajoute un joueur. Retourne { room, seatIndex } ou throw 'room_full'. */
export function joinPlayer(user) {
  // Si déjà assis quelque part, on retourne sa place.
  for (const room of rooms.values()) {
    const idx = room.seats.findIndex((s) => s && s.userId === user.id);
    if (idx >= 0) return { room, seatIndex: idx };
  }
  const room = findOrCreateRoomForJoin();
  const idx = firstFreeSeat(room);
  if (idx < 0) throw new Error('room_full'); // impossible vu findOrCreate, mais ceinture+bretelles
  room.seats[idx] = makeSeat(user);
  broadcastRoom(room);
  scheduleStartIfNeeded(room);
  return { room, seatIndex: idx };
}

function makeSeat(user) {
  return {
    userId: user.id,
    pseudo: user.pseudo,
    avatarUrl: user.avatarUrl ?? null,
    bet: 0,
    hands: [], // après deal : [[Card, Card]] (et [[…],[…]] après split)
    handBets: [],
    handStatus: [], // par main : 'playing' | 'standing' | 'busted' | 'blackjack'
    activeHandIdx: 0, // main courante (pour split)
    result: null, // 'win'|'lose'|'push'|'blackjack'|'bust' (résultat agrégé)
    payout: 0,
    lastActivity: Date.now(),
  };
}

/** Retire un joueur de sa room. Si la room est vide, la supprime. */
export function leaveByUserId(userId) {
  for (const room of rooms.values()) {
    const idx = room.seats.findIndex((s) => s && s.userId === userId);
    if (idx < 0) continue;
    room.seats[idx] = null;
    if (room.seats.every((s) => s === null)) {
      rooms.delete(room.id);
    } else {
      broadcastRoom(room);
      // Si on était dans dealer/playing et qu'il restait des actions à
      // attendre du parti, ré-évalue.
      maybeAdvancePhase(room);
    }
    return true;
  }
  return false;
}

// ─ cycle de round ─────────────────────────────────────────────────────
function scheduleStartIfNeeded(room) {
  if (room.phase !== 'waiting') return;
  const has = room.seats.some((s) => s);
  if (!has) return;
  // Lance une phase betting tout de suite (les joueurs n'attendent pas).
  startBetting(room);
}

function startBetting(room) {
  room.phase = 'betting';
  room.bettingDeadline = Date.now() + BETTING_MS;
  // Reset des hands précédentes mais on garde les seats.
  for (const seat of room.seats) {
    if (!seat) continue;
    seat.bet = 0;
    seat.hands = [];
    seat.handBets = [];
    seat.handStatus = [];
    seat.activeHandIdx = 0;
    seat.result = null;
    seat.payout = 0;
  }
  room.dealer = { hand: [], total: 0 };
  room.roundId += 1;
  broadcastRoom(room);
  setTimeout(() => {
    if (room.phase === 'betting' && rooms.has(room.id)) startPlaying(room);
  }, BETTING_MS);
}

function startPlaying(room) {
  // Filtre les joueurs qui ont effectivement misé.
  const bettors = room.seats.filter((s) => s && s.bet > 0);
  if (bettors.length === 0) {
    // Personne n'a misé — repart en betting.
    room.phase = 'waiting';
    broadcastRoom(room);
    scheduleStartIfNeeded(room);
    return;
  }
  room.deck = makeDeck();
  // Deal : 2 cartes à chaque bettor + 2 au dealer (la 2e cachée).
  for (const seat of bettors) {
    const c1 = room.deck.pop();
    const c2 = room.deck.pop();
    seat.hands = [[c1, c2]];
    seat.handBets = [seat.bet];
    const bj = isNaturalBlackjack(seat.hands[0]);
    seat.handStatus = [bj ? 'blackjack' : 'playing'];
    seat.activeHandIdx = 0;
  }
  const d1 = room.deck.pop();
  const d2 = room.deck.pop();
  room.dealer = { hand: [d1, { ...d2, hidden: true }], total: handValue([d1]) };
  room.phase = 'playing';
  broadcastRoom(room);
  // Si tous sont déjà résolus (tous BJ par ex.), on passe au dealer.
  maybeAdvancePhase(room);
}

/** Avance la phase si tous les seats actifs sont 'standing' | 'busted' | 'blackjack'. */
function maybeAdvancePhase(room) {
  if (room.phase !== 'playing') return;
  const active = room.seats.filter((s) => s && s.handBets.length > 0);
  if (active.length === 0) {
    finishRound(room);
    return;
  }
  const allDone = active.every((s) =>
    s.handStatus.every((st) => st === 'standing' || st === 'busted' || st === 'blackjack')
  );
  if (allDone) startDealer(room);
}

function startDealer(room) {
  room.phase = 'dealer';
  // Révèle la carte cachée.
  room.dealer.hand = room.dealer.hand.map((c) => ({ ...c, hidden: false }));
  // Tire jusqu'à 17 (S17).
  while (handValue(room.dealer.hand) < 17) {
    room.dealer.hand.push(room.deck.pop());
  }
  room.dealer.total = handValue(room.dealer.hand);
  // Résout chaque seat.
  for (const seat of room.seats) {
    if (!seat || !seat.handBets.length) continue;
    resolveSeatVsDealer(seat, room.dealer);
  }
  // Applique les coins via le callback injecté.
  if (applyCoins) {
    for (const seat of room.seats) {
      if (!seat || seat.payout === 0) continue;
      // Le bet a déjà été prélevé au moment du bet — donc on ne crédite
      // QUE le payout brut ici. delta = payout (pas net).
      applyCoins(seat.userId, seat.payout).catch(() => {});
    }
  }
  room.phase = 'result';
  room.resultDeadline = Date.now() + RESULT_MS;
  broadcastRoom(room);
  setTimeout(() => {
    if (rooms.has(room.id)) finishRound(room);
  }, RESULT_MS);
}

function resolveSeatVsDealer(seat, dealer) {
  const dv = dealer.total;
  let totalPayout = 0;
  // Pour chaque main du joueur (1 ou 2 si split).
  seat.handStatus = seat.handStatus.map((st, i) => {
    const h = seat.hands[i];
    const b = seat.handBets[i];
    if (st === 'busted') return 'busted';
    if (st === 'blackjack') {
      // Dealer aussi BJ → push, sinon paie 3:2.
      if (isNaturalBlackjack(dealer.hand)) { totalPayout += b; return 'push'; }
      totalPayout += Math.floor(b * 2.5);
      return 'blackjack';
    }
    const pv = handValue(h);
    if (dv > 21 || pv > dv) { totalPayout += b * 2; return 'win'; }
    if (pv < dv) return 'lose';
    totalPayout += b; return 'push';
  });
  seat.payout = totalPayout;
  // Résultat agrégé : on prend le meilleur (blackjack > win > push > lose > bust).
  const priority = { blackjack: 5, win: 4, push: 3, lose: 2, busted: 1 };
  let best = null;
  for (const st of seat.handStatus) {
    if (!best || priority[st] > priority[best]) best = st;
  }
  seat.result = best;
}

function finishRound(room) {
  room.phase = 'waiting';
  broadcastRoom(room);
  scheduleStartIfNeeded(room);
}

// ─ actions joueur ──────────────────────────────────────────────────────
/** Pose une mise pendant betting. Renvoie {ok, room} ou throw error. */
export function placeBet(userId, amount) {
  const found = findSeat(userId);
  if (!found) throw new Error('not_seated');
  const { room, seat } = found;
  if (room.phase !== 'betting') throw new Error('not_betting_phase');
  if (amount < 1) throw new Error('bet_too_low');
  if (seat.bet > 0) throw new Error('already_bet');
  seat.bet = amount;
  seat.lastActivity = Date.now();
  broadcastRoom(room);
  return room;
}

export function hit(userId) {
  const found = findSeat(userId);
  if (!found) throw new Error('not_seated');
  const { room, seat } = found;
  if (room.phase !== 'playing') throw new Error('not_playing_phase');
  const i = seat.activeHandIdx;
  if (seat.handStatus[i] !== 'playing') throw new Error('hand_done');
  seat.hands[i].push(room.deck.pop());
  const v = handValue(seat.hands[i]);
  if (v > 21) seat.handStatus[i] = 'busted';
  else if (v === 21) seat.handStatus[i] = 'standing';
  seat.lastActivity = Date.now();
  // Si main bust ou stand, avance à la main suivante (cas split).
  if (seat.handStatus[i] !== 'playing' && i + 1 < seat.hands.length) {
    seat.activeHandIdx = i + 1;
  }
  broadcastRoom(room);
  maybeAdvancePhase(room);
  return room;
}

export function stand(userId) {
  const found = findSeat(userId);
  if (!found) throw new Error('not_seated');
  const { room, seat } = found;
  if (room.phase !== 'playing') throw new Error('not_playing_phase');
  const i = seat.activeHandIdx;
  if (seat.handStatus[i] !== 'playing') throw new Error('hand_done');
  seat.handStatus[i] = 'standing';
  seat.lastActivity = Date.now();
  if (i + 1 < seat.hands.length) seat.activeHandIdx = i + 1;
  broadcastRoom(room);
  maybeAdvancePhase(room);
  return room;
}

export async function doubleDown(userId, applyExtraBetCallback) {
  const found = findSeat(userId);
  if (!found) throw new Error('not_seated');
  const { room, seat } = found;
  if (room.phase !== 'playing') throw new Error('not_playing_phase');
  const i = seat.activeHandIdx;
  if (seat.handStatus[i] !== 'playing') throw new Error('hand_done');
  if (seat.hands[i].length !== 2) throw new Error('double_after_hit');
  const extra = seat.handBets[i];
  // Débit du bet AVANT de muter le seat — si le débit échoue (insuf. coins
  // côté DB), on jette et le state reste cohérent.
  if (applyExtraBetCallback) await applyExtraBetCallback(seat.userId, extra);
  seat.handBets[i] *= 2;
  seat.hands[i].push(room.deck.pop());
  const v = handValue(seat.hands[i]);
  seat.handStatus[i] = v > 21 ? 'busted' : 'standing';
  seat.lastActivity = Date.now();
  if (i + 1 < seat.hands.length) seat.activeHandIdx = i + 1;
  broadcastRoom(room);
  maybeAdvancePhase(room);
  return room;
}

export async function split(userId, applyExtraBetCallback) {
  const found = findSeat(userId);
  if (!found) throw new Error('not_seated');
  const { room, seat } = found;
  if (room.phase !== 'playing') throw new Error('not_playing_phase');
  if (seat.hands.length !== 1) throw new Error('already_split');
  const h = seat.hands[0];
  if (h.length !== 2 || h[0].rank !== h[1].rank) throw new Error('not_splittable');
  const extra = seat.handBets[0];
  if (applyExtraBetCallback) await applyExtraBetCallback(seat.userId, extra);
  const c1 = room.deck.pop();
  const c2 = room.deck.pop();
  seat.hands = [[h[0], c1], [h[1], c2]];
  seat.handBets = [extra, extra];
  // Split d'As → 1 carte chacun puis stand auto (règle casino).
  const isAces = h[0].rank === 'A';
  seat.handStatus = isAces ? ['standing', 'standing'] : ['playing', 'playing'];
  seat.activeHandIdx = 0;
  seat.lastActivity = Date.now();
  broadcastRoom(room);
  maybeAdvancePhase(room);
  return room;
}

// ─ helpers internes ────────────────────────────────────────────────────
function findSeat(userId) {
  for (const room of rooms.values()) {
    const seat = room.seats.find((s) => s && s.userId === userId);
    if (seat) return { room, seat };
  }
  return null;
}

/** Snapshot d'une room pour le client. La carte cachée du dealer n'est pas
 *  exposée tant qu'on n'est pas en phase dealer/result. */
export function snapshotRoom(room, viewerId) {
  const dealerHand = room.dealer.hand.map((c) =>
    c.hidden ? { hidden: true } : { rank: c.rank, suit: c.suit }
  );
  return {
    id: room.id,
    phase: room.phase,
    roundId: room.roundId,
    bettingDeadline: room.bettingDeadline,
    resultDeadline: room.resultDeadline,
    maxSeats: MAX_SEATS,
    dealer: { hand: dealerHand, total: room.phase === 'playing' ? handValue([room.dealer.hand[0]]) : (room.phase === 'waiting' || room.phase === 'betting' ? 0 : handValue(room.dealer.hand.filter((c) => !c.hidden))) },
    seats: room.seats.map((s, i) => {
      if (!s) return { index: i, empty: true };
      return {
        index: i,
        empty: false,
        userId: s.userId,
        pseudo: s.pseudo,
        avatarUrl: s.avatarUrl,
        bet: s.bet,
        hands: s.hands,
        handBets: s.handBets,
        handStatus: s.handStatus,
        activeHandIdx: s.activeHandIdx,
        result: s.result,
        payout: s.payout,
        isMe: s.userId === viewerId,
      };
    }),
  };
}

function broadcastRoom(room) {
  if (!broadcaster) return;
  for (const seat of room.seats) {
    if (!seat) continue;
    broadcaster(seat.userId, 'blackjack.room', snapshotRoom(room, seat.userId));
  }
}

// ─ cleanup périodique ──────────────────────────────────────────────────
export function tickCleanup() {
  const now = Date.now();
  for (const room of rooms.values()) {
    // Idle seats (pas de heartbeat depuis SEAT_IDLE_TIMEOUT_MS).
    for (let i = 0; i < room.seats.length; i++) {
      const s = room.seats[i];
      if (!s) continue;
      if (now - s.lastActivity > SEAT_IDLE_TIMEOUT_MS) {
        room.seats[i] = null;
      }
    }
    if (room.seats.every((s) => s === null)) {
      rooms.delete(room.id);
    }
  }
}

/** Marque l'activité du seat (heartbeat depuis le client). */
export function heartbeat(userId) {
  const found = findSeat(userId);
  if (!found) return false;
  found.seat.lastActivity = Date.now();
  return true;
}
