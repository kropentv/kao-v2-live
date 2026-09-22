#!/usr/bin/env node
/**
 * Jeu de demonstration : un restaurant complet, credible, sur lequel on
 * peut lancer une demo ou un scenario de test manuel.
 */
import pg from 'pg';
import { config } from '../config.js';
import { withTenant } from './pool.js';
import { createReservation } from '../domain/reservation-engine.js';
import { tryAssignServer } from '../services/assignment.js';
import { hashPassword } from '../services/auth.js';
import { utcToZonedParts, zonedTimeToUtc } from '../lib/time.js';

export const DEMO_PASSWORD = 'demo-orsyne-2026';

const TEAM = [
  { email: 'patron@orsyne.demo',  name: 'Camille Durand', role: 'owner' },
  { email: 'manager@orsyne.demo', name: 'Inès Bertrand',  role: 'manager' },
  { email: 'lucas@orsyne.demo',   name: 'Lucas Perrin',   role: 'server', zones: ['Salle'] },
  { email: 'sarah@orsyne.demo',   name: 'Sarah Nguyen',   role: 'server', zones: ['Terrasse', 'Bar'] },
  { email: 'hugo@orsyne.demo',    name: 'Hugo Mercier',   role: 'server', zones: ['Salle'] },
];

const TABLES = [
  // Salle principale
  { code: 'T1', zone: 'Salle', seats: 2, x: 1, y: 1, attributes: ['window'] },
  { code: 'T2', zone: 'Salle', seats: 2, x: 3, y: 1, attributes: ['window'] },
  { code: 'T3', zone: 'Salle', seats: 4, x: 5, y: 1 },
  { code: 'T4', zone: 'Salle', seats: 4, x: 1, y: 4 },
  { code: 'T5', zone: 'Salle', seats: 6, x: 4, y: 4 },
  { code: 'T6', zone: 'Salle', seats: 4, x: 7, y: 4, combinable: true },
  { code: 'T7', zone: 'Salle', seats: 4, x: 9, y: 4, combinable: true },
  // Terrasse
  { code: 'TE1', zone: 'Terrasse', seats: 2, x: 1, y: 8, attributes: ['outdoor'] },
  { code: 'TE2', zone: 'Terrasse', seats: 4, x: 3, y: 8, attributes: ['outdoor'] },
  { code: 'TE3', zone: 'Terrasse', seats: 4, x: 6, y: 8, attributes: ['outdoor', 'quiet'] },
  // Bar
  { code: 'B1', zone: 'Bar', seats: 2, x: 11, y: 1, attributes: ['counter'] },
  { code: 'B2', zone: 'Bar', seats: 2, x: 12, y: 1, attributes: ['counter'] },
  // Salon prive
  { code: 'SP1', zone: 'Salon privé', seats: 12, x: 11, y: 7, attributes: ['private'] },
];

const ZONES = [
  { name: 'Salle', kind: 'dining_room', selectable: true },
  { name: 'Terrasse', kind: 'terrace', selectable: true },
  { name: 'Bar', kind: 'bar', selectable: true },
  { name: 'Salon privé', kind: 'private_room', selectable: false },
];

const GUESTS = [
  { first: 'Thomas', last: 'Martin', phone: '+33612345001', locale: 'fr-FR',
    prefs: [['zone', 'outdoor', false], ['dish', 'Entrecôte', false]], visits: 9 },
  { first: 'Alice', last: 'Dubois', phone: '+33612345002', locale: 'fr-FR',
    prefs: [['allergy', 'Fruits à coque', true]], visits: 4 },
  { first: 'Sofia', last: 'Rossi', phone: '+39331234503', locale: 'it-IT',
    prefs: [['table', 'window', false]], visits: 2 },
  { first: 'James', last: 'Carter', phone: '+447700900004', locale: 'en-GB',
    prefs: [['diet', 'Végétarien', false]], visits: 1 },
];

