-- =====================================================================
-- ORSYNE — 0004 Moteur de reservation
--
-- Piece maitresse du produit. La garantie « deux clients ne peuvent
-- jamais obtenir la meme table » n'est PAS confiee au code applicatif :
-- elle est portee par une contrainte d'exclusion GiST sur
-- table_occupancies. Meme un bug, un script manuel ou un second service
-- ecrivant en direct dans la base ne peut pas la contourner.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Politiques d'acompte. Les trois mecanismes financiers sont distincts
-- et ne doivent jamais etre confondus (section 6) :
--   deposit          — somme encaissee immediatement, deduite ou remboursee
--   preauthorization — empreinte bancaire, capturee seulement en cas de no-show
--   full_payment     — evenement paye integralement a la reservation
-- ---------------------------------------------------------------------
CREATE TYPE guarantee_mechanism AS ENUM ('none', 'deposit', 'preauthorization', 'full_payment');
CREATE TYPE amount_mode        AS ENUM ('fixed', 'per_person');

CREATE TABLE deposit_policies (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  restaurant_id         uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  -- Conditions (NULL = ce critere n'est pas contraignant).
  days_of_week          int[],
  time_from             time,
  time_to               time,
  party_size_min        int,
  party_size_max        int,
  zone_id               uuid REFERENCES zones(id) ON DELETE CASCADE,
  table_id              uuid REFERENCES restaurant_tables(id) ON DELETE CASCADE,
  -- Effet.
  mechanism             guarantee_mechanism NOT NULL,
  amount_mode           amount_mode NOT NULL DEFAULT 'fixed',
  amount_cents          int NOT NULL DEFAULT 0,
  currency              char(3) NOT NULL DEFAULT 'EUR',
  -- Politique d'annulation : gratuite jusqu'a N heures avant l'arrivee.
  free_cancellation_hours int NOT NULL DEFAULT 24,
  no_show_charge_cents  int,          -- NULL = on retient la totalite
  priority              int NOT NULL DEFAULT 100,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, name),
  CONSTRAINT amount_positive CHECK (amount_cents >= 0)
);
CREATE INDEX deposit_policies_lookup_idx ON deposit_policies (tenant_id, restaurant_id, priority)
  WHERE is_active;
SELECT orsyne_core.apply_tenant_rls('deposit_policies');

-- ---------------------------------------------------------------------
-- Reservations
-- ---------------------------------------------------------------------
CREATE TYPE reservation_status AS ENUM (
  'draft',            -- panier en cours cote client
  'pending_payment',  -- table tenue le temps du paiement de l'acompte
  'pending_approval', -- demande de groupe a valider par le restaurant
  'confirmed',
  'arrived',          -- client present, pas encore installe
  'seated',
  'completed',
  'cancelled',
  'no_show'
);

CREATE TYPE reservation_source AS ENUM (
  'widget', 'phone_ai', 'phone_staff', 'walk_in', 'staff', 'partner', 'google', 'import'
);

CREATE TABLE reservations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  restaurant_id       uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  reference           text NOT NULL,             -- code lisible communique au client
  guest_id            uuid REFERENCES guests(id) ON DELETE SET NULL,
  service_period_id   uuid REFERENCES service_periods(id) ON DELETE SET NULL,

  party_size          int NOT NULL,
  starts_at           timestamptz NOT NULL,
  duration_minutes    int NOT NULL,
  -- Fin de reservation, toujours coherente avec starts_at. Maintenue par
  -- un trigger (et non par une colonne generee : `timestamptz + interval`
  -- n'est que STABLE, Postgres la refuse dans une expression generee).
  -- Aucun code applicatif n'a le droit de l'ecrire.
  ends_at             timestamptz NOT NULL DEFAULT now(),

  status              reservation_status NOT NULL DEFAULT 'draft',
  source              reservation_source NOT NULL DEFAULT 'widget',
  locale              text NOT NULL DEFAULT 'fr-FR',

  -- Souhait exprime par le client (section 5). La table reellement
  -- attribuee vit dans table_occupancies : le souhait n'est pas l'attribution.
  requested_zone_id   uuid REFERENCES zones(id) ON DELETE SET NULL,
  requested_table_id  uuid REFERENCES restaurant_tables(id) ON DELETE SET NULL,
  occasion            text,
  guest_notes         text,        -- ecrit par le client
  staff_notes         text,        -- interne

  deposit_policy_id   uuid REFERENCES deposit_policies(id) ON DELETE SET NULL,

  arrived_at          timestamptz,
  seated_at           timestamptz,
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  cancellation_reason text,
  cancelled_by        text,        -- guest | staff | system
  no_show_at          timestamptz,

  created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE (restaurant_id, reference),
  CONSTRAINT party_size_positive CHECK (party_size > 0),
  CONSTRAINT duration_positive   CHECK (duration_minutes > 0)
);
CREATE INDEX reservations_service_idx
  ON reservations (tenant_id, restaurant_id, starts_at);
