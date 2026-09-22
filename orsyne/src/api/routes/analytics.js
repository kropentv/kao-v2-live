import { Router, sendJson, badRequest } from '../http.js';

/** Analytics (section 20). Chiffres calcules, jamais estimes. */
export function analyticsRoutes(router = new Router()) {
  router.get('/api/restaurants/:restaurantId/analytics', async (ctx) => {
    const from = ctx.query.get('from');
    const to = ctx.query.get('to');
    if (!from || !to) throw badRequest('Parametres `from` et `to` requis (ISO).');

    const data = await ctx.withTenant(async (client) => {
      const { rows: [totals] } = await client.query(
        `SELECT count(*)::int AS reservations,
                COALESCE(sum(party_size), 0)::int AS covers,
                count(*) FILTER (WHERE status = 'cancelled')::int AS cancellations,
                count(*) FILTER (WHERE status = 'no_show')::int   AS no_shows,
                count(*) FILTER (WHERE status = 'completed')::int AS completed,
                count(DISTINCT guest_id)::int AS unique_guests
           FROM reservations
          WHERE restaurant_id = $1 AND starts_at >= $2 AND starts_at < $3`,
        [ctx.params.restaurantId, from, to],
      );

      const { rows: bySource } = await client.query(
        `SELECT source, count(*)::int AS reservations, COALESCE(sum(party_size),0)::int AS covers
           FROM reservations
          WHERE restaurant_id = $1 AND starts_at >= $2 AND starts_at < $3
          GROUP BY source ORDER BY reservations DESC`,
        [ctx.params.restaurantId, from, to],
      );

      const { rows: byDay } = await client.query(
        `SELECT (starts_at AT TIME ZONE r.timezone)::date AS day,
                count(*)::int AS reservations,
                COALESCE(sum(party_size),0)::int AS covers
           FROM reservations res JOIN restaurants r ON r.id = res.restaurant_id
          WHERE res.restaurant_id = $1 AND starts_at >= $2 AND starts_at < $3
            AND status <> 'cancelled'
          GROUP BY day ORDER BY day`,
        [ctx.params.restaurantId, from, to],
      );

      // Taux d'occupation : couverts servis rapportes a la capacite
      // reellement ouverte, pas a la capacite theorique du restaurant.
      const { rows: [occupancy] } = await client.query(
        `SELECT COALESCE(sum(r.party_size), 0)::int AS seated_covers,
                (SELECT COALESCE(sum(seats_max), 0) FROM restaurant_tables
                  WHERE restaurant_id = $1 AND is_active)::int AS capacity
           FROM reservations r
          WHERE r.restaurant_id = $1 AND r.starts_at >= $2 AND r.starts_at < $3
            AND r.status IN ('seated','completed')`,
        [ctx.params.restaurantId, from, to],
      );

      const { rows: byServer } = await client.query(
        `SELECT COALESCE(u.display_name, u.full_name) AS name,
                count(*)::int AS reservations,
                COALESCE(sum(r.party_size), 0)::int AS covers
           FROM server_assignments a
           JOIN reservations r ON r.id = a.reservation_id
           JOIN users u ON u.id = a.user_id
          WHERE a.restaurant_id = $1 AND a.is_current
            AND r.starts_at >= $2 AND r.starts_at < $3
            AND r.status IN ('seated','completed')
          GROUP BY u.id, u.display_name, u.full_name
          ORDER BY covers DESC`,
        [ctx.params.restaurantId, from, to],
      );

      const { rows: [returning] } = await client.query(
        `SELECT count(*) FILTER (WHERE prior > 0)::int  AS returning_guests,
                count(*) FILTER (WHERE prior = 0)::int  AS new_guests
           FROM (
             SELECT r.guest_id,
                    (SELECT count(*) FROM reservations p
                      WHERE p.guest_id = r.guest_id AND p.starts_at < $2
                        AND p.status = 'completed') AS prior
               FROM reservations r
              WHERE r.restaurant_id = $1 AND r.starts_at >= $2 AND r.starts_at < $3
                AND r.guest_id IS NOT NULL AND r.status <> 'cancelled'
              GROUP BY r.guest_id
           ) s`,
        [ctx.params.restaurantId, from, to],
      );

      const { rows: [ai] } = await client.query(
        `SELECT count(*)::int AS calls,
                count(*) FILTER (WHERE outcome = 'reservation_created')::int AS reservations_created,
                COALESCE(avg(duration_seconds), 0)::int AS avg_duration_seconds
           FROM ai_calls
          WHERE restaurant_id = $1 AND started_at >= $2 AND started_at < $3`,
        [ctx.params.restaurantId, from, to],
      );

      const booked = totals.reservations || 1;
      return {
        window: { from, to },
        totals: {
          ...totals,
          cancellationRate: Number((totals.cancellations / booked * 100).toFixed(1)),
          noShowRate: Number((totals.no_shows / booked * 100).toFixed(1)),
        },
        occupancyRate: occupancy.capacity > 0
          ? Number((occupancy.seated_covers / occupancy.capacity * 100).toFixed(1))
          : null,
        bySource, byDay, byServer,
        guests: returning,
        ai,
      };
    });
    sendJson(ctx.res, 200, data);
  }, { permission: 'analytics:read' });

  return router;
}
