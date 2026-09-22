-- =====================================================================
-- ORSYNE — 0008 Acces du worker a l'outbox
--
-- Le publicateur d'evenements travaille par nature pour TOUS les tenants :
-- il ne peut donc pas poser un contexte tenant unique, et la RLS lui
-- renverrait zero ligne.
--
-- Plutot que de lui accorder BYPASSRLS — ce qui ouvrirait toute la base —
-- on expose deux fonctions SECURITY DEFINER au perimetre minimal :
-- reclamer un lot d'evenements, et marquer un evenement comme publie.
-- Le role applicatif reste NOBYPASSRLS et ne gagne aucun autre acces.
-- =====================================================================

CREATE OR REPLACE FUNCTION orsyne_core.claim_outbox_events(p_limit int DEFAULT 50)
RETURNS TABLE (
  id bigint, tenant_id uuid, restaurant_id uuid, topic text, payload jsonb, attempts int
)
LANGUAGE sql SECURITY DEFINER SET search_path = public, orsyne_core AS $$
  -- FOR UPDATE SKIP LOCKED : plusieurs workers peuvent tourner en
  -- parallele sans se marcher dessus ni publier deux fois. Le verrou
  -- tient jusqu'a la fin de la transaction de l'appelant.
  SELECT e.id, e.tenant_id, e.restaurant_id, e.topic, e.payload, e.attempts
    FROM outbox_events e
   WHERE e.published_at IS NULL
     AND e.available_at <= now()
   ORDER BY e.id
   LIMIT p_limit
   FOR UPDATE SKIP LOCKED
$$;

CREATE OR REPLACE FUNCTION orsyne_core.mark_outbox_published(p_id bigint, p_error text DEFAULT NULL)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, orsyne_core AS $$
  UPDATE outbox_events
     SET published_at = CASE WHEN p_error IS NULL THEN now() ELSE NULL END,
         attempts     = attempts + 1,
         last_error   = p_error,
         -- Echec : on reprogramme avec un recul croissant plutot que de
         -- boucler a pleine vitesse sur un evenement qui ne passe pas.
         available_at = CASE
                          WHEN p_error IS NULL THEN available_at
                          ELSE now() + make_interval(secs => least(300, power(2, attempts + 1)))
                        END
   WHERE id = p_id
$$;

REVOKE ALL ON FUNCTION orsyne_core.claim_outbox_events(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION orsyne_core.mark_outbox_published(bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION orsyne_core.claim_outbox_events(int) TO orsyne_app;
GRANT EXECUTE ON FUNCTION orsyne_core.mark_outbox_published(bigint, text) TO orsyne_app;
