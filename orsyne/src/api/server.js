import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Router, parseCookies, sendJson, toHttpError, unauthorized, forbidden, notFound,
} from './http.js';
import { resolveSession } from '../services/auth.js';
import { canAccessRestaurant, hasPermission, permissionsFor } from './rbac.js';
import { withTenant } from '../db/pool.js';
import { hub } from '../realtime/hub.js';
import { outboxWorker } from '../services/outbox-worker.js';

import { authRoutes } from './routes/auth.js';
import { floorRoutes } from './routes/floor.js';
import { reservationRoutes } from './routes/reservations.js';
import { guestRoutes } from './routes/guests.js';
import { staffRoutes } from './routes/staff.js';
import { publicRoutes } from './routes/public.js';
import { realtimeRoutes } from './routes/realtime.js';
import { analyticsRoutes } from './routes/analytics.js';
import { paymentRoutes } from './routes/payments.js';
import { waitlistRoutes } from './routes/waitlist.js';
import { securityHeaders, limiter, limitFor, clientIp } from './security.js';
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import { integrationStatus } from '../integrations/index.js';
import { scheduler } from '../services/scheduler.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

export function buildRouter() {
  const router = new Router();
  authRoutes(router);
  publicRoutes(router);
  floorRoutes(router);
  reservationRoutes(router);
  guestRoutes(router);
  staffRoutes(router);
  realtimeRoutes(router);
  analyticsRoutes(router);
  paymentRoutes(router);
  waitlistRoutes(router);
  return router;
}

export function createApp({ router = buildRouter() } = {}) {
  return async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

    try {
      securityHeaders(res);

      // Vivacite : le processus repond. Ne touche pas la base, pour qu'un
      // orchestrateur ne tue pas le conteneur pendant une coupure DB.
      if (url.pathname === '/health') {
        return sendJson(res, 200, { status: 'ok', service: 'orsyne' });
      }
      // Disponibilite : la base repond et les branchements sont connus.
      if (url.pathname === '/ready') {
        try {
          await getPool().query('SELECT 1');
          return sendJson(res, 200, { status: 'ready', integrations: integrationStatus() });
        } catch {
          return sendJson(res, 503, { status: 'database_unavailable' });
        }
      }

      const quota = limitFor(req.method, url.pathname);
      if (quota) {
        const verdict = limiter.take(`${quota.bucket}:${clientIp(req)}`, quota.limit);
        if (!verdict.allowed) {
          return sendJson(res, 429, {
            error: { code: 'rate_limited', message: 'Trop de requetes. Reessayez dans un instant.' },
          }, { 'retry-after': String(verdict.retryAfterSeconds) });
        }
      }

      const matched = router.match(req.method, url.pathname);
      if (matched?.methodNotAllowed) {
        return sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'Methode non autorisee.' } });
      }
      if (!matched) {
        // Tout ce qui n'est pas une route API est servi comme fichier.
        // `await` obligatoire : sans lui, le rejet d'une promesse rendue
        // depuis un try/catch async echappe au catch et devient une
        // exception non geree qui abat le processus.
        if (url.pathname.startsWith('/api/')) throw notFound('Route inconnue.');
        return await serveStatic(url.pathname, res);
      }

      const { route, params } = matched;
      const ctx = await buildContext({ req, res, url, params, route });

      if (!route.options.public) {
        if (!ctx.user) throw unauthorized();
        if (route.options.permission
            && !hasPermission(ctx.permissions, route.options.permission)) {
          throw forbidden(`Permission requise : ${route.options.permission}.`);
        }
        // Une route portant :restaurantId verifie systematiquement le
        // perimetre, meme si la permission est accordee au niveau tenant.
        if (params.restaurantId) await assertRestaurantInScope(ctx, params.restaurantId);
      }

      await route.handler(ctx);
    } catch (error) {
      respondWithError(res, error);
    }
  };
}

