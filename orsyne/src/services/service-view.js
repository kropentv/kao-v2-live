import { parseIsoDate, utcToZonedParts, zonedTimeToUtc } from '../lib/time.js';

const parseIsoDateParts = parseIsoDate;

/**
 * Vue « service en cours » (section 18) : l'etat de la salle en une
 * requete, cadre sur la journee d'exploitation du restaurant.
 *
 * Une journee d'exploitation n'est pas une journee calendaire : un
 * service qui finit a 1h du matin appartient a la veille. On borne donc
 * de 04h00 a 04h00 en heure locale.
 */
export const SERVICE_DAY_START_HOUR = 4;

export function serviceDayBounds({ timeZone, now = new Date() }) {
  const parts = utcToZonedParts(now, timeZone);
  const day = parts.hour < SERVICE_DAY_START_HOUR ? parts.day - 1 : parts.day;
  const from = zonedTimeToUtc(
    { year: parts.year, month: parts.month, day, hour: SERVICE_DAY_START_HOUR }, timeZone,
  );
  return { from, to: new Date(from.getTime() + 24 * 3_600_000) };
}

/** Retard tolere avant qu'une arrivee ne devienne une alerte. */
export const LATE_GRACE_MINUTES = 15;
/** Delai au-dela duquel on propose de basculer en no-show. */
export const NO_SHOW_AFTER_MINUTES = 30;

/** Statuts pour lesquels une table est physiquement prise. */
const IN_SERVICE = new Set(['seated', 'ordered', 'in_service', 'check_requested']);

/**
 * @param {object} options
 * @param {string} [options.isoDate] journee d'exploitation a consulter
 *   (YYYY-MM-DD, heure locale du restaurant). Par defaut : celle en cours.
 */
