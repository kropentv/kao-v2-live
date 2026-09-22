/**
 * Attribution des tables (section 8 du cahier des charges).
 *
 * Deux principes non negociables :
 *   1. Le moteur propose un ORDRE de candidats, il ne « reserve » rien.
 *      La reservation effective est faite par la base, sous contrainte.
 *   2. L'humain garde la main : un table_id impose par le manager
 *      court-circuite tout le scoring.
 */

/**
 * Candidats possibles pour une demande : chaque candidat est un ensemble
 * de tables (une seule le plus souvent, plusieurs pour une combinaison).
 *
 * @param {object} input
 * @param {Array}  input.tables            tables actives de l'etablissement
 * @param {Array}  input.combinations      combinaisons actives + leurs membres
 * @param {number} input.partySize
 * @param {string|null} input.requestedZoneId
 * @param {string|null} input.requestedTableId
 * @param {string[]} [input.guestPreferredAttributes]
 * @param {Map<string, Date|null>} [input.nextOccupiedAt] prochaine occupation par table
 * @param {Date}   [input.occupancyEnd]    fin de l'occupation demandee
 * @returns {Array<{tableIds: string[], seats: number, score: number, reason: string}>}
 */
export function rankAllocations(input) {
  const {
    tables,
    combinations = [],
    partySize,
    requestedZoneId = null,
    requestedTableId = null,
    guestPreferredAttributes = [],
    nextOccupiedAt = new Map(),
    occupancyEnd = null,
  } = input;

  const byId = new Map(tables.map((t) => [t.id, t]));
  const candidates = [];

  // --- Table imposee : candidat unique, aucune substitution silencieuse. ---
  if (requestedTableId) {
    const table = byId.get(requestedTableId);
    if (!table || partySize > table.seats_max) return [];
    return [{
      tableIds: [table.id],
      seats: table.seats_max,
      score: 0,
      reason: 'table demandee explicitement',
    }];
  }

  // --- Tables simples ---
  for (const table of tables) {
    if (partySize > table.seats_max) continue;
    // Une table de 6 pour 2 personnes reste possible, mais coutera cher au
    // scoring : c'est au moteur de l'eviter, pas au restaurant de l'interdire.
    candidates.push({
      tableIds: [table.id],
      seats: table.seats_max,
      seatsMin: table.seats_min,
      zoneId: table.zone_id,
      priority: table.priority,
      attributes: table.attributes ?? [],
      isCombination: false,
    });
  }

  // --- Combinaisons, pour les groupes qu'aucune table seule n'absorbe ---
  for (const combination of combinations) {
    if (partySize > combination.seats_max || partySize < combination.seats_min) continue;
    const members = combination.table_ids.map((id) => byId.get(id)).filter(Boolean);
    if (members.length !== combination.table_ids.length) continue;
    candidates.push({
      tableIds: combination.table_ids,
      seats: combination.seats_max,
      seatsMin: combination.seats_min,
      // Une combinaison prend la zone de ses membres si elle est homogene.
      zoneId: members.every((m) => m.zone_id === members[0].zone_id) ? members[0].zone_id : null,
      priority: combination.priority,
      attributes: [],
      isCombination: true,
    });
  }

  const scored = candidates.map((candidate) => {
    let score = 0;
    const reasons = [];

    // Sieges gaspilles : le critere dominant. Asseoir 2 personnes a une
    // table de 8 coute une table de 8 pour le service entier.
    const wasted = candidate.seats - partySize;
    score += wasted * 10;
    if (wasted === 0) reasons.push('capacite exacte');

    // Une table sous sa capacite minimale est mal dimensionnee (un bar de
    // 4 places ou l'on n'installe pas une personne seule, par exemple).
    if (partySize < candidate.seatsMin) score += 40;

    // Zone demandee par le client : forte preference, jamais une obligation.
    if (requestedZoneId) {
      if (candidate.zoneId === requestedZoneId) {
        score -= 50;
        reasons.push('zone demandee');
      } else {
        score += 60;
      }
    }

    // Preferences du profil CRM (terrasse, fenetre...).
    const matched = candidate.attributes.filter((a) => guestPreferredAttributes.includes(a));
    if (matched.length > 0) {
      score -= 15 * matched.length;
      reasons.push(`preference client: ${matched.join(', ')}`);
    }

    // Preference d'exploitation definie par le restaurant.
    score += (candidate.priority ?? 100) / 100;

    // Rotation : a qualite egale, on choisit la table dont la prochaine
    // reservation est la plus proche. On compacte le service au lieu de
    // fragmenter les grands creneaux libres.
    if (occupancyEnd) {
      const gaps = candidate.tableIds
        .map((id) => nextOccupiedAt.get(id))
        .filter((d) => d instanceof Date)
        .map((d) => (d.getTime() - occupancyEnd.getTime()) / 60_000);
      if (gaps.length > 0) {
        const minGap = Math.min(...gaps);
        score += Math.min(minGap, 240) / 30;
        reasons.push('rotation optimisee');
      } else {
        // Aucune reservation derriere : table plus « libre », legerement
        // moins prioritaire qu'une table deja engagee sur le service.
        score += 6;
      }
    }

    // Mobiliser plusieurs tables coute une flexibilite : dernier recours.
    if (candidate.isCombination) score += 25;

    return {
      tableIds: candidate.tableIds,
      seats: candidate.seats,
      score: Number(score.toFixed(3)),
      reason: reasons.length > 0 ? reasons.join(' · ') : 'meilleur compromis disponible',
    };
  });

  return scored.sort((a, b) => a.score - b.score || a.seats - b.seats);
}

