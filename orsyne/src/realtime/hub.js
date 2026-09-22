/**
 * Diffusion temps reel par Server-Sent Events.
 *
 * SSE plutot que WebSocket : le flux est unidirectionnel (le serveur
 * pousse l'etat du service, le client agit par requetes HTTP normales),
 * il passe tous les proxys d'entreprise, et il se reconnecte tout seul.
 * Un WebSocket n'apporterait ici que de la complexite.
 *
 * Cloisonnement : un abonne ne recoit que les evenements de son
 * etablissement, et un serveur de salle ne recoit que ce qui le concerne.
 */
export class RealtimeHub {
  constructor() {
    /** @type {Map<string, Set<object>>} restaurantId -> abonnes */
    this.channels = new Map();
    this.heartbeat = setInterval(() => this.ping(), 25_000);
    this.heartbeat.unref?.();
  }

  subscribe(res, { restaurantId, userId, role }) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connecte a ORSYNE\n\n');

    const subscriber = { res, userId, role, restaurantId };
    if (!this.channels.has(restaurantId)) this.channels.set(restaurantId, new Set());
    this.channels.get(restaurantId).add(subscriber);

    const cleanup = () => {
      const set = this.channels.get(restaurantId);
      set?.delete(subscriber);
      if (set?.size === 0) this.channels.delete(restaurantId);
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
    return subscriber;
  }

  /**
   * @param {string} restaurantId
   * @param {string} topic
   * @param {object} payload
   * @param {(subscriber: object) => boolean} [filter] cloisonnement fin
   */
  publish(restaurantId, topic, payload, filter = null) {
    const subscribers = this.channels.get(restaurantId);
    if (!subscribers?.size) return 0;
    const frame = `event: ${topic}\ndata: ${JSON.stringify(payload)}\n\n`;
    let delivered = 0;
    for (const subscriber of subscribers) {
      if (filter && !filter(subscriber)) continue;
      try {
        subscriber.res.write(frame);
        delivered += 1;
      } catch {
        subscribers.delete(subscriber);
      }
    }
    return delivered;
  }

  ping() {
    for (const subscribers of this.channels.values()) {
      for (const subscriber of subscribers) {
        try { subscriber.res.write(': ping\n\n'); } catch { subscribers.delete(subscriber); }
      }
    }
  }

  countFor(restaurantId) { return this.channels.get(restaurantId)?.size ?? 0; }

  close() {
    clearInterval(this.heartbeat);
    for (const subscribers of this.channels.values()) {
      for (const subscriber of subscribers) {
        try { subscriber.res.end(); } catch { /* deja ferme */ }
      }
    }
    this.channels.clear();
  }
}

export const hub = new RealtimeHub();
