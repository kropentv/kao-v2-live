-- =====================================================================
-- ORSYNE — 0007 Points d'entree anterieurs au contexte tenant
--
-- Probleme : la connexion et le widget public doivent trouver un
-- utilisateur ou un restaurant AVANT de connaitre le tenant, alors que la
-- RLS exige le tenant pour lire quoi que ce soit.
--
-- Solution : deux fonctions SECURITY DEFINER, au perimetre volontairement
-- minuscule. Elles ne renvoient que ce qui est strictement necessaire
-- pour poser le contexte. Le role applicatif reste NOBYPASSRLS : il ne
-- gagne pas un acces general, seulement ces deux reponses precises.
-- =====================================================================

-- Recherche de connexion. Ne renvoie jamais de donnees metier : juste de
-- quoi verifier un mot de passe et poser le contexte tenant.
CREATE OR REPLACE FUNCTION orsyne_core.lookup_login(p_email citext)
RETURNS TABLE (user_id uuid, tenant_id uuid, password_hash text, status user_status)
LANGUAGE sql SECURITY DEFINER SET search_path = public, orsyne_core AS $$
  SELECT u.id, u.tenant_id, u.password_hash, u.status
    FROM users u
    JOIN tenants t ON t.id = u.tenant_id
   WHERE u.email = p_email
     AND u.status <> 'disabled'
     AND t.status = 'active'
   LIMIT 1
$$;

-- Resolution d'une session a partir du hash du jeton. Meme principe :
-- le strict necessaire pour reconstituer le contexte de la requete.
CREATE OR REPLACE FUNCTION orsyne_core.lookup_session(p_token_hash text)
RETURNS TABLE (user_id uuid, tenant_id uuid, session_id uuid, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public, orsyne_core AS $$
  SELECT s.user_id, s.tenant_id, s.id, s.expires_at
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
   WHERE s.token_hash = p_token_hash
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
     AND u.status = 'active'
   LIMIT 1
$$;

-- Widget public : un visiteur non authentifie doit pouvoir atteindre la
-- page de reservation d'un restaurant a partir de son slug.
CREATE OR REPLACE FUNCTION orsyne_core.lookup_public_restaurant(p_slug citext)
RETURNS TABLE (restaurant_id uuid, tenant_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, orsyne_core AS $$
  SELECT r.id, r.tenant_id
    FROM restaurants r
    JOIN tenants t ON t.id = r.tenant_id
   WHERE r.slug = p_slug
     AND r.is_active
     AND t.status = 'active'
   LIMIT 1
$$;

-- Acces a une reservation par sa reference, pour qu'un client puisse
-- modifier ou annuler depuis son email sans compte. La reference est un
-- secret a 6 caracteres : on la traite comme tel, jamais comme un
-- identifiant devinable par enumeration.
CREATE OR REPLACE FUNCTION orsyne_core.lookup_reservation_by_reference(
  p_slug citext, p_reference text)
RETURNS TABLE (reservation_id uuid, tenant_id uuid, restaurant_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, orsyne_core AS $$
  SELECT res.id, res.tenant_id, res.restaurant_id
    FROM reservations res
    JOIN restaurants r ON r.id = res.restaurant_id
   WHERE r.slug = p_slug
     AND upper(res.reference) = upper(p_reference)
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION orsyne_core.lookup_login(citext) FROM PUBLIC;
REVOKE ALL ON FUNCTION orsyne_core.lookup_session(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION orsyne_core.lookup_public_restaurant(citext) FROM PUBLIC;
REVOKE ALL ON FUNCTION orsyne_core.lookup_reservation_by_reference(citext, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION orsyne_core.lookup_login(citext) TO orsyne_app;
GRANT EXECUTE ON FUNCTION orsyne_core.lookup_session(text) TO orsyne_app;
GRANT EXECUTE ON FUNCTION orsyne_core.lookup_public_restaurant(citext) TO orsyne_app;
GRANT EXECUTE ON FUNCTION orsyne_core.lookup_reservation_by_reference(citext, text) TO orsyne_app;

-- ---------------------------------------------------------------------
-- Index d'appui pour la recherche de session (chemin le plus chaud de
-- l'API : une resolution par requete authentifiee).
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS auth_sessions_active_idx
  ON auth_sessions (token_hash) WHERE revoked_at IS NULL;
