import { getPool } from '../db/pool.js';
import { hub } from '../realtime/hub.js';
import { buildGuestBrief } from './guest-brief.js';

/**
 * Publie les evenements ecrits dans l'outbox par le moteur metier.
 *
 * L'evenement a ete ecrit dans la MEME transaction que le changement :
 * il n'existe donc pas d'evenement pour un changement annule, ni de
 * changement sans evenement. C'est ce qui rend le dashboard de service
 * fiable pendant un coup de feu.
 *
 * `FOR UPDATE SKIP LOCKED` permet de faire tourner plusieurs workers sans
 * qu'ils se marchent dessus ni qu'un evenement parte deux fois.
 */
export class OutboxWorker {
  constructor({ intervalMs = 400, batchSize = 50 } = {}) {
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.running) return 0;
    this.running = true;
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      // Le worker sert tous les tenants a la fois : il ne peut pas poser
      // un contexte unique, et passe donc par une fonction dediee au
      // perimetre minimal (voir migration 0008).
      const { rows } = await client.query(
        'SELECT * FROM orsyne_core.claim_outbox_events($1)', [this.batchSize],
      );

      for (const event of rows) {
        await client.query('SAVEPOINT dispatch');
        try {
          await this.dispatch(client, event);
          await client.query('RELEASE SAVEPOINT dispatch');
          await client.query('SELECT orsyne_core.mark_outbox_published($1)', [event.id]);
        } catch (error) {
          // Un evenement qui echoue ne doit pas bloquer le lot entier :
          // il est reprogramme, les autres partent normalement.
          await client.query('ROLLBACK TO SAVEPOINT dispatch').catch(() => {});
          await client.query(
            'SELECT orsyne_core.mark_outbox_published($1, $2)',
            [event.id, String(error.message).slice(0, 500)],
          );
        }
      }
      await client.query('COMMIT');
      return rows.length;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
      this.running = false;
    }
  }

  async dispatch(client, event) {
    if (!event.restaurant_id) return;
    hub.publish(event.restaurant_id, event.topic, {
      topic: event.topic,
      ...event.payload,
      at: new Date().toISOString(),
    });

    // Une arrivee declenche la note de briefing du serveur : c'est
    // l'endroit ou l'information passe du CRM a la salle.
    if (event.topic === 'reservation.seated' && event.payload.guestId) {
      await this.notifyServer(client, event);
    }
  }

  async notifyServer(client, event) {
    await client.query('SELECT set_config($1,$2,true)', ['orsyne.tenant_id', event.tenant_id]);
    const { rows: [assignment] } = await client.query(
      `SELECT user_id FROM server_assignments
        WHERE reservation_id = $1 AND is_current LIMIT 1`,
      [event.payload.reservationId],
    );
    if (!assignment) return;

    const brief = await buildGuestBrief(client, {
      guestId: event.payload.guestId,
      restaurantId: event.restaurant_id,
    });
    if (!brief || brief.lines.length === 0) return;

    const { rows: [notification] } = await client.query(
      `INSERT INTO notifications
         (tenant_id, restaurant_id, recipient_user_id, kind, title, body, payload, reservation_id, priority)
       VALUES ($1,$2,$3,'guest_brief',$4,$5,$6,$7,$8) RETURNING id`,
      [
        event.tenant_id, event.restaurant_id, assignment.user_id,
        brief.title, brief.lines.map((l) => `${l.icon} ${l.text}`).join('\n'),
        JSON.stringify(brief), event.payload.reservationId,
        brief.hasCritical ? 10 : 50,
      ],
    );

    hub.publish(event.restaurant_id, 'notification.created', {
      id: notification.id, recipientUserId: assignment.user_id, ...brief,
    }, (subscriber) => subscriber.role !== 'server' || subscriber.userId === assignment.user_id);
  }
}

export const outboxWorker = new OutboxWorker();
