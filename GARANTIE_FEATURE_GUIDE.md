# 🔧 FEATURE: Envoi Garantie depuis Stock

## 🎯 OBJECTIF:

**Responsable stock** afaka mandefa produit any garantie mivantana:
- **Sortie:** Stock dépôt
- **Entrée:** Stock garantie (tsy hita isany)
- **2 Types:** Garantie fournisseur / Garantie exceptionnelle

---

## 📋 WORKFLOW:

```
┌─────────────────────────────────────────────────┐
│ RESPONSABLE STOCK (stock.html)                  │
├─────────────────────────────────────────────────┤
│ 1. Voit produit avec problème                   │
│ 2. Clique engrenage (⚙) → "Envoyer en garantie"│
│ 3. Modal s'ouvre:                               │
│    - Sélectionne unité(s) (serial)              │
│    - Choisit type garantie:                     │
│      ○ Garantie fournisseur                     │
│      ○ Garantie exceptionnelle                  │
│    - Raison / Note                              │
│ 4. Confirme → Envoi                             │
├─────────────────────────────────────────────────┤
│ RÉSULTAT:                                       │
│ - Unité quitte location='depot'                 │
│ - Devient location='garantie'                   │
│ - Status='garantie_fournisseur' ou             │
│   'garantie_exceptionnelle'                     │
│ - N'apparaît plus dans stock dépôt              │
│ - Visible dans page garantie.html               │
└─────────────────────────────────────────────────┘
```

---

## 🔧 MODIFICATIONS NÉCESSAIRES:

### **1. API ENDPOINT (server.js)**

```javascript
// Envoyer unité(s) en garantie
app.post('/api/stock/send-warranty', requireAuth, requireRole('admin', 'gestion_stock'), async (req, res) => {
    try {
        const { unit_ids, warranty_type, reason } = req.body;
        // warranty_type: 'garantie_fournisseur' | 'garantie_exceptionnelle'
        
        if (!unit_ids || !unit_ids.length) return res.status(400).json({ error: 'Aucune unité sélectionnée' });
        if (!['garantie_fournisseur', 'garantie_exceptionnelle'].includes(warranty_type)) {
            return res.status(400).json({ error: 'Type garantie invalide' });
        }
        
        const now = new Date().toISOString();
        const userName = req.session.user.full_name || req.session.user.username;
        
        for (const unitId of unit_ids) {
            // Récupérer unité
            const unit = await dbGet('SELECT * FROM stock_units WHERE id = ?', [unitId]);
            if (!unit) continue;
            if (unit.location !== 'depot' || unit.status !== 'stock') {
                return res.status(400).json({ error: `Unité ${unit.serial} non disponible au dépôt` });
            }
            
            // Mettre à jour location + status
            await dbRun(`UPDATE stock_units 
                SET location = 'garantie', 
                    status = ?, 
                    holder_user_id = NULL,
                    updated_at = ?
                WHERE id = ?`, 
                [warranty_type, now, unitId]
            );
            
            // Logger mouvement
            await dbRun(`INSERT INTO unit_movements 
                (unit_id, serial, from_status, to_status, action, user_id, user_name, note, created_at)
                VALUES (?, ?, 'stock', ?, 'garantie_envoi', ?, ?, ?, ?)`,
                [unitId, unit.serial, warranty_type, req.session.user.id, userName, reason || '', now]
            );
            
            logActivity(req, 'create', 'warranty', unitId, { warranty_type, reason, serial: unit.serial });
        }
        
        broadcast('stock:update', {});
        broadcast('warranty:update', {});
        
        res.json({ success: true, count: unit_ids.length });
    } catch (e) {
        console.error('Send warranty error:', e);
        res.status(500).json({ error: e.message });
    }
});
```

**📍 Position:** Après les endpoints stock existants (chercher `/api/stock` ou `/api/products`)

---

### **2. UI MODAL (stock.html)**

**A. Ajouter bouton "Envoyer en garantie" dans menu engrenage:**

Chercher fonction `showProductMenu` ou là où le menu engrenage est affiché, ajouter:

```html
<button onclick="Stock.openWarrantyModal(${productId})">
    <i class="fas fa-shield-alt"></i> Envoyer en garantie
</button>
```

