import { payments } from '../integrations/index.js';
import { DomainError } from '../domain/errors.js';
import { confirmPayment } from '../domain/reservation-engine.js';

/**
 * Paiements — le pont entre le moteur de reservation et le prestataire.
 *
 * Invariant du cahier des charges tenu ici : acompte, preautorisation et
 * paiement integral restent trois choses distinctes, de la politique
 * jusqu'a la ligne comptable. Une empreinte est `authorized` et n'a rien
 * encaisse ; un acompte est `captured`. On ne les additionne jamais.
 */

/** Ouvre le paiement et renvoie l'URL vers laquelle envoyer le client. */
export async function openCheckout(client, { reservationId, returnPath = '/' }) {
  const { rows: [r] } = await client.query(
    `SELECT res.id, res.reference, res.party_size, res.status, res.tenant_id, res.restaurant_id,
            res.guest_id, g.email AS guest_email,
            rest.name AS restaurant_name, rest.currency, rest.slug,
            p.mechanism, p.amount_mode, p.amount_cents
       FROM reservations res
       JOIN restaurants rest ON rest.id = res.restaurant_id
       LEFT JOIN guests g ON g.id = res.guest_id
       LEFT JOIN deposit_policies p ON p.id = res.deposit_policy_id
      WHERE res.id = $1`,
    [reservationId],
  );
  if (!r) throw new DomainError('reservation_not_found', 'Reservation introuvable.');
  if (!r.mechanism || r.mechanism === 'none') {
    throw new DomainError('no_payment_required', "Cette reservation n'exige aucun paiement.");
  }
  if (r.status !== 'pending_payment') {
    throw new DomainError('invalid_transition', "Cette reservation n'attend pas de paiement.");
  }

  const amountCents = r.amount_mode === 'per_person'
    ? r.amount_cents * r.party_size
    : r.amount_cents;

  const provider = payments();
  const checkout = await provider.createCheckout({
    reservation: { id: r.id, reference: r.reference },
    mechanism: r.mechanism,
    amountCents,
    currency: r.currency ?? 'EUR',
    guestEmail: r.guest_email,
    restaurantName: r.restaurant_name,
    returnPath: returnPath || `/r/${r.slug}`,
  });

  // On enregistre l'intention AVANT de renvoyer le client : si le
  // webhook arrive pendant qu'il paie, il trouve une ligne a mettre a
  // jour plutot que d'en creer une orpheline.
  await client.query(
    `INSERT INTO payment_intents
       (tenant_id, restaurant_id, reservation_id, guest_id, mechanism, provider,
        provider_ref, amount_cents, currency, status, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'requires_action',$10)
     ON CONFLICT (provider, provider_ref) WHERE provider_ref IS NOT NULL
     DO UPDATE SET amount_cents = EXCLUDED.amount_cents, updated_at = now()`,
    [
      r.tenant_id, r.restaurant_id, r.id, r.guest_id, r.mechanism, provider.name,
      checkout.providerRef, amountCents, r.currency ?? 'EUR',
      JSON.stringify({ sessionId: checkout.sessionId }),
    ],
  );

  return {
    url: checkout.url,
    providerRef: checkout.providerRef,
    mechanism: r.mechanism,
    amountCents,
    currency: r.currency ?? 'EUR',
  };
}

/**
 * Applique le resultat d'un paiement.
 *
 * Idempotent : un webhook peut arriver deux fois, ou dans le desordre.
 * On se fie a l'etat vise, jamais au fait d'avoir deja ete appele.
 */
export async function applyPaymentEvent(client, event) {
  if (!event?.reservationId) return { applied: false, reason: 'sans reservation' };

  const { rows: [reservation] } = await client.query(
    `SELECT id, tenant_id, restaurant_id, guest_id, status FROM reservations WHERE id = $1`,
    [event.reservationId],
  );
  if (!reservation) return { applied: false, reason: 'reservation introuvable' };

  if (event.kind === 'failed') {
    await upsertIntent(client, reservation, event, { status: 'failed', captured: 0 });
    return { applied: true, outcome: 'failed' };
  }

  // Une empreinte est autorisee, jamais encaissee : la distinction est
  // portee jusque dans le statut du paiement.
  const isHold = event.mechanism === 'preauthorization' || event.kind === 'authorized';
  await upsertIntent(client, reservation, event, {
    status: isHold ? 'authorized' : 'captured',
    captured: isHold ? 0 : event.amountCents ?? 0,
  });

  if (reservation.status === 'pending_payment') {
    await confirmPayment(client, { reservationId: reservation.id });
    return { applied: true, outcome: 'confirmed' };
  }
  return { applied: true, outcome: 'payment_recorded' };
}

