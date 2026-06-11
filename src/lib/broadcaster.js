// In-memory broadcaster pour SSE. Garde les connexions actives par userId et
// pousse un payload texte à toutes les sessions ouvertes du destinataire.
//
// Limites : monoprocessus. Si on scale à plusieurs replicas, il faudra passer par
// Redis pub/sub. Pour notre échelle (potes), 1 process suffit.

class Broadcaster {
  constructor() {
    /** @type {Map<string, Set<import('http').ServerResponse>>} */
    this.channels = new Map();
  }

  add(userId, res) {
    if (!this.channels.has(userId)) this.channels.set(userId, new Set());
    this.channels.get(userId).add(res);
  }

  remove(userId, res) {
    const set = this.channels.get(userId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) this.channels.delete(userId);
  }

  /** Envoie un event SSE typé à toutes les sessions d'un user. */
  send(userId, type, data) {
    const set = this.channels.get(userId);
    if (!set || set.size === 0) return 0;
    const payload =
      `event: ${type}\n` +
      `data: ${JSON.stringify(data)}\n\n`;
    let n = 0;
    for (const res of set) {
      try { res.write(payload); n++; } catch { /* socket cassée → ignore */ }
    }
    return n;
  }

  /** Pour debug / health. */
  count() {
    let total = 0;
    for (const s of this.channels.values()) total += s.size;
    return { users: this.channels.size, sessions: total };
  }
}

export const broadcaster = new Broadcaster();