/**
 * Choix du serveur pour une reservation (section 9).
 * Le serveur le moins charge parmi ceux qui couvrent la table gagne.
 *
 * @param {object} input
 * @param {Array} input.shifts  shifts couvrants, avec charge courante
 * @param {string[]} input.tableIds
 * @param {string|null} input.zoneId
 * @param {number} input.partySize
 */
export function rankServers({ shifts, tableIds, zoneId, partySize }) {
  const eligible = shifts.filter((shift) => {
    const coversTable = shift.table_ids?.some((id) => tableIds.includes(id));
    const coversZone = zoneId != null && shift.zone_ids?.includes(zoneId);
    // Un shift sans rang declare couvre toute la salle.
    const coversAll = (shift.table_ids?.length ?? 0) === 0 && (shift.zone_ids?.length ?? 0) === 0;
    return coversTable || coversZone || coversAll;
  });

  return eligible
    .map((shift) => {
      const maxTables = Math.max(1, Math.round((shift.max_tables ?? 6) * (shift.load_factor ?? 1)));
      const maxCovers = Math.max(1, Math.round((shift.max_covers ?? 24) * (shift.load_factor ?? 1)));
      const tableLoad = (shift.current_tables ?? 0) / maxTables;
      const coverLoad = ((shift.current_covers ?? 0) + partySize) / maxCovers;

      // Charge combinee : un serveur peut tenir beaucoup de petites tables
      // ou peu de grandes, jamais les deux.
      let score = tableLoad * 50 + coverLoad * 50;
      const reasons = [];

      // Depassement de capacite : fortement penalise, jamais interdit.
      // Un service complet doit rester attribuable.
      if ((shift.current_tables ?? 0) >= maxTables) score += 100;
      if ((shift.current_covers ?? 0) + partySize > maxCovers) score += 100;

      if (shift.table_ids?.some((id) => tableIds.includes(id))) {
        score -= 40;
        reasons.push('table dans son rang');
      } else if (zoneId != null && shift.zone_ids?.includes(zoneId)) {
        score -= 20;
        reasons.push('zone dans son rang');
      }

      return {
        userId: shift.user_id,
        shiftId: shift.id,
        score: Number(score.toFixed(3)),
        currentTables: shift.current_tables ?? 0,
        currentCovers: shift.current_covers ?? 0,
        reason: reasons.length > 0 ? reasons.join(' · ') : 'serveur le moins charge',
      };
    })
    .sort((a, b) => a.score - b.score);
}
