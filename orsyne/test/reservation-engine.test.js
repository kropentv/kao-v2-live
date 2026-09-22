import test from 'node:test';
import assert from 'node:assert/strict';
import { after, before } from 'node:test';

import { ensureSchema, createFixture, eveningAt, admin, closePool } from './helpers/db.js';
import { withTenant } from '../src/db/pool.js';
import {
  createReservation, cancelReservation, markNoShow, seatReservation,
  completeReservation, moveReservation, confirmPayment,
} from '../src/domain/reservation-engine.js';
import { listSlots } from '../src/domain/availability.js';
import { NoAvailabilityError, TableUnavailableError } from '../src/domain/errors.js';
import { zonedTimeToUtc } from '../src/lib/time.js';

before(async () => { await ensureSchema(); });
after(async () => { await closePool(); });

const PARIS = 'Europe/Paris';
const at = (hour, minute = 0, daysFromNow = 7) =>
  zonedTimeToUtc(eveningAt(hour, minute, daysFromNow), PARIS);

test('une reservation simple obtient la table la mieux dimensionnee', async () => {
  const fx = await createFixture();
  const result = await withTenant({ tenantId: fx.tenantId }, (client) =>
    createReservation(client, {
      restaurantId: fx.restaurantId, partySize: 4, startsAt: at(20),
    }));

  assert.equal(result.reservation.status, 'confirmed');
  assert.equal(result.tableIds.length, 1);
  // 4 personnes : la table de 4, pas celle de 6.
  assert.equal(result.tableIds[0], fx.tables.T2.id, 'doit choisir T2 (4 places)');
  assert.match(result.reservation.reference, /^[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}$/);
});

test('deux clients ne peuvent jamais obtenir la meme table', async () => {
  // Restaurant a table unique : toute concurrence porte sur la meme ressource.
  const fx = await createFixture({ tables: [{ code: 'UNIQUE', seats_max: 4 }] });
  const startsAt = at(20);
  const ATTEMPTS = 25;

  const outcomes = await Promise.allSettled(
    Array.from({ length: ATTEMPTS }, (_, i) =>
      withTenant({ tenantId: fx.tenantId }, (client) =>
        createReservation(client, {
          restaurantId: fx.restaurantId, partySize: 2, startsAt,
          guestNotes: `tentative ${i}`,
        }))),
  );

  const granted = outcomes.filter((o) => o.status === 'fulfilled');
  const refused = outcomes.filter((o) => o.status === 'rejected');

  assert.equal(granted.length, 1, `exactement une reservation doit aboutir (obtenu ${granted.length})`);
  assert.equal(refused.length, ATTEMPTS - 1);
  for (const outcome of refused) {
    assert.ok(
      outcome.reason instanceof NoAvailabilityError,
      `refus attendu pour indisponibilite, recu: ${outcome.reason?.name} ${outcome.reason?.message}`,
    );
  }

  // Verification independante du moteur : la base elle-meme ne contient
  // qu'une seule occupation active sur ce creneau.
  const active = await admin((db) => db.query(
    `SELECT count(*)::int AS n FROM table_occupancies
      WHERE table_id = $1 AND is_active`,
    [fx.tables.UNIQUE.id],
  ));
  assert.equal(active.rows[0].n, 1);

  const confirmed = await admin((db) => db.query(
    `SELECT count(*)::int AS n FROM reservations
      WHERE restaurant_id = $1 AND status = 'confirmed'`,
    [fx.restaurantId],
  ));
  assert.equal(confirmed.rows[0].n, 1);
});

test('la concurrence repartit les clients sur les tables disponibles sans collision', async () => {
  const fx = await createFixture({
    tables: [
      { code: 'A', seats_max: 4 }, { code: 'B', seats_max: 4 },
      { code: 'C', seats_max: 4 }, { code: 'D', seats_max: 4 },
    ],
  });
  const startsAt = at(20);

  const outcomes = await Promise.allSettled(
    Array.from({ length: 12 }, () =>
      withTenant({ tenantId: fx.tenantId }, (client) =>
        createReservation(client, { restaurantId: fx.restaurantId, partySize: 3, startsAt }))),
  );

  const granted = outcomes.filter((o) => o.status === 'fulfilled');
  assert.equal(granted.length, 4, 'les 4 tables doivent etre attribuees, ni plus ni moins');

  const assignedTables = granted.flatMap((o) => o.value.tableIds);
  assert.equal(new Set(assignedTables).size, 4, 'aucune table attribuee deux fois');
});

