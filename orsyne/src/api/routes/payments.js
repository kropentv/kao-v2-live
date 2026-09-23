import { Router, readJson, sendJson, badRequest, notFound } from '../http.js';
import { getPool, withTenant } from '../../db/pool.js';
import { payments } from '../../integrations/index.js';
import { openCheckout, applyPaymentEvent, chargeNoShow, releaseOrRefund, cancellationIsFree }
  from '../../services/payments.js';
import { notifyReservation } from '../../services/messaging.js';

/**
 * Paiements.
 *
 * Le webhook est la seule source de verite sur l'encaissement : le
 * retour navigateur du client peut etre perdu, falsifie, ou ne jamais
 * arriver. Une reservation n'est donc jamais confirmee sur la foi d'une
 * redirection — uniquement sur un evenement signe du prestataire.
 */
export function paymentRoutes(router = new Router()) {
  // Ouvre le paiement depuis le widget public, par reference.
  router.post('/api/public/:slug/reservations/:reference/checkout', async (ctx) => {
    const { rows } = await getPool().query(
      'SELECT * FROM orsyne_core.lookup_reservation_by_reference($1,$2)',
      [ctx.params.slug, ctx.params.reference]);
    if (rows.length === 0) throw notFound('Reservation introuvable.');
    const found = rows[0];

    const checkout = await withTenant({ tenantId: found.tenant_id }, (client) =>
      openCheckout(client, {
        reservationId: found.reservation_id,
        returnPath: `/r/${ctx.params.slug}`,
      }));
    sendJson(ctx.res, 200, checkout);
  }, { public: true });

  /**
   * Webhook du prestataire. Corps brut obligatoire : la signature porte
   * sur les octets recus, pas sur un JSON re-serialise.
   */
  router.post('/api/webhooks/payments', async (ctx) => {
    const rawBody = await readRaw(ctx.req);
    const provider = payments();

    let event;
    try {
      event = provider.verifyWebhook({
        rawBody,
        signatureHeader: ctx.req.headers['stripe-signature'] ?? ctx.req.headers['x-orsyne-signature'],
      });
    } catch (error) {
      // On repond 400 : le prestataire reessaiera, et un appel non signe
      // n'obtient jamais rien.
      return sendJson(ctx.res, 400, { error: { code: 'invalid_signature', message: error.message } });
    }

    const intent = provider.interpretEvent(event);
    if (!intent) return sendJson(ctx.res, 200, { received: true, handled: false });

    const tenantId = await tenantOf(intent.reservationId);
    if (!tenantId) return sendJson(ctx.res, 200, { received: true, handled: false });

    const result = await withTenant({ tenantId }, async (client) => {
      const applied = await applyPaymentEvent(client, intent);
      if (applied.outcome === 'confirmed') {
        await notifyReservation(client, { reservationId: intent.reservationId, template: 'confirmed' });
      }
      return applied;
    });
    sendJson(ctx.res, 200, { received: true, ...result });
  }, { public: true, rawBody: true });

  // Capture d'empreinte sur no-show, decidee par le restaurant.
  router.post('/api/reservations/:reservationId/charge-no-show', async (ctx) => {
    const result = await ctx.withTenant((client) =>
      chargeNoShow(client, { reservationId: ctx.params.reservationId }));
    sendJson(ctx.res, 200, result);
  }, { permission: 'reservations:write' });

  router.post('/api/reservations/:reservationId/refund', async (ctx) => {
    const outcomes = await ctx.withTenant((client) =>
      releaseOrRefund(client, { reservationId: ctx.params.reservationId }));
    sendJson(ctx.res, 200, { outcomes });
  }, { permission: 'billing:*' });

  router.get('/api/reservations/:reservationId/payments', async (ctx) => {
    const rows = await ctx.withTenant(async (client) => (await client.query(
      `SELECT id, mechanism, provider, status, amount_cents, captured_amount_cents,
              refunded_amount_cents, currency, authorized_at, captured_at, refunded_at
         FROM payment_intents WHERE reservation_id = $1 ORDER BY created_at`,
      [ctx.params.reservationId])).rows);
    const free = await ctx.withTenant((client) =>
      cancellationIsFree(client, { reservationId: ctx.params.reservationId }));
    sendJson(ctx.res, 200, { payments: rows, cancellationIsFree: free });
  }, { permission: 'reservations:read' });

  /**
   * Page de paiement de developpement. N'existe que lorsque le
   * prestataire « console » est branche : en production, Stripe heberge
   * sa propre page et celle-ci ne repond pas.
   */
  router.get('/paiement-demo', async (ctx) => {
    if (payments().name !== 'console') throw notFound();
    const reference = ctx.query.get('ref') ?? '';
    const reservationId = ctx.query.get('rid') ?? '';
    const providerRef = ctx.query.get('pid') ?? '';
    const amount = Number(ctx.query.get('montant') ?? 0);
    const currency = ctx.query.get('devise') ?? 'EUR';
    const mechanism = ctx.query.get('mecanisme') ?? 'deposit';
    // Un chemin local uniquement : jamais une redirection ouverte vers
    // un site tiers construit par un lien pieges.
    const rawBack = ctx.query.get('retour') ?? '/';
    const back = rawBack.startsWith('/') && !rawBack.startsWith('//') ? rawBack : '/';
    const safeBack = back;

    const label = {
      deposit: 'Acompte', preauthorization: 'Empreinte bancaire', full_payment: 'Règlement',
    }[mechanism] ?? 'Paiement';
    const amountLabel = new Intl.NumberFormat('fr-FR', { style: 'currency', currency })
      .format(amount / 100);

    const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Paiement de démonstration — ORSYNE</title>
<link rel="stylesheet" href="/assets/orsyne.css"></head>
<body><main class="wrap wrap--narrow" style="padding-top:3rem">
<div class="card"><div class="card__body center">
  <p class="tag tag--warn">Mode démonstration — aucun débit réel</p>
  <h1 style="margin:.8rem 0">${label}</h1>
  <p class="muted">Réservation <span class="mono">${escapeHtml(reference)}</span></p>
  <p style="font-size:2rem;font-weight:700;margin:1rem 0">${amountLabel}</p>
  <p class="small muted">${mechanism === 'preauthorization'
    ? "Une empreinte n'est pas débitée : elle ne serait capturée qu'en cas d'absence."
    : 'Ce montant sera déduit de votre addition.'}</p>
  <button class="btn btn--primary btn--block" style="margin-top:1.2rem" id="pay">Payer ${amountLabel}</button>
  <a class="btn btn--block" style="margin-top:.5rem" href="${escapeHtml(safeBack)}">Annuler</a>
</div></div></main>
<script type="module">
document.getElementById('pay').addEventListener('click', async (e) => {
  e.target.disabled = true; e.target.textContent = 'Traitement…';
  const response = await fetch('/api/webhooks/payments', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: ${JSON.stringify(mechanism === 'preauthorization' ? 'authorized' : 'captured')},
      reservationId: ${JSON.stringify(reservationId)}, providerRef: ${JSON.stringify(providerRef)},
      mechanism: ${JSON.stringify(mechanism)},
      amountCents: ${Number.isFinite(amount) ? amount : 0}, currency: ${JSON.stringify(currency)} }),
  });
  const target = new URL(${JSON.stringify(back)}, location.origin);
  target.searchParams.set('ref', ${JSON.stringify(reference)});
  target.searchParams.set('paiement', response.ok ? 'ok' : 'erreur');
  location.href = target.toString();
});
</script></body></html>`;

    ctx.res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    ctx.res.end(html);
  }, { public: true, html: true });

  return router;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function readRaw(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw badRequest('Corps de requete trop volumineux.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function tenantOf(reservationId) {
  if (!reservationId) return null;
  const { rows } = await getPool().query(
    'SELECT tenant_id FROM orsyne_core.lookup_reservation_tenant($1)', [reservationId]);
  return rows[0]?.tenant_id ?? null;
}
