import { Router, readJson, sendJson, badRequest, notFound, forbidden, reportSideEffect } from '../http.js';
import {
  createReservation, cancelReservation, markNoShow, seatReservation,
  completeReservation, moveReservation, confirmPayment, seatWalkIn,
} from '../../domain/reservation-engine.js';
import { listSlots } from '../../domain/availability.js';
import { assignServer, suggestServer, tryAssignServer } from '../../services/assignment.js';
import { getServiceView } from '../../services/service-view.js';
import { isServerOnly } from '../rbac.js';
import { recordAllergies, upsertGuest } from '../../services/guest-profile.js';
import { notifyReservation } from '../../services/messaging.js';
import { releaseOrRefund } from '../../services/payments.js';
import { onTableFreed } from '../../services/waitlist.js';

function parseStartsAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw badRequest('startsAt doit etre une date ISO valide.');
  return date;
}

export function reservationRoutes(router = new Router()) {
  router.get('/api/restaurants/:restaurantId/availability', async (ctx) => {
    const date = ctx.query.get('date');
    const partySize = Number(ctx.query.get('partySize') ?? 2);
    if (!date) throw badRequest('Parametre `date` requis (YYYY-MM-DD).');
    if (!Number.isInteger(partySize) || partySize < 1) throw badRequest('partySize invalide.');

    const result = await ctx.withTenant((client) => listSlots(client, {
      restaurantId: ctx.params.restaurantId,
      isoDate: date,
      partySize,
      zoneId: ctx.query.get('zoneId') || null,
    }));
    sendJson(ctx.res, 200, result);
  }, { permission: 'reservations:read' });

  router.get('/api/restaurants/:restaurantId/service', async (ctx) => {
    // Un serveur ne voit que ses propres tables : le cloisonnement est
    // applique a la requete, pas masque dans l'interface.
    const forUserId = isServerOnly(ctx.memberships, ctx.params.restaurantId) ? ctx.user.id : null;
    const view = await ctx.withTenant((client) => getServiceView(client, {
      restaurantId: ctx.params.restaurantId,
      forUserId,
      isoDate: ctx.query.get('date') || null,
    }));
    if (!view) throw notFound('Etablissement introuvable.');
    sendJson(ctx.res, 200, view);
  }, { permission: 'service:read' });

  router.get('/api/restaurants/:restaurantId/reservations', async (ctx) => {
    const from = ctx.query.get('from');
    const to = ctx.query.get('to');
    const status = ctx.query.getAll('status');
    const rows = await ctx.withTenant(async (client) => (await client.query(
      `SELECT r.*, g.first_name, g.last_name, g.phone_e164, g.locale AS guest_locale,
              COALESCE(array_agg(t.code) FILTER (WHERE t.code IS NOT NULL), '{}') AS table_codes
         FROM reservations r
         LEFT JOIN guests g ON g.id = r.guest_id
         LEFT JOIN table_occupancies o ON o.reservation_id = r.id AND o.is_active
         LEFT JOIN restaurant_tables t ON t.id = o.table_id
        WHERE r.restaurant_id = $1
          AND ($2::timestamptz IS NULL OR r.starts_at >= $2)
          AND ($3::timestamptz IS NULL OR r.starts_at < $3)
          AND ($4::text[] = '{}' OR r.status::text = ANY($4))
        GROUP BY r.id, g.id
        ORDER BY r.starts_at LIMIT 500`,
      [ctx.params.restaurantId, from || null, to || null, status],
    )).rows);
    sendJson(ctx.res, 200, rows);
  }, { permission: 'reservations:read' });

  router.post('/api/restaurants/:restaurantId/reservations', async (ctx) => {
    const body = await readJson(ctx.req);
    if (!body.startsAt) throw badRequest('startsAt est requis.');

    const result = await ctx.withTenant(async (client) => {
      const guestId = body.guestId ?? (body.guest ? await upsertGuest(client, ctx.tenantId, body.guest) : null);
      // Saisie par l'equipe : vaut confirmation de vive voix.
      await recordAllergies(client, {
        tenantId: ctx.tenantId, guestId, allergies: body.allergies,
        source: 'staff_entered', createdBy: ctx.user.id,
      });
      const created = await createReservation(client, {
        restaurantId: ctx.params.restaurantId,
        guestId,
        partySize: body.partySize,
        startsAt: parseStartsAt(body.startsAt),
        durationMinutes: body.durationMinutes ?? null,
        requestedZoneId: body.zoneId ?? null,
        requestedTableId: body.tableId ?? null,
        tableIds: body.tableIds ?? null,
        source: body.source ?? 'staff',
        occasion: body.occasion ?? null,
        guestNotes: body.guestNotes ?? null,
        staffNotes: body.staffNotes ?? null,
        locale: body.locale ?? null,
        createdByUserId: ctx.user.id,
        skipDeposit: body.skipDeposit ?? true,
      });
      const assignment = await tryAssignServer(client, {
        restaurantId: ctx.params.restaurantId,
        reservationId: created.reservation.id,
        userId: body.serverUserId ?? null,
        actorUserId: ctx.user.id,
      });
      return { ...created, assignment };
    });
    // Confirmation au client apres validation, jamais dedans.
    if (body.notifyGuest !== false) {
      await ctx.withTenant((client) => notifyReservation(client, {
        reservationId: result.reservation.id, template: 'confirmed',
      })).catch(reportSideEffect('confirmation au client'));
    }
    sendJson(ctx.res, 201, result);
  }, { permission: 'reservations:write' });

  router.post('/api/restaurants/:restaurantId/walk-ins', async (ctx) => {
    const body = await readJson(ctx.req);
    const result = await ctx.withTenant((client) => seatWalkIn(client, {
      restaurantId: ctx.params.restaurantId,
      partySize: body.partySize,
      tableIds: body.tableIds ?? null,
      requestedZoneId: body.zoneId ?? null,
      createdByUserId: ctx.user.id,
      durationMinutes: body.durationMinutes ?? null,
    }));
    sendJson(ctx.res, 201, result);
  }, { permission: 'reservations:write' });

  const transition = (name, fn, permission = 'service:write') =>
    router.post(`/api/reservations/:reservationId/${name}`, async (ctx) => {
      const body = await readJson(ctx.req).catch(() => ({}));
      const result = await ctx.withTenant((client) =>
        fn(client, { reservationId: ctx.params.reservationId, actorUserId: ctx.user.id, ...body }));
      sendJson(ctx.res, 200, { ok: true, result });
    }, { permission });

  transition('seat', seatReservation);
  transition('complete', completeReservation);
  transition('no-show', markNoShow);
  transition('confirm-payment', confirmPayment, 'reservations:write');

  router.post('/api/reservations/:reservationId/cancel', async (ctx) => {
    const body = await readJson(ctx.req).catch(() => ({}));
    const outcome = await ctx.withTenant(async (client) => {
      const { rows: [before] } = await client.query(
        'SELECT restaurant_id, starts_at, duration_minutes FROM reservations WHERE id = $1',
        [ctx.params.reservationId]);
      const freed = await cancelReservation(client, {
        reservationId: ctx.params.reservationId,
        reason: body.reason ?? null,
        by: 'staff',
        actorUserId: ctx.user.id,
      });
      // Quand c'est le restaurant qui annule, le client n'a rien a payer :
      // l'empreinte est relachee et l'acompte rendu, quel que soit le delai.
      const refunds = await releaseOrRefund(client, { reservationId: ctx.params.reservationId });
      return { freed, refunds, before };
    });

    await ctx.withTenant(async (client) => {
      if (body.notifyGuest !== false) {
        await notifyReservation(client, { reservationId: ctx.params.reservationId, template: 'cancelled' });
      }
      if (outcome.before) {
        await onTableFreed(client, {
          restaurantId: outcome.before.restaurant_id,
          startsAt: new Date(outcome.before.starts_at),
          durationMinutes: outcome.before.duration_minutes,
        });
      }
    }).catch(reportSideEffect("suites de l'annulation"));

    sendJson(ctx.res, 200, {
      ok: true, freedTableIds: outcome.freed, refunds: outcome.refunds.map((r) => r.outcome),
    });
  }, { permission: 'reservations:write' });

  router.post('/api/reservations/:reservationId/move', async (ctx) => {
    const body = await readJson(ctx.req);
    const moved = await ctx.withTenant((client) => moveReservation(client, {
      reservationId: ctx.params.reservationId,
      startsAt: body.startsAt ? parseStartsAt(body.startsAt) : null,
      durationMinutes: body.durationMinutes ?? null,
      tableIds: body.tableIds ?? null,
      actorUserId: ctx.user.id,
    }));
    ctx.publish('reservation.moved', moved);
    sendJson(ctx.res, 200, moved);
  }, { permission: 'reservations:write' });

  router.get('/api/reservations/:reservationId/server-suggestions', async (ctx) => {
    const result = await ctx.withTenant(async (client) => {
      const { rows: [reservation] } = await client.query(
        'SELECT restaurant_id FROM reservations WHERE id = $1', [ctx.params.reservationId]);
      if (!reservation) throw notFound('Reservation introuvable.');
      if (!ctx.canAccessRestaurant(reservation.restaurant_id)) throw forbidden();
      return suggestServer(client, {
        restaurantId: reservation.restaurant_id, reservationId: ctx.params.reservationId,
      });
    });
    sendJson(ctx.res, 200, result);
  }, { permission: 'staff:read' });

  router.post('/api/reservations/:reservationId/assign-server', async (ctx) => {
    const body = await readJson(ctx.req);
    const result = await ctx.withTenant(async (client) => {
      const { rows: [reservation] } = await client.query(
        'SELECT restaurant_id FROM reservations WHERE id = $1', [ctx.params.reservationId]);
      if (!reservation) throw notFound('Reservation introuvable.');
      if (!ctx.canAccessRestaurant(reservation.restaurant_id)) throw forbidden();
      return assignServer(client, {
        restaurantId: reservation.restaurant_id,
        reservationId: ctx.params.reservationId,
        userId: body.userId ?? null,
        actorUserId: ctx.user.id,
      });
    });
    sendJson(ctx.res, 200, result);
  }, { permission: 'staff:schedule' });

  return router;
}
