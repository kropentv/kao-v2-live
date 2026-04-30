# 🚀 KAO V2 V6.0 — Full Pack + SaaS Multi-Users

## 🆕 Tout ce qui est dans cette version

### **PHASE 1 — Améliorations sur ton dashboard `/dashboard`**

**TIER 1 (5 features)** :
- 🔊 **Notifications vocales** : voix annonce les A++ en français · bouton ON/OFF dans la mini-bar
- 📱 **Sounds critiques** : beep sur A++ / A+ (Web Audio API)
- 🎨 **Code couleurs setups** : violet=Sweep, vert=OB, bleu=Divergence, ambre=BB...
- 🔄 **Auto-reload smart** : reconnexion auto si serveur down
- 📊 **Comparaison setups vs résultats** : meilleur grade vs pire grade visualisé

**TIER 2 (3 features)** :
- 🌅 **Daily Plan auto** : briefing complet du jour (price + trend + sentiment + news + reco)
- 🎬 **Replay setups** : visualisation win rate par grade avec barres
- 🧪 **Backtest** : "Si tu n'avais pris que les A+/A++, tu aurais fait $X de plus"

### **PHASE 2 — Plateforme SaaS Multi-Users `/app/*`**

- 🔐 **Login / Register** (`/login`, `/register`)
- 👤 **Auth JWT sécurisé** avec cookies httpOnly
- 🎯 **Setup Wizard** (`/app/setup`) en 5 étapes guidées :
  - Token unique généré
  - Bot Telegram custom
  - Téléchargement EA personnalisé
  - Config MT5
  - Vérification
- 📊 **Dashboard utilisateur** (`/app/dashboard`) :
  - Stats P&L jour / total / WR
  - Trades ouverts / historique
  - Niveaux Gold custom (ajout/suppression)
- 🔒 **Isolation des données** : chaque user voit que ses propres trades

**Ton dashboard à toi reste sur `/dashboard` · INCHANGÉ**

---

## 📦 Fichiers livrés

```
v6/
├── server.js              ← Backend v6 (auth + SaaS)
├── package.json           ← Avec bcrypt + jwt
├── dashboard.html         ← Ton dashboard avec features V6
├── login.html             ← NEW · Login page
├── register.html          ← NEW · Register page
├── app_dashboard.html     ← NEW · Dashboard SaaS user
├── app_setup.html         ← NEW · Setup wizard
├── world.html             ← Inchangé
└── KaoV2_Observer.mq5     ← Inchangé (pour ton compte)
```

---

## 🚀 Déploiement (5 min)

### **1. Ajouter variable JWT**
Sur Railway → Variables → ajoute :
- `JWT_SECRET` = chaîne aléatoire longue (ex: `kao_super_secret_xyz_789`)

### **2. Replace fichiers GitHub**
- `package.json` (ajout deps bcrypt, jwt, cookie-parser)
- `server.js`
- `dashboard.html`
- `login.html` (nouveau)
- `register.html` (nouveau)
- `app_dashboard.html` (nouveau)
- `app_setup.html` (nouveau)

Railway va redéployer en installant les nouvelles deps (bcrypt, jwt) automatiquement.

### **3. Test**
- `https://kao-v2-live-production-73ab.up.railway.app/dashboard` → ton dashboard avec V6
- `https://kao-v2-live-production-73ab.up.railway.app/login` → page login publique
- `https://kao-v2-live-production-73ab.up.railway.app/register` → page register publique

---

## 🎯 URLs résumé

| URL | À qui | Description |
|---|---|---|
| `/dashboard` | **Toi seul** | Ton dashboard complet (V6 features incluses) |
| `/world` | **Public** | World Intelligence (carte + TV) |
| `/login` | **Tout le monde** | Login utilisateurs SaaS |
| `/register` | **Tout le monde** | Inscription gratuite |
| `/app/dashboard` | **User connecté** | Dashboard utilisateur |
| `/app/setup` | **User connecté** | Setup wizard |

---

## 🔐 Endpoints API V6

### Auth
- `POST /api/auth/register` — Inscription
- `POST /api/auth/login` — Login
- `POST /api/auth/logout` — Logout
- `GET /api/auth/me` — Profil actuel
- `POST /api/auth/settings` — Update Telegram + username

### User data
- `GET /api/user/levels` — Liste niveaux custom
- `POST /api/user/levels` — Ajouter niveau
- `DELETE /api/user/levels/:name` — Supprimer niveau
- `GET /api/user/trades` — Mes trades

### EA endpoints (pour utilisateurs)
- `POST /api/user/trade/new` — EA envoie nouveau trade (header X-Auth-Token)
- `POST /api/user/trade/close` — EA envoie fermeture trade

---

## 💡 Comment un nouveau user s'inscrit

1. Va sur `/register`
2. Email + password + username
3. Compte créé → redirigé vers `/app/setup`
4. Suit les 5 étapes :
   - Récupère son token unique généré
   - Crée son bot Telegram
   - Configure MT5
5. Ses trades arrivent sur `/app/dashboard`
6. Aucune interférence avec ton dashboard à toi

---

## ⚠️ Points importants

### **Coûts**
- **Railway** : free tier 500h/mois suffit pour quelques utilisateurs
- **Au-delà** : upgrade Railway à ~5€/mois si beaucoup d'inscrits
- **Neon DB** : gratuit jusqu'à 10 GB (= des milliers de trades)

### **Sécurité**
- Mots de passe hashés bcrypt (10 rounds)
- JWT signé · cookies httpOnly + sameSite + secure
- Token unique par utilisateur pour EA
- Isolation DB stricte (user_id sur toutes les tables)

### **Limites actuelles**
- Pas d'envoi Telegram par utilisateur (architecture à étendre)
- EA téléchargeable depuis setup wizard (basique · à enrichir)
- Pas de smart engine sur trades user (reste sur compte principal)
- Pas de password reset (à ajouter si besoin)

### **Ta responsabilité**
Si tu rends ça public commercial, tu dois :
- CGU + mentions légales
- Disclaimer trading
- RGPD (tu stockes des emails)
- Statut juridique adéquat

---

## 🎁 Bonus inclus

Ton dashboard `/dashboard` a maintenant :
- Bouton **🔇 Voix OFF / 🔊 Voix ON** dans la mini status bar
- Section **🌅 Daily Plan** (briefing complet du jour)
- Trio **⚖️ Comparaison + 🎬 Replay + 🧪 Backtest** côte à côte
- Beep sonore sur A++
- Code couleurs par type de setup
- Auto-reconnexion si serveur down

---

**KAO V2 V6.0** · Full Pack + SaaS · Public platform ready
