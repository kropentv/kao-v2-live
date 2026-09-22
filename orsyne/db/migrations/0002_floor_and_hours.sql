-- =====================================================================
-- ORSYNE — 0002 Plan de salle, horaires, regles de reservation
-- =====================================================================

-- ---------------------------------------------------------------------
-- Zones : salle, terrasse, bar, salon prive, VIP...
-- `guest_selectable` decide de ce que le client voit au moment de reserver.
-- ---------------------------------------------------------------------
CREATE TYPE zone_kind AS ENUM (
  'dining_room', 'terrace', 'bar', 'private_room', 'vip', 'lounge', 'counter', 'other'
);

CREATE TABLE zones (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  restaurant_id    uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name             text NOT NULL,
  kind             zone_kind NOT NULL DEFAULT 'dining_room',
  -- Le client peut-il demander cette zone depuis le moteur de reservation ?
  guest_selectable boolean NOT NULL DEFAULT true,
  description      text,
  color            text,
  sort_order       int NOT NULL DEFAULT 0,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, name)
);
CREATE INDEX zones_restaurant_idx ON zones (tenant_id, restaurant_id);
CREATE TRIGGER zones_touch BEFORE UPDATE ON zones
  FOR EACH ROW EXECUTE FUNCTION orsyne_core.touch_updated_at();
SELECT orsyne_core.apply_tenant_rls('zones');

-- ---------------------------------------------------------------------
-- Tables. Geometrie incluse : le plan de salle est la meme source de
-- verite que le moteur de reservation, jamais un dessin a part.
-- ---------------------------------------------------------------------
CREATE TYPE table_shape AS ENUM ('round', 'square', 'rect', 'oval', 'booth', 'counter');

-- Statut temps reel du couvert (section 7 du cahier des charges).
CREATE TYPE table_live_status AS ENUM (
  'available', 'reserved', 'guest_expected', 'seated', 'ordered',
  'in_service', 'check_requested', 'finished', 'cleaning', 'unavailable'
);

CREATE TABLE restaurant_tables (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  restaurant_id    uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  zone_id          uuid REFERENCES zones(id) ON DELETE SET NULL,
  code             text NOT NULL,                    -- "T14"
  label            text,
  seats_min        int NOT NULL DEFAULT 1,
  seats_max        int NOT NULL,
  shape            table_shape NOT NULL DEFAULT 'round',
  -- Geometrie du plan de salle, en unites de grille.
  pos_x            numeric(10,2) NOT NULL DEFAULT 0,
  pos_y            numeric(10,2) NOT NULL DEFAULT 0,
  width            numeric(10,2) NOT NULL DEFAULT 1,
  height           numeric(10,2) NOT NULL DEFAULT 1,
  rotation         numeric(6,2)  NOT NULL DEFAULT 0,
  -- Le client peut-il choisir precisement cette table ?
  guest_selectable boolean NOT NULL DEFAULT false,
  combinable       boolean NOT NULL DEFAULT false,
  -- Ordre de preference lors de l'attribution automatique (plus bas = prefere).
  priority         int NOT NULL DEFAULT 100,
  attributes       text[] NOT NULL DEFAULT '{}',     -- window, quiet, accessible...
  live_status      table_live_status NOT NULL DEFAULT 'available',
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, code),
  CONSTRAINT seats_coherent CHECK (seats_min >= 1 AND seats_max >= seats_min)
);
CREATE INDEX tables_restaurant_idx ON restaurant_tables (tenant_id, restaurant_id) WHERE is_active;
CREATE INDEX tables_zone_idx ON restaurant_tables (zone_id);
CREATE TRIGGER tables_touch BEFORE UPDATE ON restaurant_tables
  FOR EACH ROW EXECUTE FUNCTION orsyne_core.touch_updated_at();
SELECT orsyne_core.apply_tenant_rls('restaurant_tables');

