/**
 * Identification et enrichissement du profil client.
 *
 * Point sensible du produit : une allergie declaree par le client doit
 * devenir une donnee STRUCTUREE, pas une note libre. Une note libre ne
 * declenche aucune alerte, n'est pas memorisee d'une visite a l'autre, et
 * peut etre tronquee a l'affichage. Sur un sujet ou l'erreur envoie
 * quelqu'un a l'hopital, c'est inacceptable.
 */

/**
 * Les 14 allergenes a declaration obligatoire (reglement UE 1169/2011).
 * La liste sert de suggestions ; le client peut toujours en saisir une
 * autre, et rien n'est filtre a la saisie.
 */
export const EU_ALLERGENS = [
  'Gluten', 'Crustacés', 'Œufs', 'Poissons', 'Arachides', 'Soja',
  'Lait / lactose', 'Fruits à coque', 'Céleri', 'Moutarde',
  'Graines de sésame', 'Sulfites', 'Lupin', 'Mollusques',
];

const MAX_ALLERGIES = 12;
const MAX_LENGTH = 80;

/** Nettoie et deduplique une liste d'allergies venue d'un formulaire. */
export function normalizeAllergies(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim().replace(/\s+/g, ' ').slice(0, MAX_LENGTH);
    if (!value) continue;
    const key = value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= MAX_ALLERGIES) break;
  }
  return out;
}

/**
 * Enregistre les allergies comme preferences critiques.
 *
 * `source` distingue une declaration du client d'une saisie par l'equipe.
 * Le serveur en salle doit savoir si l'information a ete confirmee de
 * vive voix ou simplement cochee dans un formulaire — les deux ne
 * meritent pas la meme confiance au moment de conseiller un plat.
 */
export async function recordAllergies(client, { tenantId, guestId, allergies, source = 'guest_declared', createdBy = null }) {
  const values = normalizeAllergies(allergies);
  if (!guestId || values.length === 0) return [];

  const recorded = [];
  for (const value of values) {
    const { rows: [row] } = await client.query(
      `INSERT INTO guest_preferences (tenant_id, guest_id, kind, value, source, is_critical, created_by)
       VALUES ($1, $2, 'allergy', $3, $4, true, $5)
       ON CONFLICT (guest_id, kind, value) DO UPDATE SET
         is_critical = true,
         -- Une saisie par l'equipe prime : elle vaut confirmation de
         -- vive voix, on ne la retrograde jamais en simple declaration.
         source = CASE WHEN guest_preferences.source = 'staff_entered'
                       THEN guest_preferences.source ELSE EXCLUDED.source END
       RETURNING id, value, source`,
      [tenantId, guestId, value, source, createdBy],
    );
    recorded.push(row);
  }
  return recorded;
}

/**
 * Deduplication du client sur le telephone puis l'email.
 * On complete un profil existant sans jamais ecraser une valeur par un
 * vide : une reservation rapide ne doit pas appauvrir le CRM.
 */
export async function upsertGuest(client, tenantId, guest) {
  const phone = guest.phone?.trim() || null;
  const email = guest.email?.trim() || null;
  if (!phone && !email) return null;

  const { rows: existing } = await client.query(
    `SELECT id FROM guests
      WHERE tenant_id = $1 AND anonymized_at IS NULL
        AND (($2::text IS NOT NULL AND phone_e164 = $2)
          OR ($3::citext IS NOT NULL AND email = $3))
      LIMIT 1`,
    [tenantId, phone, email],
  );

  if (existing.length > 0) {
    const { rows } = await client.query(
      `UPDATE guests SET
         first_name = COALESCE($2, first_name),
         last_name  = COALESCE($3, last_name),
         email      = COALESCE(email, $4),
         phone_e164 = COALESCE(phone_e164, $5),
         locale     = COALESCE($6, locale)
       WHERE id = $1 RETURNING id`,
      [existing[0].id, guest.firstName ?? null, guest.lastName ?? null, email, phone, guest.locale ?? null],
    );
    return rows[0].id;
  }

  const { rows } = await client.query(
    `INSERT INTO guests (tenant_id, first_name, last_name, email, phone_e164, locale, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [tenantId, guest.firstName ?? null, guest.lastName ?? null, email, phone,
     guest.locale ?? 'fr-FR', guest.source ?? 'widget'],
  );
  return rows[0].id;
}
