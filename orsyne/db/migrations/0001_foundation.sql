-- =====================================================================
-- ORSYNE — 0001 Foundation
-- Multi-tenant, RBAC, audit, outbox.
--
-- REGLE D'OR : toute table metier porte tenant_id et est protegee par RLS.
-- L'application se connecte avec le role orsyne_app (NOBYPASSRLS) et
-- positionne `SET LOCAL orsyne.tenant_id` a chaque transaction.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------
-- Role applicatif : ne peut jamais contourner les politiques RLS.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'orsyne_app') THEN
    CREATE ROLE orsyne_app LOGIN NOBYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------------
-- Contexte de requete
-- ---------------------------------------------------------------------
-- Schema technique, distinct de `public` ou vivent les tables metier.
-- Le nom evite volontairement tout nom de role : `search_path` contient
-- "$user", et un schema homonyme du role detournerait silencieusement
-- toutes les creations de tables.
CREATE SCHEMA IF NOT EXISTS orsyne_core;

-- Tenant courant. STABLE (et non IMMUTABLE) : la valeur change par transaction.
CREATE OR REPLACE FUNCTION orsyne_core.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('orsyne.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION orsyne_core.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('orsyne.user_id', true), '')::uuid
$$;

-- Applique la RLS tenant standard a une table : lecture et ecriture
-- strictement limitees au tenant courant. Un contexte absent => 0 ligne.
CREATE OR REPLACE FUNCTION orsyne_core.apply_tenant_rls(p_table regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_table);
  EXECUTE format($f$
    CREATE POLICY tenant_isolation ON %s
      USING (tenant_id = orsyne_core.current_tenant_id())
      WITH CHECK (tenant_id = orsyne_core.current_tenant_id())
  $f$, p_table);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO orsyne_app', p_table);
END
$$;

CREATE OR REPLACE FUNCTION orsyne_core.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- ---------------------------------------------------------------------
-- Tenants (comptes SaaS). Seule table sans tenant_id : elle EST le tenant.
-- ---------------------------------------------------------------------
CREATE TYPE tenant_plan   AS ENUM ('trial', 'starter', 'pro', 'premium', 'enterprise');
CREATE TYPE tenant_status AS ENUM ('active', 'suspended', 'cancelled');

CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          citext NOT NULL UNIQUE,
  plan          tenant_plan   NOT NULL DEFAULT 'trial',
  status        tenant_status NOT NULL DEFAULT 'active',
  default_locale text        NOT NULL DEFAULT 'fr-FR',
  settings      jsonb        NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now()
);
CREATE TRIGGER tenants_touch BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION orsyne_core.touch_updated_at();

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants
  USING (id = orsyne_core.current_tenant_id())
  WITH CHECK (id = orsyne_core.current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON tenants TO orsyne_app;

-- ---------------------------------------------------------------------
-- Etablissements
-- ---------------------------------------------------------------------
CREATE TABLE restaurants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  slug          citext NOT NULL,
  timezone      text NOT NULL DEFAULT 'Europe/Paris',
  locale        text NOT NULL DEFAULT 'fr-FR',
  currency      char(3) NOT NULL DEFAULT 'EUR',
  phone_e164    text,
  email         citext,
  address_line1 text,
  address_line2 text,
  postal_code   text,
  city          text,
  country_code  char(2),
  -- Reglages operationnels : buffer de rotation, pas de reservation, etc.
  settings      jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);
CREATE INDEX restaurants_tenant_idx ON restaurants (tenant_id);
CREATE TRIGGER restaurants_touch BEFORE UPDATE ON restaurants
  FOR EACH ROW EXECUTE FUNCTION orsyne_core.touch_updated_at();
SELECT orsyne_core.apply_tenant_rls('restaurants');

