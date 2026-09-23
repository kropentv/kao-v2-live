import { Router, readJson, sendJson, badRequest, notFound, reportSideEffect } from '../http.js';
import { getPool, withTenant } from '../../db/pool.js';
import { listSlots } from '../../domain/availability.js';
import { createReservation, cancelReservation, confirmPayment } from '../../domain/reservation-engine.js';
import { recordAllergies, upsertGuest } from '../../services/guest-profile.js';
import { EU_ALLERGENS } from '../../services/guest-profile.js';
import { tryAssignServer } from '../../services/assignment.js';
import { notifyReservation } from '../../services/messaging.js';
import { releaseOrRefund, cancellationIsFree } from '../../services/payments.js';
import { addToWaitlist, acceptOffer, declineOffer, onTableFreed } from '../../services/waitlist.js';
import { payments } from '../../integrations/index.js';

/**
 * Widget de reservation client. Aucune authentification.
 *
 * Toutes les routes passent par le slug de l'etablissement, resolu par une
 * fonction SECURITY DEFINER au perimetre minimal, puis basculent dans le
 * contexte tenant normal. Le visiteur ne touche jamais a autre chose.
 */
async function resolveRestaurant(slug) {
  const { rows } = await getPool().query(
    'SELECT * FROM orsyne_core.lookup_public_restaurant($1)', [slug]);
  if (rows.length === 0) throw notFound('Restaurant introuvable.');
  return { restaurantId: rows[0].restaurant_id, tenantId: rows[0].tenant_id };
}

