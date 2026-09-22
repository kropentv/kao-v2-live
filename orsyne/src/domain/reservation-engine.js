import { randomBytes } from 'node:crypto';
import {
  DomainError, InvalidTransitionError, NoAvailabilityError,
  PG_EXCLUSION_VIOLATION, RestaurantClosedError, TableUnavailableError,
} from './errors.js';
import { rankAllocations } from './allocation.js';
import {
  DEFAULTS, applyBookingRules, findServicePeriodFor, freeCombinations, freeTables,
  getRestaurant, isClosed, matchingBookingRules, nextOccupancyStarts, releaseExpiredHolds,
} from './availability.js';
import { addMinutes } from '../lib/time.js';

// Alphabet sans I, O, 0, 1 : une reference se dicte au telephone sans
// ambiguite, ce que l'IA receptionniste fait a chaque appel.
const REFERENCE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function generateReference() {
  const bytes = randomBytes(6);
  let out = '';
  for (const byte of bytes) out += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
  return `${out.slice(0, 3)}-${out.slice(3)}`;
}

/** Transitions autorisees du cycle de vie d'une reservation. */
const ALLOWED_TRANSITIONS = {
  draft: ['pending_payment', 'pending_approval', 'confirmed', 'cancelled'],
  pending_payment: ['confirmed', 'cancelled'],
  pending_approval: ['confirmed', 'cancelled'],
  confirmed: ['arrived', 'seated', 'cancelled', 'no_show'],
  arrived: ['seated', 'cancelled', 'no_show'],
  seated: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  no_show: [],
};

async function emit(client, { tenantId, restaurantId, topic, payload }) {
  await client.query(
    `INSERT INTO outbox_events (tenant_id, restaurant_id, topic, payload)
     VALUES ($1, $2, $3, $4)`,
    [tenantId, restaurantId, topic, JSON.stringify(payload)],
  );
}

