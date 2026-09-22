/**
 * Conversions heure locale <-> instant UTC, sans dependance externe.
 *
 * Un restaurant raisonne en heure murale ("le service commence a 19h30").
 * La base raisonne en instants. Tout le produit passe par ces deux
 * fonctions pour que le passage a l'heure d'ete ne cree jamais de creneau
 * fantome ni de double creneau.
 */

/** Decalage du fuseau, en ms, a l'instant donne. */
function zoneOffsetMs(instant, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(instant).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  );
  return asUtc - instant.getTime();
}

/**
 * Heure murale locale -> instant UTC.
 * Deux passes : la premiere estime le decalage, la seconde le corrige si
 * l'estimation tombait du mauvais cote d'un changement d'heure.
 */
export function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0 }, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  let instant = naive - zoneOffsetMs(new Date(naive), timeZone);
  instant = naive - zoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

/** Instant UTC -> composantes de l'heure murale locale. */
export function utcToZonedParts(instant, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(instant).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  );
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    // Meme convention que Date#getDay : 0 = dimanche.
    dayOfWeek: weekdays[parts.weekday],
  };
}

/** 'YYYY-MM-DD' -> { year, month, day }. */
export function parseIsoDate(isoDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) throw new TypeError(`Date invalide: ${isoDate} (attendu YYYY-MM-DD)`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** 'HH:MM[:SS]' -> minutes depuis minuit. */
export function parseTimeToMinutes(time) {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!match) throw new TypeError(`Heure invalide: ${time} (attendu HH:MM)`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function addMinutes(instant, minutes) {
  return new Date(instant.getTime() + minutes * 60_000);
}

/** Jour de la semaine local (0 = dimanche), pour un couple date + fuseau. */
export function dayOfWeekInZone(isoDate, timeZone) {
  const { year, month, day } = parseIsoDate(isoDate);
  return utcToZonedParts(zonedTimeToUtc({ year, month, day, hour: 12 }, timeZone), timeZone).dayOfWeek;
}
