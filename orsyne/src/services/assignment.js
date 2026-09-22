import { rankServers } from '../domain/allocation.js';
import { DomainError } from '../domain/errors.js';

/**
 * Attribution client -> table -> serveur (section 9).
 *
 * Le scoring vit dans le domaine (pur, teste unitairement) ; ce service
 * ne fait que lui fournir l'etat reel du service et enregistrer la
 * decision. L'attribution manuelle du manager remplace l'automatique sans
 * la supprimer : l'historique reste lisible pour mesurer la qualite des
 * propositions.
 */

/** Shifts couvrant un instant donne, avec leur charge courante reelle. */
export async function loadShiftLoad(client, { restaurantId, at }) {
  const { rows } = await client.query(
    `SELECT s.id, s.user_id,
            u.full_name, u.display_name,
            COALESCE(p.max_tables, 6)   AS max_tables,
            COALESCE(p.max_covers, 24)  AS max_covers,
            COALESCE(p.load_factor, 1)  AS load_factor,
            COALESCE(zs.zone_ids,  '{}') AS zone_ids,
            COALESCE(ts.table_ids, '{}') AS table_ids,
            COALESCE(load.tables, 0)    AS current_tables,
            COALESCE(load.covers, 0)    AS current_covers
       FROM shifts s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN staff_profiles p ON p.user_id = s.user_id AND p.restaurant_id = s.restaurant_id
       LEFT JOIN LATERAL (
         SELECT array_agg(zone_id) AS zone_ids FROM shift_zones WHERE shift_id = s.id
       ) zs ON true
       LEFT JOIN LATERAL (
         SELECT array_agg(table_id) AS table_ids FROM shift_tables WHERE shift_id = s.id
       ) ts ON true
       LEFT JOIN LATERAL (
         -- Charge reelle : ce que le serveur a deja sur les bras a cet
         -- instant, pas ce qui lui a ete attribue sur toute la soiree.
         SELECT count(DISTINCT a.reservation_id) AS tables,
                COALESCE(sum(r.party_size), 0)   AS covers
           FROM server_assignments a
           JOIN reservations r ON r.id = a.reservation_id
          WHERE a.user_id = s.user_id
            AND a.is_current
            AND r.status IN ('confirmed','arrived','seated')
            AND tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange($2::timestamptz - interval '90 minutes', $2::timestamptz + interval '90 minutes', '[)')
       ) load ON true
      WHERE s.restaurant_id = $1
        AND s.status <> 'cancelled'
        AND s.starts_at <= $2 AND s.ends_at > $2
        AND s.role IN ('server','floor_manager')`,
    [restaurantId, at],
  );
  return rows.map((row) => ({
    ...row,
    max_tables: Number(row.max_tables),
    max_covers: Number(row.max_covers),
    load_factor: Number(row.load_factor),
    current_tables: Number(row.current_tables),
    current_covers: Number(row.current_covers),
  }));
}

/** Propose un classement sans rien ecrire — utilise par le dashboard. */
export async function suggestServer(client, { restaurantId, reservationId }) {
  const { rows: [reservation] } = await client.query(
    `SELECT r.id, r.starts_at, r.party_size,
            array_agg(o.table_id) FILTER (WHERE o.table_id IS NOT NULL) AS table_ids,
            min(t.zone_id::text) AS zone_id
       FROM reservations r
       LEFT JOIN table_occupancies o ON o.reservation_id = r.id AND o.is_active
       LEFT JOIN restaurant_tables t ON t.id = o.table_id
      WHERE r.id = $1 GROUP BY r.id`,
    [reservationId],
  );
  if (!reservation) throw new DomainError('reservation_not_found', 'Reservation introuvable.');

  const shifts = await loadShiftLoad(client, { restaurantId, at: reservation.starts_at });
  if (shifts.length === 0) return { candidates: [], reason: 'aucun serveur en service sur ce creneau' };

  const candidates = rankServers({
    shifts,
    tableIds: reservation.table_ids ?? [],
    zoneId: reservation.zone_id,
    partySize: reservation.party_size,
  });
  const byId = new Map(shifts.map((s) => [s.user_id, s]));
  return {
    candidates: candidates.map((c) => ({
      ...c,
      name: byId.get(c.userId)?.display_name ?? byId.get(c.userId)?.full_name,
    })),
    reason: null,
  };
}