-- Index dedie au plan de service du jour (le plus sollicite du produit).
CREATE INDEX reservations_active_idx
  ON reservations (restaurant_id, starts_at)
  WHERE status IN ('pending_payment', 'confirmed', 'arrived', 'seated');
CREATE INDEX reservations_guest_idx ON reservations (tenant_id, guest_id, starts_at DESC);
-- ends_at est derive, jamais saisi : toute ecriture est recalculee.
CREATE OR REPLACE FUNCTION orsyne_core.sync_reservation_end() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.ends_at := NEW.starts_at + make_interval(mins => NEW.duration_minutes);
  RETURN NEW;
END
$$;
CREATE TRIGGER reservations_sync_end BEFORE INSERT OR UPDATE OF starts_at, duration_minutes
  ON reservations FOR EACH ROW EXECUTE FUNCTION orsyne_core.sync_reservation_end();

CREATE TRIGGER reservations_touch BEFORE UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION orsyne_core.touch_updated_at();
SELECT orsyne_core.apply_tenant_rls('reservations');

-- ---------------------------------------------------------------------
-- OCCUPATION DES TABLES — la garantie d'unicite du produit.
--
-- Bornes '[)' : une reservation qui finit a 21h00 et une autre qui
-- commence a 21h00 ne se chevauchent pas. Le battement de remise en place
-- (turn_buffer_minutes) est integre a l'intervalle par le moteur, pas
-- laisse a l'interpretation de la contrainte.
-- ---------------------------------------------------------------------
CREATE TYPE occupancy_kind AS ENUM (
  'reservation',  -- reservation confirmee ou en cours
  'walk_in',      -- client sans reservation installe en direct
  'hold',         -- maintien temporaire pendant le paiement de l'acompte
  'block'         -- table neutralisee : travaux, privatisation, nettoyage
);

CREATE TABLE table_occupancies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id        uuid NOT NULL REFERENCES restaurant_tables(id) ON DELETE CASCADE,
  reservation_id  uuid REFERENCES reservations(id) ON DELETE CASCADE,
  kind            occupancy_kind NOT NULL DEFAULT 'reservation',
  occupied_during tstzrange NOT NULL,
  -- Un hold non converti expire : un panier abandonne ne bloque pas la salle.
  expires_at      timestamptz,
  -- Libere par annulation, no-show ou fin de service. Une ligne inactive
  -- reste en base pour l'audit mais ne bloque plus rien.
  is_active       boolean NOT NULL DEFAULT true,
  released_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT occupancy_range_valid CHECK (NOT isempty(occupied_during)),
  CONSTRAINT occupancy_reservation_link CHECK (
    (kind IN ('reservation', 'hold') AND reservation_id IS NOT NULL)
    OR kind IN ('walk_in', 'block')
  ),
  -- ============================================================
  -- INVARIANT CENTRAL : une table, un convive, a un instant donne.
  -- ============================================================
  CONSTRAINT table_occupancies_no_overlap EXCLUDE USING gist (
    table_id WITH =,
    occupied_during WITH &&
  ) WHERE (is_active)
);
CREATE INDEX occupancies_reservation_idx ON table_occupancies (reservation_id);
CREATE INDEX occupancies_service_idx
  ON table_occupancies USING gist (table_id, occupied_during) WHERE is_active;
CREATE INDEX occupancies_expiry_idx ON table_occupancies (expires_at)
  WHERE is_active AND kind = 'hold';
SELECT orsyne_core.apply_tenant_rls('table_occupancies');