export async function seed({ connectionString = config.adminDatabaseUrl, log = console.log } = {}) {
  const db = new pg.Client({ connectionString });
  await db.connect();
  await db.query('SET search_path = public, orsyne_core');

  try {
    const existing = await db.query(`SELECT id FROM tenants WHERE slug = 'demo'`);
    if (existing.rows.length > 0) {
      log('Jeu de demonstration deja present (tenant "demo").');
      return existing.rows[0].id;
    }

    const { rows: [tenant] } = await db.query(
      `INSERT INTO tenants (name, slug, plan) VALUES ('Groupe Démo', 'demo', 'pro') RETURNING *`);
    const { rows: [restaurant] } = await db.query(
      `INSERT INTO restaurants (tenant_id, name, slug, timezone, city, country_code, phone_e164)
       VALUES ($1, 'Le Comptoir Démo', 'comptoir-demo', 'Europe/Paris', 'Paris', 'FR', '+33140000000')
       RETURNING *`, [tenant.id]);

    const zoneIds = {};
    for (const [index, zone] of ZONES.entries()) {
      const { rows: [row] } = await db.query(
        `INSERT INTO zones (tenant_id, restaurant_id, name, kind, guest_selectable, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [tenant.id, restaurant.id, zone.name, zone.kind, zone.selectable, index]);
      zoneIds[zone.name] = row.id;
    }

    const tableIds = {};
    for (const t of TABLES) {
      const { rows: [row] } = await db.query(
        `INSERT INTO restaurant_tables
           (tenant_id, restaurant_id, zone_id, code, seats_min, seats_max,
            pos_x, pos_y, guest_selectable, combinable, attributes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10) RETURNING id`,
        [tenant.id, restaurant.id, zoneIds[t.zone], t.code,
         Math.max(1, t.seats - 2), t.seats, t.x, t.y, t.combinable ?? false, t.attributes ?? []]);
      tableIds[t.code] = row.id;
    }

    // T6 + T7 accueillent les groupes de 5 a 8.
    const { rows: [combo] } = await db.query(
      `INSERT INTO table_combinations (tenant_id, restaurant_id, name, seats_min, seats_max)
       VALUES ($1,$2,'T6 + T7',5,8) RETURNING id`, [tenant.id, restaurant.id]);
    for (const code of ['T6', 'T7']) {
      await db.query(
        `INSERT INTO table_combination_members (tenant_id, combination_id, table_id)
         VALUES ($1,$2,$3)`, [tenant.id, combo.id, tableIds[code]]);
    }

    for (const service of [
      { name: 'Déjeuner', days: [2, 3, 4, 5, 6], from: '12:00', to: '14:30', duration: 75 },
      { name: 'Dîner', days: [2, 3, 4, 5, 6], from: '19:00', to: '23:00', duration: 105 },
    ]) {
      await db.query(
        `INSERT INTO service_periods
           (tenant_id, restaurant_id, name, days_of_week, starts_at, ends_at,
            last_seating_offset_minutes, default_duration_minutes, turn_buffer_minutes)
         VALUES ($1,$2,$3,$4,$5,$6,60,$7,15)`,
        [tenant.id, restaurant.id, service.name, service.days, service.from, service.to, service.duration]);
    }

    // Acompte : uniquement sur les groupes et le salon prive.
    await db.query(
      `INSERT INTO deposit_policies
         (tenant_id, restaurant_id, name, party_size_min, mechanism, amount_mode, amount_cents, priority)
       VALUES ($1,$2,'Groupes à partir de 8',8,'deposit','per_person',1500,10)`,
      [tenant.id, restaurant.id]);
    await db.query(
      `INSERT INTO deposit_policies
         (tenant_id, restaurant_id, name, zone_id, mechanism, amount_mode, amount_cents, priority)
       VALUES ($1,$2,'Salon privé',$3,'full_payment','per_person',6500,5)`,
      [tenant.id, restaurant.id, zoneIds['Salon privé']]);

    // Vendredi et samedi soir : empreinte bancaire, pas d'encaissement.
    await db.query(
      `INSERT INTO deposit_policies
         (tenant_id, restaurant_id, name, days_of_week, time_from, mechanism,
          amount_mode, amount_cents, priority)
       VALUES ($1,$2,'Week-end soir',ARRAY[5,6],'19:00','preauthorization','per_person',2000,20)`,
      [tenant.id, restaurant.id]);

    for (const guest of GUESTS) {
      const { rows: [row] } = await db.query(
        `INSERT INTO guests (tenant_id, first_name, last_name, phone_e164, locale)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [tenant.id, guest.first, guest.last, guest.phone, guest.locale]);
      for (const [kind, value, critical] of guest.prefs) {
        await db.query(
          `INSERT INTO guest_preferences (tenant_id, guest_id, kind, value, source, is_critical)
           VALUES ($1,$2,$3,$4,'guest_declared',$5)`,
          [tenant.id, row.id, kind, value, critical]);
      }
      await db.query(
        `INSERT INTO guest_restaurant_stats
           (tenant_id, guest_id, restaurant_id, visits, covers, last_visit_at)
         VALUES ($1,$2,$3,$4,$5, now() - interval '3 weeks')`,
        [tenant.id, row.id, restaurant.id, guest.visits, guest.visits * 2]);
      // Un fait mesure, et la deduction qui en decoule : jamais confondus.
      if (guest.first === 'Thomas') {
        const { rows: [fact] } = await db.query(
          `INSERT INTO guest_facts (tenant_id, guest_id, restaurant_id, subject, occurrences)
           VALUES ($1,$2,$3,'dish:Entrecôte',5) RETURNING id`,
          [tenant.id, row.id, restaurant.id]);
        await db.query(
          `INSERT INTO guest_insights
             (tenant_id, guest_id, restaurant_id, statement, confidence, evidence_fact_ids, model)
           VALUES ($1,$2,$3,'Semble apprécier l''entrecôte et commande souvent une bouteille de rouge avec.',
                   0.82, ARRAY[$4::uuid], 'seed')`,
          [tenant.id, row.id, restaurant.id, fact.id]);
      }
    }

    // --- Equipe, avec des shifts couvrant le service du soir ---------
    const passwordHash = await hashPassword(DEMO_PASSWORD);
    const userIds = {};
    for (const member of TEAM) {
      const { rows: [user] } = await db.query(
        `INSERT INTO users (tenant_id, email, password_hash, full_name, status)
         VALUES ($1,$2,$3,$4,'active') RETURNING id`,
        [tenant.id, member.email, passwordHash, member.name]);
      userIds[member.email] = user.id;

      await db.query(
        `INSERT INTO memberships (tenant_id, user_id, restaurant_id, role)
         VALUES ($1,$2,$3,$4)`,
        // Le proprietaire est rattache au tenant, pas a un etablissement :
        // il couvrira automatiquement les futurs restaurants du groupe.
        [tenant.id, user.id, member.role === 'owner' ? null : restaurant.id, member.role]);

      if (member.role === 'server') {
        await db.query(
          `INSERT INTO staff_profiles (tenant_id, user_id, restaurant_id, max_tables, max_covers)
           VALUES ($1,$2,$3,6,24)`,
          [tenant.id, user.id, restaurant.id]);

        const { rows: [shift] } = await db.query(
          `INSERT INTO shifts (tenant_id, restaurant_id, user_id, starts_at, ends_at, role, status)
           VALUES ($1,$2,$3, now() - interval '2 hours', now() + interval '10 hours',
                   'server', 'clocked_in')
           RETURNING id`,
          [tenant.id, restaurant.id, user.id]);

        for (const zoneName of member.zones ?? []) {
          await db.query(
            `INSERT INTO shift_zones (tenant_id, shift_id, zone_id) VALUES ($1,$2,$3)`,
            [tenant.id, shift.id, zoneIds[zoneName]]);
        }
      }
    }

    log(`Tenant demo cree : ${tenant.id}`);
    log(`Restaurant : ${restaurant.name} (${restaurant.id})`);
    log(`${TABLES.length} tables, ${ZONES.length} zones, ${GUESTS.length} clients, ${TEAM.length} membres d'equipe.`);
    return { tenantId: tenant.id, restaurantId: restaurant.id, slug: restaurant.slug };
  } finally {
    await db.end();
  }
}