**B. Ajouter modal HTML (avant </body>):**

```html
<!-- Modal Envoi Garantie -->
<div class="modal-overlay" id="warrantyModal">
    <div class="modal" style="max-width:560px;">
        <div class="modal-header">
            <h3><i class="fas fa-shield-alt"></i> Envoyer en garantie</h3>
            <button class="modal-close" onclick="SF.Modal.close('warrantyModal')">&times;</button>
        </div>
        <div class="modal-body">
            <div class="form-group">
                <label>Produit</label>
                <div id="warrantyProductName" style="font-weight:600;"></div>
            </div>
            
            <div class="form-group">
                <label>Unités disponibles</label>
                <div id="warrantyUnitsList" style="max-height:200px;overflow-y:auto;border:1px solid var(--border-color);border-radius:8px;padding:8px;">
                    <div style="text-align:center;padding:20px;color:var(--text-muted);">Chargement...</div>
                </div>
            </div>
            
            <div class="form-group">
                <label>Type de garantie *</label>
                <div style="display:flex;flex-direction:column;gap:8px;">
                    <label class="dest-opt" onclick="Stock.selectWarrantyType('garantie_fournisseur')">
                        <input type="radio" name="warranty_type" value="garantie_fournisseur" style="margin:0;">
                        <div style="flex:1;">
                            <div style="font-weight:600;">Garantie fournisseur</div>
                            <div style="font-size:11px;color:var(--text-muted);">Produit défectueux → retour fournisseur</div>
                        </div>
                    </label>
                    <label class="dest-opt" onclick="Stock.selectWarrantyType('garantie_exceptionnelle')">
                        <input type="radio" name="warranty_type" value="garantie_exceptionnelle" style="margin:0;">
                        <div style="flex:1;">
                            <div style="font-weight:600;">Garantie exceptionnelle</div>
                            <div style="font-size:11px;color:var(--text-muted);">Geste commercial (hors garantie normale)</div>
                        </div>
                    </label>
                </div>
            </div>
            
            <div class="form-group">
                <label>Raison / Note</label>
                <textarea id="warrantyReason" class="form-control" rows="3" placeholder="Décrivez le problème..."></textarea>
            </div>
        </div>
        <div class="modal-footer">
            <button class="btn btn-secondary" onclick="SF.Modal.close('warrantyModal')">Annuler</button>
            <button class="btn btn-primary" id="warrantyConfirmBtn" disabled onclick="Stock.confirmWarranty()">
                <i class="fas fa-paper-plane"></i> Envoyer en garantie
            </button>
        </div>
    </div>
</div>
```

**C. Ajouter fonctions JavaScript dans Stock object:**