test('la contrainte de base refuse un chevauchement meme insere a la main', async () => {
  const fx = await createFixture({ tables: [{ code: 'T1', seats_max: 4 }] });
  const startsAt = at(20);

  await withTenant({ tenantId: fx.tenantId }, (client) =>
    createReservation(client, { restaurantId: fx.restaurantId, partySize: 2, startsAt }));

  // Ecriture directe, en contournant tout le code metier.
  await assert.rejects(
    admin((db) => db.query(
      `INSERT INTO table_occupancies
         (tenant_id, restaurant_id, table_id, kind, occupied_during)
       VALUES ($1,$2,$3,'block',tstzrange($4,$5,'[)'))`,
      [fx.tenantId, fx.restaurantId, fx.tables.T1.id, startsAt, new Date(startsAt.getTime() + 3_600_000)],
    )),
    (error) => error.code === '23P01',
    "la contrainte d'exclusion doit rejeter le chevauchement",
  );
});

test('deux services consecutifs sur la meme table sont acceptes', async () => {
  // 19h00 + 90 min + 15 min de battement = 20h45 : 21h00 doit passer.
  const fx = await createFixture({ tables: [{ code: 'T1', seats_max: 4 }] });

  const first = await withTenant({ tenantId: fx.tenantId }, (client) =>
    createReservation(client, { restaurantId: fx.restaurantId, partySize: 2, startsAt: at(19, 0) }));
  const second = await withTenant({ tenantId: fx.tenantId }, (client) =>
    createReservation(client, { restaurantId: fx.restaurantId, partySize: 2, startsAt: at(21, 0) }));

  assert.deepEqual(first.tableIds, second.tableIds, 'la table doit tourner');
});

test('le battement de remise en place est respecte', async () => {
  // 20h30 tombe pendant le battement de la reservation de 19h00.
  const fx = await createFixture({ tables: [{ code: 'T1', seats_max: 4 }] });

  await withTenant({ tenantId: fx.tenantId }, (client) =>
    createReservation(client, { restaurantId: fx.restaurantId, partySize: 2, startsAt: at(19, 0) }));

  await assert.rejects(
    withTenant({ tenantId: fx.tenantId }, (client) =>
      createReservation(client, { restaurantId: fx.restaurantId, partySize: 2, startsAt: at(20, 30) })),
    NoAvailabilityError,
  );
});

test('une annulation libere immediatement la table', async () => {
  const fx = await createFixture({ tables: [{ code: 'T1', seats_max: 4 }] });
  const startsAt = at(20);

  const first = await withTenant({ tenantId: fx.tenantId }, (client) =>
    createReservation(client, { restaurantId: fx.restaurantId, partySize: 2, startsAt }));

  await assert.rejects(
    withTenant({ tenantId: fx.tenantId }, (client) =>
      createReservation(client, { restaurantId: fx.restaurantId, partySize: 2, startsAt })),
    NoAvailabilityError,
  );

  const freed = await withTenant({ tenantId: fx.tenantId }, (client) =>
    cancelReservation(client, { reservationId: first.reservation.id, reason: 'imprevu' }));
  assert.deepEqual(freed, first.tableIds);

  const second = await withTenant({ tenantId: fx.tenantId }, (client) =>
    createReservation(client, { restaurantId: fx.restaurantId, partySize: 2, startsAt }));
  assert.deepEqual(second.tableIds, first.tableIds);
});