/**
 * Reservations placees sur le PROCHAIN SERVICE REEL du restaurant.
 *
 * On ne force jamais un creneau : la demo passe par le vrai moteur, donc
 * elle doit viser une plage que le restaurant ouvre effectivement. Sinon
 * le jeu de donnees ne prouve rien — il montre juste des refus.
 */
export async function seedReservations({ tenantId, restaurantId, log = console.log }) {
  const context = await withTenant({ tenantId }, async (client) => ({
    guests: (await client.query('SELECT id FROM guests ORDER BY created_at LIMIT 4')).rows,
    restaurant: (await client.query(
      'SELECT timezone FROM restaurants WHERE id = $1', [restaurantId])).rows[0],
    periods: (await client.query(
      `SELECT name, days_of_week, starts_at, ends_at, last_seating_offset_minutes
         FROM service_periods WHERE restaurant_id = $1 AND is_active
         ORDER BY starts_at`, [restaurantId])).rows,
  }));

  const target = nextServiceOccurrence(context);
  if (!target) {
    log('Aucun service ouvert dans les 14 prochains jours : aucune reservation creee.');
    return { created: 0 };
  }

  const parties = [2, 4, 2, 6, 4, 2];
  const sources = ['widget', 'phone_ai', 'widget', 'staff', 'widget', 'phone_ai'];
  let created = 0;

  for (const [index, party] of parties.entries()) {
    // Etale les arrivees par quart d'heure, comme un vrai service.
    const startsAt = new Date(target.opensAt.getTime() + (index * 15 + 30) * 60_000);
    if (startsAt > target.lastSeatingAt) break;
    try {
      await withTenant({ tenantId }, async (client) => {
        const result = await createReservation(client, {
          restaurantId,
          partySize: party,
          startsAt,
          guestId: context.guests[index % context.guests.length]?.id ?? null,
          source: sources[index],
          skipDeposit: true,
        });
        await tryAssignServer(client, { restaurantId, reservationId: result.reservation.id });
      });
      created += 1;
    } catch (error) {
      log(`  ${startsAt.toISOString()} — ${error.message}`);
    }
  }

  const label = target.opensAt.toLocaleString('fr-FR', {
    timeZone: context.restaurant.timezone,
    weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
  });
  log(`${created} reservation(s) creee(s) — service « ${target.name} » du ${label}.`);
  return { created, date: target.isoDate };
}

