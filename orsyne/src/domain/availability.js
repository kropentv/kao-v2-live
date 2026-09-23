import { RestaurantClosedError, BookingRuleError } from './errors.js';
import {
  addMinutes, dayOfWeekInZone, parseIsoDate, parseTimeToMinutes, utcToZonedParts, zonedTimeToUtc,
} from '../lib/time.js';

export const DEFAULTS = {
  durationMinutes: 90,
  turnBufferMinutes: 15,
  slotIntervalMinutes: 15,
  holdMinutes: 15,
  lateGraceMinutes: 15,
};

export async function getRestaurant(client, restaurantId) {
  const { rows } = await client.query(
    `SELECT id, tenant_id, name, timezone, locale, currency, settings, is_active
       FROM restaurants WHERE id = $1`,
    [restaurantId],
  );
  if (rows.length === 0) throw new RestaurantClosedError({ restaurantId, cause: 'introuvable' });
  return rows[0];
}

/** Services actifs ce jour-la, selon l'heure murale du restaurant. */
export async function getServicePeriods(client, { restaurantId, isoDate, timeZone }) {
  const dow = dayOfWeekInZone(isoDate, timeZone);
  const { rows } = await client.query(
    `SELECT * FROM service_periods
      WHERE restaurant_id = $1 AND is_active AND $2 = ANY(days_of_week)
      ORDER BY starts_at`,
    [restaurantId, dow],
  );
  return rows;
}

/**
 * Service couvrant un instant donne. Un service accepte les arrivees de
 * starts_at jusqu'a ends_at - last_seating_offset_minutes : on ne prend pas
 * une table a 22h55 quand la cuisine ferme a 23h.
 */
export async function findServicePeriodFor(client, { restaurantId, timeZone, startsAt }) {
  const parts = utcToZonedParts(startsAt, timeZone);
  const isoDate = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  const periods = await getServicePeriods(client, { restaurantId, isoDate, timeZone });
  const minutes = parts.hour * 60 + parts.minute;

  return periods.find((period) => {
    const open = parseTimeToMinutes(period.starts_at);
    const close = parseTimeToMinutes(period.ends_at);
    const lastSeating = close - period.last_seating_offset_minutes;
    return minutes >= open && minutes <= lastSeating;
  }) ?? null;
}

/** Une fermeture exceptionnelle recouvre-t-elle le creneau ? */
export async function isClosed(client, { restaurantId, startsAt, endsAt, publicBooking = true }) {
  const { rows } = await client.query(
    `SELECT 1 FROM closures
      WHERE restaurant_id = $1
        AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2, $3, '[)')
        AND ($4 OR blocks_public_booking = false)
      LIMIT 1`,
    [restaurantId, startsAt, endsAt, publicBooking],
  );
  return rows.length > 0;
}

/** Regles applicables, de la plus specifique a la plus generale. */
export async function matchingBookingRules(client, { restaurantId, timeZone, startsAt, partySize, zoneId }) {
  const parts = utcToZonedParts(startsAt, timeZone);
  const minutes = parts.hour * 60 + parts.minute;
  const { rows } = await client.query(
    `SELECT * FROM booking_rules
      WHERE restaurant_id = $1 AND is_active
        AND (days_of_week   IS NULL OR $2 = ANY(days_of_week))
        AND (party_size_min IS NULL OR party_size_min <= $3)
        AND (party_size_max IS NULL OR party_size_max >= $3)
        AND (zone_id        IS NULL OR zone_id = $4)
      ORDER BY priority, created_at`,
    [restaurantId, parts.dayOfWeek, partySize, zoneId],
  );
  return rows.filter((rule) => {
    if (rule.time_from && minutes < parseTimeToMinutes(rule.time_from)) return false;
    if (rule.time_to && minutes > parseTimeToMinutes(rule.time_to)) return false;
    return true;
  });
}

/**
 * Verifie les regles et renvoie la duree retenue.
 * `channel` distingue une reservation en ligne (soumise aux regles
 * publiques) d'une saisie par le personnel (qui peut passer outre).
 */
