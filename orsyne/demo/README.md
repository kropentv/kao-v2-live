# ORSYNE dans le navigateur

Le produit complet, sans serveur ni installation : le code de `src/`
tourne tel quel dans la page, sur une base PostgreSQL embarquée (PGlite).

- mêmes migrations (`db/migrations`), même jeu de démonstration ;
- même routeur API, mêmes droits, même moteur de réservation ;
- l'application se connecte avec le rôle `orsyne_app` (sans BYPASSRLS) :
  l'isolation entre restaurants s'applique vraiment ;
- la contrainte d'exclusion interdit toujours deux réservations sur la
  même table au même moment ;
- les trois interfaces de `public/` (widget client, tableau de bord,
  application de salle) sont affichées côte à côte et reliées au flux
  temps réel.

Ce qui change par rapport au serveur Node : paiements, emails et SMS
restent en mode démonstration, et les données vivent dans le navigateur
de la personne qui essaie (IndexedDB).

```bash
cd demo
npm install
npm run build   # produit demo/dist
npm run check   # parcours complet dans Chromium
node serve.mjs  # http://localhost:4173
```

`shims/` remplace les modules Node absents du navigateur (`pg`,
`node:crypto`…) ; `browser/backend.js` démarre la base et fait passer
chaque appel `/api/...` par `createApp()`.
