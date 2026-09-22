-- =====================================================================
-- ORSYNE — 0006 Couche d'integration et journal IA
--
-- Le POS reste le systeme de reference pour la caisse, le paiement final,
-- la fiscalite et la comptabilite. ORSYNE ne le remplace pas : il s'y
-- connecte. Cette couche existe des le premier jour pour qu'ajouter un
-- fournisseur n'oblige jamais a reecrire le produit.
-- =====================================================================

CREATE TYPE integration_kind AS ENUM (
  'pos', 'kds', 'psp', 'sms', 'whatsapp', 'email', 'voice',
  'google', 'booking_platform', 'marketing', 'accounting'
);
CREATE TYPE integration_status AS ENUM ('disconnected', 'connected', 'error', 'expired', 'paused');

CREATE TABLE integrations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  restaurant_id  uuid REFERENCES restaurants(id) ON DELETE CASCADE,
  kind           integration_kind NOT NULL,
  provider       text NOT NULL,            -- lightspeed, tiller, stripe, twilio...
  display_name   text,
  status         integration_status NOT NULL DEFAULT 'disconnected',
  -- Secrets chiffres au repos par la couche applicative ; la base ne voit
  -- jamais de jeton en clair.
  credentials_encrypted bytea,
  settings       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Capacites reellement negociees avec ce fournisseur : le produit
  -- s'adapte au POS, il ne suppose pas.
  capabilities   text[] NOT NULL DEFAULT '{}',
  last_sync_at   timestamptz,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (restaurant_id, kind, provider)
);
CREATE INDEX integrations_tenant_idx ON integrations (tenant_id, kind);
CREATE TRIGGER integrations_touch BEFORE UPDATE ON integrations
  FOR EACH ROW EXECUTE FUNCTION orsyne_core.touch_updated_at();
SELECT orsyne_core.apply_tenant_rls('integrations');

-- ---------------------------------------------------------------------
-- Correspondance entre nos identifiants et ceux du systeme distant.
-- Indispensable pour rapprocher une table ORSYNE d'une table POS sans
-- imposer au restaurant de renommer quoi que ce soit.
-- ---------------------------------------------------------------------
CREATE TABLE external_references (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  entity_type    text NOT NULL,      -- table, guest, reservation, order, menu_item
  entity_id      uuid NOT NULL,
  external_id    text NOT NULL,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (integration_id, entity_type, entity_id),
  UNIQUE (integration_id, entity_type, external_id)
);
SELECT orsyne_core.apply_tenant_rls('external_references');

-- ---------------------------------------------------------------------
-- Webhooks entrants. On stocke la charge brute avant tout traitement :
-- un POS qui change son format ne doit jamais provoquer une perte de
-- donnee silencieuse.
-- ---------------------------------------------------------------------
CREATE TABLE webhook_deliveries (
  id             bigserial PRIMARY KEY,
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  integration_id uuid REFERENCES integrations(id) ON DELETE SET NULL,
  provider       text NOT NULL,
  event_type     text,
  signature_valid boolean,
  payload        jsonb NOT NULL,
  processed_at   timestamptz,
  error          text,
  received_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_unprocessed_idx ON webhook_deliveries (received_at)
  WHERE processed_at IS NULL;
SELECT orsyne_core.apply_tenant_rls('webhook_deliveries');
GRANT USAGE, SELECT ON SEQUENCE webhook_deliveries_id_seq TO orsyne_app;

-- ---------------------------------------------------------------------
-- Appels traites par l'IA receptionniste (section 15).
-- Chaque appel est trace : ce qui a ete compris, ce qui a ete fait, et
-- si un humain a du reprendre la main.
-- ---------------------------------------------------------------------
CREATE TYPE call_outcome AS ENUM (
  'reservation_created', 'reservation_modified', 'reservation_cancelled',
  'waitlisted', 'question_answered', 'transferred_to_human', 'abandoned', 'failed'
);

CREATE TABLE ai_calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  restaurant_id   uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  guest_id        uuid REFERENCES guests(id) ON DELETE SET NULL,
  reservation_id  uuid REFERENCES reservations(id) ON DELETE SET NULL,
  provider        text,
  provider_call_id text,
  from_e164       text,
  detected_locale text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  duration_seconds int,
  outcome         call_outcome,
  transferred_to_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  transcript      jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary         text,
  cost_cents      int,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_calls_restaurant_idx ON ai_calls (tenant_id, restaurant_id, started_at DESC);
SELECT orsyne_core.apply_tenant_rls('ai_calls');

-- ---------------------------------------------------------------------
-- Commandes. ORSYNE les capte (serveur ou QR) et les transmet au POS/KDS ;
-- le montant fiscal reste celui de la caisse.
-- ---------------------------------------------------------------------
CREATE TYPE order_channel AS ENUM ('server_app', 'guest_qr', 'pos_import');
CREATE TYPE order_status  AS ENUM ('draft', 'submitted', 'accepted', 'preparing', 'ready', 'served', 'cancelled', 'rejected');

CREATE TABLE orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  restaurant_id  uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  reservation_id uuid REFERENCES reservations(id) ON DELETE SET NULL,
  table_id       uuid REFERENCES restaurant_tables(id) ON DELETE SET NULL,
  guest_id       uuid REFERENCES guests(id) ON DELETE SET NULL,
  server_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  channel        order_channel NOT NULL DEFAULT 'server_app',
  status         order_status NOT NULL DEFAULT 'draft',
  -- Montant indicatif cote ORSYNE ; la caisse fait foi.
  subtotal_cents int NOT NULL DEFAULT 0,
  currency       char(3) NOT NULL DEFAULT 'EUR',
  pos_integration_id uuid REFERENCES integrations(id) ON DELETE SET NULL,
  pushed_to_pos_at timestamptz,
  pos_error      text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_service_idx ON orders (tenant_id, restaurant_id, created_at DESC);
CREATE INDEX orders_reservation_idx ON orders (reservation_id);
CREATE TRIGGER orders_touch BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION orsyne_core.touch_updated_at();
SELECT orsyne_core.apply_tenant_rls('orders');

CREATE TABLE order_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id       uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  name           text NOT NULL,
  external_item_id text,
  quantity       int NOT NULL DEFAULT 1,
  unit_price_cents int NOT NULL DEFAULT 0,
  modifiers      jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes          text,
  seat_number    int,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quantity_positive CHECK (quantity > 0)
);
CREATE INDEX order_items_order_idx ON order_items (order_id);
SELECT orsyne_core.apply_tenant_rls('order_items');
