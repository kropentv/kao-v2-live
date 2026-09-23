import { Router, readJson, sendJson, badRequest } from '../http.js';
import { upsertGuest, recordAllergies } from '../../services/guest-profile.js';
import {
  addToWaitlist, matchesFor, offerSlot, acceptOffer, declineOffer,
} from '../../services/waitlist.js';

/** Liste d'attente cote equipe (section 22). */
export function waitlistRoutes(router = new Router()) {
  router.get('/api/restaurants/:restaurantId/waitlist', async (ctx) => {
    const rows = await ctx.withTenant(async (client) => (await client.query(
      `SELECT w.id, w.party_size, w.desired_from, w.desired_to, w.status, w.priority,
              w.offered_at, w.offer_expires_at, w.offered_reservation_id, w.notes, w.created_at,
              g.first_name, g.last_name, g.phone_e164, g.email,
              z.name AS zone_name
         FROM waitlist_entries w
         LEFT JOIN guests g ON g.id = w.guest_id
         LEFT JOIN zones z ON z.id = w.requested_zone_id
        WHERE w.restaurant_id = $1
          AND ($2::boolean OR w.status IN ('waiting','offered'))
        ORDER BY w.status = 'offered' DESC, w.priority, w.created_at
        LIMIT 200`,
      [ctx.params.restaurantId, ctx.query.get('all') === 'true'])).rows);
    sendJson(ctx.res, 200, rows);
  }, { permission: 'reservations:read' });

  router.post('/api/restaurants/:restaurantId/waitlist', async (ctx) => {
    const body = await readJson(ctx.req);
    for (const field of ['partySize', 'desiredFrom', 'desiredTo']) {
      if (body[field] === undefined) throw badRequest(`Champ manquant : ${field}.`);
    }
    const entry = await ctx.withTenant(async (client) => {
      const guestId = body.guestId ?? (body.guest ? await upsertGuest(client, ctx.tenantId, body.guest) : null);
      await recordAllergies(client, {
        tenantId: ctx.tenantId, guestId, allergies: body.allergies,
        source: 'staff_entered', createdBy: ctx.user.id,
      });
      return addToWaitlist(client, {
        tenantId: ctx.tenantId,
        restaurantId: ctx.params.restaurantId,
        guestId,
        partySize: Number(body.partySize),
        desiredFrom: new Date(body.desiredFrom),
        desiredTo: new Date(body.desiredTo),
        zoneId: body.zoneId ?? null,
        notes: body.notes ?? null,
        priority: body.priority ?? 100,
      });
    });
    sendJson(ctx.res, 201, entry);
  }, { permission: 'reservations:write' });

  // Qui pourrait prendre ce creneau ? Lecture seule, pour decider.
  router.get('/api/restaurants/:restaurantId/waitlist/matches', async (ctx) => {
    const startsAt = new Date(ctx.query.get('startsAt') ?? '');
    if (Number.isNaN(startsAt.getTime())) throw badRequest('startsAt doit etre une date ISO.');
    const matches = await ctx.withTenant((client) => matchesFor(client, {
      restaurantId: ctx.params.restaurantId, startsAt,
    }));
    sendJson(ctx.res, 200, matches);
  }, { permission: 'reservations:read' });

  router.post('/api/restaurants/:restaurantId/waitlist/offer', async (ctx) => {
    const body = await readJson(ctx.req);
    const startsAt = new Date(body.startsAt ?? '');
    if (Number.isNaN(startsAt.getTime())) throw badRequest('startsAt doit etre une date ISO.');
    const result = await ctx.withTenant((client) => offerSlot(client, {
      restaurantId: ctx.params.restaurantId,
      startsAt,
      entryId: body.entryId ?? null,
      durationMinutes: body.durationMinutes ?? null,
    }));
    sendJson(ctx.res, result.offered ? 201 : 200, result);
  }, { permission: 'reservations:write' });

  router.post('/api/waitlist/:entryId/accept', async (ctx) => {
    const result = await ctx.withTenant((client) => acceptOffer(client, { entryId: ctx.params.entryId }));
    sendJson(ctx.res, 200, { ok: true, ...result });
  }, { permission: 'reservations:write' });

  router.post('/api/waitlist/:entryId/decline', async (ctx) => {
    const result = await ctx.withTenant((client) =>
      declineOffer(client, { entryId: ctx.params.entryId, reason: 'refusee par l equipe' }));
    sendJson(ctx.res, 200, { ok: true, ...result });
  }, { permission: 'reservations:write' });

  router.delete('/api/waitlist/:entryId', async (ctx) => {
    const updated = await ctx.withTenant(async (client) => (await client.query(
      `UPDATE waitlist_entries SET status = 'cancelled'
        WHERE id = $1 AND status IN ('waiting','offered') RETURNING id`,
      [ctx.params.entryId])).rowCount);
    sendJson(ctx.res, 200, { ok: true, cancelled: updated });
  }, { permission: 'reservations:write' });

  return router;
}
