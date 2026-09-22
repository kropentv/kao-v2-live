-- =====================================================================
-- ORSYNE — 0003 CRM / Client Intelligence
--
-- Separation stricte exigee par le cahier des charges (section 12) :
--   guest_facts    = ce qui s'est reellement produit (observe, compte)
--   guest_insights = ce que l'IA en deduit (probabiliste, refutable)
-- Les deux ne partagent aucune table : une deduction ne peut pas etre
-- affichee par erreur comme un fait.
-- =====================================================================

CREATE TABLE guests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  first_name     text,
  last_name      text,
  email          citext,
  phone_e164     text,
  -- Langue preferee du client (section 14) : pilote SMS, WhatsApp, email,
  -- et la langue que l'IA telephonique adopte des qu'elle le reconnait.
  locale         text NOT NULL DEFAULT 'fr-FR',
  company        text,
  birthday       date,
  -- Le CRM est au niveau du tenant : un groupe reconnait son client sur
  -- tous ses etablissements, `guest_restaurant_stats` porte le detail.
  vip            boolean NOT NULL DEFAULT false,
  blacklisted    boolean NOT NULL DEFAULT false,
  blacklist_reason text,
  source         text,
  anonymized_at  timestamptz,       -- RGPD : droit a l'effacement
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guest_reachable CHECK (
    anonymized_at IS NOT NULL OR email IS NOT NULL OR phone_e164 IS NOT NULL
  )
);
-- Deduplication : un numero et un email identifient un client unique par tenant.
CREATE UNIQUE INDEX guests_phone_unique ON guests (tenant_id, phone_e164)
  WHERE phone_e164 IS NOT NULL AND anonymized_at IS NULL;
CREATE UNIQUE INDEX guests_email_unique ON guests (tenant_id, email)
  WHERE email IS NOT NULL AND anonymized_at IS NULL;
CREATE INDEX guests_name_idx ON guests (tenant_id, last_name, first_name);
CREATE TRIGGER guests_touch BEFORE UPDATE ON guests
  FOR EACH ROW EXECUTE FUNCTION orsyne_core.touch_updated_at();
SELECT orsyne_core.apply_tenant_rls('guests');

-- ---------------------------------------------------------------------
-- Statistiques par etablissement, mises a jour par les evenements.
-- ---------------------------------------------------------------------
CREATE TABLE guest_restaurant_stats (
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  guest_id             uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  restaurant_id        uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  visits               int NOT NULL DEFAULT 0,
  cancellations        int NOT NULL DEFAULT 0,
  no_shows             int NOT NULL DEFAULT 0,
  covers               int NOT NULL DEFAULT 0,
  total_spend_cents    bigint NOT NULL DEFAULT 0,
  avg_spend_cents      bigint NOT NULL DEFAULT 0,
  first_visit_at       timestamptz,
  last_visit_at        timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guest_id, restaurant_id)
);
CREATE INDEX guest_stats_restaurant_idx ON guest_restaurant_stats (tenant_id, restaurant_id, last_visit_at DESC);
SELECT orsyne_core.apply_tenant_rls('guest_restaurant_stats');

-- ---------------------------------------------------------------------
-- Preferences declarees ou constatees. `source` dit toujours d'ou elle vient.
-- ---------------------------------------------------------------------
CREATE TYPE preference_kind AS ENUM (
  'allergy', 'diet', 'table', 'zone', 'drink', 'dish', 'occasion', 'service', 'other'
);
CREATE TYPE preference_source AS ENUM ('guest_declared', 'staff_entered', 'observed', 'imported');

CREATE TABLE guest_preferences (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  guest_id     uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  kind         preference_kind NOT NULL,
  value        text NOT NULL,
  source       preference_source NOT NULL DEFAULT 'staff_entered',
  -- Une allergie est critique : elle doit remonter au serveur sans filtrage.
  is_critical  boolean NOT NULL DEFAULT false,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guest_id, kind, value)
);
CREATE INDEX guest_preferences_guest_idx ON guest_preferences (tenant_id, guest_id);
SELECT orsyne_core.apply_tenant_rls('guest_preferences');

-- ---------------------------------------------------------------------
-- FAITS : « a commande l'entrecote 5 fois ». Toujours chiffrable, toujours
-- rattachable a des evenements sources.
-- ---------------------------------------------------------------------
CREATE TABLE guest_facts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  guest_id       uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  restaurant_id  uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  subject        text NOT NULL,          -- 'dish:entrecote', 'zone:terrace'
  occurrences    int NOT NULL DEFAULT 1,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guest_id, restaurant_id, subject)
);
CREATE INDEX guest_facts_guest_idx ON guest_facts (tenant_id, guest_id, occurrences DESC);
SELECT orsyne_core.apply_tenant_rls('guest_facts');

-- ---------------------------------------------------------------------
-- DEDUCTIONS IA : « semble apprecier l'entrecote ». Jamais presentees
-- comme certaines ; le restaurant peut les rejeter, ce qui les retire
-- definitivement de l'affichage.
-- ---------------------------------------------------------------------
CREATE TYPE insight_status AS ENUM ('proposed', 'accepted', 'rejected', 'expired');

CREATE TABLE guest_insights (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  guest_id       uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  restaurant_id  uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  statement      text NOT NULL,
  confidence     numeric(4,3) NOT NULL,
  -- Les faits qui ont produit la deduction : elle reste toujours auditable.
  evidence_fact_ids uuid[] NOT NULL DEFAULT '{}',
  model          text,
  status         insight_status NOT NULL DEFAULT 'proposed',
  reviewed_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at    timestamptz,
  expires_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT confidence_range CHECK (confidence >= 0 AND confidence <= 1)
);
CREATE INDEX guest_insights_guest_idx ON guest_insights (tenant_id, guest_id)
  WHERE status IN ('proposed', 'accepted');
SELECT orsyne_core.apply_tenant_rls('guest_insights');

-- ---------------------------------------------------------------------
-- Notes libres. `visibility` evite d'exposer au serveur ce qui ne le
-- concerne pas (section 24).
-- ---------------------------------------------------------------------
CREATE TYPE note_visibility AS ENUM ('all_staff', 'managers_only');

CREATE TABLE guest_notes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  guest_id      uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  restaurant_id uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  body          text NOT NULL,
  visibility    note_visibility NOT NULL DEFAULT 'all_staff',
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX guest_notes_guest_idx ON guest_notes (tenant_id, guest_id, created_at DESC);
SELECT orsyne_core.apply_tenant_rls('guest_notes');

-- ---------------------------------------------------------------------
-- Consentements (RGPD). Un envoi marketing sans ligne `granted` ici est
-- un bug, pas une option de configuration.
-- ---------------------------------------------------------------------
CREATE TYPE consent_channel AS ENUM ('email', 'sms', 'whatsapp', 'phone', 'push');
CREATE TYPE consent_purpose AS ENUM ('transactional', 'marketing', 'profiling');

CREATE TABLE guest_consents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  guest_id      uuid NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  channel       consent_channel NOT NULL,
  purpose       consent_purpose NOT NULL,
  granted       boolean NOT NULL,
  source        text NOT NULL,          -- widget, phone_ai, staff, import
  evidence      jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guest_id, channel, purpose)
);
CREATE INDEX guest_consents_guest_idx ON guest_consents (tenant_id, guest_id);
SELECT orsyne_core.apply_tenant_rls('guest_consents');
