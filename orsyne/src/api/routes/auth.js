import { Router, readJson, sendJson, sessionCookie, clearedSessionCookie, unauthorized, badRequest } from '../http.js';
import { login, logout, registerTenant } from '../../services/auth.js';
import { permissionsFor, scopeFor } from '../rbac.js';

export function authRoutes(router = new Router()) {
  router.post('/api/auth/register', async (ctx) => {
    const body = await readJson(ctx.req);
    for (const field of ['tenantName', 'slug', 'restaurantName', 'email', 'password', 'fullName']) {
      if (!body[field]) throw badRequest(`Champ manquant : ${field}.`);
    }
    if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(body.slug)) {
      throw badRequest('Le slug doit contenir 3 a 50 caracteres : minuscules, chiffres et tirets.');
    }
    const created = await registerTenant(body);
    const session = await login({
      email: body.email, password: body.password,
      userAgent: ctx.req.headers['user-agent'], ip: ctx.ip,
    });
    sendJson(ctx.res, 201, {
      tenant: { id: created.tenant.id, name: created.tenant.name, slug: created.tenant.slug },
      restaurant: { id: created.restaurant.id, name: created.restaurant.name, slug: created.restaurant.slug },
      user: { id: created.user.id, email: created.user.email, fullName: created.user.full_name },
    }, { 'set-cookie': sessionCookie(session.token, session.expiresAt, { secure: ctx.secure }) });
  }, { public: true });

  router.post('/api/auth/login', async (ctx) => {
    const { email, password } = await readJson(ctx.req);
    if (!email || !password) throw badRequest('Email et mot de passe requis.');
    const session = await login({
      email, password, userAgent: ctx.req.headers['user-agent'], ip: ctx.ip,
    });
    sendJson(ctx.res, 200, { ok: true }, {
      'set-cookie': sessionCookie(session.token, session.expiresAt, { secure: ctx.secure }),
    });
  }, { public: true });

  router.post('/api/auth/logout', async (ctx) => {
    await logout({ tenantId: ctx.tenantId, userId: ctx.user.id, sessionId: ctx.sessionId });
    sendJson(ctx.res, 200, { ok: true }, { 'set-cookie': clearedSessionCookie });
  });

  // Point d'entree du frontend : identite, droits et perimetre en un appel.
  router.get('/api/me', async (ctx) => {
    if (!ctx.user) throw unauthorized();
    const restaurants = await ctx.withTenant(async (client) => {
      const scope = scopeFor(ctx.memberships);
      const { rows } = await client.query(
        `SELECT id, name, slug, timezone, locale, currency FROM restaurants
          WHERE is_active AND ($1::boolean OR id = ANY($2::uuid[]))
          ORDER BY name`,
        [scope.tenantWide, scope.restaurantIds ?? []],
      );
      return rows;
    });
    sendJson(ctx.res, 200, {
      user: ctx.user,
      memberships: ctx.memberships,
      permissions: [...permissionsFor(ctx.memberships)],
      restaurants,
    });
  });

  return router;
}