test('un no-show libere la table et incremente le compteur CRM', async () => {
  const fx = await createFixture({ tables: [{ code: 'T1', seats_max: 4 }] });
  const guestId = await admin(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO guests (tenant_id, first_name, last_name, phone_e164)
       VALUES ($1, 'Thomas', 'Martin', '+33600000001') RETURNING id`,
      [fx.tenantId],
    );
    return rows[0].id;
  });

  const booked = await withTenant({ tenantId: fx.tenantId }, (client) =>
    createReservation(client, {
      restaurantId: fx.restaurantId, partySize: 2, startsAt: at(20), guestId,
    }));

  await withTenant({ tenantId: fx.tenantId }, (client) =>
    markNoShow(client, { reservationId: booked.reservation.id }));

  const stats = await admin((db) => db.query(
    `SELECT no_shows FROM guest_restaurant_stats WHERE guest_id = $1 AND restaurant_id = $2`,
    [guestId, fx.restaurantId],
  ));
  assert.equal(stats.rows[0].no_shows, 1);

  // La table repart au service.
  const reused = await withTenant({ tenantId: fx.tenantId }, (client) =>
    createReservation(client, { restaurantId: fx.restaurantId, partySize: 2, startsAt: at(20) }));
  assert.deepEqual(reused.tableIds, booked.tableIds);
});

test('la zone demandee par le client est respectee quand elle est libre', async () => {
  const fx = await createFixture({
    tables: [
      { code: 'S1', seats_max: 4 },
      { code: 'TE1', seats_max: 4, zone: 'terrace' },
    ],
  });

  const result = await withTenant({ tenantId: fx.tenantId }, (client) =>
    createReservation(client, {
      restaurantId: fx.restaurantId, partySize: 4, startsAt: at(20),
      requestedZoneId: fx.zones.terrace,
    }));

  assert.deepEqual(result.tableIds, [fx.tables.TE1.id]);
  assert.match(result.allocation.reason, /zone demandee/);
});

test('une table explicitement demandee, deja prise, echoue sans substitution', async () => {
  const fx = await createFixture({
    tables: [{ code: 'T1', seats_max: 4 }, { code: 'T2', seats_max: 4 }],
  });
  const startsAt = at(20);

  await withTenant({ tenantId: fx.tenantId }, (client) =>
    createReservation(client, {
      restaurantId: fx.restaurantId, partySize: 2, startsAt,
      requestedTableId: fx.tables.T1.id,
    }));

  // T2 est libre, mais le client voulait T1 : on ne le deplace pas en silence.
  await assert.rejects(
    withTenant({ tenantId: fx.tenantId }, (client) =>
      createReservation(client, {
        restaurantId: fx.restaurantId, partySize: 2, startsAt,
        requestedTableId: fx.tables.T1.id,
      })),
    TableUnavailableError,
  );
});

test('un groupe trop grand pour une table utilise une combinaison', async () => {
  const fx = await createFixture({
    tables: [
      { code: 'C1', seats_max: 4, combinable: true },
      { code: 'C2', seats_max: 4, combinable: true },
    ],
  });
  await admin(async (db) => {
    const { rows: [combo] } = await db.query(
      `INSERT INTO table_combinations (tenant_id, restaurant_id, name, seats_min, seats_max)
       VALUES ($1, $2, 'C1+C2', 5, 8) RETURNING id`,
      [fx.tenantId, fx.restaurantId],
    );
    for (const code of ['C1', 'C2']) {
      await db.query(
        `INSERT INTO table_combination_members (tenant_id, combination_id, table_id)
         VALUES ($1, $2, $3)`,
        [fx.tenantId, combo.id, fx.tables[code].id],
      );
    }
  });

  const result = await withTenant({ tenantId: fx.tenantId }, (client) =>
    createReservation(client, { restaurantId: fx.restaurantId, partySize: 7, startsAt: at(20) }));

  assert.equal(result.tableIds.length, 2);
  assert.deepEqual(
    [...result.tableIds].sort(),
    [fx.tables.C1.id, fx.tables.C2.id].sort(),
  );
});

test('une combinaison occupee bloque ses tables individuellement', async () => {
  const fx = await createFixture({
    tables: [
      { code: 'C1', seats_max: 4, combinable: true },
      { code: 'C2', seats_max: 4, combinable: true },
    ],
  });
  await admin(async (db) => {
    const { rows: [combo] } = await db.query(
      `INSERT INTO table_combinations (tenant_id, restaurant_id, name, seats_min, seats_max)
       VALUES ($1, $2, 'C1+C2', 5, 8) RETURNING id`,
      [fx.tenantId, fx.restaurantId],
    );
    for (const code of ['C1', 'C2']) {
      await db.query(
        `INSERT INTO table_combination_members (tenant_id, combination_id, table_id)
         VALUES ($1, $2, $3)`,
        [fx.tenantId, combo.id, fx.tables[code].id],
      );
    }
  });
  const startsAt = at(20);

  await withTenant({ tenantId: fx.tenantId }, (client) =>
    createReservation(client, { restaurantId: fx.restaurantId, partySize: 7, startsAt }));

  // Les deux tables sont prises par la combinaison : plus rien de libre.
  await assert.rejects(
    withTenant({ tenantId: fx.tenantId }, (client) =>
      createReservation(client, { restaurantId: fx.restaurantId, partySize: 2, startsAt })),
    NoAvailabilityError,
  );
});

test('un acompte requis maintient la table puis la confirme au paiement', async () => {
  const fx = await createFixture({ tables: [{ code: 'T1', seats_max: 6 }] });
  await admin((db) => db.query(
    `INSERT INTO deposit_policies
       (tenant_id, restaurant_id, name, party_size_min, mechanism, amount_mode, amount_cents)
     VALUES ($1, $2, 'Groupes', 6, 'deposit', 'per_person', 1000)`,
    [fx.tenantId, fx.restaurantId],
  ));

  const result = await withTenant({ tenantId: fx.tenantId }, (client) =>
    createReservation(client, { restaurantId: fx.restaurantId, partySize: 6, startsAt: at(20) }));

  assert.equal(result.reservation.status, 'pending_payment');
  assert.equal(result.occupancy.kind, 'hold');
  assert.equal(result.deposit.mechanism, 'deposit');
  assert.equal(result.deposit.amountCents, 6000, '10 EUR par personne pour 6 couverts');

  // Le maintien bloque bien la table en attendant le paiement.
  await assert.rejects(
    withTenant({ tenantId: fx.tenantId }, (client) =>
      createReservation(client, { restaurantId: fx.restaurantId, partySize: 2, startsAt: at(20) })),
    NoAvailabilityError,
  );

  const confirmed = await withTenant({ tenantId: fx.tenantId }, (client) =>
    confirmPayment(client, { reservationId: result.reservation.id }));
  assert.equal(confirmed.status, 'confirmed');

  const occupancy = await admin((db) => db.query(
    `SELECT kind, expires_at FROM table_occupancies WHERE reservation_id = $1 AND is_active`,
    [result.reservation.id],
  ));
  assert.equal(occupancy.rows[0].kind, 'reservation');
  assert.equal(occupancy.rows[0].expires_at, null);
});

test('un maintien expire libere la table pour le client suivant', async () => {
  const fx = await createFixture({ tables: [{ code: 'T1', seats_max: 4 }] });
  await admin((db) => db.query(
    `INSERT INTO deposit_policies
       (tenant_id, restaurant_id, name, mechanism, amount_mode, amount_cents)
     VALUES ($1, $2, 'Acompte standard', 'deposit', 'fixed', 2000)`,
    [fx.tenantId, fx.restaurantId],
  ));

  const abandoned = await withTenant({ tenantId: fx.tenantId }, (client) =>
    createReservation(client, {
      restaurantId: fx.restaurantId, partySize: 2, startsAt: at(20), holdMinutes: 15,
    }));
  assert.equal(abandoned.reservation.status, 'pending_payment');

  // Le client ne paie jamais : on avance l'expiration comme le ferait le temps.
  await admin((db) => db.query(
    `UPDATE table_occupancies SET expires_at = now() - interval '1 minute'
      WHERE reservation_id = $1`,
    [abandoned.reservation.id],
  ));

  const next = await withTenant({ tenantId: fx.tenantId }, (client) =>
    createReservation(client, {
      restaurantId: fx.restaurantId, partySize: 2, startsAt: at(20), skipDeposit: true,
    }));
  assert.deepEqual(next.tableIds, abandoned.tableIds);

  const stale = await admin((db) => db.query(
    `SELECT status FROM reservations WHERE id = $1`, [abandoned.reservation.id],
  ));
  assert.equal(stale.rows[0].status, 'cancelled');
});

test('le cycle de service va de la reservation a la table nettoyee', async () => {
  const fx = await createFixture({ tables: [{ code: 'T1', seats_max: 4 }] });
  const guestId = await admin(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO guests (tenant_id, first_name, phone_e164)
       VALUES ($1, 'Alice', '+33600000002') RETURNING id`, [fx.tenantId]);
    return rows[0].id;
  });

  const booked = await withTenant({ tenantId: fx.tenantId }, (client) =>
    createReservation(client, {
      restaurantId: fx.restaurantId, partySize: 2, startsAt: at(20), guestId,
    }));

  await withTenant({ tenantId: fx.tenantId }, (client) =>
    seatReservation(client, { reservationId: booked.reservation.id }));
  let table = await admin((db) => db.query(
    `SELECT live_status FROM restaurant_tables WHERE id = $1`, [booked.tableIds[0]]));
  assert.equal(table.rows[0].live_status, 'seated');

  await withTenant({ tenantId: fx.tenantId }, (client) =>
    completeReservation(client, { reservationId: booked.reservation.id }));
  table = await admin((db) => db.query(
    `SELECT live_status FROM restaurant_tables WHERE id = $1`, [booked.tableIds[0]]));
  assert.equal(table.rows[0].live_status, 'cleaning');

  const stats = await admin((db) => db.query(
    `SELECT visits, covers FROM guest_restaurant_stats WHERE guest_id = $1`, [guestId]));
  assert.equal(stats.rows[0].visits, 1);
  assert.equal(stats.rows[0].covers, 2);
});

