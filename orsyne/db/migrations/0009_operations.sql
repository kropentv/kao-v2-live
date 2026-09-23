-- =====================================================================
-- ORSYNE — 0009 Exploitation : rappels, journal des taches
-- =====================================================================

-- Un rappel envoye deux fois est pire que pas de rappel du tout : la
-- colonne porte la garantie, pas la memoire du processus.
ALTER TABLE reservations ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz;

CREATE INDEX IF NOT EXISTS reservations_reminder_due_idx
  ON reservations (starts_at)
  WHERE status = 'confirmed' AND reminder_sent_at IS NULL;

-- Le balayage des no-shows et des maintiens expires attaque ces deux
-- index a chaque tick : sans eux, il scanne toute la table.
CREATE INDEX IF NOT EXISTS reservations_no_show_watch_idx
  ON reservations (starts_at)
  WHERE status = 'confirmed' AND arrived_at IS NULL;

-- Trace des taches automatiques : savoir qu'un rappel n'est PAS parti
-- vaut autant que savoir qu'il est parti.
CREATE TABLE IF NOT EXISTS job_runs (
  id          bigserial PRIMARY KEY,
  job         text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome     jsonb NOT NULL DEFAULT '{}'::jsonb,
  error       text
);
CREATE INDEX IF NOT EXISTS job_runs_recent_idx ON job_runs (job, started_at DESC);

-- Table d'exploitation, sans tenant_id : elle ne contient aucune donnee
-- client, seulement des compteurs. On la ferme quand meme a l'ecriture
-- applicative directe.
GRANT SELECT, INSERT, UPDATE ON job_runs TO orsyne_app;
GRANT USAGE, SELECT ON SEQUENCE job_runs_id_seq TO orsyne_app;
