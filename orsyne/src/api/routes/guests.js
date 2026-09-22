import { Router, readJson, sendJson, badRequest, notFound, forbidden } from '../http.js';
import { buildGuestBrief } from '../../services/guest-brief.js';
import { isServerOnly } from '../rbac.js';
import { upsertGuest } from './reservations.js';

/** CRM. Le serveur n'a acces qu'a la note de briefing, jamais au profil. */
export function guestRoutes(router = new Router()) {
  router.get('/api/guests', async (ctx) => {
    const search = (ctx.query.get('q') ?? '').trim();
    const rows = await ctx.withTenant(async (client) => (await client.query(
      `SELECT g.id, g.first_name, g.last_name, g.email, g.phone_e164, g.locale, g.vip,
              COALESCE(sum(s.visits), 0)   AS visits,
              COALESCE(sum(s.no_shows), 0) AS no_shows,
              max(s.last_visit_at)         AS last_visit_at
         FROM guests g
         LEFT JOIN guest_restaurant_stats s ON s.guest_id = g.id
        WHERE g.anonymized_at IS NULL
          AND ($1 = '' OR g.first_name ILIKE '%'||$1||'%' OR g.last_name ILIKE '%'||$1||'%'
               OR g.email ILIKE '%'||$1||'%' OR g.phone_e164 ILIKE '%'||$1||'%')
        GROUP BY g.id
        ORDER BY max(s.last_visit_at) DESC NULLS LAST, g.last_name
        LIMIT 100`,
      [search],
    )).rows);
    sendJson(ctx.res, 200, rows);
  }, { permission: 'guests:read' });

  router.get('/api/guests/:guestId', async (ctx) => {
    if (isServerOnly(ctx.memberships)) throw forbidden('Le profil complet est reserve a l\'encadrement.');
    const profile = await ctx.withTenant(async (client) => {
      const { rows: [guest] } = await client.query(
        `SELECT * FROM guests WHERE id = $1 AND anonymized_at IS NULL`, [ctx.params.guestId]);
      if (!guest) return null;
      const [stats, preferences, facts, insights, notes, history, consents] = await Promise.all([
        client.query(`SELECT s.*, r.name AS restaurant_name FROM guest_restaurant_stats s
                        JOIN restaurants r ON r.id = s.restaurant_id WHERE s.guest_id = $1`, [guest.id]),
        client.query(`SELECT * FROM guest_preferences WHERE guest_id = $1 ORDER BY is_critical DESC, kind`, [guest.id]),
        client.query(`SELECT * FROM guest_facts WHERE guest_id = $1 ORDER BY occurrences DESC LIMIT 20`, [guest.id]),
        client.query(`SELECT * FROM guest_insights WHERE guest_id = $1 AND status <> 'rejected'
                       ORDER BY confidence DESC LIMIT 10`, [guest.id]),
        client.query(`SELECT n.*, u.full_name AS author_name FROM guest_notes n
                        LEFT JOIN users u ON u.id = n.author_user_id
                       WHERE n.guest_id = $1 ORDER BY n.created_at DESC LIMIT 50`, [guest.id]),
        client.query(`SELECT r.id, r.reference, r.starts_at, r.party_size, r.status, rest.name AS restaurant_name
                        FROM reservations r JOIN restaurants rest ON rest.id = r.restaurant_id
                       WHERE r.guest_id = $1 ORDER BY r.starts_at DESC LIMIT 50`, [guest.id]),
        client.query(`SELECT channel, purpose, granted, occurred_at FROM guest_consents WHERE guest_id = $1`, [guest.id]),
      ]);
      return {
        guest,
        stats: stats.rows,
        preferences: preferences.rows,
        // Faits et deductions restent separes jusque dans la reponse HTTP.
        facts: facts.rows,
        insights: insights.rows,
        notes: notes.rows,
        history: history.rows,
        consents: consents.rows,
      };
    });
    if (!profile) throw notFound('Client introuvable.');
    sendJson(ctx.res, 200, profile);
  }, { permission: 'guests:read' });

  // Ce que le serveur a le droit de voir : la note, rien de plus.
  router.get('/api/guests/:guestId/brief', async (ctx) => {
    const restaurantId = ctx.query.get('restaurantId');
    if (!restaurantId) throw badRequest('restaurantId est requis.');
    if (!ctx.canAccessRestaurant(restaurantId)) throw forbidden();
    const brief = await ctx.withTenant((client) => buildGuestBrief(client, {
      guestId: ctx.params.guestId, restaurantId,
    }));
    if (!brief) throw notFound('Client introuvable.');
    sendJson(ctx.res, 200, brief);
  }, { permission: 'guests:read_brief' });

  router.post('/api/guests', async (ctx) => {
    const body = await readJson(ctx.req);
    if (!body.phone && !body.email) throw badRequest('Un telephone ou un email est requis.');
    const guestId = await ctx.withTenant((client) => upsertGuest(client, ctx.tenantId, body));
    sendJson(ctx.res, 201, { id: guestId });
  }, { permission: 'guests:write' });

  router.patch('/api/guests/:guestId', async (ctx) => {
    const body = await readJson(ctx.req);
    const allowed = {
      first_name: body.firstName, last_name: body.lastName, email: body.email,
      phone_e164: body.phone, locale: body.locale, vip: body.vip,
      birthday: body.birthday, company: body.company,
    };
    const entries = Object.entries(allowed).filter(([, v]) => v !== undefined);
    if (entries.length === 0) throw badRequest('Aucun champ a modifier.');
    const guest = await ctx.withTenant(async (client) => {
      const sets = entries.map(([column], i) => `${column} = $${i + 2}`);
      const { rows } = await client.query(
        `UPDATE guests SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
        [ctx.params.guestId, ...entries.map(([, v]) => v)],
      );
      return rows[0];
    });
    if (!guest) throw notFound('Client introuvable.');
    sendJson(ctx.res, 200, guest);
  }, { permission: 'guests:write' });

  router.post('/api/guests/:guestId/preferences', async (ctx) => {
    const body = await readJson(ctx.req);
    if (!body.kind || !body.value) throw badRequest('kind et value sont requis.');
    const preference = await ctx.withTenant(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO guest_preferences (tenant_id, guest_id, kind, value, source, is_critical, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (guest_id, kind, value) DO UPDATE SET is_critical = EXCLUDED.is_critical
         RETURNING *`,
        [ctx.tenantId, ctx.params.guestId, body.kind, body.value,
         body.source ?? 'staff_entered', body.isCritical ?? body.kind === 'allergy', ctx.user.id],
      );
      return rows[0];
    });
    sendJson(ctx.res, 201, preference);
  }, { permission: 'guests:write' });

  router.post('/api/guests/:guestId/notes', async (ctx) => {
    const body = await readJson(ctx.req);
    if (!body.body) throw badRequest('Le contenu de la note est requis.');
    const note = await ctx.withTenant(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO guest_notes (tenant_id, guest_id, restaurant_id, body, visibility, author_user_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [ctx.tenantId, ctx.params.guestId, body.restaurantId ?? null, body.body,
         body.visibility ?? 'all_staff', ctx.user.id],
      );
      return rows[0];
    });
    sendJson(ctx.res, 201, note);
  }, { permission: 'guests:write' });

  // Le restaurant tranche sur une deduction IA. Un rejet la retire
  // definitivement de l'affichage : l'humain corrige la machine.
  router.post('/api/insights/:insightId/review', async (ctx) => {
    const { status } = await readJson(ctx.req);
    if (!['accepted', 'rejected'].includes(status)) {
      throw badRequest('status doit valoir accepted ou rejected.');
    }
    const insight = await ctx.withTenant(async (client) => {
      const { rows } = await client.query(
        `UPDATE guest_insights SET status = $2, reviewed_by = $3, reviewed_at = now()
          WHERE id = $1 RETURNING *`,
        [ctx.params.insightId, status, ctx.user.id],
      );
      return rows[0];
    });
    if (!insight) throw notFound('Deduction introuvable.');
    sendJson(ctx.res, 200, insight);
  }, { permission: 'guests:write' });

  // RGPD : droit a l'effacement. On anonymise au lieu de supprimer, pour
  // ne pas detruire l'historique comptable du restaurant.
  router.delete('/api/guests/:guestId', async (ctx) => {
    const result = await ctx.withTenant(async (client) => {
      const { rows } = await client.query(
        `UPDATE guests SET
           first_name = 'Client', last_name = 'anonymisé',
           email = NULL, phone_e164 = NULL, company = NULL, birthday = NULL,
           anonymized_at = now()
         WHERE id = $1 AND anonymized_at IS NULL RETURNING id`,
        [ctx.params.guestId],
      );
      if (rows.length === 0) return null;
      await client.query('DELETE FROM guest_preferences WHERE guest_id = $1', [ctx.params.guestId]);
      await client.query('DELETE FROM guest_notes WHERE guest_id = $1', [ctx.params.guestId]);
      await client.query('DELETE FROM guest_insights WHERE guest_id = $1', [ctx.params.guestId]);
      await client.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, action, entity_type, entity_id)
         VALUES ($1,$2,'guest.anonymized','guest',$3)`,
        [ctx.tenantId, ctx.user.id, ctx.params.guestId],
      );
      return rows[0];
    });
    if (!result) throw notFound('Client introuvable ou deja anonymise.');
    sendJson(ctx.res, 200, { ok: true, anonymized: result.id });
  }, { permission: 'guests:*' });

  // RGPD : droit d'acces et portabilite.
  router.get('/api/guests/:guestId/export', async (ctx) => {
    const data = await ctx.withTenant(async (client) => {
      const { rows: [guest] } = await client.query('SELECT * FROM guests WHERE id = $1', [ctx.params.guestId]);
      if (!guest) return null;
      const tables = ['guest_preferences', 'guest_facts', 'guest_insights', 'guest_notes', 'guest_consents'];
      const extra = {};
      for (const table of tables) {
        extra[table] = (await client.query(`SELECT * FROM ${table} WHERE guest_id = $1`, [guest.id])).rows;
      }
      const reservations = await client.query(
        'SELECT id, reference, starts_at, party_size, status FROM reservations WHERE guest_id = $1', [guest.id]);
      return { guest, ...extra, reservations: reservations.rows };
    });
    if (!data) throw notFound('Client introuvable.');
    sendJson(ctx.res, 200, data, {
      'content-disposition': `attachment; filename="orsyne-client-${ctx.params.guestId}.json"`,
    });
  }, { permission: 'guests:*' });

  return router;
}
