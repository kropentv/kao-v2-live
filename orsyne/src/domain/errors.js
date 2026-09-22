/** Erreur metier : porte un code stable, destine a l'API et a l'IA. */
export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export class NoAvailabilityError extends DomainError {
  constructor(details = {}) {
    super('no_availability', "Aucune table disponible pour cette demande.", details);
    this.name = 'NoAvailabilityError';
  }
}

export class TableUnavailableError extends DomainError {
  constructor(details = {}) {
    super('table_unavailable', "La table demandee n'est plus disponible.", details);
    this.name = 'TableUnavailableError';
  }
}

export class RestaurantClosedError extends DomainError {
  constructor(details = {}) {
    super('restaurant_closed', "Le restaurant n'accepte pas de reservation sur ce creneau.", details);
    this.name = 'RestaurantClosedError';
  }
}

export class BookingRuleError extends DomainError {
  constructor(message, details = {}) {
    super('booking_rule_violation', message, details);
    this.name = 'BookingRuleError';
  }
}

export class InvalidTransitionError extends DomainError {
  constructor(from, to) {
    super('invalid_transition', `Transition ${from} -> ${to} interdite.`, { from, to });
    this.name = 'InvalidTransitionError';
  }
}

/** Violation de la contrainte d'exclusion GiST sur table_occupancies. */
export const PG_EXCLUSION_VIOLATION = '23P01';
