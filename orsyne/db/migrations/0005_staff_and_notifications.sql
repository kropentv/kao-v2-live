-- =====================================================================
-- ORSYNE — 0005 Equipes, attribution, notifications
-- =====================================================================

-- ---------------------------------------------------------------------
-- Profil operationnel d'un membre d'equipe, par etablissement.
-- La charge maximale est une donnee du restaurant, pas une constante du
-- code : un serveur experimente ne tient pas la meme salle qu'un extra.
-- ---------------------------------------------------------------------
CREATE TABLE staff_profiles (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  max_tables      int NOT NULL DEFAULT 6,
  max_covers      int NOT NULL DEFAULT 24,
  -- Poids relatif dans l'attribution automatique : 1.0 = charge normale.
  load_factor     numeric(4,2) NOT NULL DEFAULT 1.00,
  languages       text[] NOT NULL DEFAULT '{}',   -- utile pour router un client
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, restaurant_id),
  CONSTRAINT load_factor_positive CHECK (load_factor > 0)
);
CREATE INDEX staff_profiles_restaurant_idx ON staff_profiles (tenant_id, restaurant_id);
SELECT orsyne_core.apply_tenant_rls('staff_profiles');

-- ---------------------------------------------------------------------
-- Services travailles. Un shift declare qui est en salle et quand.
-- ---------------------------------------------------------------------
CREATE TYPE shift_status AS ENUM ('planned', 'confirmed', 'clocked_in', 'clocked_out', 'cancelled');

CREATE TABLE shifts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_period_id uuid REFERENCES service_periods(id) ON DELETE SET NULL,
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  role              staff_role NOT NULL DEFAULT 'server',
  status            shift_status NOT NULL DEFAULT 'planned',
  clocked_in_at     timestamptz,
  clocked_out_at    timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shift_window_valid CHECK (ends_at > starts_at)
);
CREATE INDEX shifts_service_idx ON shifts (tenant_id, restaurant_id, starts_at);
CREATE INDEX shifts_user_idx ON shifts (tenant_id, user_id, starts_at);
CREATE TRIGGER shifts_touch BEFORE UPDATE ON shifts
  FOR EACH ROW EXECUTE FUNCTION orsyne_core.touch_updated_at();
SELECT orsyne_core.apply_tenant_rls('shifts');

-- Zones couvertes par un shift (le « rang » du serveur).
CREATE TABLE shift_zones (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shift_id  uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  zone_id   uuid NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  PRIMARY KEY (shift_id, zone_id)
);
SELECT orsyne_core.apply_tenant_rls('shift_zones');

-- Tables explicitement rattachees a un shift, quand le responsable de
-- salle decoupe les rangs table par table plutot que par zone.
CREATE TABLE shift_tables (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shift_id  uuid NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  table_id  uuid NOT NULL REFERENCES restaurant_tables(id) ON DELETE CASCADE,
  PRIMARY KEY (shift_id, table_id)
);
CREATE INDEX shift_tables_table_idx ON shift_tables (table_id);
SELECT orsyne_core.apply_tenant_rls('shift_tables');

-- ---------------------------------------------------------------------
-- Attribution client -> table -> serveur.
-- `mode` conserve la trace de qui a decide : l'IA propose, l'humain
-- tranche, et on doit pouvoir mesurer la qualite des deux.
-- ---------------------------------------------------------------------
CREATE TYPE assignment_mode AS ENUM ('auto', 'manual', 'ai_suggested');

CREATE TABLE server_assignments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  reservation_id  uuid NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shift_id        uuid REFERENCES shifts(id) ON DELETE SET NULL,
  mode            assignment_mode NOT NULL DEFAULT 'auto',
  -- Score calcule par l'attribution automatique, conserve pour analyse.
  score           numeric(6,3),
  reason          text,
  assigned_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  is_current      boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
-- Une seule attribution courante par reservation ; l'historique reste lisible.
CREATE UNIQUE INDEX server_assignment_current_unique
  ON server_assignments (reservation_id) WHERE is_current;
CREATE INDEX server_assignments_user_idx ON server_assignments (tenant_id, user_id)
  WHERE is_current;
SELECT orsyne_core.apply_tenant_rls('server_assignments');

-- ---------------------------------------------------------------------
-- Notifications internes (section 13). `payload` porte uniquement les
-- informations selectionnees pour ce serveur, jamais tout le profil CRM.
-- ---------------------------------------------------------------------
CREATE TYPE notification_kind AS ENUM (
  'table_assigned', 'guest_arrived', 'guest_late', 'guest_seated',
  'reservation_created', 'reservation_modified', 'reservation_cancelled',
  'guest_brief', 'order_ready', 'check_requested', 'manager_alert'
);

CREATE TABLE notifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  restaurant_id     uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  recipient_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              notification_kind NOT NULL,
  title             text NOT NULL,
  body              text,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  reservation_id    uuid REFERENCES reservations(id) ON DELETE CASCADE,
  -- Urgence : pilote le rendu (banniere vs ligne de liste) cote application.
  priority          int NOT NULL DEFAULT 100,
  read_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_inbox_idx
  ON notifications (tenant_id, recipient_user_id, created_at DESC)
  WHERE read_at IS NULL;
SELECT orsyne_core.apply_tenant_rls('notifications');

-- ---------------------------------------------------------------------
-- Messages sortants vers le client (SMS, WhatsApp, email). Trace unique
-- pour la conformite et pour l'analytics des campagnes.
-- ---------------------------------------------------------------------
CREATE TYPE message_direction AS ENUM ('outbound', 'inbound');
CREATE TYPE message_status AS ENUM ('queued', 'sent', 'delivered', 'read', 'failed', 'blocked');

CREATE TABLE guest_messages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  guest_id       uuid REFERENCES guests(id) ON DELETE SET NULL,
  reservation_id uuid REFERENCES reservations(id) ON DELETE SET NULL,
  channel        consent_channel NOT NULL,
  direction      message_direction NOT NULL DEFAULT 'outbound',
  purpose        consent_purpose NOT NULL DEFAULT 'transactional',
  locale         text NOT NULL DEFAULT 'fr-FR',
  template       text,
  body           text NOT NULL,
  status         message_status NOT NULL DEFAULT 'queued',
  provider       text,
  provider_ref   text,
  failure_reason text,
  sent_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX guest_messages_guest_idx ON guest_messages (tenant_id, guest_id, created_at DESC);
CREATE INDEX guest_messages_reservation_idx ON guest_messages (reservation_id);
SELECT orsyne_core.apply_tenant_rls('guest_messages');
