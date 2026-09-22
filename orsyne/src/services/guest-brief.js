/**
 * Note de briefing serveur (section 13).
 *
 * Regle de conception : on ne montre PAS le CRM. On selectionne les
 * quelques informations qui changent le service dans les trente secondes
 * qui viennent, et rien d'autre. Un serveur en plein coup de feu lit
 * trois lignes, pas un profil.
 *
 * Deux garde-fous :
 *   - une allergie passe toujours, meme si le quota de lignes est atteint ;
 *   - une deduction IA est marquee comme telle et formulee au conditionnel,
 *     jamais presentee comme un fait.
 */

const MAX_LINES = 4;

export async function buildGuestBrief(client, { guestId, restaurantId, maxLines = MAX_LINES }) {
  const { rows: [guest] } = await client.query(
    `SELECT id, first_name, last_name, locale, vip FROM guests WHERE id = $1`, [guestId],
  );
  if (!guest) return null;

  const { rows: [stats] } = await client.query(
    `SELECT visits, no_shows, last_visit_at FROM guest_restaurant_stats
      WHERE guest_id = $1 AND restaurant_id = $2`,
    [guestId, restaurantId],
  );
  const { rows: preferences } = await client.query(
    `SELECT kind, value, is_critical, source FROM guest_preferences
      WHERE guest_id = $1 ORDER BY is_critical DESC, kind`,
    [guestId],
  );
  const { rows: facts } = await client.query(
    `SELECT subject, occurrences FROM guest_facts
      WHERE guest_id = $1 AND (restaurant_id = $2 OR restaurant_id IS NULL)
      ORDER BY occurrences DESC LIMIT 3`,
    [guestId, restaurantId],
  );
  const { rows: insights } = await client.query(
    `SELECT statement, confidence FROM guest_insights
      WHERE guest_id = $1 AND status IN ('proposed','accepted')
        AND (expires_at IS NULL OR expires_at > now())
      ORDER BY confidence DESC LIMIT 1`,
    [guestId],
  );

  const critical = [];
  const useful = [];

  // 1. Ce qui peut blesser quelqu'un passe avant tout le reste.
  for (const preference of preferences.filter((p) => p.is_critical)) {
    critical.push({
      icon: preference.kind === 'allergy' ? '⚠️' : '🚫',
      text: preference.kind === 'allergy' ? `Allergie : ${preference.value}` : preference.value,
      kind: 'critical',
      // Une allergie cochee dans un formulaire n'a pas ete confirmee de
      // vive voix. Le serveur doit le savoir avant de conseiller un plat :
      // on l'affiche, on ne le devine pas.
      source: preference.source,
      needsConfirmation: preference.source === 'guest_declared',
    });
  }

  // 2. Le statut du client : ce qui change le ton de l'accueil.
  const visits = stats?.visits ?? 0;
  if (guest.vip) {
    useful.push({ icon: '⭐', text: 'Client VIP', kind: 'fact' });
  } else if (visits >= 10) {
    useful.push({ icon: '🏅', text: `${visits + 1}e visite — habitué`, kind: 'fact' });
  } else if (visits >= 3) {
    useful.push({ icon: '👋', text: `${visits + 1}e visite`, kind: 'fact' });
  } else if (visits === 0) {
    useful.push({ icon: '✨', text: 'Première visite', kind: 'fact' });
  }

  // 3. La langue, seulement si elle change quelque chose.
  if (guest.locale && !guest.locale.startsWith('fr')) {
    useful.push({
      icon: '🗣️', kind: 'fact',
      text: `Parle ${languageName(guest.locale)} — accueil dans sa langue`,
    });
  }

  // 4. Habitudes mesurees d'abord : un fait chiffre vaut mieux qu'une
  // preference declaree sur le meme sujet.
  const covered = new Set();
  for (const fact of facts) {
    if (fact.occurrences < 2) continue;
    const subject = prettySubject(fact.subject);
    covered.add(normalize(subject));
    useful.push({
      icon: '🍽️', kind: 'fact',
      text: `${subject} — commandé ${fact.occurrences} fois`,
    });
  }

  // 5. Preferences non critiques, sauf celles qu'un fait dit deja mieux :
  // le serveur n'a pas besoin de lire deux fois « entrecote ».
  for (const preference of preferences.filter((p) => !p.is_critical)) {
    const label = prettyPreference(preference.kind, preference.value);
    if (covered.has(normalize(label))) continue;
    covered.add(normalize(label));
    useful.push({ icon: iconFor(preference.kind), text: label, kind: 'fact' });
  }

  // 6. Une seule suggestion IA, explicitement signalee comme telle.
  const suggestion = insights[0] && {
    icon: '💡',
    text: insights[0].statement,
    kind: 'inference',
    confidence: Number(insights[0].confidence),
  };

  const lines = [...critical, ...useful].slice(0, Math.max(critical.length, maxLines));

  return {
    guestId: guest.id,
    title: [guest.first_name, guest.last_name].filter(Boolean).join(' ') || 'Client',
    subtitle: visits > 0 ? `${visits} visite${visits > 1 ? 's' : ''}` : 'Nouveau client',
    lines,
    // La suggestion est separee des lignes : l'interface doit pouvoir la
    // rendre differemment, jamais la melanger aux faits.
    suggestion: suggestion ?? null,
    hasCritical: critical.length > 0,
    // Au moins une allergie vient d'un formulaire et reste a confirmer.
    needsAllergyConfirmation: critical.some((line) => line.needsConfirmation),
  };
}

/**
 * Les preferences de table et de zone sont stockees avec le meme
 * vocabulaire que les attributs des tables ('outdoor', 'window'), pour
 * que le moteur d'attribution puisse les rapprocher. Ce vocabulaire est
 * technique : on ne le montre jamais tel quel a un serveur.
 */
const ATTRIBUTE_LABELS = {
  outdoor: 'Préfère la terrasse',
  window: 'Préfère une table en fenêtre',
  quiet: 'Préfère un coin calme',
  counter: 'Préfère le comptoir',
  booth: 'Préfère une banquette',
  accessible: 'Accès facilité nécessaire',
  private: 'Préfère un espace privatif',
};

function prettyPreference(kind, value) {
  if (kind === 'table' || kind === 'zone') {
    return ATTRIBUTE_LABELS[value.toLowerCase()] ?? `Préfère ${value}`;
  }
  return value;
}

/** Comparaison tolerante aux accents et a la casse, pour dedupliquer. */
function normalize(text) {
  return String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function iconFor(kind) {
  return {
    diet: '🥗', table: '🪑', zone: '🌳', drink: '🍷',
    dish: '🍽️', occasion: '🎉', service: '🛎️',
  }[kind] ?? '•';
}

function prettySubject(subject) {
  const value = subject.includes(':') ? subject.split(':').slice(1).join(':') : subject;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function languageName(locale) {
  const names = {
    en: 'anglais', es: 'espagnol', it: 'italien', de: 'allemand',
    pt: 'portugais', nl: 'néerlandais', ar: 'arabe', zh: 'chinois', ja: 'japonais',
  };
  return names[locale.slice(0, 2).toLowerCase()] ?? locale;
}