-- ---------------------------------------------------------------------
-- Historique de statut : reconstruire « ce qui s'est passe pendant le
-- service » sans dependre des logs applicatifs.
-- ---------------------------------------------------------------------
CREATE TABLE reservation_status_history (
  id             bigserial PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reservation_id uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  from_status    reservation_status,
  to_status      reservation_status NOT NULL,
  actor_kind     text NOT NULL DEFAULT 'system',
  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  reason         text,
  occurred_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reservation_history_idx
  ON reservation_status_history (tenant_id, reservation_id, occurred_at);
SELECT orsyne_core.apply_tenant_rls('reservation_status_history');
GRANT USAGE, SELECT ON SEQUENCE reservation_status_history_id_seq TO orsyne_app;

-- ---------------------------------------------------------------------
-- Paiements. Une ligne = un mecanisme. On ne melange jamais un acompte
-- et une preautorisation sur le meme enregistrement.
-- ---------------------------------------------------------------------
CREATE TYPE payment_status AS ENUM (
  'requires_action', 'authorized', 'captured', 'cancelled', 'refunded',
  'partially_refunded', 'failed', 'expired'
);

CREATE TABLE payment_intents (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  restaurant_id        uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  reservation_id       uuid REFERENCES reservations(id) ON DELETE SET NULL,
  guest_id             uuid REFERENCES guests(id) ON DELETE SET NULL,
  mechanism            guarantee_mechanism NOT NULL,
  provider             text NOT NULL DEFAULT 'stripe',
  provider_ref         text,
  amount_cents         int NOT NULL,
  currency             char(3) NOT NULL DEFAULT 'EUR',
  status               payment_status NOT NULL DEFAULT 'requires_action',
  captured_amount_cents int NOT NULL DEFAULT 0,
  refunded_amount_cents int NOT NULL DEFAULT 0,
  authorized_at        timestamptz,
  captured_at          timestamptz,
  refunded_at          timestamptz,
  expires_at           timestamptz,
  failure_reason       text,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_mechanism_real CHECK (mechanism <> 'none'),
  CONSTRAINT payment_amounts_coherent CHECK (
    captured_amount_cents >= 0
    AND refunded_amount_cents >= 0
    AND captured_amount_cents <= amount_cents
    AND refunded_amount_cents <= captured_amount_cents
  )
);
CREATE UNIQUE INDEX payment_provider_ref_unique
  ON payment_intents (provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX payments_reservation_idx ON payment_intents (tenant_id, reservation_id);
CREATE TRIGGER payment_intents_touch BEFORE UPDATE ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION orsyne_core.touch_updated_at();
SELECT orsyne_core.apply_tenant_rls('payment_intents');

-- ---------------------------------------------------------------------
-- Liste d'attente (section 22).
-- ---------------------------------------------------------------------
CREATE TYPE waitlist_status AS ENUM (
  'waiting', 'offered', 'accepted', 'declined', 'expired', 'converted', 'cancelled'
);

CREATE TABLE waitlist_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  guest_id          uuid REFERENCES guests(id) ON DELETE SET NULL,
  party_size        int NOT NULL,
  -- Fenetre acceptable par le client, pas un horaire ferme.
  desired_from      timestamptz NOT NULL,
  desired_to        timestamptz NOT NULL,
  requested_zone_id uuid REFERENCES zones(id) ON DELETE SET NULL,
  status            waitlist_status NOT NULL DEFAULT 'waiting',
  priority          int NOT NULL DEFAULT 100,
  offered_at        timestamptz,
  offer_expires_at  timestamptz,
  offered_reservation_id uuid REFERENCES reservations(id) ON DELETE SET NULL,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT waitlist_window_valid CHECK (desired_to > desired_from),
  CONSTRAINT waitlist_party_positive CHECK (party_size > 0)
);
CREATE INDEX waitlist_active_idx
  ON waitlist_entries (tenant_id, restaurant_id, desired_from)
  WHERE status IN ('waiting', 'offered');
CREATE TRIGGER waitlist_touch BEFORE UPDATE ON waitlist_entries
  FOR EACH ROW EXECUTE FUNCTION orsyne_core.touch_updated_at();
SELECT orsyne_core.apply_tenant_rls('waitlist_entries');
