# Mise à jour: Cartes de livraison cliquables

## Modifications apportées

### Fichier: `STOCKFLOW/public/coordination.html`

## ✅ Nouvelles fonctionnalités

### 1. **Cartes cliquables**
- Toutes les cartes de livraison sont maintenant cliquables
- Cursor change en pointer au survol
- Animation de survol (border accent + shadow)

### 2. **Modal de détails complets**
- Nouveau modal `detailsModal` qui affiche:
  - **Statut** de la livraison avec badge coloré
  - **Date** de création et date de livraison
  - **Priorité** (si marquée comme prioritaire)
  - **Informations client:**
    - Nom
    - Téléphone
    - Adresse complète
    - Heure de livraison souhaitée
  - **Liste détaillée des articles:**
    - Nom du produit
    - Quantité
    - Prix unitaire
    - Sous-total par article
  - **Montants:**
    - Sous-total des articles
    - Frais de livraison
    - **Total général** (en gros, coloré)
  - **Équipe:**
    - Nom du commercial
    - Nom du livreur (si assigné)
  - **Note** (si présente)

### 3. **Actions rapides dans le modal**
- Bouton "Fermer"
- Bouton "Assigner" / "Réassigner" → ouvre modal d'assignation
- Bouton "Étiquette" (si livreur assigné) → imprime l'étiquette

### 4. **Gestion des clics**
- `event.stopPropagation()` sur les boutons d'action
- Les boutons dans la carte n'ouvrent pas le modal
- Seul le clic sur la carte elle-même ouvre les détails

## 🎨 Améliorations visuelles

### Styles ajoutés:
```css
.dcard {
  cursor: pointer;
  transition: all 0.2s;
}

.dcard:hover {
  border-color: var(--accent);
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

.dcard-content {
  pointer-events: none;
}

.dcard-actions {
  pointer-events: auto;
}
```

### Layout du modal:
- Rangées de détails avec labels/valeurs alignés
- Sections séparées par des séparateurs horizontaux
- Liste d'articles avec quantités et prix
- Total mis en évidence (grand, gras, coloré)

## 🔧 Fonctions JavaScript

### `showDetails(id)`
- Charge les détails complets via API `/api/deliveries/:id`
- Construit dynamiquement le HTML du modal
- Affiche toutes les informations de la commande
- Génère les boutons d'action appropriés selon le statut

### Structure des données affichées:
```javascript
{
  delivery_number: "123",
  status: "nouvelle",
  priority: true/false,
  client_name: "...",
  client_phone: "...",
  client_address: "...",
  delivery_time: "14h",
  items: [
    { product_name: "...", quantity: 2, unit_price: 100000 }
  ],
  total: 200000,
  delivery_fee: 5000,
  commercial_name: "...",
  livreur_name: "...",
  note: "..."
}
```

## 🚀 Workflow utilisateur

### Ancien workflow:
1. Voir la carte avec résumé
2. Cliquer "Assigner" directement

### Nouveau workflow:
1. **Cliquer sur la carte** → voir tous les détails
2. Examiner les articles, montants, client
3. Décider d'assigner ou imprimer étiquette
4. Actions rapides depuis le modal
5. OU cliquer "Assigner" directement depuis la carte (sans ouvrir le modal)

## ✅ Avantages

1. **Vision complète** — Coordinateur voit tous les détails avant d'assigner
2. **Meilleure décision** — Liste des articles aide à choisir le bon livreur
3. **Gain de temps** — Pas besoin d'aller ailleurs pour voir les détails
4. **UX améliorée** — Interface plus intuitive et professionnelle
5. **Flexibilité** — Peut assigner rapidement OU voir détails d'abord

## 📊 Informations techniques

- **API utilisée:** `GET /api/deliveries/:id`
- **Format:** JSON complet avec items
- **Modal:** Réutilise le système SF.Modal existant
- **Responsive:** S'adapte aux petits écrans
- **Performances:** Charge les détails à la demande uniquement

---

**Date de mise à jour:** 3 août 2026  
**Fichiers modifiés:** `STOCKFLOW/public/coordination.html`  
**Rétrocompatibilité:** ✅ Totale — les boutons "Assigner" et "Étiquette" fonctionnent toujours directement
