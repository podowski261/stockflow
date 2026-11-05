# 📄 FACTURE CAISSE — SECTION TESTS

## ✅ MODIFICATIONS EFFECTUÉES:

### **1. Facture 80mm (Ticket Thermique) - SANS SIGNATURES**
- **Layout:** Compact vertical 80mm
- **Font-size:** `9px` (optimisé pour thermique)
- **Section tests** après TOTAL et Paiement
- **PAS de cages signature** (ticket simple)

### **2. Facture A4 (Format pro avec signatures)**
- **Mise en page TechFlow:** Margin `12mm 10mm`
- **Font-size:** `11.5px`
- **Section tests** + **4 cages signatures**
- **Remarque garantie** après tests (français professionnel)

### **3. Ticket 80mm (Format thermique TechFlow)**
- **Style:** Courier New monospace, dashed borders
- **Padding:** `8mm 5mm`
- **Section tests** après TOTAL
- **Remarque garantie** (version compacte)

---

## 🎯 FACTURE 80mm - SECTION TESTS:

```
┌─────────────────────────────────────┐
│ TESTS EFFECTUÉS                     │
├─────────────────────────────────────┤
│ [Varie selon produits]              │
└─────────────────────────────────────┘
```

---

## 🎯 LOGIQUE DÉTECTION:

### **A. Ordinateur seul:**
```
☐ Écran
☐ Son
☐ Clavier
☐ Tous les ports
☐ Webcam (si existant)
☐ Trackpad / Souris
```

**Détection:** 
- Category contient: `ordinateur`, `laptop`, `pc`
- OU Product_name contient: `ordinateur`, `laptop`, `macbook`

---

### **B. Accessoires seul:**
```
☐ Test fonctionnel effectué
```

**Détection:**
- Category contient: `accessoire`, `périphérique`
- OU mots-clés: `souris`, `clavier`, `casque`, `écouteur`, `cable`, `adaptateur`, `chargeur`

---

### **C. Ordinateur + Accessoires:**

Séparation automatique:

```
Tests Ordinateur
☐ Écran
☐ Son
☐ Clavier
☐ Tous les ports
☐ Webcam (si existant)
☐ Trackpad / Souris

Tests Accessoires
☐ Test fonctionnel effectué
```

---

## 📋 LAYOUT TICKET 80mm:

```
┌─────────────────────────────┐
│     [LOGO]                  │
│     NOM SOCIÉTÉ             │
│     Adresse                 │
│     Tél · Email             │
│     NIF · STAT              │
├─────────────────────────────┤
│ FACTURE N° XXXXX            │
│ Date: XX/XX/XXXX XX:XX      │
│ Client: XXX                 │
│ Caisse: XXX  Vend.: XXX     │
├─────────────────────────────┤
│ Produit 1                   │
│ Specs...                    │
│ SN001        1 000 000 Ar   │
│ ........................... │
│ Produit 2                   │
│ SN002          500 000 Ar   │
├─────────────────────────────┤
│ TOTAL      1 500 000 Ar     │
│ Paiement: Espèces           │
├─────────────────────────────┤
│   TESTS EFFECTUÉS           │
│ ☐ Écran                     │
│ ☐ Son                       │
│ ☐ Clavier                   │
│ ☐ Tous les ports            │
│ ☐ Webcam (si existant)      │
│ ☐ Trackpad / Souris         │
├─────────────────────────────┤
│ ⚠ Remarque importante :     │
│ Tous les périphériques      │
│ testés (webcam, son,        │
│ clavier, trackpad, ports,   │
│ etc.) ne sont pas couverts  │
│ par la garantie en cas de   │
│ dysfonctionnement ultérieur.│
├─────────────────────────────┤
│ ⚠ Remarque : Les            │
│ périphériques testés ne     │
│ sont pas couverts par la    │
│ garantie.                   │
├─────────────────────────────┤
│     *BARCODE*               │
│     12345678                │
├─────────────────────────────┤
│ Merci de votre visite !     │
└─────────────────────────────┘
```

---

## 📋 LAYOUT FACTURE A4 (avec signatures):

