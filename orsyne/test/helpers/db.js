import pg from 'pg';
import { migrate } from '../../src/db/migrate.js';
import { getPool, closePool } from '../../src/db/pool.js';

const ADMIN_URL = process.env.ORSYNE_ADMIN_DATABASE_URL;
const APP_URL = process.env.ORSYNE_DATABASE_URL;

let migrated = false;

/** Applique le schema une seule fois pour toute la suite. */
export async function ensureSchema() {
  if (migrated) return;
  await migrate({ connectionString: ADMIN_URL, log: () => {} });
  migrated = true;
}

/** Connexion privilegiee, hors RLS : reservee a la preparation des fixtures. */
export async function admin(fn) {
  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export { getPool, closePool, APP_URL, ADMIN_URL };

/**
 * Cree un restaurant complet pret a tester : tenant, etablissement,
 * zones, tables et service du soir.
 */
export async function createFixture(options = {}) {
  const {
    slugPrefix = 'test',
    tables = [{ code: 'T1', seats_max: 2 }, { code: 'T2', seats_max: 4 }, { code: 'T3', seats_max: 6 }],
    timezone = 'Europe/Paris',
    servicePeriod = {
      name: 'Diner', days_of_week: [0, 1, 2, 3, 4, 5, 6],
      starts_at: '18:00', ends_at: '23:00',
      last_seating_offset_minutes: 60, default_duration_minutes: 90,
      turn_buffer_minutes: 15, slot_interval_minutes: 15,
    },
  } = options;

  const suffix = Math.random().toString(36).slice(2, 10);
  return admin(async (db) => {
    const { rows: [tenant] } = await db.query(
      `INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING *`,
      [`Tenant ${suffix}`, `${slugPrefix}-${suffix}`],
    );
    const { rows: [restaurant] } = await db.query(
      `INSERT INTO restaurants (tenant_id, name, slug, timezone)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [tenant.id, `Restaurant ${suffix}`, `r-${suffix}`, timezone],
    );
    const { rows: [zoneMain] } = await db.query(
      `INSERT INTO zones (tenant_id, restaurant_id, name, kind, guest_selectable)
       VALUES ($1, $2, 'Salle', 'dining_room', true) RETURNING *`,
      [tenant.id, restaurant.id],
    );
    const { rows: [zoneTerrace] } = await db.query(
      `INSERT INTO zones (tenant_id, restaurant_id, name, kind, guest_selectable)
       VALUES ($1, $2, 'Terrasse', 'terrace', true) RETURNING *`,
      [tenant.id, restaurant.id],
    );

    const created = [];
    for (const [index, table] of tables.entries()) {
      const zoneId = table.zone === 'terrace' ? zoneTerrace.id : zoneMain.id;
      const { rows: [row] } = await db.query(
        `INSERT INTO restaurant_tables
           (tenant_id, restaurant_id, zone_id, code, seats_min, seats_max,
            priority, guest_selectable, combinable, attributes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          tenant.id, restaurant.id, zoneId, table.code,
          table.seats_min ?? 1, table.seats_max,
          table.priority ?? 100 + index,
          table.guest_selectable ?? true,
          table.combinable ?? false,
          table.attributes ?? [],
        ],
      );
      created.push(row);
    }

    const { rows: [period] } = await db.query(
      `INSERT INTO service_periods
         (tenant_id, restaurant_id, name, days_of_week, starts_at, ends_at,
          last_seating_offset_minutes, default_duration_minutes,
          turn_buffer_minutes, slot_interval_minutes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        tenant.id, restaurant.id, servicePeriod.name, servicePeriod.days_of_week,
        servicePeriod.starts_at, servicePeriod.ends_at,
        servicePeriod.last_seating_offset_minutes, servicePeriod.default_duration_minutes,
        servicePeriod.turn_buffer_minutes, servicePeriod.slot_interval_minutes,
      ],
    );

    return {
      tenantId: tenant.id,
      restaurantId: restaurant.id,
      zones: { main: zoneMain.id, terrace: zoneTerrace.id },
      tables: Object.fromEntries(created.map((t) => [t.code, t])),
      tableList: created,
      servicePeriod: period,
    };
  });
}

/** Un soir de service a venir, a l'heure murale demandee. */
export function eveningAt(hour = 20, minute = 0, daysFromNow = 7) {
  const base = new Date();
  base.setUTCDate(base.getUTCDate() + daysFromNow);
  const year = base.getUTCFullYear();
  const month = base.getUTCMonth() + 1;
  const day = base.getUTCDate();
  return { year, month, day, hour, minute };
}
