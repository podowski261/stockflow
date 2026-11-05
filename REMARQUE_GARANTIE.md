# ⚠ REMARQUE GARANTIE — FACTURES

## ✅ AJOUTÉ:

### **Remarque après section tests:**

> **⚠ Remarque importante :** Tous les périphériques testés (webcam, son, clavier, trackpad, ports, etc.) ne sont pas couverts par la garantie en cas de dysfonctionnement ultérieur.

---

## 📋 INTÉGRATION:

### **Facture A4:**
```
┌─────────────────────────────────────┐
│ TESTS EFFECTUÉS                     │
│ ☐ Écran      ☐ Son                 │
│ ☐ Clavier    ☐ Tous les ports      │
│ ☐ Webcam     ☐ Trackpad             │
├─────────────────────────────────────┤
│ ⚠ Remarque importante :             │
│ Tous les périphériques testés      │
│ (webcam, son, clavier, trackpad,    │
│ ports, etc.) ne sont pas couverts   │
│ par la garantie en cas de           │
│ dysfonctionnement ultérieur.        │
└─────────────────────────────────────┘
```

**Style:**
- Font-size: `10px`
- Color: `#666` (gris)
- Font-style: `italic`
- Icon ⚠: `#d32f2f` (rouge)
- Border-top: `1px solid #ddd`
- Padding-top: `10px`
- Margin-top: `12px`

---

### **Ticket 80mm:**
```
┌─────────────────────────────┐
│ TESTS EFFECTUÉS             │
│ ☐ Écran                     │
│ ☐ Son                       │
│ ☐ Clavier                   │
│ ☐ Tous les ports            │
│ ☐ Webcam (si existant)      │
│ ☐ Trackpad / Souris         │
├-----------------------------┤
│ ⚠ Remarque : Les            │
│ périphériques testés ne     │
│ sont pas couverts par la    │
│ garantie.                   │
└─────────────────────────────┘
```

**Style (version compacte):**
- Font-size: `8px`
- Color: `#555` (gris foncé)
- Font-style: `italic`
- Icon ⚠: `#000` (noir)
- Border-top: `1px dashed #999`
- Padding-top: `2mm`
- Margin-top: `2mm`

---

## 🎯 OBJECTIF:

**Protéger l'entreprise juridiquement:**
- Client informé AVANT signature
- Tests = contrôle initial uniquement
- Périphériques testés ≠ garantis
- Clause visible sur facture officielle

---

## 📁 CODE MODIFIÉ:

### **`generateTestSection(sale)` — Facture A4:**
```javascript
// Remarque garantie
html += '<div style="margin-top:12px;padding-top:10px;border-top:1px solid #ddd;font-size:10px;color:#666;font-style:italic;line-height:1.5;">';
html += '<strong style="color:#d32f2f;">⚠ Remarque importante :</strong> Tous les périphériques testés (webcam, son, clavier, trackpad, ports, etc.) ne sont pas couverts par la garantie en cas de dysfonctionnement ultérieur.';
html += '</div>';
```

### **`generateTestSection80(sale)` — Ticket 80mm:**
```javascript
// Remarque garantie (version compacte 80mm)
html += '<div style="margin-top:2mm;padding-top:2mm;border-top:1px dashed #999;font-size:8px;color:#555;font-style:italic;line-height:1.4;">';
html += '<strong style="color:#000;">⚠ Remarque :</strong> Les périphériques testés ne sont pas couverts par la garantie.';
html += '</div>';
```

---

## ✅ RÉSULTAT:

### **Workflow facture:**
1. Caisse crée facture
2. Section tests affichée avec checkboxes
3. **Remarque garantie visible SOUS les tests**
4. Client signe = accepte conditions
5. Protection juridique entreprise

---

## 📊 EXEMPLES RÉELS:

### **Vente MacBook + Souris:**

**Section A4:**
```
TESTS EFFECTUÉS

Tests Ordinateur
☐ Écran                ☐ Son
☐ Clavier              ☐ Tous les ports
☐ Webcam (si existant) ☐ Trackpad / Souris

Tests Accessoires
☐ Test fonctionnel effectué

⚠ Remarque importante : Tous les périphériques testés 
(webcam, son, clavier, trackpad, ports, etc.) ne sont 
pas couverts par la garantie en cas de dysfonctionnement 
ultérieur.
```

**Section 80mm:**
```
TESTS EFFECTUÉS

Tests Ordinateur
☐ Écran
☐ Son
☐ Clavier
☐ Tous les ports
☐ Webcam (si existant)
☐ Trackpad / Souris

Tests Accessoires
☐ Test fonctionnel effectué

⚠ Remarque : Les périphériques testés ne 
sont pas couverts par la garantie.
```

---

## 🎯 CLARIFICATION JURIDIQUE:

**Ce qui EST couvert:**
- Défauts fabrication
- Pannes matérielles principales (carte mère, écran, disque)

**Ce qui N'EST PAS couvert (si testé):**
- Webcam testée → non garantie
- Ports USB testés → non garantis
- Son testé → non garanti
- Clavier/trackpad testés → non garantis

**Raison:** Test initial ≠ garantie fonctionnement durable

---

**VITA!** Remarque garantie sur tous les formats de facture! 🎉