async function buildContext({ req, res, url, params, route }) {
  const cookies = parseCookies(req.headers.cookie ?? '');
  const session = route.options.public && !cookies.orsyne_session
    ? null
    : await resolveSession(cookies.orsyne_session);

  const memberships = session?.memberships ?? [];
  const tenantId = session?.tenantId ?? null;

  return {
    req, res, params, url,
    query: url.searchParams,
    ip: clientIp(req),
    secure: config.forceSecureCookies || (config.trustProxy && req.headers['x-forwarded-proto'] === 'https'),
    tenantId,
    sessionId: session?.sessionId ?? null,
    user: session?.user ?? null,
    memberships,
    permissions: permissionsFor(memberships),
    /**
     * Verification synchrone, utilisable dans un handler. Une portee
     * tenant est acceptee ici parce que la requete metier qui suit passe
     * de toute facon sous RLS : un etablissement d'un autre tenant ne
     * renverra aucune ligne. Le controle strict, lui, est fait en amont
     * par assertRestaurantInScope.
     */
    canAccessRestaurant: (restaurantId) => canAccessRestaurant(memberships, restaurantId) !== false,
    /** Toute lecture/ecriture metier passe par ici : jamais de pool nu. */
    withTenant: (fn) => {
      if (!tenantId) throw unauthorized();
      return withTenant({ tenantId, userId: session?.user?.id ?? null }, fn);
    },
    publish: (topic, payload) => params.restaurantId
      ? hub.publish(params.restaurantId, topic, payload)
      : 0,
  };
}

/**
 * Controle strict du perimetre d'un etablissement.
 *
 * Point critique : le flux temps reel est indexe par restaurantId et
 * n'est PAS protege par la RLS. Se contenter de « cet utilisateur a une
 * portee tenant » laisserait donc le proprietaire d'un tenant s'abonner
 * aux evenements d'un autre. On verifie l'appartenance reelle en base,
 * sous RLS : si l'etablissement n'est pas dans le tenant courant, la
 * requete ne renvoie rien.
 */
async function assertRestaurantInScope(ctx, restaurantId) {
  const verdict = canAccessRestaurant(ctx.memberships, restaurantId);
  if (verdict === false) throw forbidden("Cet etablissement n'est pas dans votre perimetre.");
  if (verdict === true) return;

  const exists = await ctx.withTenant(async (client) => {
    const { rowCount } = await client.query(
      'SELECT 1 FROM restaurants WHERE id = $1', [restaurantId]);
    return rowCount > 0;
  }).catch(() => false);

  if (!exists) throw forbidden("Cet etablissement n'est pas dans votre perimetre.");
}

function respondWithError(res, error) {
  if (res.headersSent) {
    // Un flux SSE deja ouvert : on le ferme proprement plutot que de
    // corrompre la reponse avec du JSON.
    return res.end();
  }
  const httpError = toHttpError(error);
  if (httpError) {
    return sendJson(res, httpError.status, {
      error: { code: httpError.code, message: httpError.message, ...httpError.details },
    });
  }
  console.error('[orsyne] erreur non geree:', error);
  sendJson(res, 500, { error: { code: 'internal_error', message: 'Erreur interne.' } });
}

async function serveStatic(pathname, res) {
  // normalize + prefixe verifie : aucune remontee hors de public/.
  const relative = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(publicDir, relative);
  if (!filePath.startsWith(publicDir)) throw notFound();

  let info = await stat(filePath).catch(() => null);
  if (info?.isDirectory()) {
    filePath = join(filePath, 'index.html');
    info = await stat(filePath).catch(() => null);
  }
  if (!info?.isFile()) {
    // Routes cote client : /r/<slug> ouvre le widget, /app/... ouvre
    // l'application. Le serveur renvoie la page, le navigateur lit le
    // chemin — un lien de reservation partage doit toujours s'ouvrir.
    const fallback = pathname.startsWith('/app')
      ? join(publicDir, 'app', 'index.html')
      : pathname.startsWith('/r/') ? join(publicDir, 'index.html') : null;
    if (!fallback) throw notFound();
    filePath = fallback;
    info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) throw notFound();
  }

  if (extname(filePath) === '.html') securityHeaders(res, { html: true });
  res.writeHead(200, {
    'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-cache',
  });
  createReadStream(filePath).pipe(res);
}

export function startServer({ port = config.port, withWorker = true, withScheduler = false } = {}) {
  const server = http.createServer(createApp());
  // Une requete lente ne doit pas monopoliser une connexion indefiniment ;
  // les flux temps reel, eux, gardent leur connexion ouverte.
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  if (withWorker) outboxWorker.start();
  if (withScheduler) scheduler.start();
  return new Promise((resolve) => {
    server.listen(port, () => resolve({
      server,
      port: server.address().port,
      async close() {
        outboxWorker.stop();
        scheduler.stop();
        hub.close();
        server.closeAllConnections?.();
        await new Promise((done) => server.close(done));
      },
    }));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Point d'entree complet (migrations, controles, arret propre) :
  // src/main.js. Ce raccourci reste pour le developpement.
  const { port } = await startServer({ withScheduler: true });
  console.log(`ORSYNE — Tout s'accorde.`);
  console.log(`API et interfaces sur http://localhost:${port}`);
}
