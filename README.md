# StockFlow — Gestion de Stock en Temps Réel

Application web de suivi de stock pour ordinateurs, avec mouvements en temps réel, PDF et catalogue public.

## 🗂️ Structure du projet

```
stockflow/
├── backend/
│   ├── server.js            # Serveur Express principal
│   ├── db/
│   │   ├── index.js         # Connexion PostgreSQL
│   │   └── schema.sql       # Schéma complet de la base de données
│   ├── middleware/
│   │   └── auth.js          # JWT authentication
│   ├── routes/
│   │   ├── auth.js          # Login, change-password
│   │   ├── products.js      # CRUD produits, mouvements, étiquettes
│   │   ├── api.js           # Fournisseurs, users, garanties, rapports, config
│   │   └── public.js        # Catalogue public + SSE temps réel
│   ├── utils/
│   │   ├── snGenerator.js   # Génération SN automatique
│   │   └── pdfGenerator.js  # Rapports HTML imprimables (A4 + étiquettes 50x30mm)
│   ├── sse.js               # Server-Sent Events (temps réel)
│   └── package.json
├── frontend/
│   ├── login.html           # Page de connexion
│   ├── app.html             # Application principale (shell)
│   ├── catalogue.html       # Catalogue public (point de vente)
│   ├── vite.config.js
│   ├── package.json
│   └── src/
│       ├── app.js           # Router, auth, API client, toast
│       └── pages/
│           ├── dashboard.js     # Admin: stats + graphiques
│           ├── atelier.js       # Stock atelier: réception, envoi
│           ├── installation.js  # Stock installation
│           ├── boutique.js      # Stock boutique: vente, livraison
│           ├── garantie.js      # Stock garantie: traitement
│           ├── vendu.js         # Historique ventes
│           ├── mouvements.js    # Historique mouvements
│           ├── search.js        # Recherche globale
│           ├── rapports.js      # Génération rapports PDF
│           ├── utilisateurs.js  # Gestion utilisateurs (admin)
│           └── config.js        # Configuration entreprise (admin)
└── render.yaml              # Déploiement Render

```

## 🚀 Déploiement sur Render (gratuit)

### Méthode 1 — render.yaml (recommandée)

1. Créez un compte sur [render.com](https://render.com)
2. Poussez ce projet sur GitHub
3. Dans Render : **New > Blueprint** → pointez sur votre repo
4. Render lit automatiquement `render.yaml` et crée le service + la base de données
5. Attendez le déploiement (~5 min)

### Méthode 2 — Manuelle

1. **Base de données** : New > PostgreSQL (plan Free)
   - Notez la **Connection String**

2. **Web Service** : New > Web Service
   - Repo: votre GitHub
   - Root Directory: `backend`
   - Build Command: `npm install && cd ../frontend && npm install && npm run build && cp -r dist ../backend/`
   - Start Command: `node server.js`
   - Variables d'environnement:
     - `DATABASE_URL` = votre connection string PostgreSQL
     - `JWT_SECRET` = une chaîne aléatoire longue
     - `NODE_ENV` = `production`

## 🔐 Connexion par défaut

```
Identifiant : admin
Mot de passe : admin_26
```

⚠️ **Changez ce mot de passe après la première connexion !**

## 👥 Rôles utilisateurs

| Rôle | Accès |
|------|-------|
| `admin` | Tout voir, modifier, supprimer, rapports, config |
| `atelier` | Réception produits, envoi vers installation/garantie |
| `installation` | Stock installation, envoi vers boutique/garantie |
| `boutique` | Stock boutique, vente, livraison, envoi garantie |
| `garantie` | Traitement des garanties |

## 📋 Circulation des produits

```
Fournisseur
    ↓
[Stock Atelier] → [Garantie]
    ↓
[Installation] → [Garantie]
    ↓
[Stock Boutique] → [Garantie]
    ↓
[Vendu] ou [Livré]
```

## 📄 Fonctionnalités PDF

- **Étiquette thermique 50×30mm** : N° série + code-barre + infos produit
- **État du stock** (A4 paysage) : liste de tous les produits par stock
- **Historique des mouvements** (A4) : par période, filtrable
- **Bon de réception boutique** (A4 portrait) : avec zones de signature

## 🔄 Temps réel

Le catalogue et le dashboard se mettent à jour automatiquement via Server-Sent Events (SSE) lorsque le stock change.

## 🔢 Format du N° Série interne

```
FG-HP-640G5-091026-0001
│   │   │    │      │
│   │   │    │      └─ Compteur 4 chiffres
│   │   │    └────────── Date (JJMMAA)
│   │   └─────────────── Code modèle
│   └─────────────────── Code marque
└─────────────────────── Code fournisseur
```

## 💻 Développement local

```bash
# Backend
cd backend
cp .env.example .env
# Modifier DATABASE_URL dans .env
npm install
npm start

# Frontend (dans un autre terminal)
cd frontend
npm install
npm run dev
# Ouvre sur http://localhost:5173
```
