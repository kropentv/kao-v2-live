import { createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../../domain/errors.js';

/**
 * Stripe, via son API REST.
 *
 * Aucun SDK : l'API de Stripe est stable, encodee en formulaire, et la
 * verification de signature tient en quelques lignes. Le produit garde
 * ainsi une seule dependance (pg), et brancher un autre prestataire ne
 * demande que d'ecrire le meme contrat.
 *
 * Les trois mecanismes du cahier des charges se traduisent ainsi :
 *   deposit          -> PaymentIntent capture immediatement
 *   preauthorization -> PaymentIntent en capture_method=manual (empreinte)
 *   full_payment     -> PaymentIntent capture immediatement
 */
const API = 'https://api.stripe.com/v1';

export function returnUrl(publicUrl, returnPath, reference, outcome) {
  const url = new URL(returnPath || '/', publicUrl);
  url.searchParams.set('ref', reference);
  url.searchParams.set('paiement', outcome);
  return url.toString();
}

function form(params, prefix = '') {
  const out = new URLSearchParams();
  const walk = (value, key) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${key}[${i}]`));
    else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, key ? `${key}[${k}]` : k);
    } else out.append(key, String(value));
  };
  walk(params, prefix);
  return out;
}

export function createStripeProvider({ secretKey, webhookSecret, publicUrl }) {
  if (!secretKey) throw new Error('Stripe: STRIPE_SECRET_KEY requis.');

  async function call(path, params, { method = 'POST', idempotencyKey = null } = {}) {
    const headers = {
      authorization: `Bearer ${secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    };
    // Une reservation ne doit jamais produire deux encaissements parce
    // qu'un appel a ete rejoue apres un timeout reseau.
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

    const response = await fetch(`${API}${path}`, {
      method,
      headers,
      body: method === 'GET' ? undefined : form(params ?? {}).toString(),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new DomainError(
        'payment_provider_error',
        body?.error?.message ?? `Stripe a refuse l'operation (${response.status}).`,
        { status: response.status, type: body?.error?.type, code: body?.error?.code },
      );
    }
    return body;
  }

  return {
    name: 'stripe',
    publicConfigured: true,

    /**
     * Ouvre une session de paiement hebergee par Stripe et renvoie l'URL
     * vers laquelle envoyer le client. On ne touche jamais au numero de
     * carte : c'est ce qui garde le produit hors du perimetre PCI lourd.
     */
    async createCheckout({ reservation, mechanism, amountCents, currency, guestEmail, restaurantName, returnPath }) {
      const isHold = mechanism === 'preauthorization';
      const label = {
        deposit: `Acompte — ${restaurantName}`,
        preauthorization: `Empreinte bancaire — ${restaurantName}`,
        full_payment: `Règlement — ${restaurantName}`,
      }[mechanism] ?? `Réservation — ${restaurantName}`;

      const session = await call('/checkout/sessions', {
        mode: 'payment',
        currency: currency.toLowerCase(),
        customer_email: guestEmail || undefined,
        client_reference_id: reservation.id,
        success_url: returnUrl(publicUrl, returnPath, reservation.reference, 'ok'),
        cancel_url: returnUrl(publicUrl, returnPath, reservation.reference, 'annule'),
        line_items: [{
          quantity: 1,
          price_data: {
            currency: currency.toLowerCase(),
            unit_amount: amountCents,
            product_data: { name: label },
          },
        }],
        payment_intent_data: {
          // L'empreinte autorise sans debiter : on ne capture qu'en cas
          // de no-show, selon la politique du restaurant.
          capture_method: isHold ? 'manual' : 'automatic',
          metadata: {
            orsyne_reservation_id: reservation.id,
            orsyne_reference: reservation.reference,
            orsyne_mechanism: mechanism,
          },
        },
        metadata: {
          orsyne_reservation_id: reservation.id,
          orsyne_reference: reservation.reference,
          orsyne_mechanism: mechanism,
        },
      }, { idempotencyKey: `checkout_${reservation.id}` });

      return { url: session.url, providerRef: session.payment_intent ?? session.id, sessionId: session.id };
    },

    /** Capture une empreinte : le no-show est facture, pas avant. */
    async capture({ providerRef, amountCents }) {
      const intent = await call(`/payment_intents/${providerRef}/capture`,
        amountCents ? { amount_to_capture: amountCents } : {},
        { idempotencyKey: `capture_${providerRef}_${amountCents ?? 'full'}` });
      return { status: intent.status, capturedCents: intent.amount_received ?? 0 };
    },

    /** Annule une empreinte non capturee — le client n'est jamais debite. */
    async release({ providerRef }) {
      const intent = await call(`/payment_intents/${providerRef}/cancel`, {},
        { idempotencyKey: `cancel_${providerRef}` });
      return { status: intent.status };
    },

    async refund({ providerRef, amountCents }) {
      const refund = await call('/refunds', {
        payment_intent: providerRef,
        amount: amountCents ?? undefined,
      }, { idempotencyKey: `refund_${providerRef}_${amountCents ?? 'full'}` });
      return { status: refund.status, refundedCents: refund.amount ?? 0 };
    },

    /**
     * Verifie la signature d'un webhook.
     *
     * Sans cette verification, n'importe qui pourrait confirmer une
     * reservation en appelant l'URL : le corps brut et la signature sont
     * donc indispensables, et la tolerance temporelle bloque le rejeu.
     */
    verifyWebhook({ rawBody, signatureHeader, toleranceSeconds = 300, now = Date.now() }) {
      if (!webhookSecret) throw new DomainError('webhook_unverifiable', 'STRIPE_WEBHOOK_SECRET absent.');
      if (!signatureHeader) throw new DomainError('webhook_invalid', 'Signature absente.');

      const parts = Object.fromEntries(
        signatureHeader.split(',').map((p) => p.split('=').map((s) => s.trim())),
      );
      const timestamp = Number(parts.t);
      if (!Number.isFinite(timestamp)) throw new DomainError('webhook_invalid', 'Horodatage illisible.');
      if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) {
        throw new DomainError('webhook_invalid', 'Signature expiree.');
      }

      const expected = createHmac('sha256', webhookSecret)
        .update(`${timestamp}.${rawBody}`)
        .digest('hex');
      const received = parts.v1 ?? '';
      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(received, 'utf8');
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new DomainError('webhook_invalid', 'Signature invalide.');
      }
      return JSON.parse(rawBody);
    },

    /** Traduit un evenement Stripe en intention metier, ou null. */
    interpretEvent(event) {
      const object = event?.data?.object ?? {};
      const reservationId = object.metadata?.orsyne_reservation_id
        ?? object.payment_intent_data?.metadata?.orsyne_reservation_id
        ?? null;

      switch (event?.type) {
        case 'checkout.session.completed':
          return {
            kind: 'authorized_or_captured',
            reservationId: object.client_reference_id ?? reservationId,
            providerRef: object.payment_intent ?? object.id,
            mechanism: object.metadata?.orsyne_mechanism ?? 'deposit',
            amountCents: object.amount_total ?? 0,
            currency: (object.currency ?? 'eur').toUpperCase(),
          };
        case 'payment_intent.amount_capturable_updated':
          return {
            kind: 'authorized', reservationId, providerRef: object.id,
            mechanism: 'preauthorization',
            amountCents: object.amount_capturable ?? object.amount ?? 0,
            currency: (object.currency ?? 'eur').toUpperCase(),
          };
        case 'payment_intent.succeeded':
          return {
            kind: 'captured', reservationId, providerRef: object.id,
            mechanism: object.metadata?.orsyne_mechanism ?? 'deposit',
            amountCents: object.amount_received ?? object.amount ?? 0,
            currency: (object.currency ?? 'eur').toUpperCase(),
          };
        case 'payment_intent.payment_failed':
        case 'checkout.session.expired':
          return {
            kind: 'failed',
            reservationId: object.client_reference_id ?? reservationId,
            providerRef: object.payment_intent ?? object.id,
            reason: object.last_payment_error?.message ?? 'paiement non abouti',
          };
        default:
          return null;
      }
    },
  };
}