async function recordStatus(client, { tenantId, reservationId, from, to, actorKind = 'system', actorUserId = null, reason = null }) {
  await client.query(
    `INSERT INTO reservation_status_history
       (tenant_id, reservation_id, from_status, to_status, actor_kind, actor_user_id, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, reservationId, from, to, actorKind, actorUserId, reason],
  );
}

/**
 * Politique de garantie applicable (section 6). La regle la plus
 * specifique gagne ; aucune regle = aucun acompte.
 */
export async function resolveDepositPolicy(client, { restaurantId, startsAt, partySize, zoneId, tableId, timeZone }) {
  const { utcToZonedParts } = await import('../lib/time.js');
  const parts = utcToZonedParts(startsAt, timeZone);
  const minutes = parts.hour * 60 + parts.minute;

  const { rows } = await client.query(
    `SELECT * FROM deposit_policies
      WHERE restaurant_id = $1 AND is_active
        AND (days_of_week   IS NULL OR $2 = ANY(days_of_week))
        AND (party_size_min IS NULL OR party_size_min <= $3)
        AND (party_size_max IS NULL OR party_size_max >= $3)
        AND (zone_id        IS NULL OR zone_id  = $4)
        AND (table_id       IS NULL OR table_id = $5)
      ORDER BY priority, created_at`,
    [restaurantId, parts.dayOfWeek, partySize, zoneId, tableId],
  );

  const { parseTimeToMinutes } = await import('../lib/time.js');
  const policy = rows.find((p) => {
    if (p.time_from && minutes < parseTimeToMinutes(p.time_from)) return false;
    if (p.time_to && minutes > parseTimeToMinutes(p.time_to)) return false;
    return true;
  });
  if (!policy || policy.mechanism === 'none') return null;

  const amountCents = policy.amount_mode === 'per_person'
    ? policy.amount_cents * partySize
    : policy.amount_cents;

  return { ...policy, computed_amount_cents: amountCents };
}

/**
 * Cree une reservation et lui attribue une ou plusieurs tables.
 *
 * GARANTIE D'UNICITE
 * ------------------
 * Le moteur ne verrouille pas les tables a l'avance et n'utilise aucun
 * mutex applicatif. Il propose des candidats par ordre de pertinence et
 * laisse la contrainte d'exclusion GiST arbitrer : si une transaction
 * concurrente a pris la table entre-temps, l'INSERT echoue en 23P01, on
 * revient au SAVEPOINT et on tente le candidat suivant. Deux clients ne
 * peuvent donc pas obtenir la meme table, quel que soit le parallelisme,
 * et un seul aller-retour suffit dans le cas nominal.
 *
 * L'appelant fournit un client DEJA dans une transaction bornee au tenant
 * (voir withTenant).
 */
export async function createReservation(client, input) {
  const {
    restaurantId,
    guestId = null,
    partySize,
    startsAt,
    durationMinutes: durationOverride = null,
    requestedZoneId = null,
    requestedTableId = null,
    tableIds: forcedTableIds = null,   // attribution manuelle du manager
    source = 'widget',
    locale = null,
    occasion = null,
    guestNotes = null,
    staffNotes = null,
    createdByUserId = null,
    now = new Date(),
    holdMinutes = DEFAULTS.holdMinutes,
    skipDeposit = false,
  } = input;

  if (!Number.isInteger(partySize) || partySize < 1) {
    throw new DomainError('invalid_party_size', 'Le nombre de personnes doit etre un entier positif.');
  }
  if (!(startsAt instanceof Date) || Number.isNaN(startsAt.getTime())) {
    throw new DomainError('invalid_start', "L'heure de reservation est invalide.");
  }

  const restaurant = await getRestaurant(client, restaurantId);
  if (!restaurant.is_active) throw new RestaurantClosedError({ restaurantId });
  const timeZone = restaurant.timezone;
  const tenantId = restaurant.tenant_id;

  await releaseExpiredHolds(client, restaurantId);

  // Une saisie par le personnel ou un walk-in n'est pas soumise aux regles
  // publiques : le manager doit toujours pouvoir installer un client.
  const staffDriven = ['staff', 'phone_staff', 'walk_in'].includes(source);
  const channel = staffDriven ? 'staff' : 'online';

  const period = await findServicePeriodFor(client, { restaurantId, timeZone, startsAt });
  if (!period && !staffDriven) {
    throw new RestaurantClosedError({ restaurantId, startsAt: startsAt.toISOString(), cause: 'hors service' });
  }

  const rules = await matchingBookingRules(client, {
    restaurantId, timeZone, startsAt, partySize, zoneId: requestedZoneId,
  });
  const applied = applyBookingRules({ rules, startsAt, now, channel });

  const durationMinutes = durationOverride
    ?? applied.durationMinutes
    ?? period?.default_duration_minutes
    ?? DEFAULTS.durationMinutes;
  const turnBuffer = period?.turn_buffer_minutes ?? DEFAULTS.turnBufferMinutes;

  const endsAt = addMinutes(startsAt, durationMinutes);
  // L'intervalle reserve inclut le battement de remise en place ; la fin
  // annoncee au client reste endsAt.
  const occupancyEnd = addMinutes(endsAt, turnBuffer);

  if (!staffDriven && await isClosed(client, { restaurantId, startsAt, endsAt })) {
    throw new RestaurantClosedError({ restaurantId, startsAt: startsAt.toISOString(), cause: 'fermeture exceptionnelle' });
  }

  // --- Candidats ---
  let allocations;
  if (forcedTableIds?.length) {
    // Attribution manuelle : on respecte le choix tel quel. S'il est
    // occupe, on echoue explicitement plutot que de substituer en silence.
    allocations = [{ tableIds: forcedTableIds, seats: partySize, score: -1, reason: 'attribution manuelle' }];
  } else {
    const tables = await freeTables(client, { restaurantId, from: startsAt, to: occupancyEnd });
    const combinations = await freeCombinations(client, { restaurantId, from: startsAt, to: occupancyEnd });
    const nextStarts = await nextOccupancyStarts(client, { restaurantId, after: occupancyEnd });

    const guestAttributes = guestId ? await loadGuestTableAttributes(client, guestId) : [];

    allocations = rankAllocations({
      tables,
      combinations,
      partySize,
      requestedZoneId,
      requestedTableId,
      guestPreferredAttributes: guestAttributes,
      nextOccupiedAt: nextStarts,
      occupancyEnd,
    });

    if (allocations.length === 0) {
      if (requestedTableId) throw new TableUnavailableError({ tableId: requestedTableId });
      throw new NoAvailabilityError({
        restaurantId, startsAt: startsAt.toISOString(), partySize,
      });
    }
  }

  // --- Garantie financiere ---
  const policy = skipDeposit ? null : await resolveDepositPolicy(client, {
    restaurantId, startsAt, partySize, zoneId: requestedZoneId, tableId: requestedTableId, timeZone,
  });

  const needsPayment = policy != null && policy.computed_amount_cents > 0;
  const status = needsPayment ? 'pending_payment'
    : applied.requiresApproval ? 'pending_approval'
    : 'confirmed';
  const occupancyKind = needsPayment ? 'hold' : 'reservation';
  const expiresAt = needsPayment ? addMinutes(now, holdMinutes) : null;

  // --- Ecriture ---
  const reference = generateReference();
  const { rows: [reservation] } = await client.query(
    `INSERT INTO reservations (
        tenant_id, restaurant_id, reference, guest_id, service_period_id,
        party_size, starts_at, duration_minutes, status, source, locale,
        requested_zone_id, requested_table_id, occasion, guest_notes, staff_notes,
        deposit_policy_id, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING *`,
    [
      tenantId, restaurantId, reference, guestId, period?.id ?? null,
      partySize, startsAt, durationMinutes, status, source,
      locale ?? restaurant.locale,
      requestedZoneId, requestedTableId, occasion, guestNotes, staffNotes,
      policy?.id ?? null, createdByUserId,
    ],
  );

  // Tentatives successives : le premier candidat qui survit a la contrainte
  // d'exclusion gagne la table.
  let assigned = null;
  const conflicts = [];

  for (const allocation of allocations) {
    await client.query('SAVEPOINT allocate');
    try {
      for (const tableId of allocation.tableIds) {
        await client.query(
          `INSERT INTO table_occupancies
             (tenant_id, restaurant_id, table_id, reservation_id, kind, occupied_during, expires_at)
           VALUES ($1,$2,$3,$4,$5,tstzrange($6,$7,'[)'),$8)`,
          [tenantId, restaurantId, tableId, reservation.id, occupancyKind, startsAt, occupancyEnd, expiresAt],
        );
      }
      await client.query('RELEASE SAVEPOINT allocate');
      assigned = allocation;
      break;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT allocate');
      await client.query('RELEASE SAVEPOINT allocate');
      if (error.code !== PG_EXCLUSION_VIOLATION) throw error;
      // Une transaction concurrente a pris cette table : on descend d'un cran.
      conflicts.push(allocation.tableIds);
    }
  }

  if (!assigned) {
    if (forcedTableIds?.length || requestedTableId) {
      throw new TableUnavailableError({ tableIds: forcedTableIds ?? [requestedTableId], conflicts });
    }
    throw new NoAvailabilityError({
      restaurantId, startsAt: startsAt.toISOString(), partySize,
      attempted: conflicts.length,
      cause: 'toutes les tables candidates ont ete prises par des demandes concurrentes',
    });
  }

  await client.query(
    `UPDATE restaurant_tables SET live_status = 'reserved'
      WHERE id = ANY($1::uuid[]) AND live_status = 'available'`,
    [assigned.tableIds],
  );

  await recordStatus(client, {
    tenantId, reservationId: reservation.id, from: null, to: status,
    actorKind: createdByUserId ? 'user' : 'system', actorUserId: createdByUserId,
    reason: assigned.reason,
  });

  await emit(client, {
    tenantId, restaurantId,
    topic: needsPayment ? 'reservation.pending_payment' : 'reservation.confirmed',
    payload: {
      reservationId: reservation.id, reference, guestId, partySize,
      startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(),
      tableIds: assigned.tableIds, source, status,
    },
  });

  return {
    reservation: { ...reservation, ends_at: endsAt },
    tableIds: assigned.tableIds,
    allocation: assigned,
    occupancy: { from: startsAt, to: occupancyEnd, kind: occupancyKind, expiresAt },
    deposit: policy && {
      policyId: policy.id,
      mechanism: policy.mechanism,
      amountCents: policy.computed_amount_cents,
      currency: policy.currency,
      freeCancellationHours: policy.free_cancellation_hours,
    },
  };
}

/** Preferences de table/zone du profil CRM, utilisees par le scoring. */
async function loadGuestTableAttributes(client, guestId) {
  const { rows } = await client.query(
    `SELECT value FROM guest_preferences
      WHERE guest_id = $1 AND kind IN ('table', 'zone')`,
    [guestId],
  );
  return rows.map((r) => r.value);
}

async function loadReservation(client, reservationId) {
  const { rows } = await client.query('SELECT * FROM reservations WHERE id = $1', [reservationId]);
  if (rows.length === 0) throw new DomainError('reservation_not_found', 'Reservation introuvable.');
  return rows[0];
}

function assertTransition(from, to) {
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) throw new InvalidTransitionError(from, to);
}

/** Confirme une reservation dont l'acompte vient d'etre encaisse. */
export async function confirmPayment(client, { reservationId, paymentIntentId = null, actorUserId = null }) {
  const reservation = await loadReservation(client, reservationId);
  assertTransition(reservation.status, 'confirmed');

  // Le hold devient une occupation ferme : plus d'expiration.
  const { rowCount } = await client.query(
    `UPDATE table_occupancies
        SET kind = 'reservation', expires_at = NULL
      WHERE reservation_id = $1 AND is_active`,
    [reservationId],
  );
  if (rowCount === 0) {
    // Le hold avait expire et la table est repartie : on ne confirme pas
    // une reservation sans table, meme si le paiement a abouti.
    throw new TableUnavailableError({ reservationId, cause: 'le maintien de table a expire' });
  }

  await client.query(`UPDATE reservations SET status = 'confirmed' WHERE id = $1`, [reservationId]);
  await recordStatus(client, {
    tenantId: reservation.tenant_id, reservationId, from: reservation.status, to: 'confirmed',
    actorKind: actorUserId ? 'user' : 'system', actorUserId, reason: 'acompte encaisse',
  });
  await emit(client, {
    tenantId: reservation.tenant_id, restaurantId: reservation.restaurant_id,
    topic: 'reservation.confirmed',
    payload: { reservationId, reference: reservation.reference, paymentIntentId },
  });
  return { ...reservation, status: 'confirmed' };
}

/** Annulation : libere immediatement les tables pour le service. */
export async function cancelReservation(client, { reservationId, reason = null, by = 'guest', actorUserId = null }) {
  const reservation = await loadReservation(client, reservationId);
  assertTransition(reservation.status, 'cancelled');

  const { rows: released } = await client.query(
    `UPDATE table_occupancies SET is_active = false, released_at = now()
      WHERE reservation_id = $1 AND is_active
      RETURNING table_id`,
    [reservationId],
  );

  await client.query(
    `UPDATE reservations
        SET status = 'cancelled', cancelled_at = now(),
            cancellation_reason = $2, cancelled_by = $3
      WHERE id = $1`,
    [reservationId, reason, by],
  );
  await freeTableStatuses(client, released.map((r) => r.table_id));

  await recordStatus(client, {
    tenantId: reservation.tenant_id, reservationId, from: reservation.status, to: 'cancelled',
    actorKind: by === 'guest' ? 'user' : by, actorUserId, reason,
  });
  await emit(client, {
    tenantId: reservation.tenant_id, restaurantId: reservation.restaurant_id,
    topic: 'reservation.cancelled',
    payload: {
      reservationId, reference: reservation.reference,
      startsAt: reservation.starts_at, partySize: reservation.party_size,
      freedTableIds: released.map((r) => r.table_id), reason, by,
    },
  });
  return released.map((r) => r.table_id);
}

/** No-show : libere la table et alimente le CRM. */
export async function markNoShow(client, { reservationId, actorUserId = null }) {
  const reservation = await loadReservation(client, reservationId);
  assertTransition(reservation.status, 'no_show');

  const { rows: released } = await client.query(
    `UPDATE table_occupancies SET is_active = false, released_at = now()
      WHERE reservation_id = $1 AND is_active RETURNING table_id`,
    [reservationId],
  );
  await client.query(
    `UPDATE reservations SET status = 'no_show', no_show_at = now() WHERE id = $1`,
    [reservationId],
  );
  await freeTableStatuses(client, released.map((r) => r.table_id));

  if (reservation.guest_id) {
    await client.query(
      `INSERT INTO guest_restaurant_stats (tenant_id, guest_id, restaurant_id, no_shows)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (guest_id, restaurant_id)
       DO UPDATE SET no_shows = guest_restaurant_stats.no_shows + 1, updated_at = now()`,
      [reservation.tenant_id, reservation.guest_id, reservation.restaurant_id],
    );
  }

  await recordStatus(client, {
    tenantId: reservation.tenant_id, reservationId, from: reservation.status, to: 'no_show',
    actorKind: actorUserId ? 'user' : 'system', actorUserId,
  });
  await emit(client, {
    tenantId: reservation.tenant_id, restaurantId: reservation.restaurant_id,
    topic: 'reservation.no_show',
    payload: { reservationId, guestId: reservation.guest_id, freedTableIds: released.map((r) => r.table_id) },
  });
  return released.map((r) => r.table_id);
}

/** Installation du client a table. */
export async function seatReservation(client, { reservationId, actorUserId = null, now = new Date() }) {
  const reservation = await loadReservation(client, reservationId);
  assertTransition(reservation.status, 'seated');

  await client.query(
    `UPDATE reservations
        SET status = 'seated', seated_at = $2,
            arrived_at = COALESCE(arrived_at, $2)
      WHERE id = $1`,
    [reservationId, now],
  );

  // Arrivee en avance : la table est prise des maintenant, pas a l'heure
  // prevue. On avance donc le debut de l'occupation, sinon le plan de
  // salle afficherait « libre » une table ou des clients sont assis.
  // Si ce creneau anterieur appartient deja a quelqu'un d'autre, on
  // conserve l'intervalle initial : on ne prend pas la place d'un tiers.
  await client.query('SAVEPOINT extend_occupancy');
  try {
    await client.query(
      `UPDATE table_occupancies
          SET occupied_during = tstzrange($2, upper(occupied_during), '[)')
        WHERE reservation_id = $1 AND is_active AND lower(occupied_during) > $2`,
      [reservationId, now],
    );
    await client.query('RELEASE SAVEPOINT extend_occupancy');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT extend_occupancy');
    await client.query('RELEASE SAVEPOINT extend_occupancy');
    if (error.code !== PG_EXCLUSION_VIOLATION) throw error;
  }
  const { rows: tables } = await client.query(
    `UPDATE restaurant_tables SET live_status = 'seated'
      WHERE id IN (SELECT table_id FROM table_occupancies
                    WHERE reservation_id = $1 AND is_active)
      RETURNING id`,
    [reservationId],
  );

  await recordStatus(client, {
    tenantId: reservation.tenant_id, reservationId, from: reservation.status, to: 'seated',
    actorKind: actorUserId ? 'user' : 'system', actorUserId,
  });
  await emit(client, {
    tenantId: reservation.tenant_id, restaurantId: reservation.restaurant_id,
    topic: 'reservation.seated',
    payload: { reservationId, guestId: reservation.guest_id, tableIds: tables.map((t) => t.id) },
  });
  return tables.map((t) => t.id);
}

/** Fin de repas : la table repasse en nettoyage puis disponible. */
export async function completeReservation(client, { reservationId, actorUserId = null, now = new Date() }) {
  const reservation = await loadReservation(client, reservationId);
  assertTransition(reservation.status, 'completed');

  const { rows: released } = await client.query(
    `UPDATE table_occupancies SET is_active = false, released_at = $2
      WHERE reservation_id = $1 AND is_active RETURNING table_id`,
    [reservationId, now],
  );
  await client.query(
    `UPDATE reservations SET status = 'completed', completed_at = $2 WHERE id = $1`,
    [reservationId, now],
  );
  await client.query(
    `UPDATE restaurant_tables SET live_status = 'cleaning' WHERE id = ANY($1::uuid[])`,
    [released.map((r) => r.table_id)],
  );

  if (reservation.guest_id) {
    await client.query(
      `INSERT INTO guest_restaurant_stats
         (tenant_id, guest_id, restaurant_id, visits, covers, first_visit_at, last_visit_at)
       VALUES ($1, $2, $3, 1, $4, $5, $5)
       ON CONFLICT (guest_id, restaurant_id) DO UPDATE SET
         visits = guest_restaurant_stats.visits + 1,
         covers = guest_restaurant_stats.covers + EXCLUDED.covers,
         first_visit_at = LEAST(guest_restaurant_stats.first_visit_at, EXCLUDED.first_visit_at),
         last_visit_at = GREATEST(guest_restaurant_stats.last_visit_at, EXCLUDED.last_visit_at),
         updated_at = now()`,
      [reservation.tenant_id, reservation.guest_id, reservation.restaurant_id, reservation.party_size, now],
    );
  }

  await recordStatus(client, {
    tenantId: reservation.tenant_id, reservationId, from: reservation.status, to: 'completed',
    actorKind: actorUserId ? 'user' : 'system', actorUserId,
  });
  await emit(client, {
    tenantId: reservation.tenant_id, restaurantId: reservation.restaurant_id,
    topic: 'reservation.completed',
    payload: { reservationId, guestId: reservation.guest_id, freedTableIds: released.map((r) => r.table_id) },
  });
  return released.map((r) => r.table_id);
}

/**
 * Deplace une reservation : autre horaire, autre table, ou les deux.
 * L'ancienne occupation n'est liberee qu'une fois la nouvelle acquise :
 * un deplacement qui echoue ne fait jamais perdre la table d'origine.
 */
export async function moveReservation(client, input) {
  const {
    reservationId, startsAt = null, durationMinutes = null,
    tableIds = null, actorUserId = null, now = new Date(),
  } = input;

  const reservation = await loadReservation(client, reservationId);
  if (['cancelled', 'no_show', 'completed'].includes(reservation.status)) {
    throw new InvalidTransitionError(reservation.status, 'moved');
  }
  const restaurant = await getRestaurant(client, reservation.restaurant_id);
  const period = await findServicePeriodFor(client, {
    restaurantId: reservation.restaurant_id,
    timeZone: restaurant.timezone,
    startsAt: startsAt ?? reservation.starts_at,
  });
  const turnBuffer = period?.turn_buffer_minutes ?? DEFAULTS.turnBufferMinutes;

  const newStart = startsAt ?? reservation.starts_at;
  const newDuration = durationMinutes ?? reservation.duration_minutes;
  const newEnd = addMinutes(newStart, newDuration);
  const newOccupancyEnd = addMinutes(newEnd, turnBuffer);

  const { rows: current } = await client.query(
    `SELECT id, table_id FROM table_occupancies WHERE reservation_id = $1 AND is_active`,
    [reservationId],
  );
  const currentTableIds = current.map((r) => r.table_id);
  const targetTableIds = tableIds ?? currentTableIds;

  // On libere d'abord dans la transaction pour ne pas entrer en conflit
  // avec soi-meme ; un echec ci-dessous annule tout le deplacement.
  await client.query(
    `UPDATE table_occupancies SET is_active = false, released_at = now()
      WHERE reservation_id = $1 AND is_active`,
    [reservationId],
  );

  try {
    for (const tableId of targetTableIds) {
      await client.query(
        `INSERT INTO table_occupancies
           (tenant_id, restaurant_id, table_id, reservation_id, kind, occupied_during)
         VALUES ($1,$2,$3,$4,'reservation',tstzrange($5,$6,'[)'))`,
        [reservation.tenant_id, reservation.restaurant_id, tableId, reservationId, newStart, newOccupancyEnd],
      );
    }
  } catch (error) {
    if (error.code === PG_EXCLUSION_VIOLATION) {
      throw new TableUnavailableError({
        reservationId, tableIds: targetTableIds,
        cause: 'creneau deja occupe pour ces tables',
      });
    }
    throw error;
  }

  await client.query(
    `UPDATE reservations SET starts_at = $2, duration_minutes = $3 WHERE id = $1`,
    [reservationId, newStart, newDuration],
  );
  await client.query(
    `UPDATE restaurant_tables SET live_status = 'available'
      WHERE id = ANY($1::uuid[]) AND live_status = 'reserved'`,
    [currentTableIds.filter((id) => !targetTableIds.includes(id))],
  );

  await emit(client, {
    tenantId: reservation.tenant_id, restaurantId: reservation.restaurant_id,
    topic: 'reservation.moved',
    payload: {
      reservationId, reference: reservation.reference,
      from: { startsAt: reservation.starts_at, tableIds: currentTableIds },
      to: { startsAt: newStart, tableIds: targetTableIds },
      movedBy: actorUserId ?? 'system', at: now.toISOString(),
    },
  });

  return { reservationId, startsAt: newStart, durationMinutes: newDuration, tableIds: targetTableIds };
}

/** Walk-in : le client est deja la, on cherche une table tout de suite. */
export async function seatWalkIn(client, input) {
  const created = await createReservation(client, {
    ...input, source: 'walk_in', skipDeposit: true,
    startsAt: input.startsAt ?? input.now ?? new Date(),
  });
  await seatReservation(client, {
    reservationId: created.reservation.id,
    actorUserId: input.createdByUserId ?? null,
    now: input.now ?? new Date(),
  });
  return created;
}

/** Remet les tables liberees a disposition si rien d'autre ne les occupe. */
async function freeTableStatuses(client, tableIds) {
  if (tableIds.length === 0) return;
  await client.query(
    `UPDATE restaurant_tables t
        SET live_status = 'available'
      WHERE t.id = ANY($1::uuid[])
        AND t.live_status IN ('reserved', 'guest_expected')
        AND NOT EXISTS (
          SELECT 1 FROM table_occupancies o
           WHERE o.table_id = t.id AND o.is_active
             AND o.occupied_during @> now())`,
    [tableIds],
  );
}
