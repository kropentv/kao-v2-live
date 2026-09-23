-- =====================================================================
-- ORSYNE — 0010 Points d'entree des taches transverses
--
-- Le webhook de paiement et l'ordonnanceur servent tous les tenants a la
-- fois. Sous RLS, sans contexte, ils ne verraient rien. Comme pour
-- l'outbox (0008), on n'accorde pas BYPASSRLS : on expose des fonctions
-- de DECOUVERTE, en lecture seule, qui renvoient uniquement des
-- identifiants. Chaque action est ensuite executee sous le contexte du
-- tenant concerne, avec toutes les regles habituelles.
-- =====================================================================

CREATE OR REPLACE FUNCTION orsyne_core.lookup_reservation_tenant(p_reservation_id uuid)
RETURNS TABLE (tenant_id uuid, restaurant_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, orsyne_core AS $$
  SELECT r.tenant_id, r.restaurant_id FROM reservations r WHERE r.id = p_reservation_id
$$;

-- Maintiens de table dont l'acompte n'a jamais ete regle.
CREATE OR REPLACE FUNCTION orsyne_core.due_expired_holds(p_now timestamptz)
RETURNS TABLE (tenant_id uuid, restaurant_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, orsyne_core AS $$
  SELECT DISTINCT o.tenant_id, o.restaurant_id
    FROM table_occupancies o
   WHERE o.is_active AND o.kind = 'hold'
     AND o.expires_at IS NOT NULL AND o.expires_at <= p_now
$$;

-- Rappels a envoyer.
CREATE OR REPLACE FUNCTION orsyne_core.due_reminders(p_now timestamptz, p_horizon timestamptz)
RETURNS TABLE (reservation_id uuid, tenant_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, orsyne_core AS $$
  SELECT r.id, r.tenant_id FROM reservations r
   WHERE r.status = 'confirmed' AND r.reminder_sent_at IS NULL
     AND r.starts_at > p_now AND r.starts_at <= p_horizon
   ORDER BY r.starts_at LIMIT 200
$$;

-- Clients jamais arrives, largement au-dela du retard tolere.
CREATE OR REPLACE FUNCTION orsyne_core.due_no_shows(p_cutoff timestamptz)
RETURNS TABLE (reservation_id uuid, tenant_id uuid, restaurant_id uuid, starts_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, orsyne_core AS $$
  SELECT r.id, r.tenant_id, r.restaurant_id, r.starts_at FROM reservations r
   WHERE r.status = 'confirmed' AND r.arrived_at IS NULL AND r.starts_at <= p_cutoff
   ORDER BY r.starts_at LIMIT 100
$$;

-- Tenants ayant des propositions de liste d'attente expirees.
CREATE OR REPLACE FUNCTION orsyne_core.due_offer_tenants(p_now timestamptz)
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, orsyne_core AS $$
  SELECT DISTINCT w.tenant_id FROM waitlist_entries w
   WHERE w.status = 'offered' AND w.offer_expires_at IS NOT NULL AND w.offer_expires_at <= p_now
$$;

-- Reponse d'un client a une proposition de liste d'attente, depuis le lien
-- recu par message. L'identifiant d'entree est un UUID : non devinable.
CREATE OR REPLACE FUNCTION orsyne_core.lookup_waitlist_entry(p_slug citext, p_entry_id uuid)
RETURNS TABLE (entry_id uuid, tenant_id uuid, restaurant_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, orsyne_core AS $$
  SELECT w.id, w.tenant_id, w.restaurant_id
    FROM waitlist_entries w JOIN restaurants r ON r.id = w.restaurant_id
   WHERE r.slug = p_slug AND w.id = p_entry_id
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'orsyne_core.lookup_reservation_tenant(uuid)',
    'orsyne_core.due_expired_holds(timestamptz)',
    'orsyne_core.due_reminders(timestamptz, timestamptz)',
    'orsyne_core.due_no_shows(timestamptz)',
    'orsyne_core.due_offer_tenants(timestamptz)',
    'orsyne_core.lookup_waitlist_entry(citext, uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO orsyne_app', f);
  END LOOP;
END $$;
