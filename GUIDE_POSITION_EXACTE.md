# 📍 GUIDE: Toerana EXACTE hanampiana code

## 🎯 POSITION PRÉCISE:

### **Fichier:** `STOCKFLOW/server.js`

### **Ligne:** **3310** (après ligne 3309)

### **Marker visuel:**

```javascript
// CHERCHER izao ao server.js:

        broadcast('delivery:update', { id: d.id });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});   // <-- Eto no farany amin'ny endpoint /assign

// ========================================
// 🔴 AMPIANA CODE VAOVAO ETO AMBANY 🔴
// ========================================

// Livreur : accepter (prise en charge).
app.post('/api/deliveries/:id/accept', ...)
```

---

## ✅ STEP-BY-STEP INSTRUCTIONS:

### **1. OUVRIR server.js**

Efa open sahady ao VS Code ianao izao.

### **2. CTRL+G (Go to Line)**

Tape: **3310** → Enter

Tonga amin'ny ligne **3310** (après `});` farany amin'ny `/assign`)

### **3. CREATE NEW LINE**

Press **Enter** mba hahazoana line vaovao

### **4. PASTE CODE ITO:**

```javascript

// ============================================================
//  ÉTIQUETTE LIVRAISON PROFESSIONNEL 60×40mm
// ============================================================

// Générer étiquette professionnelle pour livraison
app.get('/api/deliveries/:id/label', requireAuth, requireRole('coordinateur', 'caisse', 'commercial_ligne'), async (req, res) => {
    try {
        // Récupérer infos compagnie
        const company = await dbGet('SELECT * FROM company_config WHERE id = 1');
        const companyName = company?.name || 'STOCKFLOW';
        const companyAddress = company?.address || '';
        const companyPhone = company?.phone || '';
        const companyLogo = company?.logo || null;
        
        // Récupérer livraison complète
        const d = await dbGet('SELECT * FROM deliveries WHERE id = ?', [req.params.id]);
        if (!d) return res.status(404).json({ error: 'Livraison introuvable' });
        if (!d.livreur_name) return res.status(400).json({ error: 'Livreur non assigné' });
        
        // Récupérer items
        const items = await dbAll('SELECT * FROM delivery_items WHERE delivery_id = ?', [d.id]);
        
        const total = parseFloat(d.total) + parseFloat(d.delivery_fee || 0);
        const dateStr = new Date(d.delivery_date).toLocaleDateString('fr-FR');
        const timeStr = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        
        // HTML professionnel
        const html = `<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <title>Étiquette Livraison #${d.delivery_number}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        @page { size: 210mm 140mm; margin: 0; }
        body { font-family: Arial, sans-serif; width: 210mm; height: 140mm; padding: 8mm; }
        
        .label { border: 3px solid #000; padding: 6mm; height: 124mm; display: flex; flex-direction: column; }
        
        .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #333; padding-bottom: 4mm; margin-bottom: 4mm; }
        .logo { max-width: 40mm; max-height: 20mm; object-fit: contain; }
        .company-info { text-align: right; font-size: 9px; color: #555; line-height: 1.5; }
        .company-name { font-size: 16px; font-weight: bold; color: #000; margin-bottom: 2mm; }
        
        .delivery-number { font-size: 24px; font-weight: bold; margin-bottom: 2mm; }
        .delivery-date { font-size: 10px; color: #666; margin-bottom: 4mm; }
        
        .section { margin-bottom: 3mm; }
        .section-title { font-size: 10px; font-weight: bold; color: #333; text-transform: uppercase; margin-bottom: 1.5mm; border-bottom: 1px solid #ddd; }
        .section-content { font-size: 11px; line-height: 1.6; }
        
        .items-list { background: #f9f9f9; padding: 3mm; border-radius: 2mm; max-height: 25mm; overflow: hidden; }
        .item { font-size: 10px; padding: 0.5mm 0; }
        
        .total-box { background: #000; color: #fff; padding: 3mm; text-align: center; border-radius: 2mm; margin-top: auto; }
        .total-label { font-size: 11px; margin-bottom: 1mm; }
        .total-amount { font-size: 20px; font-weight: bold; }
        
        .footer { margin-top: 3mm; padding-top: 2mm; border-top: 1px solid #ddd; }
        .thanks { font-size: 11px; font-style: italic; text-align: center; color: #333; }
        .print-time { font-size: 8px; color: #999; text-align: right; margin-top: 1mm; }
        
        @media print { body { margin: 0; } .label { page-break-inside: avoid; } }
    </style>
</head>
<body>
    <div class="label">
        <div class="header">
            ${companyLogo ? `<img src="${companyLogo}" alt="Logo" class="logo">` : `<div class="company-name">${companyName}</div>`}
            <div class="company-info">
                <div class="company-name">${companyName}</div>
                ${companyAddress ? `<div>${companyAddress}</div>` : ''}
                ${companyPhone ? `<div>Tél: ${companyPhone}</div>` : ''}
            </div>
        </div>
        
        <div class="delivery-number">BON DE LIVRAISON N° ${d.delivery_number}</div>
        <div class="delivery-date">Date: ${dateStr}</div>
        
        <div class="section">
            <div class="section-title">Destinataire</div>
            <div class="section-content">
                <strong>${d.client_name}</strong><br>
                ${d.client_phone ? `Tél: ${d.client_phone}<br>` : ''}
                Adresse: ${d.client_address}<br>
                ${d.delivery_time ? `Heure souhaitée: ${d.delivery_time}` : ''}
            </div>
        </div>
        
        <div class="section">
            <div class="section-title">Articles</div>
            <div class="items-list">
                ${items.map(item => {
                    const subtotal = item.quantity * item.unit_price;
                    return `<div class="item">${item.quantity}× ${item.product_name} - ${Math.round(subtotal).toLocaleString('fr-FR')} Ar</div>`;
                }).join('')}
            </div>
        </div>
        
        <div class="section">
            <div class="section-title">Livreur</div>
            <div class="section-content"><strong>${d.livreur_name}</strong></div>
        </div>
        
        <div class="total-box">
            <div class="total-label">MONTANT TOTAL (livraison incluse)</div>
            <div class="total-amount">${Math.round(total).toLocaleString('fr-FR')} Ar</div>
        </div>
        
        <div class="footer">
            <div class="thanks">Merci pour votre confiance et à bientôt !</div>
            <div class="print-time">Imprimée le ${dateStr} à ${timeStr}</div>
        </div>
    </div>
    <script>window.onload = () => { window.print(); };</script>
</body>
</html>`;
        
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (e) { 
        console.error('Label generation error:', e);
        res.status(500).json({ error: 'Erreur: ' + e.message }); 
    }
});

// API copier résumé (français professionnel)
app.get('/api/deliveries/:id/summary', requireAuth, async (req, res) => {
    try {
        const d = await dbGet('SELECT * FROM deliveries WHERE id = ?', [req.params.id]);
        if (!d) return res.status(404).json({ error: 'Livraison introuvable' });
        
        const items = await dbAll('SELECT * FROM delivery_items WHERE delivery_id = ?', [d.id]);
        const total = parseFloat(d.total) + parseFloat(d.delivery_fee || 0);
        
        let summary = `RÉCAPITULATIF DE COMMANDE\n\n`;
        summary += `Contact client\n`;
        summary += `Nom: ${d.client_name}\n`;
        summary += `Téléphone: ${d.client_phone || 'Non renseigné'}\n\n`;
        
        summary += `Articles commandés:\n`;
        items.forEach(item => {
            const subtotal = item.quantity * item.unit_price;
            summary += `• ${item.product_name} - ${item.quantity} pièce(s) = ${Math.round(subtotal).toLocaleString('fr-FR')} Ar\n`;
        });
        
        summary += `\nFrais de livraison: ${Math.round(d.delivery_fee).toLocaleString('fr-FR')} Ar\n`;
        summary += `TOTAL: ${Math.round(total).toLocaleString('fr-FR')} Ar\n\n`;
        summary += `Adresse de livraison: ${d.client_address}\n`;
        summary += `Heure souhaitée: ${d.delivery_time || 'Non précisée'}`;
        
        res.json({ summary });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

```

### **5. SAVE (CTRL+S)**

Tadidio SAVE rehefa paste!

---

## ✅ VISUAL MARKER:

**ALOHA (ligne 3309):**
```javascript
    } catch (e) { res.status(500).json({ error: e.message }); }
});
```

**🟢 PASTE CODE ETO AMBANY 🟢**

**APRÈS (ligne suivante ~3310+):**
```javascript
// Livreur : accepter (prise en charge).
app.post('/api/deliveries/:id/accept', requireAuth, ...
```

---

## 🎯 RÉSUMÉ:

1. **Ligne:** 3310
2. **Après:** `});` amin'ny endpoint `/assign`  
3. **Aloha:** endpoint `/accept`
4. **Action:** Paste code COMPLÈTE ao

---

## ⚠️ ATTENTION:

- **TSY OVAINA** ny code efa misy
- **PASTE FOTSINY** code vaovao eo amin'ny line 3310
- **SAVE** rehefa vita

---

Vita! Azo atao ve izao?