```
┌─────────────────────────────────────────────┐
│ [LOGO]              FACTURE                  │
│ Nom société         N° XXXXX                 │
│ Adresse             Date                     │
│ Tél · Email         *Barcode*                │
│ NIF · STAT          12345678                 │
├─────────────────────────────────────────────┤
│ Client: XXX         Vendeur: XXX             │
│ Tél: XXX            Caisse: XXX              │
│ Adresse: XXX                                 │
├─────────────────────────────────────────────┤
│ Désignation    │ N° série    │ Prix         │
├────────────────┼─────────────┼──────────────┤
│ Produit 1      │ SN001       │ 1 000 000 Ar │
│ Specs...       │ SN fab      │              │
│ Produit 2      │ SN002       │ 500 000 Ar   │
├─────────────────────────────────────────────┤
│                      TOTAL: 1 500 000 Ar     │
│ Paiement: Espèces                            │
├─────────────────────────────────────────────┤
│ 🔲 TESTS EFFECTUÉS                          │
│ ☐ Écran                ☐ Son                │
│ ☐ Clavier              ☐ Tous les ports     │
│ ☐ Webcam (si exist.)   ☐ Trackpad/Souris   │
├─────────────────────────────────────────────┤
│ [Note invoice si configuré]                 │
├─────────────────────────────────────────────┤
│ ┌──────────┐ ┌──────────┐ ┌──────────┐    │
│ │Le Client │ │La Caisse │ │Resp.Stock│    │
│ │          │ │          │ │          │    │
│ └──────────┘ └──────────┘ └──────────┘    │
│ ┌──────────┐                               │
│ │Livreur/  │                               │
│ │Remise    │                               │
│ └──────────┘                               │
├─────────────────────────────────────────────┤
│ [Footer invoice]                            │
└─────────────────────────────────────────────┘
```

---

## 🔧 CODE FUNCTIONS:

### **Pour A4:**
- **generateTestSection(sale)** - Analyse + retourne HTML A4
- **generateOrdCheckboxes()** - Checkboxes ordinateur (grid 2 cols)
- **generateAccessCheckbox()** - Checkbox accessoires

### **Pour 80mm:**
- **generateTestSection80(sale)** - Analyse + retourne HTML 80mm compact
- **generateOrdCheckboxes80()** - Checkboxes ordinateur (vertical list)
- **generateAccessCheckbox80()** - Checkbox accessoires

**Logique identique**, **layout adapté** au format!

---

## 💡 EXEMPLES:

### **Vente: 1 Laptop ASUS**
→ Section "Tests effectués" avec 6 checkboxes ordinateur

### **Vente: 1 Souris + 1 Clavier**
→ Section "Tests effectués" avec 1 checkbox "Test fonctionnel"

### **Vente: 1 MacBook + 1 Souris + 1 Cable**
→ Section divisée:
- **Tests Ordinateur** (6 checkboxes)
- **Tests Accessoires** (1 checkbox)

---

## ✅ STYLE TECHFLOW:

- **Border:** 1.5px solid #17220a (vert foncé)
- **Background:** #fafafa (gris très clair)
- **Padding:** 12px
- **Border-radius:** 8px
- **Font:** Bold 13px titre, 11.5px checkboxes
- **Checkboxes:** 14px × 14px

---

## 🎯 IMPRESSION:

1. **Caisse crée facture**
2. **Dialogue choix format:**
   - Ticket 80mm (thermique)
   - **Facture A4** ← section tests ici
3. **Print automatique**
4. **Section tests cochée manuellement** avant remise client

---

## 📁 FICHIER MODIFIÉ:

- ✅ `STOCKFLOW/public/js/sf-invoice.js`
  - **A4:** `generateTestSection()`, `generateOrdCheckboxes()`, `generateAccessCheckbox()`
  - **80mm:** `generateTestSection80()`, `generateOrdCheckboxes80()`, `generateAccessCheckbox80()`
  - Intégration dans `printA4()` ET `print80()`
  - A4: Margin réduit style TechFlow
  - 80mm: Layout vertical compact

---

## ✅ DIFFÉRENCES FORMATS:

| Caractéristique | 80mm (Thermique) | A4 (Pro) |
|----------------|------------------|----------|
| **Signatures** | ❌ Non | ✅ Oui (4 cages) |
| **Tests** | ✅ Vertical compact | ✅ Grid 2 colonnes |
| **Font-size** | 9px | 11.5px |
| **Checkboxes** | 12×12px | 14×14px |
| **Layout** | Liste verticale | Grid responsive |
| **Usage** | Ticket rapide | Facture officielle |

---

**VITA!** Section tests sur **LES DEUX formats** de facture! 🎉