async function upsertIntent(client, reservation, event, { status, captured }) {
  await client.query(
    `INSERT INTO payment_intents
       (tenant_id, restaurant_id, reservation_id, guest_id, mechanism, provider,
        provider_ref, amount_cents, currency, status, captured_amount_cents,
        authorized_at, captured_at, failure_reason)
     VALUES ($1,$2,$3,$4,$5::guarantee_mechanism,$6,$7,$8,$9,$10::payment_status,$11,
             CASE WHEN $10::payment_status IN ('authorized','captured') THEN now() END,
             CASE WHEN $10::payment_status = 'captured' THEN now() END, $12)
     ON CONFLICT (provider, provider_ref) WHERE provider_ref IS NOT NULL
     DO UPDATE SET
       status = EXCLUDED.status,
       captured_amount_cents = EXCLUDED.captured_amount_cents,
       authorized_at = COALESCE(payment_intents.authorized_at, EXCLUDED.authorized_at),
       captured_at   = COALESCE(payment_intents.captured_at, EXCLUDED.captured_at),
       failure_reason = EXCLUDED.failure_reason,
       updated_at = now()`,
    [
      reservation.tenant_id, reservation.restaurant_id, reservation.id, reservation.guest_id,
      event.mechanism ?? 'deposit', payments().name, event.providerRef,
      event.amountCents ?? 0, event.currency ?? 'EUR', status, captured,
      event.reason ?? null,
    ],
  );
}

/**
 * No-show : on capture l'empreinte, selon la politique du restaurant.
 * Un acompte deja encaisse n'est pas recapture — il est simplement
 * conserve, ce que la politique prevoit.
 */
export async function chargeNoShow(client, { reservationId }) {
  const { rows: [intent] } = await client.query(
    `SELECT pi.*, p.no_show_charge_cents
       FROM payment_intents pi
       JOIN reservations r ON r.id = pi.reservation_id
       LEFT JOIN deposit_policies p ON p.id = r.deposit_policy_id
      WHERE pi.reservation_id = $1 AND pi.status = 'authorized'
      ORDER BY pi.created_at DESC LIMIT 1`,
    [reservationId],
  );
  if (!intent) return { charged: false, reason: 'aucune empreinte a capturer' };

  const amount = intent.no_show_charge_cents ?? intent.amount_cents;
  const result = await payments().capture({ providerRef: intent.provider_ref, amountCents: amount });

  await client.query(
    `UPDATE payment_intents
        SET status = 'captured', captured_amount_cents = $2, captured_at = now()
      WHERE id = $1`,
    [intent.id, result.capturedCents || amount],
  );
  return { charged: true, amountCents: result.capturedCents || amount };
}

/** Annulation dans les delais : l'empreinte est relachee, l'acompte rendu. */
export async function releaseOrRefund(client, { reservationId }) {
  const { rows } = await client.query(
    `SELECT * FROM payment_intents
      WHERE reservation_id = $1 AND status IN ('authorized','captured')`,
    [reservationId],
  );
  const outcomes = [];
  for (const intent of rows) {
    if (intent.status === 'authorized') {
      await payments().release({ providerRef: intent.provider_ref });
      await client.query(
        `UPDATE payment_intents SET status = 'cancelled' WHERE id = $1`, [intent.id]);
      outcomes.push({ id: intent.id, outcome: 'empreinte relâchée' });
    } else {
      const refund = await payments().refund({
        providerRef: intent.provider_ref, amountCents: intent.captured_amount_cents,
      });
      await client.query(
        `UPDATE payment_intents
            SET status = 'refunded', refunded_amount_cents = $2, refunded_at = now()
          WHERE id = $1`,
        [intent.id, refund.refundedCents || intent.captured_amount_cents]);
      outcomes.push({ id: intent.id, outcome: 'remboursé' });
    }
  }
  return outcomes;
}

/** L'annulation est-elle encore gratuite au regard de la politique ? */
export async function cancellationIsFree(client, { reservationId, now = new Date() }) {
  const { rows: [row] } = await client.query(
    `SELECT r.starts_at, COALESCE(p.free_cancellation_hours, 24) AS hours
       FROM reservations r
       LEFT JOIN deposit_policies p ON p.id = r.deposit_policy_id
      WHERE r.id = $1`,
    [reservationId],
  );
  if (!row) return true;
  const limit = new Date(new Date(row.starts_at).getTime() - row.hours * 3_600_000);
  return now <= limit;
}