export function applyBookingRules({ rules, startsAt, now = new Date(), channel = 'online' }) {
  let durationMinutes = null;
  let requiresApproval = false;

  for (const rule of rules) {
    if (channel === 'online' && rule.blocks_online_booking) {
      throw new BookingRuleError(
        `La reservation en ligne est fermee sur ce creneau (${rule.name}).`,
        { rule: rule.name },
      );
    }
    if (channel === 'online' && rule.min_lead_time_minutes != null) {
      const minStart = addMinutes(now, rule.min_lead_time_minutes);
      if (startsAt < minStart) {
        throw new BookingRuleError(
          `Ce creneau demande au moins ${rule.min_lead_time_minutes} minutes d'avance.`,
          { rule: rule.name, minLeadTimeMinutes: rule.min_lead_time_minutes },
        );
      }
    }
    if (channel === 'online' && rule.max_horizon_days != null) {
      const maxStart = addMinutes(now, rule.max_horizon_days * 24 * 60);
      if (startsAt > maxStart) {
        throw new BookingRuleError(
          `Les reservations ouvrent au plus ${rule.max_horizon_days} jours a l'avance.`,
          { rule: rule.name, maxHorizonDays: rule.max_horizon_days },
        );
      }
    }
    if (durationMinutes == null && rule.duration_minutes != null) durationMinutes = rule.duration_minutes;
    if (rule.requires_approval) requiresApproval = true;
  }

  return { durationMinutes, requiresApproval };
}

/**
 * Les holds expires (acompte jamais paye) sont liberes avant tout calcul.
 * Sans cela, un panier abandonne bloquerait une table jusqu'au service.
 */
export async function releaseExpiredHolds(client, restaurantId, now = null) {
  // `now` explicite pour l'ordonnanceur et les tests ; sinon l'horloge
  // de la base, qui fait foi pour tous les serveurs d'application.
  const { rowCount } = await client.query(
    `UPDATE table_occupancies
        SET is_active = false, released_at = COALESCE($2::timestamptz, now())
      WHERE restaurant_id = $1 AND is_active AND kind = 'hold'
        AND expires_at IS NOT NULL AND expires_at <= COALESCE($2::timestamptz, now())`,
    [restaurantId, now],
  );
  if (rowCount > 0) {
    await client.query(
      `UPDATE reservations SET status = 'cancelled', cancelled_at = COALESCE($2::timestamptz, now()),
              cancelled_by = 'system', cancellation_reason = 'acompte non regle dans le delai'
        WHERE restaurant_id = $1 AND status = 'pending_payment'
          AND NOT EXISTS (
            SELECT 1 FROM table_occupancies o
             WHERE o.reservation_id = reservations.id AND o.is_active)`,
      [restaurantId, now],
    );
  }
  return rowCount;
}

/** Tables libres sur tout l'intervalle demande. */
export async function freeTables(client, { restaurantId, from, to, zoneId = null }) {
  const { rows } = await client.query(
    `SELECT t.id, t.zone_id, t.code, t.seats_min, t.seats_max, t.priority,
            t.attributes, t.guest_selectable, t.combinable
       FROM restaurant_tables t
      WHERE t.restaurant_id = $1
        AND t.is_active
        AND t.live_status <> 'unavailable'
        AND ($4::uuid IS NULL OR t.zone_id = $4)
        AND NOT EXISTS (
          SELECT 1 FROM table_occupancies o
           WHERE o.table_id = t.id
             AND o.is_active
             AND o.occupied_during && tstzrange($2, $3, '[)')
        )
      ORDER BY t.priority, t.seats_max, t.code`,
    [restaurantId, from, to, zoneId],
  );
  return rows;
}

/** Combinaisons dont TOUS les membres sont libres sur l'intervalle. */
export async function freeCombinations(client, { restaurantId, from, to }) {
  const { rows } = await client.query(
    `SELECT c.id, c.name, c.seats_min, c.seats_max, c.priority,
            array_agg(m.table_id ORDER BY m.table_id) AS table_ids
       FROM table_combinations c
       JOIN table_combination_members m ON m.combination_id = c.id
       JOIN restaurant_tables t ON t.id = m.table_id
      WHERE c.restaurant_id = $1 AND c.is_active AND t.is_active
        AND t.live_status <> 'unavailable'
      GROUP BY c.id
     HAVING NOT EXISTS (
        SELECT 1 FROM table_combination_members m2
          JOIN table_occupancies o ON o.table_id = m2.table_id
         WHERE m2.combination_id = c.id
           AND o.is_active
           AND o.occupied_during && tstzrange($2, $3, '[)')
     )
      ORDER BY c.priority, c.seats_max`,
    [restaurantId, from, to],
  );
  return rows;
}

