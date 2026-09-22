import { Router, readJson, sendJson, badRequest, notFound } from '../http.js';
import { createStaffUser } from '../../services/auth.js';
import { serviceLoad } from '../../services/assignment.js';

export function staffRoutes(router = new Router()) {
  router.get('/api/restaurants/:restaurantId/staff', async (ctx) => {
    const rows = await ctx.withTenant(async (client) => (await client.query(
      `SELECT u.id, u.email, u.full_name, u.display_name, u.status, u.locale,
              m.role, m.restaurant_id,
              p.max_tables, p.max_covers, p.load_factor, p.languages
         FROM users u
         JOIN memberships m ON m.user_id = u.id
         LEFT JOIN staff_profiles p ON p.user_id = u.id AND p.restaurant_id = $1
        WHERE m.restaurant_id = $1 OR m.restaurant_id IS NULL
        ORDER BY m.role, u.full_name`,
      [ctx.params.restaurantId],
    )).rows);
    sendJson(ctx.res, 200, rows);
  }, { permission: 'staff:read' });

  router.post('/api/restaurants/:restaurantId/staff', async (ctx) => {
    const body = await readJson(ctx.req);
    for (const field of ['email', 'fullName', 'role']) {
      if (!body[field]) throw badRequest(`Champ manquant : ${field}.`);
    }
    if (!['manager', 'floor_manager', 'server', 'kitchen'].includes(body.role)) {
      throw badRequest('Role invalide. Le role owner ne s\'accorde pas depuis cette route.');
    }
    const user = await ctx.withTenant((client) => createStaffUser(client, {
      tenantId: ctx.tenantId,
      email: body.email,
      fullName: body.fullName,
      password: body.password ?? null,
      role: body.role,
      restaurantId: ctx.params.restaurantId,
      locale: body.locale ?? 'fr-FR',
    }));
    sendJson(ctx.res, 201, user);
  }, { permission: 'staff:*' });

  router.patch('/api/restaurants/:restaurantId/staff/:userId/profile', async (ctx) => {
    const body = await readJson(ctx.req);
    const profile = await ctx.withTenant(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO staff_profiles (tenant_id, user_id, restaurant_id, max_tables, max_covers, load_factor, languages)
         VALUES ($1,$2,$3,COALESCE($4,6),COALESCE($5,24),COALESCE($6,1),COALESCE($7,'{}'))
         ON CONFLICT (user_id, restaurant_id) DO UPDATE SET
           max_tables  = COALESCE($4, staff_profiles.max_tables),
           max_covers  = COALESCE($5, staff_profiles.max_covers),
           load_factor = COALESCE($6, staff_profiles.load_factor),
           languages   = COALESCE($7, staff_profiles.languages),
           updated_at  = now()
         RETURNING *`,
        [ctx.tenantId, ctx.params.userId, ctx.params.restaurantId,
         body.maxTables ?? null, body.maxCovers ?? null, body.loadFactor ?? null, body.languages ?? null],
      );
      return rows[0];
    });
    sendJson(ctx.res, 200, profile);
  }, { permission: 'staff:*' });

  router.get('/api/restaurants/:restaurantId/shifts', async (ctx) => {
    const from = ctx.query.get('from');
    const to = ctx.query.get('to');
    const rows = await ctx.withTenant(async (client) => (await client.query(
      `SELECT s.*, COALESCE(u.display_name, u.full_name) AS name,
              COALESCE(z.zone_ids, '{}') AS zone_ids,
              COALESCE(t.table_ids, '{}') AS table_ids
         FROM shifts s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN LATERAL (SELECT array_agg(zone_id) AS zone_ids FROM shift_zones WHERE shift_id = s.id) z ON true
         LEFT JOIN LATERAL (SELECT array_agg(table_id) AS table_ids FROM shift_tables WHERE shift_id = s.id) t ON true
        WHERE s.restaurant_id = $1
          AND ($2::timestamptz IS NULL OR s.ends_at   > $2)
          AND ($3::timestamptz IS NULL OR s.starts_at < $3)
        ORDER BY s.starts_at`,
      [ctx.params.restaurantId, from || null, to || null],
    )).rows);
    sendJson(ctx.res, 200, rows);
  }, { permission: 'staff:read' });

  router.post('/api/restaurants/:restaurantId/shifts', async (ctx) => {
    const body = await readJson(ctx.req);
    for (const field of ['userId', 'startsAt', 'endsAt']) {
      if (!body[field]) throw badRequest(`Champ manquant : ${field}.`);
    }
    const shift = await ctx.withTenant(async (client) => {
      const { rows: [created] } = await client.query(
        `INSERT INTO shifts (tenant_id, restaurant_id, user_id, service_period_id, starts_at, ends_at, role, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [ctx.tenantId, ctx.params.restaurantId, body.userId, body.servicePeriodId ?? null,
         body.startsAt, body.endsAt, body.role ?? 'server', body.status ?? 'planned'],
      );
      for (const zoneId of body.zoneIds ?? []) {
        await client.query(
          `INSERT INTO shift_zones (tenant_id, shift_id, zone_id) VALUES ($1,$2,$3)`,
          [ctx.tenantId, created.id, zoneId]);
      }
      for (const tableId of body.tableIds ?? []) {
        await client.query(
          `INSERT INTO shift_tables (tenant_id, shift_id, table_id) VALUES ($1,$2,$3)`,
          [ctx.tenantId, created.id, tableId]);
      }
      return { ...created, zone_ids: body.zoneIds ?? [], table_ids: body.tableIds ?? [] };
    });
    sendJson(ctx.res, 201, shift);
  }, { permission: 'staff:schedule' });

  router.post('/api/shifts/:shiftId/clock', async (ctx) => {
    const { action } = await readJson(ctx.req);
    if (!['in', 'out'].includes(action)) throw badRequest("action doit valoir 'in' ou 'out'.");
    const shift = await ctx.withTenant(async (client) => {
      const { rows } = action === 'in'
        ? await client.query(
            `UPDATE shifts SET status = 'clocked_in', clocked_in_at = now()
              WHERE id = $1 RETURNING *`, [ctx.params.shiftId])
        : await client.query(
            `UPDATE shifts SET status = 'clocked_out', clocked_out_at = now()
              WHERE id = $1 RETURNING *`, [ctx.params.shiftId]);
      return rows[0];
    });
    if (!shift) throw notFound('Shift introuvable.');
    sendJson(ctx.res, 200, shift);
  }, { permission: 'service:write' });

  // Charge par serveur : le chiffre que le manager regarde en plein service.
  router.get('/api/restaurants/:restaurantId/load', async (ctx) => {
    const load = await ctx.withTenant((client) => serviceLoad(client, {
      restaurantId: ctx.params.restaurantId,
    }));
    const recommendation = load.length > 0
      ? { userId: load.at(-1).userId, name: load.at(-1).name, loadPct: load.at(-1).loadPct }
      : null;
    sendJson(ctx.res, 200, {
      servers: load,
      // Recommandation, pas decision : le manager reste libre.
      recommendation: recommendation && {
        ...recommendation,
        message: `${recommendation.name} est actuellement le moins chargé (${recommendation.loadPct} %). Je recommande de lui attribuer la prochaine réservation.`,
      },
    });
  }, { permission: 'staff:read' });

  return router;
}
