import { Router, readJson, sendJson, badRequest, notFound } from '../http.js';

/** Plan de salle : zones, tables, combinaisons, statuts temps reel. */
export function floorRoutes(router = new Router()) {
  router.get('/api/restaurants/:restaurantId/floor', async (ctx) => {
    const data = await ctx.withTenant(async (client) => {
      const { rows: zones } = await client.query(
        `SELECT id, name, kind, guest_selectable, color, sort_order, is_active
           FROM zones WHERE restaurant_id = $1 ORDER BY sort_order, name`,
        [ctx.params.restaurantId],
      );
      const { rows: tables } = await client.query(
        `SELECT id, zone_id, code, label, seats_min, seats_max, shape,
                pos_x, pos_y, width, height, rotation,
                guest_selectable, combinable, priority, attributes, live_status, is_active
           FROM restaurant_tables WHERE restaurant_id = $1 ORDER BY code`,
        [ctx.params.restaurantId],
      );
      const { rows: combinations } = await client.query(
        `SELECT c.id, c.name, c.seats_min, c.seats_max, c.priority, c.is_active,
                COALESCE(array_agg(m.table_id) FILTER (WHERE m.table_id IS NOT NULL), '{}') AS table_ids
           FROM table_combinations c
           LEFT JOIN table_combination_members m ON m.combination_id = c.id
          WHERE c.restaurant_id = $1 GROUP BY c.id ORDER BY c.name`,
        [ctx.params.restaurantId],
      );
      return { zones, tables, combinations };
    });
    sendJson(ctx.res, 200, data);
  }, { permission: 'floor:read' });

  router.post('/api/restaurants/:restaurantId/zones', async (ctx) => {
    const body = await readJson(ctx.req);
    if (!body.name) throw badRequest('Le nom de la zone est requis.');
    const zone = await ctx.withTenant(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO zones (tenant_id, restaurant_id, name, kind, guest_selectable, color, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [ctx.tenantId, ctx.params.restaurantId, body.name, body.kind ?? 'dining_room',
         body.guestSelectable ?? true, body.color ?? null, body.sortOrder ?? 0],
      );
      return rows[0];
    });
    sendJson(ctx.res, 201, zone);
  }, { permission: 'floor:write' });

  router.post('/api/restaurants/:restaurantId/tables', async (ctx) => {
    const body = await readJson(ctx.req);
    if (!body.code) throw badRequest('Le code de la table est requis.');
    if (!Number.isInteger(body.seatsMax) || body.seatsMax < 1) {
      throw badRequest('seatsMax doit etre un entier positif.');
    }
    const table = await ctx.withTenant(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO restaurant_tables
           (tenant_id, restaurant_id, zone_id, code, label, seats_min, seats_max, shape,
            pos_x, pos_y, width, height, rotation, guest_selectable, combinable, priority, attributes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [
          ctx.tenantId, ctx.params.restaurantId, body.zoneId ?? null, body.code, body.label ?? null,
          body.seatsMin ?? 1, body.seatsMax, body.shape ?? 'round',
          body.posX ?? 0, body.posY ?? 0, body.width ?? 1, body.height ?? 1, body.rotation ?? 0,
          body.guestSelectable ?? false, body.combinable ?? false, body.priority ?? 100,
          body.attributes ?? [],
        ],
      );
      return rows[0];
    });
    sendJson(ctx.res, 201, table);
  }, { permission: 'floor:write' });

  // Deplacement / redimensionnement depuis l'editeur de plan de salle.
  router.patch('/api/restaurants/:restaurantId/tables/:tableId', async (ctx) => {
    const body = await readJson(ctx.req);
    const allowed = {
      zone_id: body.zoneId, code: body.code, label: body.label,
      seats_min: body.seatsMin, seats_max: body.seatsMax, shape: body.shape,
      pos_x: body.posX, pos_y: body.posY, width: body.width, height: body.height,
      rotation: body.rotation, guest_selectable: body.guestSelectable,
      combinable: body.combinable, priority: body.priority, attributes: body.attributes,
      live_status: body.liveStatus, is_active: body.isActive,
    };
    const entries = Object.entries(allowed).filter(([, value]) => value !== undefined);
    if (entries.length === 0) throw badRequest('Aucun champ a modifier.');

    const table = await ctx.withTenant(async (client) => {
      const sets = entries.map(([column], i) => `${column} = $${i + 3}`);
      const { rows } = await client.query(
        `UPDATE restaurant_tables SET ${sets.join(', ')}
          WHERE id = $1 AND restaurant_id = $2 RETURNING *`,
        [ctx.params.tableId, ctx.params.restaurantId, ...entries.map(([, v]) => v)],
      );
      return rows[0];
    });
    if (!table) throw notFound('Table introuvable.');
    ctx.publish('table.updated', { tableId: table.id, liveStatus: table.live_status });
    sendJson(ctx.res, 200, table);
  }, { permission: 'floor:write' });

  // Changement de statut en salle : autorise aux serveurs, contrairement
  // a l'edition du plan qui reste au responsable.
  router.post('/api/restaurants/:restaurantId/tables/:tableId/status', async (ctx) => {
    const { status } = await readJson(ctx.req);
    const allowed = ['available', 'guest_expected', 'seated', 'ordered', 'in_service',
      'check_requested', 'finished', 'cleaning', 'unavailable'];
    if (!allowed.includes(status)) throw badRequest(`Statut invalide. Attendu : ${allowed.join(', ')}.`);

    const table = await ctx.withTenant(async (client) => {
      const { rows } = await client.query(
        `UPDATE restaurant_tables SET live_status = $3
          WHERE id = $1 AND restaurant_id = $2 RETURNING id, code, live_status`,
        [ctx.params.tableId, ctx.params.restaurantId, status],
      );
      return rows[0];
    });
    if (!table) throw notFound('Table introuvable.');
    ctx.publish('table.status_changed', { tableId: table.id, code: table.code, status });
    sendJson(ctx.res, 200, table);
  }, { permission: 'service:write' });

  router.delete('/api/restaurants/:restaurantId/tables/:tableId', async (ctx) => {
    // Desactivation plutot que suppression : une table supprimee
    // emporterait l'historique des reservations qui s'y sont tenues.
    const table = await ctx.withTenant(async (client) => {
      const { rows } = await client.query(
        `UPDATE restaurant_tables SET is_active = false
          WHERE id = $1 AND restaurant_id = $2 RETURNING id`,
        [ctx.params.tableId, ctx.params.restaurantId],
      );
      return rows[0];
    });
    if (!table) throw notFound('Table introuvable.');
    sendJson(ctx.res, 200, { ok: true, deactivated: table.id });
  }, { permission: 'floor:write' });

  router.post('/api/restaurants/:restaurantId/combinations', async (ctx) => {
    const body = await readJson(ctx.req);
    if (!body.name || !Array.isArray(body.tableIds) || body.tableIds.length < 2) {
      throw badRequest('Une combinaison exige un nom et au moins deux tables.');
    }
    const combination = await ctx.withTenant(async (client) => {
      const { rows: [created] } = await client.query(
        `INSERT INTO table_combinations
           (tenant_id, restaurant_id, name, seats_min, seats_max, priority)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [ctx.tenantId, ctx.params.restaurantId, body.name,
         body.seatsMin ?? 2, body.seatsMax, body.priority ?? 200],
      );
      for (const tableId of body.tableIds) {
        await client.query(
          `INSERT INTO table_combination_members (tenant_id, combination_id, table_id)
           VALUES ($1,$2,$3)`, [ctx.tenantId, created.id, tableId],
        );
      }
      return { ...created, table_ids: body.tableIds };
    });
    sendJson(ctx.res, 201, combination);
  }, { permission: 'floor:write' });

  // Services et horaires
  router.get('/api/restaurants/:restaurantId/services', async (ctx) => {
    const rows = await ctx.withTenant(async (client) => (await client.query(
      `SELECT * FROM service_periods WHERE restaurant_id = $1 ORDER BY starts_at`,
      [ctx.params.restaurantId],
    )).rows);
    sendJson(ctx.res, 200, rows);
  }, { permission: 'restaurants:read' });

  router.post('/api/restaurants/:restaurantId/services', async (ctx) => {
    const body = await readJson(ctx.req);
    for (const field of ['name', 'daysOfWeek', 'startsAt', 'endsAt']) {
      if (body[field] === undefined) throw badRequest(`Champ manquant : ${field}.`);
    }
    const period = await ctx.withTenant(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO service_periods
           (tenant_id, restaurant_id, name, days_of_week, starts_at, ends_at,
            last_seating_offset_minutes, default_duration_minutes,
            turn_buffer_minutes, slot_interval_minutes, max_covers_per_slot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          ctx.tenantId, ctx.params.restaurantId, body.name, body.daysOfWeek,
          body.startsAt, body.endsAt,
          body.lastSeatingOffsetMinutes ?? 60, body.defaultDurationMinutes ?? 90,
          body.turnBufferMinutes ?? 15, body.slotIntervalMinutes ?? 15,
          body.maxCoversPerSlot ?? null,
        ],
      );
      return rows[0];
    });
    sendJson(ctx.res, 201, period);
  }, { permission: 'settings:*' });

  router.post('/api/restaurants/:restaurantId/closures', async (ctx) => {
    const body = await readJson(ctx.req);
    if (!body.startsAt || !body.endsAt) throw badRequest('startsAt et endsAt sont requis.');
    const closure = await ctx.withTenant(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO closures (tenant_id, restaurant_id, starts_at, ends_at, reason, blocks_public_booking)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [ctx.tenantId, ctx.params.restaurantId, body.startsAt, body.endsAt,
         body.reason ?? null, body.blocksPublicBooking ?? true],
      );
      return rows[0];
    });
    sendJson(ctx.res, 201, closure);
  }, { permission: 'settings:*' });

  router.post('/api/restaurants/:restaurantId/deposit-policies', async (ctx) => {
    const body = await readJson(ctx.req);
    if (!body.name || !body.mechanism) throw badRequest('name et mechanism sont requis.');
    const policy = await ctx.withTenant(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO deposit_policies
           (tenant_id, restaurant_id, name, days_of_week, time_from, time_to,
            party_size_min, party_size_max, zone_id, table_id,
            mechanism, amount_mode, amount_cents, free_cancellation_hours, priority)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [
          ctx.tenantId, ctx.params.restaurantId, body.name,
          body.daysOfWeek ?? null, body.timeFrom ?? null, body.timeTo ?? null,
          body.partySizeMin ?? null, body.partySizeMax ?? null,
          body.zoneId ?? null, body.tableId ?? null,
          body.mechanism, body.amountMode ?? 'fixed', body.amountCents ?? 0,
          body.freeCancellationHours ?? 24, body.priority ?? 100,
        ],
      );
      return rows[0];
    });
    sendJson(ctx.res, 201, policy);
  }, { permission: 'settings:*' });

  return router;
}