```javascript
// Variables
warrantyProduct: null,
warrantySelectedUnits: [],
warrantyType: null,

// Ouvrir modal garantie
async openWarrantyModal(productId) {
    try {
        const product = this.list.find(p => p.id === productId);
        if (!product) return SF.toast('Produit introuvable', 'error');
        
        this.warrantyProduct = product;
        this.warrantySelectedUnits = [];
        this.warrantyType = null;
        
        document.getElementById('warrantyProductName').textContent = 
            [product.brand, product.model].filter(Boolean).join(' ') || product.name;
        
        // Charger unités disponibles au dépôt
        const units = await SF.api(`/api/products/${productId}/units?location=depot`);
        const availableUnits = units.filter(u => u.status === 'stock');
        
        if (!availableUnits.length) {
            document.getElementById('warrantyUnitsList').innerHTML = 
                '<div style="text-align:center;padding:20px;color:var(--text-muted);">Aucune unité disponible au dépôt</div>';
        } else {
            document.getElementById('warrantyUnitsList').innerHTML = availableUnits.map(u => `
                <label style="display:flex;align-items:center;gap:8px;padding:8px;border-radius:6px;cursor:pointer;border:1px solid transparent;" 
                       onmouseover="this.style.background='var(--bg-input)'" 
                       onmouseout="this.style.background='transparent'">
                    <input type="checkbox" value="${u.id}" onchange="Stock.toggleWarrantyUnit(${u.id}, this.checked)">
                    <div style="flex:1;">
                        <div style="font-weight:600;font-size:12px;">${SF.esc(u.serial)}</div>
                        ${u.manufacturer_sn ? `<div style="font-size:10px;color:var(--text-muted);">SN: ${SF.esc(u.manufacturer_sn)}</div>` : ''}
                    </div>
                </label>
            `).join('');
        }
        
        // Reset form
        document.querySelectorAll('input[name="warranty_type"]').forEach(r => r.checked = false);
        document.querySelectorAll('.dest-opt').forEach(o => o.classList.remove('active'));
        document.getElementById('warrantyReason').value = '';
        document.getElementById('warrantyConfirmBtn').disabled = true;
        
        SF.Modal.open('warrantyModal');
    } catch (e) {
        SF.toast(e.message, 'error');
    }
},

// Toggle sélection unité
toggleWarrantyUnit(unitId, checked) {
    if (checked) {
        if (!this.warrantySelectedUnits.includes(unitId)) {
            this.warrantySelectedUnits.push(unitId);
        }
    } else {
        this.warrantySelectedUnits = this.warrantySelectedUnits.filter(id => id !== unitId);
    }
    this.updateWarrantyBtn();
},

// Sélectionner type garantie
selectWarrantyType(type) {
    this.warrantyType = type;
    document.querySelectorAll('.dest-opt').forEach(o => o.classList.remove('active'));
    event.currentTarget.classList.add('active');
    document.querySelector(`input[value="${type}"]`).checked = true;
    this.updateWarrantyBtn();
},

// Update état bouton
updateWarrantyBtn() {
    const btn = document.getElementById('warrantyConfirmBtn');
    btn.disabled = !(this.warrantySelectedUnits.length > 0 && this.warrantyType);
},

// Confirmer envoi
async confirmWarranty() {
    if (!this.warrantySelectedUnits.length || !this.warrantyType) return;
    
    const reason = document.getElementById('warrantyReason').value.trim();
    const count = this.warrantySelectedUnits.length;
    const typeLabel = this.warrantyType === 'garantie_fournisseur' ? 'garantie fournisseur' : 'garantie exceptionnelle';
    
    if (!confirm(`Envoyer ${count} unité(s) en ${typeLabel} ?\n\nCes unités quitteront le stock dépôt.`)) return;
    
    try {
        await SF.api('/api/stock/send-warranty', {
            method: 'POST',
            body: JSON.stringify({
                unit_ids: this.warrantySelectedUnits,
                warranty_type: this.warrantyType,
                reason
            })
        });
        
        SF.toast(`${count} unité(s) envoyée(s) en garantie`, 'success');
        SF.Modal.close('warrantyModal');
        this.load();
    } catch (e) {
        SF.toast(e.message, 'error');
    }
},
```

---

## 📊 DATABASE:

**Pas de nouvelle table** — utilise colonnes existantes:
- `stock_units.location` → `'garantie'`
- `stock_units.status` → `'garantie_fournisseur'` ou `'garantie_exceptionnelle'`
- `unit_movements` → tracking historique

---

## 🎯 PAGE GARANTIE.HTML:

**Modification nécessaire** pour afficher les produits avec `location='garantie'`:

Chercher requête SQL:
```sql
SELECT * FROM stock_units WHERE location = 'depot'
```

Changer en:
```sql
SELECT * FROM stock_units WHERE location = 'garantie'
```

Ajouter filtre par status:
- `garantie_fournisseur`
- `garantie_exceptionnelle`

---

## ✅ RÉSUMÉ FICHIERS:

| Fichier | Modification |
|---------|--------------|
| `server.js` | ➕ Endpoint `/api/stock/send-warranty` |
| `stock.html` | ➕ Modal garantie + fonctions JS |
| `garantie.html` | 🔧 Filtrer `location='garantie'` |

---

## 🚀 TEST:

1. Login **gestion_stock**
2. Page **stock.html**
3. Clique engrenage produit
4. "Envoyer en garantie"
5. Sélectionne unité(s)
6. Choisit type garantie
7. Note raison
8. Confirme
9. Vérifie **garantie.html** → unité visible
10. Vérifie **stock.html** → unité disparue

---

**GUIDE COMPLET!** Code prêt à intégrer! 🎉