test('un deplacement vers une table occupee echoue sans perdre la table d origine', async () => {
  const fx = await createFixture({
    tables: [{ code: 'T1', seats_max: 4 }, { code: 'T2', seats_max: 4 }],
  });
  const startsAt = at(20);

  const a = await withTenant({ tenantId: fx.tenantId }, (client) =>
    createReservation(client, {
      restaurantId: fx.restaurantId, partySize: 2, startsAt,
      requestedTableId: fx.tables.T1.id,
    }));
  await withTenant({ tenantId: fx.tenantId }, (client) =>
    createReservation(client, {
      restaurantId: fx.restaurantId, partySize: 2, startsAt,
      requestedTableId: fx.tables.T2.id,
    }));

  await assert.rejects(
    withTenant({ tenantId: fx.tenantId }, (client) =>
      moveReservation(client, {
        reservationId: a.reservation.id, tableIds: [fx.tables.T2.id],
      })),
    TableUnavailableError,
  );

  // La transaction a ete annulee : la reservation garde T1.
  const held = await admin((db) => db.query(
    `SELECT table_id FROM table_occupancies WHERE reservation_id = $1 AND is_active`,
    [a.reservation.id],
  ));
  assert.equal(held.rows.length, 1);
  assert.equal(held.rows[0].table_id, fx.tables.T1.id);
});

