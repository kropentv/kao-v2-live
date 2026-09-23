# ORSYNE — Mise en production

## En local, en une commande

```bash
docker compose up
```

Ouvre `http://localhost:3000`. Au premier démarrage, un restaurant de
démonstration complet est créé (`ORSYNE_SEED_DEMO=true` par défaut dans
`docker-compose.yml`). Paiements, emails et SMS sont en **mode
démonstration** : rien n'est débité, les messages s'affichent dans les
journaux du conteneur (`docker compose logs -f app`).

| | |
|---|---|
| Widget client | `http://localhost:3000/r/comptoir-demo` |
| Dashboard | `http://localhost:3000/app/` |
| Application de salle | `http://localhost:3000/app/salle.html` |

Comptes (mot de passe `demo-orsyne-2026`) : `patron@`, `manager@`,
`lucas@`, `sarah@`, `hugo@orsyne.demo`.

## Ce que fait le démarrage

`node src/main.js`, dans cet ordre :

1. **Contrôle de configuration.** En production, un réglage manquant arrête
   tout, avec la liste de ce qui manque. Un service qui tourne sans
   encaisser les acomptes est pire qu'un service qui refuse de démarrer.
2. **Migrations**, sous verrou : plusieurs instances peuvent démarrer
   ensemble, une seule applique.
3. **Mot de passe du rôle applicatif** (`ORSYNE_APP_DB_PASSWORD`). Le rôle
   est créé par les migrations ; le secret vient de l'environnement,
   jamais d'un fichier versionné.
4. **Serveur, diffuseur d'événements, tâches automatiques.**
5. **Arrêt propre** sur `SIGTERM` : les requêtes en cours finissent avant
   la coupure. Un déploiement ne perd aucune réservation.

## Passer en production

Dans `.env` (voir `.env.example`, commenté ligne à ligne) :

```ini
NODE_ENV=production
ORSYNE_PUBLIC_URL=https://reservation.votre-domaine.fr
ORSYNE_TRUST_PROXY=true
ORSYNE_SEED_DEMO=false

ORSYNE_PAYMENT_PROVIDER=stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

ORSYNE_EMAIL_PROVIDER=resend        # ou postmark
RESEND_API_KEY=re_...
ORSYNE_EMAIL_FROM=Le Comptoir <reservations@votre-domaine.fr>

ORSYNE_SMS_PROVIDER=twilio
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
ORSYNE_SMS_FROM=+33...
```

Et des mots de passe de base réels :
`ORSYNE_DB_ADMIN_PASSWORD`, `ORSYNE_APP_DB_PASSWORD`.

### Stripe

Déclarez le webhook dans le tableau de bord Stripe :

- URL : `https://<votre-domaine>/api/webhooks/payments`
- Événements : `checkout.session.completed`, `checkout.session.expired`,
  `payment_intent.succeeded`, `payment_intent.payment_failed`,
  `payment_intent.amount_capturable_updated`

Le secret de signature affiché par Stripe va dans `STRIPE_WEBHOOK_SECRET`.
**Une réservation n'est jamais confirmée sur la foi d'une redirection** :
seul un webhook signé la confirme. Sans le secret, le service refuse de
démarrer en production.

### Hébergeurs

N'importe quel hébergeur qui lance une image Docker convient (Railway,
Render, Fly.io, Scaleway, un VPS). Il faut :

- une base **PostgreSQL 16** avec les extensions `pgcrypto`, `btree_gist`,
  `citext` (disponibles chez tous les fournisseurs gérés) ;
- un compte propriétaire de la base pour `ORSYNE_ADMIN_DATABASE_URL` ;
- `ORSYNE_DATABASE_URL` sur le rôle `orsyne_app` avec le mot de passe
  choisi dans `ORSYNE_APP_DB_PASSWORD`.

Sondes :

- `/health` — le processus répond (vivacité, ne touche pas la base) ;
- `/ready` — la base répond, et les fournisseurs branchés sont listés.

## Sécurité en place

- Isolation entre restaurants par RLS forcée ; rôle applicatif sans
  contournement possible, y compris pour les tâches automatiques.
- Mots de passe scrypt, sessions opaques en cookie `HttpOnly`, `Secure` en
  production.
- Limite de débit : connexion (force brute), widget public (remplissage
  par robot), API.
- En-têtes de sécurité partout ; politique de contenu stricte sur les pages.
- Webhooks de paiement vérifiés par signature, avec tolérance temporelle
  contre le rejeu.
- La page de paiement de démonstration et le raccourci de confirmation
  sans paiement **n'existent pas** dès qu'un vrai prestataire est branché.