/** Prochaine occupation par table, apres un instant donne (rotation). */
export async function nextOccupancyStarts(client, { restaurantId, after }) {
  const { rows } = await client.query(
    `SELECT table_id, min(lower(occupied_during)) AS next_start
       FROM table_occupancies
      WHERE restaurant_id = $1 AND is_active AND lower(occupied_during) >= $2
      GROUP BY table_id`,
    [restaurantId, after],
  );
  return new Map(rows.map((r) => [r.table_id, r.next_start]));
}

/**
 * Creneaux d'un service pour une date et une taille de groupe.
 * Renvoie, pour chaque creneau, s'il reste de la place et quelles zones
 * restent proposables au client.
 */
export async function listSlots(client, { restaurantId, isoDate, partySize, zoneId = null, now = new Date() }) {
  const restaurant = await getRestaurant(client, restaurantId);
  const timeZone = restaurant.timezone;
  await releaseExpiredHolds(client, restaurantId);

  const periods = await getServicePeriods(client, { restaurantId, isoDate, timeZone });
  const { year, month, day } = parseIsoDate(isoDate);
  const slots = [];

  for (const period of periods) {
    const open = parseTimeToMinutes(period.starts_at);
    const close = parseTimeToMinutes(period.ends_at);
    const lastSeating = close - period.last_seating_offset_minutes;
    const step = period.slot_interval_minutes || DEFAULTS.slotIntervalMinutes;

    for (let minute = open; minute <= lastSeating; minute += step) {
      const startsAt = zonedTimeToUtc(
        { year, month, day, hour: Math.floor(minute / 60), minute: minute % 60 },
        timeZone,
      );
      if (startsAt <= now) continue;

      const rules = await matchingBookingRules(client, {
        restaurantId, timeZone, startsAt, partySize, zoneId,
      });
      let duration = period.default_duration_minutes;
      let blocked = null;
      try {
        const applied = applyBookingRules({ rules, startsAt, now, channel: 'online' });
        if (applied.durationMinutes) duration = applied.durationMinutes;
      } catch (error) {
        blocked = error.message;
      }

      const endsAt = addMinutes(startsAt, duration);
      const occupancyEnd = addMinutes(endsAt, period.turn_buffer_minutes);

      if (blocked || await isClosed(client, { restaurantId, startsAt, endsAt })) {
        slots.push({
          time: startsAt.toISOString(), servicePeriodId: period.id, servicePeriodName: period.name,
          available: false, reason: blocked ?? 'fermeture exceptionnelle', zones: [],
        });
        continue;
      }

      const tables = await freeTables(client, { restaurantId, from: startsAt, to: occupancyEnd, zoneId });
      const fitting = tables.filter((t) => t.seats_max >= partySize);
      const combos = fitting.length === 0
        ? (await freeCombinations(client, { restaurantId, from: startsAt, to: occupancyEnd }))
            .filter((c) => c.seats_max >= partySize && c.seats_min <= partySize)
        : [];

      // Zones proposables au client : uniquement celles que le restaurant
      // a explicitement rendues visibles (section 5).
      const zoneIds = [...new Set(fitting.filter((t) => t.zone_id).map((t) => t.zone_id))];
      const selectableZones = zoneIds.length === 0 ? [] : (await client.query(
        `SELECT id, name, kind FROM zones
          WHERE id = ANY($1::uuid[]) AND guest_selectable AND is_active
          ORDER BY sort_order, name`,
        [zoneIds],
      )).rows;

      slots.push({
        time: startsAt.toISOString(),
        servicePeriodId: period.id,
        servicePeriodName: period.name,
        durationMinutes: duration,
        available: fitting.length > 0 || combos.length > 0,
        requiresCombination: fitting.length === 0 && combos.length > 0,
        tablesLeft: fitting.length,
        zones: selectableZones,
        selectableTables: fitting
          .filter((t) => t.guest_selectable)
          .map((t) => ({ id: t.id, code: t.code, zoneId: t.zone_id, seats: t.seats_max, attributes: t.attributes })),
        reason: null,
      });
    }
  }

  return { restaurantId, date: isoDate, timeZone, partySize, slots };
}