test('un deplacement horaire valide conserve la reservation', async () => {
  const fx = await createFixture({ tables: [{ code: 'T1', seats_max: 4 }] });

  const booked = await withTenant({ tenantId: fx.tenantId }, (client) =>
    createReservation(client, { restaurantId: fx.restaurantId, partySize: 2, startsAt: at(19) }));

  const moved = await withTenant({ tenantId: fx.tenantId }, (client) =>
    moveReservation(client, { reservationId: booked.reservation.id, startsAt: at(21) }));

  assert.deepEqual(moved.tableIds, booked.tableIds);
  const row = await admin((db) => db.query(
    `SELECT starts_at FROM reservations WHERE id = $1`, [booked.reservation.id]));
  assert.equal(row.rows[0].starts_at.getTime(), at(21).getTime());
});

test('les creneaux proposes refletent les tables reellement libres', async () => {
  const fx = await createFixture({ tables: [{ code: 'T1', seats_max: 4 }] });
  const day = eveningAt(20, 0, 7);
  const isoDate = `${day.year}-${String(day.month).padStart(2, '0')}-${String(day.day).padStart(2, '0')}`;

  const before = await withTenant({ tenantId: fx.tenantId }, (client) =>
    listSlots(client, { restaurantId: fx.restaurantId, isoDate, partySize: 2 }));
  const slotAt20 = before.slots.find((s) => s.time === at(20).toISOString());
  assert.ok(slotAt20?.available, '20h00 doit etre disponible avant reservation');

  await withTenant({ tenantId: fx.tenantId }, (client) =>
    createReservation(client, { restaurantId: fx.restaurantId, partySize: 2, startsAt: at(20) }));

  const afterBooking = await withTenant({ tenantId: fx.tenantId }, (client) =>
    listSlots(client, { restaurantId: fx.restaurantId, isoDate, partySize: 2 }));
  const sameSlot = afterBooking.slots.find((s) => s.time === at(20).toISOString());
  assert.equal(sameSlot.available, false, '20h00 ne doit plus etre proposable');
  assert.equal(sameSlot.tablesLeft, 0);
});

test('un groupe plus grand que toutes les tables est refuse proprement', async () => {
  const fx = await createFixture({ tables: [{ code: 'T1', seats_max: 4 }] });
  await assert.rejects(
    withTenant({ tenantId: fx.tenantId }, (client) =>
      createReservation(client, { restaurantId: fx.restaurantId, partySize: 12, startsAt: at(20) })),
    (error) => error instanceof NoAvailabilityError && error.code === 'no_availability',
  );
});

test('une demande hors service est refusee pour le client, acceptee pour le personnel', async () => {
  const fx = await createFixture({ tables: [{ code: 'T1', seats_max: 4 }] });

  await assert.rejects(
    withTenant({ tenantId: fx.tenantId }, (client) =>
      createReservation(client, { restaurantId: fx.restaurantId, partySize: 2, startsAt: at(15) })),
    (error) => error.code === 'restaurant_closed',
  );

  // Le manager doit toujours pouvoir installer un client hors creneau.
  const staff = await withTenant({ tenantId: fx.tenantId }, (client) =>
    createReservation(client, {
      restaurantId: fx.restaurantId, partySize: 2, startsAt: at(15), source: 'staff',
    }));
  assert.equal(staff.reservation.status, 'confirmed');
});
