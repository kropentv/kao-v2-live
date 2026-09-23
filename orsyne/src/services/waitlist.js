import { createReservation } from '../domain/reservation-engine.js';
import { freeTables, freeCombinations, getRestaurant, findServicePeriodFor, DEFAULTS } from '../domain/availability.js';
import { DomainError } from '../domain/errors.js';
import { addMinutes } from '../lib/time.js';
import { notifyReservation, sendGuestMessage } from './messaging.js';

/**
 * Liste d'attente (section 22).
 *
 * Quand une table se libere, on cherche les clients compatibles et on
 * propose — on ne reserve pas d'office. Le restaurant garde la main :
 * une proposition expire, et la table repart a tout le monde.
 *
 * L'ordre est : priorite declaree, puis anciennete. Pas de « plus gros
 * groupe d'abord » : un restaurant qui veut optimiser son remplissage le
 * fait par ses regles, pas par un tri cache dans le code.
 */
const OFFER_MINUTES = 20;

export async function addToWaitlist(client, {
  tenantId, restaurantId, guestId, partySize, desiredFrom, desiredTo,
  zoneId = null, notes = null, priority = 100,
}) {
  if (!Number.isInteger(partySize) || partySize < 1) {
    throw new DomainError('invalid_party_size', 'Le nombre de personnes doit etre un entier positif.');
  }
  if (!(desiredFrom instanceof Date) || !(desiredTo instanceof Date) || desiredTo <= desiredFrom) {
    throw new DomainError('invalid_window', "La fenetre souhaitee est invalide.");
  }
  const { rows: [entry] } = await client.query(
    `INSERT INTO waitlist_entries
       (tenant_id, restaurant_id, guest_id, party_size, desired_from, desired_to,
        requested_zone_id, notes, priority)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [tenantId, restaurantId, guestId, partySize, desiredFrom, desiredTo, zoneId, notes, priority],
  );
  return entry;
}

/**
 * Candidats pour un creneau qui vient de se liberer.
 * Ne fait aucune ecriture : le dashboard l'utilise pour proposer, et le
 * declenchement automatique pour choisir.
 */
export async function matchesFor(client, { restaurantId, startsAt, durationMinutes = null }) {
  const restaurant = await getRestaurant(client, restaurantId);
  const period = await findServicePeriodFor(client, {
    restaurantId, timeZone: restaurant.timezone, startsAt,
  });
  const duration = durationMinutes ?? period?.default_duration_minutes ?? DEFAULTS.durationMinutes;
  const endsAt = addMinutes(startsAt, duration);

  const { rows } = await client.query(
    `SELECT w.*, g.first_name, g.last_name, g.email, g.phone_e164, g.locale,
            COALESCE(s.visits, 0) AS visits
       FROM waitlist_entries w
       LEFT JOIN guests g ON g.id = w.guest_id
       LEFT JOIN guest_restaurant_stats s
              ON s.guest_id = w.guest_id AND s.restaurant_id = w.restaurant_id
      WHERE w.restaurant_id = $1
        AND w.status = 'waiting'
        -- Le client indique quand il peut ARRIVER (« de 19h a 21h30 ») :
        -- c'est l'heure de debut qui doit tomber dans sa fenetre, pas le
        -- repas entier.
        AND w.desired_from <= $2 AND w.desired_to >= $2
      ORDER BY w.priority, w.created_at`,
    [restaurantId, startsAt],
  );

  // Ne proposer que ce qu'on peut reellement honorer.
  const turnBuffer = period?.turn_buffer_minutes ?? DEFAULTS.turnBufferMinutes;
  const occupancyEnd = addMinutes(endsAt, turnBuffer);
  const tables = await freeTables(client, { restaurantId, from: startsAt, to: occupancyEnd });
  const combos = await freeCombinations(client, { restaurantId, from: startsAt, to: occupancyEnd });

  return rows
    .filter((entry) => {
      const inZone = entry.requested_zone_id
        ? tables.some((t) => t.zone_id === entry.requested_zone_id && t.seats_max >= entry.party_size)
        : tables.some((t) => t.seats_max >= entry.party_size);
      const viaCombo = combos.some((c) =>
        c.seats_max >= entry.party_size && c.seats_min <= entry.party_size);
      return inZone || viaCombo;
    })
    .map((entry) => ({
      id: entry.id,
      guestId: entry.guest_id,
      name: [entry.first_name, entry.last_name].filter(Boolean).join(' ') || 'Client',
      partySize: entry.party_size,
      visits: Number(entry.visits),
      zoneId: entry.requested_zone_id,
      priority: entry.priority,
      waitingSince: entry.created_at,
      locale: entry.locale ?? 'fr-FR',
      contact: entry.email ?? entry.phone_e164 ?? null,
    }));
}

/**
 * Propose le creneau au premier candidat et tient la table pour lui.
 *
 * La reservation est creee immediatement en `pending_approval`, avec son
 * occupation : c'est la seule facon d'etre sur que la table sera encore
 * la quand le client repondra. Si la proposition expire, elle est
 * annulee et la table repart.
 */
export async function offerSlot(client, { restaurantId, startsAt, durationMinutes = null, entryId = null, now = new Date() }) {
  const candidates = await matchesFor(client, { restaurantId, startsAt, durationMinutes });
  const chosen = entryId ? candidates.find((c) => c.id === entryId) : candidates[0];
  if (!chosen) return { offered: false, reason: 'aucun client compatible' };

  const { rows: [entry] } = await client.query(
    `SELECT * FROM waitlist_entries WHERE id = $1 AND status = 'waiting'`, [chosen.id]);
  if (!entry) return { offered: false, reason: 'entree deja traitee' };

  const created = await createReservation(client, {
    restaurantId,
    guestId: entry.guest_id,
    partySize: entry.party_size,
    startsAt,
    durationMinutes,
    requestedZoneId: entry.requested_zone_id,
    source: 'staff',
    skipDeposit: true,
    now,
  });

  // On retient la table sans la confirmer : le client n'a pas encore dit oui.
  await client.query(
    `UPDATE reservations SET status = 'pending_approval' WHERE id = $1`,
    [created.reservation.id]);

  const expiresAt = addMinutes(now, OFFER_MINUTES);
  await client.query(
    `UPDATE waitlist_entries
        SET status = 'offered', offered_at = $2, offer_expires_at = $3,
            offered_reservation_id = $4
      WHERE id = $1`,
    [entry.id, now, expiresAt, created.reservation.id]);

  await notifyReservation(client, {
    reservationId: created.reservation.id,
    template: 'waitlist_offer',
    extra: {
      expiresAt: expiresAt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
      acceptUrl: '',
    },
  });

  await client.query(
    `INSERT INTO outbox_events (tenant_id, restaurant_id, topic, payload)
     VALUES ($1,$2,'waitlist.offered',$3)`,
    [entry.tenant_id, restaurantId, JSON.stringify({
      entryId: entry.id, reservationId: created.reservation.id,
      guestId: entry.guest_id, partySize: entry.party_size,
      expiresAt: expiresAt.toISOString(),
    })]);

  return {
    offered: true,
    entryId: entry.id,
    reservationId: created.reservation.id,
    reference: created.reservation.reference,
    tableIds: created.tableIds,
    expiresAt,
    candidate: chosen,
  };
}

export async function acceptOffer(client, { entryId }) {
  const { rows: [entry] } = await client.query(
    `SELECT * FROM waitlist_entries WHERE id = $1 AND status = 'offered'`, [entryId]);
  if (!entry) throw new DomainError('offer_not_found', "Aucune proposition en cours.");
  if (entry.offer_expires_at && new Date(entry.offer_expires_at) < new Date()) {
    throw new DomainError('offer_expired', 'La proposition a expire.');
  }

  await client.query(
    `UPDATE reservations SET status = 'confirmed' WHERE id = $1`,
    [entry.offered_reservation_id]);
  await client.query(
    `UPDATE waitlist_entries SET status = 'converted' WHERE id = $1`, [entryId]);
  await notifyReservation(client, {
    reservationId: entry.offered_reservation_id, template: 'confirmed',
  });
  return { reservationId: entry.offered_reservation_id };
}

export async function declineOffer(client, { entryId, reason = null }) {
  const { rows: [entry] } = await client.query(
    `SELECT * FROM waitlist_entries WHERE id = $1 AND status = 'offered'`, [entryId]);
  if (!entry) return { released: false };
  await releaseOffer(client, entry, 'declined', reason);
  return { released: true, reservationId: entry.offered_reservation_id };
}

/** Balaye les propositions expirees et rend les tables. */
export async function expireOffers(client, { now = new Date() } = {}) {
  const { rows } = await client.query(
    `SELECT * FROM waitlist_entries
      WHERE status = 'offered' AND offer_expires_at IS NOT NULL AND offer_expires_at <= $1`,
    [now]);
  for (const entry of rows) await releaseOffer(client, entry, 'expired', 'delai depasse');
  return rows.length;
}

async function releaseOffer(client, entry, status, reason) {
  if (entry.offered_reservation_id) {
    await client.query(
      `UPDATE table_occupancies SET is_active = false, released_at = now()
        WHERE reservation_id = $1 AND is_active`,
      [entry.offered_reservation_id]);
    await client.query(
      `UPDATE reservations
          SET status = 'cancelled', cancelled_at = now(),
              cancelled_by = 'system', cancellation_reason = $2
        WHERE id = $1 AND status = 'pending_approval'`,
      [entry.offered_reservation_id, reason]);
  }
  await client.query(
    `UPDATE waitlist_entries SET status = $2, offered_reservation_id = NULL WHERE id = $1`,
    [entry.id, status]);
}

/**
 * Declenche par la liberation d'une table (annulation, no-show).
 * Ne leve jamais : la liste d'attente est un bonus, pas un point de
 * defaillance du service.
 */
export async function onTableFreed(client, { restaurantId, startsAt, durationMinutes = null }) {
  try {
    return await offerSlot(client, { restaurantId, startsAt, durationMinutes });
  } catch {
    return { offered: false, reason: 'proposition impossible' };
  }
}

export { sendGuestMessage };
