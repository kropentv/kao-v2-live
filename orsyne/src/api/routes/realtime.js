import { Router, sendJson, readJson, forbidden, badRequest } from '../http.js';
import { hub } from '../../realtime/hub.js';
import { highestRole } from '../rbac.js';

export function realtimeRoutes(router = new Router()) {
  // Flux temps reel du service. Le role est capture a l'abonnement : il
  // sert a cloisonner ce que chaque connecte recoit.
  router.get('/api/restaurants/:restaurantId/stream', async (ctx) => {
    if (!ctx.canAccessRestaurant(ctx.params.restaurantId)) throw forbidden();
    hub.subscribe(ctx.res, {
      restaurantId: ctx.params.restaurantId,
      userId: ctx.user.id,
      role: highestRole(ctx.memberships, ctx.params.restaurantId),
    });
    // Pas de sendJson : la reponse reste ouverte pour la duree du service.
  }, { permission: 'service:read', stream: true });

  router.get('/api/notifications', async (ctx) => {
    const rows = await ctx.withTenant(async (client) => (await client.query(
      `SELECT id, kind, title, body, payload, reservation_id, priority, read_at, created_at
         FROM notifications
        WHERE recipient_user_id = $1
          AND ($2::boolean IS NOT TRUE OR read_at IS NULL)
        ORDER BY priority, created_at DESC LIMIT 100`,
      [ctx.user.id, ctx.query.get('unread') === 'true'],
    )).rows);
    sendJson(ctx.res, 200, rows);
  });

  router.post('/api/notifications/:notificationId/read', async (ctx) => {
    const updated = await ctx.withTenant(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE notifications SET read_at = now()
          WHERE id = $1 AND recipient_user_id = $2 AND read_at IS NULL`,
        [ctx.params.notificationId, ctx.user.id],
      );
      return rowCount;
    });
    sendJson(ctx.res, 200, { ok: true, updated });
  });

  router.post('/api/notifications/read-all', async (ctx) => {
    const updated = await ctx.withTenant(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE notifications SET read_at = now()
          WHERE recipient_user_id = $1 AND read_at IS NULL`, [ctx.user.id]);
      return rowCount;
    });
    sendJson(ctx.res, 200, { ok: true, updated });
  });

  // Diffusion manuelle, utile pour un rappel de salle depuis le dashboard.
  router.post('/api/restaurants/:restaurantId/broadcast', async (ctx) => {
    const body = await readJson(ctx.req);
    if (!body.message) throw badRequest('message est requis.');
    const delivered = hub.publish(ctx.params.restaurantId, 'manager.broadcast', {
      message: body.message,
      from: ctx.user.display_name ?? ctx.user.full_name,
    });
    sendJson(ctx.res, 200, { ok: true, delivered });
  }, { permission: 'service:write' });

  return router;
}
