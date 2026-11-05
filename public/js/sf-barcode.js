/* ============================================================
   STOCKFLOW — Étiquettes code-barres (numéro de série).
   Étiquettes 50 × 30 mm, orientées client (présentation soignée) :
   - nom en gras / majuscule, aligné à gauche ;
   - configuration détaillée et libellée (Processeur : … / RAM : … / …) ;
   - prix centré en gras ; code-barres centré ;
   - chiffres du n° de série répartis sur toute la largeur du code-barres.
   Deux sorties : impression navigateur (police Libre Barcode 39) et
   export PDF vectoriel (Code 39 tracé en rectangles).
   ============================================================ */
(function () {
'use strict';

// Normalise toutes les espaces Unicode (dont U+202F/U+00A0 produites par
// Intl.NumberFormat) en espace simple. \s couvre ces espaces fines/insécables
// qui s'affichent sinon comme « / » dans les polices PDF standard et faussent
// le centrage.
function normSpace(s) { return String(s == null ? '' : s).replace(/\s/g, ' '); }

// Code 39 : 9 éléments par caractère (barre/espace alternés, barre d'abord).
const CODE39 = {
    '0':'nnnwwnwnn','1':'wnnwnnnnw','2':'nnwwnnnnw','3':'wnwwnnnnn','4':'nnnwwnnnw',
    '5':'wnnwwnnnn','6':'nnwwwnnnn','7':'nnnwnnwnw','8':'wnnwnnwnn','9':'nnwwnnwnn',
    'A':'wnnnnwnnw','B':'nnwnnwnnw','C':'wnwnnwnnn','D':'nnnnwwnnw','E':'wnnnwwnnn',
    'F':'nnwnwwnnn','G':'nnnnnwwnw','H':'wnnnnwwnn','I':'nnwnnwwnn','J':'nnnnwwwnn',
    'K':'wnnnnnnww','L':'nnwnnnnww','M':'wnwnnnnwn','N':'nnnnwnnww','O':'wnnnwnnwn',
    'P':'nnwnwnnwn','Q':'nnnnnnwww','R':'wnnnnnwwn','S':'nnwnnnwwn','T':'nnnnwnwwn',
    'U':'wwnnnnnnw','V':'nwwnnnnnw','W':'wwwnnnnnn','X':'nwnnwnnnw','Y':'wwnnwnnnn',
    'Z':'nwwnwnnnn','-':'nwnnnnwnw','.':'wwnnnnwnn',' ':'nwwnnnwnn','$':'nwnwnwnnn',
    '/':'nwnwnnnwn','+':'nwnnnwnwn','%':'nnnwnwnwn','*':'nwnnwnwnn'
};

const SFBarcode = window.SFBarcode = {};

// Configuration courte (usage interne).
SFBarcode.specLine = function (u) {
    return [u.cpu, u.ram, u.storage ? (u.storage + (u.storage_type ? ' ' + u.storage_type : '')) : null, u.screen_size]
        .filter(Boolean).join(' · ');
};
// Configuration détaillée libellée : liste de { l: libellé, v: valeur }.
SFBarcode.specPairs = function (u) {
    if (u.is_accessory) {
        const a = [];
        if (u.category)    a.push({ l: 'Catégorie', v: u.category });
        if (u.subcategory) a.push({ l: 'Sous-cat.', v: u.subcategory });
        return a;
    }
    const p = [];
    if (u.cpu)       p.push({ l: 'Processeur', v: u.cpu });
    if (u.ram)       p.push({ l: 'RAM', v: u.ram });
    if (u.storage)   p.push({ l: 'Stockage', v: u.storage + (u.storage_type ? ' ' + u.storage_type : '') });
    if (u.gpu)       p.push({ l: 'GPU', v: u.gpu });
    if (u.screen_size) p.push({ l: 'Écran', v: String(u.screen_size).replace(/"$/, '') + '"' });
    const opt = [];
    if (u.touchscreen) opt.push('Tactile');
    if (u.numpad)      opt.push('Pavé num.');
    if (opt.length)  p.push({ l: 'Options', v: opt.join(', ') });
    return p;
};
// Configuration complète en une chaîne (autres usages).
SFBarcode.fullSpec = function (u) {
    return SFBarcode.specPairs(u).map(p => p.l + ' : ' + p.v).join(' · ');
};
SFBarcode.title = function (u) {
    return [u.brand, u.model].filter(Boolean).join(' ') || u.product_name || u.category || 'Produit';
};

/* ---- Les étiquettes sortent TOUJOURS en PDF (pas d'impression directe). ----
   printLabels reste comme alias pour compatibilité des appelants existants. */
SFBarcode.printLabels = function (units, fmtPrice) { return SFBarcode.downloadPDF(units, fmtPrice); };

/* ---- Logo société (net, dans l'espace libre en haut à droite) ---- */
// Récupère le logo société sous forme { dataURL, ratio } (ratio = largeur/hauteur,
// pour conserver les proportions au moment du dessin). Silencieux si absent.
async function loadCompanyLogo() {
    try {
        const c = await SF.api('/api/config');
        if (!c || !c.logo) return null;
        const res = await fetch(c.logo); if (!res.ok) return null;
        const blob = await res.blob();
        const dataURL = await new Promise(r => {
            const fr = new FileReader();
            fr.onload = () => r(fr.result); fr.onerror = () => r(null);
            fr.readAsDataURL(blob);
        });
        if (!dataURL) return null;
        // Re-encodage en PNG via canvas : jsPDF ne gère pas le WEBP, et cela
        // normalise tous les formats source (jpg/png/webp/gif) en une image sûre.
        const out = await new Promise(r => {
            const im = new Image();
            im.onload = () => {
                try {
                    const cv = document.createElement('canvas');
                    cv.width = im.naturalWidth; cv.height = im.naturalHeight;
                    cv.getContext('2d').drawImage(im, 0, 0);
                    r({ dataURL: cv.toDataURL('image/png'), ratio: im.naturalWidth / im.naturalHeight });
                } catch (e) { r(null); }
            };
            im.onerror = () => r(null);
            im.src = dataURL;
        });
        if (!out || !out.ratio) return null;
        return out;
    } catch (e) { return null; }
}

// Zone réservée au logo, en haut à droite de l'étiquette (mm).
const LOGO_BOX = { w: 16, h: 12, x: 60 - 3 - 16, y: 2.5 }; // x = LW - M - w

// Dessine le logo NET (pleine opacité) dans l'espace libre en haut à droite.
// Proportions conservées : on ajuste l'image pour tenir dans la boîte (contain),
// puis on la cale sur le bord droit intérieur.
function drawCornerLogo(doc, wm) {
    if (!wm) return;
    const r = wm.ratio || 1;
    let w = LOGO_BOX.w, h = w / r;
    if (h > LOGO_BOX.h) { h = LOGO_BOX.h; w = h * r; }
    const x = (60 - 3) - w;        // aligné à droite (LW - M)
    const y = LOGO_BOX.y + (LOGO_BOX.h - h) / 2; // centré verticalement dans la boîte
    try { doc.addImage(wm.dataURL, 'PNG', x, y, w, h); } catch (e) {}
}

/* ---- PDF vectoriel ---- */
function drawBarcode39(doc, code, cx, y, maxWidth, height) {
    const txt = '*' + String(code).toUpperCase() + '*';
    const chars = txt.split('').filter(c => CODE39[c]);
    if (!chars.length) return 0;
    const modules = chars.length * (6 + 9) + (chars.length - 1); // 6 étroits + 3 larges(x3) + gap
    const unit = maxWidth / modules;
    let x = cx - maxWidth / 2;
    doc.setFillColor(0, 0, 0);
    chars.forEach((ch, i) => {
        CODE39[ch].split('').forEach((el, j) => {
            const width = (el === 'w' ? 3 : 1) * unit;
            if (j % 2 === 0) doc.rect(x, y, width, height, 'F');
            x += width;
        });
        if (i < chars.length - 1) x += unit;
    });
    return height;
}

// Étiquettes 60 × 40 mm — sortie PDF uniquement.
// Kit STARLINK (unité avec router_id) : DEUX étiquettes, l'une pour l'antenne (dish), l'autre pour le
// routeur — même code-barres (le kit se vend en une fois, au prix du kit).
// kit : 'both' (défaut) | 'dish' (antenne seule) | 'router' (routeur seul).
SFBarcode.expandKits = function (units, kit = 'both') {
    const out = [];
    (units || []).forEach(u => {
        if (!u.router_id) { out.push(u); return; }
        const ver = u.subcategory || String(u.model || '').replace(/^kit\s+(starlink\s*)?/i, '') || '';
        // Titre « STARLINK » (court, jamais tronqué) ; la version ouvre le texte central (V4 STANDARD, PERFORMANCE GEN 3…).
        const V = ver.toUpperCase();
        if (kit !== 'router') out.push({ ...u, brand: '', model: 'Starlink',
            description: `${V} · ANTENNE (DISH)${u.manufacturer_sn ? ' · SN ' + u.manufacturer_sn : ''} · routeur ${u.router_id}` });
        if (kit !== 'dish') out.push({ ...u, brand: '', model: 'Starlink',
            description: `${V} · ROUTEUR · ID ${u.router_id} · kit avec l'antenne` });
    });
    return out;
};

SFBarcode.downloadPDF = async function (units, fmtPrice, opts = {}) {
    units = SFBarcode.expandKits((units || []).filter(u => u.serial), opts.kit || 'both');
    if (!units.length) { SF.toast('Aucune unité à exporter', 'error'); return; }
    try { await SF.needPDF(); } catch (e) { SF.toast(e.message, 'error'); return; }
    const { jsPDF } = window.jspdf;
    const LW = 60, LH = 40, M = 3, INNER = LW - 2 * M;   // format fixe

    const wm = await loadCompanyLogo();   // logo société (null si absent)

    let doc = null;
    units.forEach(u => {
        if (!doc) doc = new jsPDF({ unit: 'mm', format: [LW, LH], orientation: 'landscape' });
        else doc.addPage([LW, LH], 'landscape');
        drawCornerLogo(doc, wm);          // logo net, haut à droite
        doc.setTextColor(0, 0, 0);

        // Espace réservé au logo (haut droite) : tout le bloc texte du haut (nom, config,
        // description) est calé à sa gauche. Le prix / code-barres du bas gardent la pleine
        // largeur (le logo ne descend pas jusque-là).
        const bodyW = INNER - (wm ? (LOGO_BOX.w + 2) : 0);  // largeur utile du texte haut
        const bodyCx = M + bodyW / 2;                        // centre du bloc gauche

        // 1) Nom du produit — gras, aligné à gauche, MAJUSCULE (1 ligne, tronquée).
        doc.setFont('helvetica', 'bold').setFontSize(10.5);
        let name = SFBarcode.title(u).toUpperCase();
        while (name.length > 4 && doc.getTextWidth(name) > bodyW) name = name.slice(0, -1);
        doc.text(name, M, 5.0);

        // 2) Corps de l'étiquette (sans état).
        //    - Ordinateurs : configuration libellée (Processeur : … / RAM : …) + description.
        //    - Accessoires : PAS de catégorie/sous-catégorie ; uniquement la description, centrée.
        const isAcc = !!u.is_accessory;
        const pairs = isAcc ? [] : SFBarcode.specPairs(u).slice(0, 6);
        const desc = normSpace(u.description || '').trim();
        const bandTop = 7.2, bandBottom = LH - 18, band = bandBottom - bandTop;
        const descReserve = desc ? (isAcc ? 4 : 2) : 0;
        const n = Math.max(1, pairs.length + descReserve);
        const lineH = Math.min(2.8, band / n);
        const fs = Math.max(4.6, Math.min(7.5, lineH * 2.55));
        let yy = bandTop + lineH - 0.3;
        pairs.forEach(p => {
            doc.setFontSize(fs);
            doc.setFont('helvetica', 'normal').setTextColor(90, 90, 90);
            const lab = p.l + ' : ';
            doc.text(lab, M, yy);
            const lw = doc.getTextWidth(lab);
            doc.setFont('helvetica', 'bold').setTextColor(0, 0, 0);
            let val = normSpace(p.v);
            const maxVW = bodyW - lw;
            while (val.length > 3 && doc.getTextWidth(val) > maxVW) val = val.slice(0, -1);
            doc.text(val, M + lw, yy);
            yy += lineH;
        });
        // Description — sans libellé « Description ». Accessoire : centrée (contenu principal).
        if (desc) {
            const dfs = isAcc ? Math.min(8, fs + 1.2) : fs;
            doc.setFontSize(dfs).setFont('helvetica', isAcc ? 'bold' : 'normal').setTextColor(isAcc ? 0 : 70, isAcc ? 0 : 70, isAcc ? 0 : 70);
            let lines = doc.splitTextToSize(desc, bodyW);
            const maxLines = isAcc ? 4 : 2;
            if (lines.length > maxLines) { lines = lines.slice(0, maxLines); lines[maxLines - 1] = lines[maxLines - 1].replace(/.$/, '…'); }
            const dlh = isAcc ? Math.min(band / Math.max(1, lines.length), 3.2) : lineH;
            lines.forEach(ln => { doc.text(ln, isAcc ? bodyCx : M, yy, isAcc ? { align: 'center' } : undefined); yy += dlh; });
        }
        doc.setTextColor(0, 0, 0);

        // 3) Prix — centré, gras, MAJUSCULE (espaces normalisés).
        doc.setFont('helvetica', 'bold').setFontSize(10.5);
        const price = normSpace('PRIX : ' + (fmtPrice ? fmtPrice(u.sale_price) : (u.sale_price + ' Ar'))).toUpperCase();
        const priceY = LH - 15;
        doc.text(price, LW / 2, priceY, { align: 'center' });

        // 4) Code-barres — remonté pour laisser une marge basse ; chiffres répartis sous les barres.
        const bcW = INNER, bcY = priceY + 1.8, bcH = 7.0;
        drawBarcode39(doc, u.serial, LW / 2, bcY, bcW, bcH);
        const serial = String(u.serial);
        doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(0, 0, 0);
        const natural = doc.getTextWidth(serial);
        const charSpace = serial.length > 1 ? Math.max(0, (bcW - natural) / (serial.length - 1)) : 0;
        // Baseline à ~2.6 mm sous le code-barres, en laissant ≥3.6 mm de marge basse.
        doc.text(serial, LW / 2 - bcW / 2, bcY + bcH + 2.6, { charSpace: charSpace });
    });
    doc.save(`Etiquettes-${units.length}.pdf`);
    SF.toast(units.length + ' étiquette(s) 60×40 en PDF', 'success');
};

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

})();
