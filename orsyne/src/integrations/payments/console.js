import { randomUUID } from 'node:crypto';

/**
 * Prestataire de developpement : aucune somme ne circule.
 *
 * Il implemente exactement le meme contrat que Stripe pour que le reste
 * du produit ne sache jamais lequel des deux est branche. La page de
 * paiement est une page locale ou l'on clique « payer » — assez pour
 * derouler tout le parcours sans compte Stripe.
 */
export function createConsoleProvider({ publicUrl, log = console.log } = {}) {
  return {
    name: 'console',
    publicConfigured: false,

    async createCheckout({ reservation, mechanism, amountCents, currency, returnPath }) {
      const providerRef = `demo_${randomUUID()}`;
      log(`[paiement:demo] ${mechanism} ${(amountCents / 100).toFixed(2)} ${currency}`
        + ` pour ${reservation.reference} — aucun debit reel`);
      const params = new URLSearchParams({
        ref: reservation.reference,
        rid: reservation.id,
        pid: providerRef,
        montant: String(amountCents),
        devise: currency,
        mecanisme: mechanism,
        retour: returnPath,
      });
      return { url: `${publicUrl}/paiement-demo?${params}`, providerRef, sessionId: providerRef };
    },

    async capture({ amountCents }) { return { status: 'succeeded', capturedCents: amountCents ?? 0 }; },
    async release() { return { status: 'canceled' }; },
    async refund({ amountCents }) { return { status: 'succeeded', refundedCents: amountCents ?? 0 }; },

    verifyWebhook({ rawBody }) { return JSON.parse(rawBody); },

    interpretEvent(event) {
      if (!event?.type) return null;
      return {
        kind: event.type,
        reservationId: event.reservationId ?? null,
        providerRef: event.providerRef ?? null,
        mechanism: event.mechanism ?? 'deposit',
        amountCents: event.amountCents ?? 0,
        currency: event.currency ?? 'EUR',
        reason: event.reason ?? null,
      };
    },
  };
}
