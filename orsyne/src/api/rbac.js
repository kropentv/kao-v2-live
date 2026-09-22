/**
 * Controle d'acces par role (section 3 du cahier des charges).
 *
 * Deux verrous distincts, qui ne se remplacent pas :
 *   - la PERMISSION dit ce que le role a le droit de faire ;
 *   - la PORTEE dit sur quel etablissement, et pour un serveur, sur
 *     quelles tables.
 *
 * Un serveur a la permission `reservations:read` mais une portee limitee
 * a son service : les deux sont verifiees, jamais l'une a la place de
 * l'autre.
 */

export const PERMISSIONS = {
  owner: [
    'restaurants:*', 'billing:*', 'analytics:*', 'staff:*', 'settings:*',
    'integrations:*', 'reservations:*', 'floor:*', 'guests:*', 'service:*',
  ],
  manager: [
    'reservations:*', 'floor:*', 'guests:*', 'staff:read', 'staff:schedule',
    'service:*', 'analytics:read', 'settings:read', 'restaurants:read',
  ],
  floor_manager: [
    'reservations:read', 'reservations:write', 'floor:*', 'guests:read',
    'guests:write', 'staff:read', 'service:*', 'restaurants:read',
  ],
  server: [
    // Volontairement etroit : le serveur voit son service, pas le CRM complet.
    'reservations:read', 'service:read', 'service:write',
    'guests:read_brief', 'floor:read', 'restaurants:read',
  ],
  kitchen: [
    'service:read', 'orders:read', 'orders:write', 'restaurants:read',
  ],
};

export function permissionsFor(memberships) {
  const set = new Set();
  for (const membership of memberships) {
    for (const permission of PERMISSIONS[membership.role] ?? []) set.add(permission);
  }
  return set;
}

export function hasPermission(permissions, required) {
  if (permissions.has(required)) return true;
  const [domain] = required.split(':');
  return permissions.has(`${domain}:*`);
}

/**
 * Etablissements accessibles. Une adhesion `restaurant_id NULL` porte sur
 * tout le tenant : le proprietaire d'un groupe n'a pas a etre rattache
 * manuellement a chaque nouvel etablissement.
 */
export function scopeFor(memberships) {
  const tenantWide = memberships.some((m) => m.restaurant_id == null);
  return {
    tenantWide,
    restaurantIds: tenantWide ? null : [...new Set(memberships.map((m) => m.restaurant_id))],
  };
}

/**
 * Verification PARTIELLE, volontairement.
 *
 * Une adhesion de portee tenant couvre « tous les etablissements de MON
 * tenant », jamais « tous les identifiants existants ». Cette fonction ne
 * peut pas trancher seule dans ce cas : l'appartenance de l'etablissement
 * au tenant se verifie en base, sous RLS (voir assertRestaurantInScope).
 *
 * @returns {true|'needs_tenant_check'|false}
 */
export function canAccessRestaurant(memberships, restaurantId) {
  const scope = scopeFor(memberships);
  if (!scope.tenantWide) return scope.restaurantIds.includes(restaurantId);
  return 'needs_tenant_check';
}

/** Role le plus eleve detenu sur un etablissement donne. */
const RANK = ['kitchen', 'server', 'floor_manager', 'manager', 'owner'];

export function highestRole(memberships, restaurantId = null) {
  const relevant = memberships.filter(
    (m) => m.restaurant_id == null || restaurantId == null || m.restaurant_id === restaurantId,
  );
  return relevant.reduce((best, m) =>
    RANK.indexOf(m.role) > RANK.indexOf(best) ? m.role : best, 'kitchen');
}

/** Un serveur ne voit que son propre service ; au-dessus, toute la salle. */
export function isServerOnly(memberships, restaurantId = null) {
  return highestRole(memberships, restaurantId) === 'server';
}