-- ---------------------------------------------------------------------
-- Utilisateurs internes (staff). Les clients finaux vivent dans `guests`.
-- ---------------------------------------------------------------------
CREATE TYPE user_status AS ENUM ('invited', 'active', 'disabled');

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email          citext NOT NULL,
  password_hash  text,
  full_name      text NOT NULL,
  display_name   text,
  phone_e164     text,
  locale         text NOT NULL DEFAULT 'fr-FR',
  status         user_status NOT NULL DEFAULT 'invited',
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);
CREATE INDEX users_tenant_idx ON users (tenant_id);
CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION orsyne_core.touch_updated_at();
SELECT orsyne_core.apply_tenant_rls('users');

-- ---------------------------------------------------------------------
-- Roles. `restaurant_id NULL` = portee tenant (owner multi-sites).
-- ---------------------------------------------------------------------
CREATE TYPE staff_role AS ENUM ('owner', 'manager', 'floor_manager', 'server', 'kitchen');

CREATE TABLE memberships (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  restaurant_id uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  role          staff_role NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Un role donne n'est accorde qu'une fois par (utilisateur, etablissement).
CREATE UNIQUE INDEX memberships_unique_scoped
  ON memberships (user_id, restaurant_id, role) WHERE restaurant_id IS NOT NULL;
CREATE UNIQUE INDEX memberships_unique_tenant_wide
  ON memberships (user_id, role) WHERE restaurant_id IS NULL;
CREATE INDEX memberships_lookup_idx ON memberships (tenant_id, user_id);
SELECT orsyne_core.apply_tenant_rls('memberships');

-- ---------------------------------------------------------------------
-- Sessions d'authentification (refresh tokens hashes).
-- ---------------------------------------------------------------------
CREATE TABLE auth_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash     text NOT NULL UNIQUE,
  user_agent     text,
  ip             inet,
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (tenant_id, user_id);
SELECT orsyne_core.apply_tenant_rls('auth_sessions');

-- ---------------------------------------------------------------------
-- Journal d'audit (RGPD art. 30 + tracabilite operationnelle).
-- Append-only : pas d'UPDATE ni de DELETE pour l'application.
-- ---------------------------------------------------------------------
CREATE TABLE audit_logs (
  id             bigserial PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  restaurant_id  uuid REFERENCES restaurants(id) ON DELETE SET NULL,
  actor_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_kind     text NOT NULL DEFAULT 'user',  -- user | system | ai | integration
  action         text NOT NULL,                 -- reservation.created, guest.deleted...
  entity_type    text NOT NULL,
  entity_id      uuid,
  diff           jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip             inet,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_scope_idx ON audit_logs (tenant_id, restaurant_id, created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (tenant_id, entity_type, entity_id);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read   ON audit_logs FOR SELECT USING (tenant_id = orsyne_core.current_tenant_id());
CREATE POLICY audit_append ON audit_logs FOR INSERT WITH CHECK (tenant_id = orsyne_core.current_tenant_id());
GRANT SELECT, INSERT ON audit_logs TO orsyne_app;
GRANT USAGE, SELECT ON SEQUENCE audit_logs_id_seq TO orsyne_app;

-- ---------------------------------------------------------------------
-- Outbox transactionnel : l'evenement est ecrit dans la meme transaction
-- que le changement metier, puis publie par un worker (temps reel,
-- notifications, integrations POS, IA). Zero evenement fantome.
-- ---------------------------------------------------------------------
CREATE TABLE outbox_events (
  id             bigserial PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  restaurant_id  uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  topic          text NOT NULL,        -- reservation.confirmed, table.seated...
  payload        jsonb NOT NULL,
  available_at   timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  attempts       int NOT NULL DEFAULT 0,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending_idx ON outbox_events (available_at)
  WHERE published_at IS NULL;
SELECT orsyne_core.apply_tenant_rls('outbox_events');
GRANT USAGE, SELECT ON SEQUENCE outbox_events_id_seq TO orsyne_app;

GRANT USAGE ON SCHEMA public, orsyne_core TO orsyne_app;