export async function getServiceView(client, { restaurantId, now = new Date(), isoDate = null, forUserId = null }) {
  const { rows: [restaurant] } = await client.query(
    `SELECT id, name, timezone, locale, currency FROM restaurants WHERE id = $1`, [restaurantId],
  );
  if (!restaurant) return null;

  // Consulter une autre journee : on se place a midi local, heure qui
  // appartient sans ambiguite a la journee d'exploitation demandee.
  const anchor = isoDate
    ? zonedTimeToUtc({ ...parseIsoDateParts(isoDate), hour: 12 }, restaurant.timezone)
    : now;
  const { from, to } = serviceDayBounds({ timeZone: restaurant.timezone, now: anchor });

  const { rows: reservations } = await client.query(
    `SELECT r.id, r.reference, r.party_size, r.starts_at, r.ends_at, r.status, r.source,
            r.occasion, r.guest_notes, r.arrived_at, r.seated_at,
            g.id AS guest_id, g.first_name, g.last_name, g.locale AS guest_locale, g.vip,
            COALESCE(gs.visits, 0) AS guest_visits,
            COALESCE(array_agg(DISTINCT t.code) FILTER (WHERE t.code IS NOT NULL), '{}') AS table_codes,
            COALESCE(array_agg(DISTINCT t.id)   FILTER (WHERE t.id   IS NOT NULL), '{}') AS table_ids,
            sa.user_id AS server_user_id,
            COALESCE(su.display_name, su.full_name) AS server_name,
            EXISTS (SELECT 1 FROM guest_preferences gp
                     WHERE gp.guest_id = g.id AND gp.is_critical) AS has_critical_preference
       FROM reservations r
       LEFT JOIN guests g ON g.id = r.guest_id
       LEFT JOIN guest_restaurant_stats gs ON gs.guest_id = g.id AND gs.restaurant_id = r.restaurant_id
       LEFT JOIN table_occupancies o ON o.reservation_id = r.id AND o.is_active
       LEFT JOIN restaurant_tables t ON t.id = o.table_id
       LEFT JOIN server_assignments sa ON sa.reservation_id = r.id AND sa.is_current
       LEFT JOIN users su ON su.id = sa.user_id
      WHERE r.restaurant_id = $1
        AND r.starts_at >= $2 AND r.starts_at < $3
        AND r.status <> 'cancelled'
        AND ($4::uuid IS NULL OR sa.user_id = $4)
      GROUP BY r.id, g.id, gs.visits, sa.user_id, su.display_name, su.full_name
      ORDER BY r.starts_at`,
    [restaurantId, from, to, forUserId],
  );

  const { rows: tables } = await client.query(
    `SELECT t.id, t.code, t.seats_min, t.seats_max, t.live_status, t.zone_id,
            t.pos_x, t.pos_y, t.width, t.height, t.shape, t.attributes,
            z.name AS zone_name, z.kind AS zone_kind,
            cur.reservation_id AS current_reservation_id,
            cur.reference      AS current_reference,
            cur.party_size     AS current_party_size,
            nxt.reservation_id AS next_reservation_id,
            nxt.starts_at      AS next_starts_at
       FROM restaurant_tables t
       LEFT JOIN zones z ON z.id = t.zone_id
       LEFT JOIN LATERAL (
         SELECT r.id AS reservation_id, r.reference, r.party_size
           FROM table_occupancies o JOIN reservations r ON r.id = o.reservation_id
          WHERE o.table_id = t.id AND o.is_active AND o.occupied_during @> $2::timestamptz
          LIMIT 1
       ) cur ON true
       LEFT JOIN LATERAL (
         SELECT r.id AS reservation_id, r.starts_at
           FROM table_occupancies o JOIN reservations r ON r.id = o.reservation_id
          WHERE o.table_id = t.id AND o.is_active AND lower(o.occupied_during) > $2::timestamptz
          ORDER BY lower(o.occupied_during) LIMIT 1
       ) nxt ON true
      WHERE t.restaurant_id = $1 AND t.is_active
      ORDER BY z.sort_order NULLS LAST, t.code`,
    [restaurantId, now],
  );

  const enriched = reservations.map((r) => {
    const minutesLate = r.status === 'confirmed'
      ? Math.floor((now - new Date(r.starts_at)) / 60_000)
      : 0;
    return {
      ...r,
      guestName: [r.first_name, r.last_name].filter(Boolean).join(' ') || null,
      isLate: minutesLate > LATE_GRACE_MINUTES,
      minutesLate: minutesLate > 0 ? minutesLate : 0,
      noShowCandidate: minutesLate > NO_SHOW_AFTER_MINUTES,
    };
  });

  const covers = enriched.reduce((sum, r) => sum + r.party_size, 0);
  const seated = enriched.filter((r) => r.status === 'seated');

  return {
    restaurant,
    window: { from, to, now },
    reservations: enriched,
    tables,
    alerts: enriched.filter((r) => r.isLate).map((r) => ({
      kind: r.noShowCandidate ? 'no_show_candidate' : 'late',
      reservationId: r.id,
      reference: r.reference,
      guestName: r.guestName,
      minutesLate: r.minutesLate,
      tables: r.table_codes,
    })),
    stats: {
      reservations: enriched.length,
      covers,
      seatedTables: seated.length,
      seatedCovers: seated.reduce((sum, r) => sum + r.party_size, 0),
      expected: enriched.filter((r) => r.status === 'confirmed').length,
      completed: enriched.filter((r) => r.status === 'completed').length,
      noShows: enriched.filter((r) => r.status === 'no_show').length,
      tablesTotal: tables.length,
      // Une table est occupee si un creneau la couvre maintenant OU si
      // des clients y sont assis : les deux peuvent diverger quand une
      // table est prise en avance ou liberee en retard.
      tablesOccupied: tables.filter((t) => t.current_reservation_id || IN_SERVICE.has(t.live_status)).length,
      tablesFree: tables.filter((t) => !t.current_reservation_id && t.live_status === 'available').length,
    },
  };
}