/** Attribue effectivement, en automatique ou sur decision humaine. */
export async function assignServer(client, { restaurantId, reservationId, userId = null, actorUserId = null }) {
  const suggestion = await suggestServer(client, { restaurantId, reservationId });
  const mode = userId ? 'manual' : 'auto';

  const chosen = userId
    ? { userId, score: null, reason: 'attribution manuelle' }
    : suggestion.candidates[0];

  if (!chosen) {
    throw new DomainError('no_server_available', suggestion.reason ?? 'Aucun serveur disponible.');
  }

  const { rows: [shift] } = await client.query(
    `SELECT s.id FROM shifts s
      JOIN reservations r ON r.id = $2
     WHERE s.restaurant_id = $1 AND s.user_id = $3
       AND s.starts_at <= r.starts_at AND s.ends_at > r.starts_at
       AND s.status <> 'cancelled' LIMIT 1`,
    [restaurantId, reservationId, chosen.userId],
  );

  const { rows: [{ tenant_id: tenantId }] } = await client.query(
    'SELECT tenant_id FROM reservations WHERE id = $1', [reservationId],
  );

  // L'ancienne attribution est archivee, pas ecrasee.
  await client.query(
    `UPDATE server_assignments SET is_current = false
      WHERE reservation_id = $1 AND is_current`,
    [reservationId],
  );
  const { rows: [assignment] } = await client.query(
    `INSERT INTO server_assignments
       (tenant_id, restaurant_id, reservation_id, user_id, shift_id, mode, score, reason, assigned_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      tenantId, restaurantId, reservationId, chosen.userId, shift?.id ?? null,
      mode, chosen.score, chosen.reason, actorUserId,
    ],
  );

  await client.query(
    `INSERT INTO notifications
       (tenant_id, restaurant_id, recipient_user_id, kind, title, body, payload, reservation_id)
     SELECT $1, $2, $3, 'table_assigned',
            'Nouvelle table — ' || COALESCE(string_agg(t.code, ' + '), 'à placer'),
            r.party_size || ' personnes · ' ||
              to_char(r.starts_at AT TIME ZONE rest.timezone, 'HH24:MI'),
            jsonb_build_object(
              'reservationId', r.id, 'reference', r.reference,
              'partySize', r.party_size, 'startsAt', r.starts_at,
              'tables', COALESCE(array_agg(t.code), '{}')),
            r.id
       FROM reservations r
       JOIN restaurants rest ON rest.id = r.restaurant_id
       LEFT JOIN table_occupancies o ON o.reservation_id = r.id AND o.is_active
       LEFT JOIN restaurant_tables t ON t.id = o.table_id
      WHERE r.id = $4
      GROUP BY r.id, rest.timezone`,
    [tenantId, restaurantId, chosen.userId, reservationId],
  );

  await client.query(
    `INSERT INTO outbox_events (tenant_id, restaurant_id, topic, payload)
     VALUES ($1,$2,'reservation.server_assigned',$3)`,
    [tenantId, restaurantId, JSON.stringify({
      reservationId, userId: chosen.userId, mode, score: chosen.score, reason: chosen.reason,
    })],
  );

  return { ...assignment, candidates: suggestion.candidates };
}

/**
 * Attribution « au mieux » : tente, et n'echoue jamais l'appelant.
 *
 * Une reservation sans serveur disponible reste une reservation valide —
 * typiquement une reservation prise trois semaines a l'avance, pour
 * laquelle aucun planning n'existe encore. Elle apparait « a attribuer »
 * dans le dashboard, et le manager ou une attribution ulterieure s'en
 * charge. Ne jamais faire echouer une table pour un probleme de planning.
 */
export async function tryAssignServer(client, options) {
  try {
    return await assignServer(client, options);
  } catch (error) {
    if (error.code === 'no_server_available' || error.code === 'reservation_not_found') return null;
    throw error;
  }
}

/** Charge par serveur pour le dashboard manager (section 18). */
export async function serviceLoad(client, { restaurantId, at = new Date() }) {
  const shifts = await loadShiftLoad(client, { restaurantId, at });
  return shifts
    .map((shift) => ({
      userId: shift.user_id,
      name: shift.display_name ?? shift.full_name,
      tables: shift.current_tables,
      covers: shift.current_covers,
      maxTables: Math.round(shift.max_tables * shift.load_factor),
      maxCovers: Math.round(shift.max_covers * shift.load_factor),
      loadPct: Math.round(
        Math.max(
          shift.current_tables / Math.max(1, shift.max_tables * shift.load_factor),
          shift.current_covers / Math.max(1, shift.max_covers * shift.load_factor),
        ) * 100,
      ),
    }))
    .sort((a, b) => b.loadPct - a.loadPct);
}