export function publicRoutes(router = new Router()) {
  router.get('/api/public/:slug', async (ctx) => {
    const { restaurantId, tenantId } = await resolveRestaurant(ctx.params.slug);
    const data = await withTenant({ tenantId }, async (client) => {
      const { rows: [restaurant] } = await client.query(
        `SELECT id, name, slug, timezone, locale, currency, city, phone_e164
           FROM restaurants WHERE id = $1`, [restaurantId]);
      // Seules les zones que le restaurateur a rendues visibles sortent.
      const { rows: zones } = await client.query(
        `SELECT id, name, kind, description FROM zones
          WHERE restaurant_id = $1 AND is_active AND guest_selectable
          ORDER BY sort_order, name`, [restaurantId]);
      const { rows: services } = await client.query(
        `SELECT name, days_of_week, starts_at, ends_at FROM service_periods
          WHERE restaurant_id = $1 AND is_active ORDER BY starts_at`, [restaurantId]);
      const { rows: [capacity] } = await client.query(
        `SELECT COALESCE(max(seats_max), 0) AS max_party FROM restaurant_tables
          WHERE restaurant_id = $1 AND is_active`, [restaurantId]);
      const { rows: [combo] } = await client.query(
        `SELECT COALESCE(max(seats_max), 0) AS max_party FROM table_combinations
          WHERE restaurant_id = $1 AND is_active`, [restaurantId]);
      return {
        restaurant, zones, services,
        maxPartySize: Math.max(Number(capacity.max_party), Number(combo?.max_party ?? 0)),
        // Suggestions d'allergenes, servies par l'API pour rester
        // alignees entre le widget, l'application et l'IA telephonique.
        allergenSuggestions: EU_ALLERGENS,
      };
    });
    sendJson(ctx.res, 200, data);
  }, { public: true });

  router.get('/api/public/:slug/availability', async (ctx) => {
    const date = ctx.query.get('date');
    const partySize = Number(ctx.query.get('partySize') ?? 2);
    if (!date) throw badRequest('Parametre `date` requis (YYYY-MM-DD).');
    if (!Number.isInteger(partySize) || partySize < 1 || partySize > 100) {
      throw badRequest('partySize invalide.');
    }
    const { restaurantId, tenantId } = await resolveRestaurant(ctx.params.slug);
    const result = await withTenant({ tenantId }, (client) => listSlots(client, {
      restaurantId, isoDate: date, partySize, zoneId: ctx.query.get('zoneId') || null,
    }));
    sendJson(ctx.res, 200, result);
  }, { public: true });

  router.post('/api/public/:slug/reservations', async (ctx) => {
    const body = await readJson(ctx.req);
    for (const field of ['startsAt', 'partySize', 'guest']) {
      if (!body[field]) throw badRequest(`Champ manquant : ${field}.`);
    }
    if (!body.guest.phone && !body.guest.email) {
      throw badRequest('Un telephone ou un email est requis pour confirmer la reservation.');
    }
    const { restaurantId, tenantId } = await resolveRestaurant(ctx.params.slug);

    const result = await withTenant({ tenantId }, async (client) => {
      const guestId = await upsertGuest(client, tenantId, { ...body.guest, source: 'widget' });

      // L'allergie declaree par le client devient une donnee structuree :
      // elle declenche l'alerte en salle, remonte toujours dans la note
      // du serveur, et sera connue a sa prochaine visite. Une note libre
      // ne ferait aucune des trois.
      await recordAllergies(client, {
        tenantId, guestId, allergies: body.allergies, source: 'guest_declared',
      });
      const created = await createReservation(client, {
        restaurantId,
        guestId,
        partySize: body.partySize,
        startsAt: new Date(body.startsAt),
        requestedZoneId: body.zoneId ?? null,
        requestedTableId: body.tableId ?? null,
        source: 'widget',
        occasion: body.occasion ?? null,
        guestNotes: body.notes ?? null,
        locale: body.guest.locale ?? null,
        // Le widget est le canal public : les regles s'y appliquent, et
        // l'acompte configure par le restaurant est exige.
        skipDeposit: false,
      });
      // Une reservation confirmee part tout de suite vers un serveur.
      // Celles en attente d'acompte ne sont PAS attribuees : on ne
      // previent pas la salle d'une table qui peut encore s'evaporer.
      if (created.reservation.status === 'confirmed') {
        await tryAssignServer(client, {
          restaurantId, reservationId: created.reservation.id,
        });
      }
      if (body.guest.marketingConsent !== undefined && guestId) {
        await client.query(
          `INSERT INTO guest_consents (tenant_id, guest_id, channel, purpose, granted, source)
           VALUES ($1,$2,'email','marketing',$3,'widget')
           ON CONFLICT (guest_id, channel, purpose)
           DO UPDATE SET granted = EXCLUDED.granted, occurred_at = now()`,
          [tenantId, guestId, Boolean(body.guest.marketingConsent)]);
      }
      return created;
    });

    // Le message part APRES validation : un email de confirmation pour
    // une reservation annulee par un rollback serait pire que rien.
    await withTenant({ tenantId }, (client) => notifyReservation(client, {
      reservationId: result.reservation.id,
      template: result.reservation.status === 'pending_payment' ? 'pending_payment' : 'confirmed',
      extra: result.deposit ? {
        amount: new Intl.NumberFormat('fr-FR', { style: 'currency', currency: result.deposit.currency ?? 'EUR' })
          .format(result.deposit.amountCents / 100),
      } : {},
    })).catch(reportSideEffect('message au client'));

    sendJson(ctx.res, 201, {
      reference: result.reservation.reference,
      status: result.reservation.status,
      startsAt: result.reservation.starts_at,
      endsAt: result.reservation.ends_at,
      partySize: result.reservation.party_size,
      // On ne revele jamais quelle table a ete attribuee : c'est une
      // information d'exploitation, et elle peut encore changer.
      deposit: result.deposit,
    });
  }, { public: true });

  router.get('/api/public/:slug/reservations/:reference', async (ctx) => {
    const found = await lookupByReference(ctx.params.slug, ctx.params.reference);
    const reservation = await withTenant({ tenantId: found.tenantId }, async (client) => {
      const { rows } = await client.query(
        `SELECT r.reference, r.starts_at, r.ends_at, r.party_size, r.status, r.occasion,
                r.guest_notes, rest.name AS restaurant_name, rest.timezone, rest.phone_e164,
                p.mechanism, p.amount_mode, p.amount_cents, p.currency, p.free_cancellation_hours
           FROM reservations r
           JOIN restaurants rest ON rest.id = r.restaurant_id
           LEFT JOIN deposit_policies p ON p.id = r.deposit_policy_id
          WHERE r.id = $1`, [found.reservationId]);
      const row = rows[0];
      if (!row) return null;
      const { mechanism, amount_mode: mode, amount_cents: cents, currency,
              free_cancellation_hours: freeHours, ...rest } = row;
      return {
        ...rest,
        deposit: mechanism && mechanism !== 'none' ? {
          mechanism,
          amountCents: mode === 'per_person' ? cents * row.party_size : cents,
          currency: currency ?? 'EUR',
          freeCancellationHours: freeHours,
        } : null,
      };
    });
    sendJson(ctx.res, 200, reservation);
  }, { public: true });

  router.post('/api/public/:slug/reservations/:reference/cancel', async (ctx) => {
    const found = await lookupByReference(ctx.params.slug, ctx.params.reference);
    const outcome = await withTenant({ tenantId: found.tenantId }, async (client) => {
      const { rows: [before] } = await client.query(
        'SELECT starts_at, duration_minutes FROM reservations WHERE id = $1', [found.reservationId]);
      // Delai de la politique : dans les temps, l'empreinte est relachee
      // et l'acompte rendu ; hors delai, on garde, comme annonce au client.
      const free = await cancellationIsFree(client, { reservationId: found.reservationId });
      await cancelReservation(client, {
        reservationId: found.reservationId, reason: 'annulation par le client', by: 'guest',
      });
      const refunds = free ? await releaseOrRefund(client, { reservationId: found.reservationId }) : [];
      return { free, refunds, before };
    });

    await withTenant({ tenantId: found.tenantId }, async (client) => {
      await notifyReservation(client, { reservationId: found.reservationId, template: 'cancelled' });
      // La table liberee est proposee a la liste d'attente.
      await onTableFreed(client, {
        restaurantId: found.restaurantId,
        startsAt: new Date(outcome.before.starts_at),
        durationMinutes: outcome.before.duration_minutes,
      });
    }).catch(reportSideEffect("suites de l'annulation"));

    sendJson(ctx.res, 200, {
      ok: true,
      freeCancellation: outcome.free,
      refunds: outcome.refunds.map((r) => r.outcome),
    });
  }, { public: true });

  // --- Liste d'attente cote client -------------------------------------
  router.post('/api/public/:slug/waitlist', async (ctx) => {
    const body = await readJson(ctx.req);
    if (!body.guest?.phone && !body.guest?.email) {
      throw badRequest('Un telephone ou un email est requis pour vous prevenir.');
    }
    const { restaurantId, tenantId } = await resolveRestaurant(ctx.params.slug);
    const entry = await withTenant({ tenantId }, async (client) => {
      const guestId = await upsertGuest(client, tenantId, { ...body.guest, source: 'widget' });
      await recordAllergies(client, { tenantId, guestId, allergies: body.allergies, source: 'guest_declared' });
      return addToWaitlist(client, {
        tenantId, restaurantId, guestId,
        partySize: Number(body.partySize),
        desiredFrom: new Date(body.desiredFrom),
        desiredTo: new Date(body.desiredTo),
        zoneId: body.zoneId ?? null,
        notes: body.notes ?? null,
      });
    });
    sendJson(ctx.res, 201, { id: entry.id, status: entry.status });
  }, { public: true });

  router.post('/api/public/:slug/waitlist/:entryId/:decision', async (ctx) => {
    if (!['accept', 'decline'].includes(ctx.params.decision)) throw notFound();
    const { rows } = await getPool().query(
      'SELECT * FROM orsyne_core.lookup_waitlist_entry($1, $2)',
      [ctx.params.slug, ctx.params.entryId]).catch(() => ({ rows: [] }));
    if (rows.length === 0) throw notFound('Proposition introuvable.');
    const { tenant_id: tenantId } = rows[0];

    const result = await withTenant({ tenantId }, (client) => ctx.params.decision === 'accept'
      ? acceptOffer(client, { entryId: ctx.params.entryId })
      : declineOffer(client, { entryId: ctx.params.entryId, reason: 'refusee par le client' }));
    sendJson(ctx.res, 200, { ok: true, ...result });
  }, { public: true });

  /**
   * Confirmation d'acompte. En production, cette route est appelee par le
   * webhook du PSP apres encaissement reel ; elle enregistre le paiement
   * et transforme le maintien de table en reservation ferme.
   */
  router.post('/api/public/:slug/reservations/:reference/confirm-payment', async (ctx) => {
    // Raccourci de demonstration : confirme un acompte SANS paiement.
    // Il n'existe que lorsque le prestataire « console » est branche. En
    // production, seul un webhook signe du prestataire confirme une
    // table — sinon n'importe qui pourrait valider sa reservation gratuite.
    if (payments().name !== 'console') throw notFound();
    const body = await readJson(ctx.req).catch(() => ({}));
    const found = await lookupByReference(ctx.params.slug, ctx.params.reference);
    const result = await withTenant({ tenantId: found.tenantId }, async (client) => {
      const { rows: [reservation] } = await client.query(
        `SELECT r.*, p.mechanism, p.amount_mode, p.amount_cents, p.currency
           FROM reservations r
           LEFT JOIN deposit_policies p ON p.id = r.deposit_policy_id
          WHERE r.id = $1`, [found.reservationId]);

      if (reservation.mechanism && reservation.mechanism !== 'none') {
        const amount = reservation.amount_mode === 'per_person'
          ? reservation.amount_cents * reservation.party_size
          : reservation.amount_cents;
        await client.query(
          `INSERT INTO payment_intents
             (tenant_id, restaurant_id, reservation_id, guest_id, mechanism, provider,
              provider_ref, amount_cents, currency, status, captured_amount_cents,
              authorized_at, captured_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),$12)`,
          [
            found.tenantId, found.restaurantId, reservation.id, reservation.guest_id,
            reservation.mechanism, body.provider ?? 'stripe', body.providerRef ?? null,
            amount, reservation.currency ?? 'EUR',
            // Une preautorisation est autorisee, pas encaissee : la
            // distinction est portee jusque dans le statut du paiement.
            reservation.mechanism === 'preauthorization' ? 'authorized' : 'captured',
            reservation.mechanism === 'preauthorization' ? 0 : amount,
            reservation.mechanism === 'preauthorization' ? null : new Date(),
          ],
        );
      }
      const confirmed = await confirmPayment(client, { reservationId: found.reservationId });
      // La table est desormais ferme : c'est le moment de la confier a
      // un serveur, et pas avant.
      await tryAssignServer(client, {
        restaurantId: found.restaurantId, reservationId: found.reservationId,
      });
      return confirmed;
    });
    sendJson(ctx.res, 200, { ok: true, status: result.status });
  }, { public: true });

  return router;
}

async function lookupByReference(slug, reference) {
  const { rows } = await getPool().query(
    'SELECT * FROM orsyne_core.lookup_reservation_by_reference($1,$2)', [slug, reference]);
  if (rows.length === 0) throw notFound('Reservation introuvable.');
  return {
    reservationId: rows[0].reservation_id,
    tenantId: rows[0].tenant_id,
    restaurantId: rows[0].restaurant_id,
  };
}
