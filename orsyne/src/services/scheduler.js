import { getPool, withTenant } from '../db/pool.js';
import { config } from '../config.js';
import { markNoShow } from '../domain/reservation-engine.js';
import { releaseExpiredHolds as releaseRestaurantHolds } from '../domain/availability.js';
import { notifyReservation } from './messaging.js';
import { expireOffers } from './waitlist.js';

/**
 * Travaux periodiques.
 *
 * Trois choses qu'aucun humain ne doit avoir a faire a la main :
 *   - liberer les tables tenues pour un acompte jamais regle ;
 *   - envoyer le rappel de la veille ;
 *   - basculer en no-show ce qui n'est manifestement pas venu.
 *
 * Deux etages, toujours : on DECOUVRE le travail via des fonctions en
 * lecture seule qui ne renvoient que des identifiants (migration 0010),
 * puis on AGIT sous le contexte du tenant concerne, avec toutes les
 * regles de la RLS. Le role applicatif n'obtient jamais d'acces global.
 *
 * Un verrou consultatif fait que plusieurs instances peuvent tourner sans
 * envoyer deux fois le meme rappel.
 */
const LOCK_KEY = 4_120_907;

export class Scheduler {
  constructor(options = {}) {
    this.tickMs = (options.tickSeconds ?? config.jobs.tickSeconds) * 1000;
    this.timer = null;
    this.running = false;
    this.log = options.log ?? console.log;
  }

  start() {
    if (this.timer || !config.jobs.enabled) return this;
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.log(`[orsyne] tache periodique en echec : ${error.message}`));
    }, this.tickMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick({ now = new Date() } = {}) {
    if (this.running) return null;
    this.running = true;
    const lockClient = await getPool().connect();
    try {
      const { rows: [lock] } = await lockClient.query(
        'SELECT pg_try_advisory_lock($1) AS got', [LOCK_KEY]);
      if (!lock.got) return null;

      try {
        const outcome = {
          holds: await this.releaseHolds(now),
          reminders: await this.sendReminders(now),
          noShows: await this.flagNoShows(now),
          offers: await this.expireOffers(now),
        };
        await lockClient.query(
          `INSERT INTO job_runs (job, started_at, finished_at, outcome)
           VALUES ('scheduler.tick', $1, now(), $2)`,
          [now, JSON.stringify(outcome)]);
        return outcome;
      } finally {
        await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
      }
    } finally {
      lockClient.release();
      this.running = false;
    }
  }

  /** Maintiens expires : l'acompte n'a jamais ete regle, la table repart. */
  async releaseHolds(now) {
    const { rows } = await getPool().query(
      'SELECT * FROM orsyne_core.due_expired_holds($1)', [now]);
    let released = 0;
    for (const { tenant_id: tenantId, restaurant_id: restaurantId } of rows) {
      released += await withTenant({ tenantId }, (client) =>
        releaseRestaurantHolds(client, restaurantId, now));
    }
    return released;
  }

  /**
   * Rappel de la veille. `reminder_sent_at` garantit qu'un client ne
   * recoit jamais deux fois le meme rappel, meme apres un redemarrage.
   */
  async sendReminders(now) {
    const horizon = new Date(now.getTime() + config.jobs.reminderHoursBefore * 3_600_000);
    const { rows } = await getPool().query(
      'SELECT * FROM orsyne_core.due_reminders($1, $2)', [now, horizon]);

    let sent = 0;
    for (const { reservation_id: reservationId, tenant_id: tenantId } of rows) {
      // On marque AVANT d'envoyer, dans la meme transaction : si l'envoi
      // plante, la transaction annule tout et le rappel sera retente ;
      // s'il reussit, il ne partira plus jamais une seconde fois.
      const result = await withTenant({ tenantId }, async (client) => {
        const { rowCount } = await client.query(
          `UPDATE reservations SET reminder_sent_at = $2
            WHERE id = $1 AND reminder_sent_at IS NULL`, [reservationId, now]);
        if (rowCount === 0) return { sent: false };
        return notifyReservation(client, { reservationId, template: 'reminder' });
      });
      if (result.sent) sent += 1;
    }
    return sent;
  }

  /**
   * No-show automatique, volontairement conservateur : uniquement ce qui
   * est confirme, jamais arrive, et largement au-dela du retard tolere.
   * On ne capture AUCUNE empreinte ici : facturer un client reste une
   * decision humaine (route charge-no-show).
   */
  async flagNoShows(now) {
    const cutoff = new Date(now.getTime() - config.jobs.noShowAfterMinutes * 60_000);
    const { rows } = await getPool().query(
      'SELECT * FROM orsyne_core.due_no_shows($1)', [cutoff]);

    let flagged = 0;
    for (const row of rows) {
      try {
        await withTenant({ tenantId: row.tenant_id }, (client) =>
          markNoShow(client, { reservationId: row.reservation_id }));
        flagged += 1;
      } catch { /* traite par un humain entre-temps */ }
    }
    return flagged;
  }

  async expireOffers(now) {
    const { rows } = await getPool().query(
      'SELECT * FROM orsyne_core.due_offer_tenants($1)', [now]);
    let total = 0;
    for (const { tenant_id: tenantId } of rows) {
      total += await withTenant({ tenantId }, (client) => expireOffers(client, { now }));
    }
    return total;
  }
}

export const scheduler = new Scheduler();