-- ---------------------------------------------------------------------
-- Combinaisons de tables (groupes). Reserver une combinaison occupe
-- chacune de ses tables : la contrainte d'exclusion de 0003 suffit alors
-- a interdire tout conflit entre combinaison et table isolee.
-- ---------------------------------------------------------------------
CREATE TABLE table_combinations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  seats_min     int NOT NULL,
  seats_max     int NOT NULL,
  priority      int NOT NULL DEFAULT 200,   -- apres les tables simples
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, name),
  CONSTRAINT combination_seats_coherent CHECK (seats_max >= seats_min)
);
CREATE INDEX combinations_restaurant_idx ON table_combinations (tenant_id, restaurant_id);
SELECT orsyne_core.apply_tenant_rls('table_combinations');

CREATE TABLE table_combination_members (
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  combination_id uuid NOT NULL REFERENCES table_combinations(id) ON DELETE CASCADE,
  table_id       uuid NOT NULL REFERENCES restaurant_tables(id) ON DELETE CASCADE,
  PRIMARY KEY (combination_id, table_id)
);
CREATE INDEX combination_members_table_idx ON table_combination_members (table_id);
SELECT orsyne_core.apply_tenant_rls('table_combination_members');

-- ---------------------------------------------------------------------
-- Services (dejeuner, diner...). days_of_week : 0=dimanche .. 6=samedi,
-- convention ISO de JS (Date#getDay) pour eviter toute ambiguite.
-- ---------------------------------------------------------------------
CREATE TABLE service_periods (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  restaurant_id        uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  days_of_week         int[] NOT NULL,
  starts_at            time NOT NULL,
  ends_at              time NOT NULL,          -- fin de service (cuisine fermee)
  -- Derniere arrivee acceptee, en minutes avant ends_at.
  last_seating_offset_minutes int NOT NULL DEFAULT 60,
  slot_interval_minutes       int NOT NULL DEFAULT 15,
  default_duration_minutes    int NOT NULL DEFAULT 90,
  -- Battement de remise en place entre deux convives sur la meme table.
  turn_buffer_minutes         int NOT NULL DEFAULT 15,
  max_covers_per_slot  int,                    -- lissage du pic de cuisine
  is_active            boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, name),
  CONSTRAINT service_window_valid CHECK (ends_at > starts_at),
  CONSTRAINT service_days_valid CHECK (
    days_of_week <@ ARRAY[0,1,2,3,4,5,6] AND cardinality(days_of_week) > 0
  )
);
CREATE INDEX service_periods_restaurant_idx ON service_periods (tenant_id, restaurant_id)
  WHERE is_active;
CREATE TRIGGER service_periods_touch BEFORE UPDATE ON service_periods
  FOR EACH ROW EXECUTE FUNCTION orsyne_core.touch_updated_at();
SELECT orsyne_core.apply_tenant_rls('service_periods');

-- ---------------------------------------------------------------------
-- Fermetures exceptionnelles (conges, jours feries, privatisation).
-- ---------------------------------------------------------------------
CREATE TABLE closures (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  reason        text,
  -- Une privatisation ferme la reservation publique sans fermer le service.
  blocks_public_booking boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT closure_window_valid CHECK (ends_at > starts_at)
);
CREATE INDEX closures_window_idx ON closures (tenant_id, restaurant_id, starts_at, ends_at);
SELECT orsyne_core.apply_tenant_rls('closures');

-- ---------------------------------------------------------------------
-- Regles de reservation. La regle la plus specifique (priority la plus
-- basse) qui matche s'applique ; le reste vient des reglages etablissement.
-- ---------------------------------------------------------------------
CREATE TABLE booking_rules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  restaurant_id       uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name                text NOT NULL,
  -- Conditions de declenchement (NULL = pas de contrainte sur ce critere).
  days_of_week        int[],
  time_from           time,
  time_to             time,
  party_size_min      int,
  party_size_max      int,
  zone_id             uuid REFERENCES zones(id) ON DELETE CASCADE,
  -- Effets.
  min_lead_time_minutes int,
  max_horizon_days      int,
  duration_minutes      int,     -- surcharge la duree par defaut du service
  requires_approval     boolean NOT NULL DEFAULT false,
  blocks_online_booking boolean NOT NULL DEFAULT false,
  priority            int NOT NULL DEFAULT 100,
  is_active           boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, name)
);
CREATE INDEX booking_rules_lookup_idx ON booking_rules (tenant_id, restaurant_id, priority)
  WHERE is_active;
SELECT orsyne_core.apply_tenant_rls('booking_rules');