/** Premiere plage de service ouverte dans les 14 prochains jours. */
function nextServiceOccurrence({ restaurant, periods }) {
  const timeZone = restaurant.timezone;
  const now = new Date();

  for (let offset = 0; offset < 14; offset += 1) {
    const day = new Date(now.getTime() + offset * 86_400_000);
    const parts = utcToZonedParts(day, timeZone);
    const isoDate = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;

    for (const period of periods) {
      if (!period.days_of_week.includes(parts.dayOfWeek)) continue;
      const [openHour, openMinute] = period.starts_at.split(':').map(Number);
      const [closeHour, closeMinute] = period.ends_at.split(':').map(Number);

      const opensAt = zonedTimeToUtc(
        { year: parts.year, month: parts.month, day: parts.day, hour: openHour, minute: openMinute },
        timeZone);
      const closesAt = zonedTimeToUtc(
        { year: parts.year, month: parts.month, day: parts.day, hour: closeHour, minute: closeMinute },
        timeZone);
      const lastSeatingAt = new Date(
        closesAt.getTime() - period.last_seating_offset_minutes * 60_000);

      // Un service deja commence n'est pas rejoue : on vise la suite.
      if (lastSeatingAt <= now) continue;
      return { name: period.name, opensAt: opensAt > now ? opensAt : now, lastSeatingAt, isoDate };
    }
  }
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await seed();
  if (typeof result === 'object') {
    const seeded = await seedReservations(result);
    console.log('');
    if (seeded?.date) console.log(`  Service de demonstration : ${seeded.date}`);
    console.log('  Widget client   http://localhost:3000/r/' + result.slug);
    console.log('  Dashboard       http://localhost:3000/app/');
    console.log('  App de salle    http://localhost:3000/app/salle.html');
    console.log('');
    console.log('  Comptes de demonstration (mot de passe : ' + DEMO_PASSWORD + ')');
    for (const member of TEAM) console.log(`    ${member.role.padEnd(8)} ${member.email}`);
    const { closePool } = await import('./pool.js');
    await closePool();
  }
}
