/* ============================================================
   STOCKFLOW — Factures.
   Deux formats au choix :
   - printA4(sale, c) : facture A4 portrait pro avec 4 cages de signature.
   - print80(sale, c) : ticket thermique 80 mm (imprimante XP-80C),
     avec code-barres du n° de vente (JsBarcode local).
   - print80Direct(sale, c) : impression directe sans dialogue
   SFInvoice.print = alias vers printA4 (compatibilité).
   ============================================================ */
(function () {
'use strict';
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, x => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[x]));
const fmt = n => new Intl.NumberFormat('fr-FR').format(Math.round(n || 0)).replace(/[  ]/g, ' ') + ' Ar';
const fmtDate = s => new Date(String(s).replace(' ', 'T')).toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
const methodLabel = m => ({ especes:'Espèces', mvola:'MVola', orange_money:'Orange Money', airtel_money:'Airtel Money', cheque:'Chèque', virement:'Virement bancaire' }[m] || m);
const spec = it => [it.cpu, it.ram, it.storage ? it.storage + (it.storage_type ? ' ' + it.storage_type : '') : '', it.screen_size ? String(it.screen_size).replace(/"$/, '') + '"' : '', it.gpu]
    .filter(Boolean).join(' · ');

// Code-barres du n° de vente : AAAAMMJJ-#### (ex. 20260801-0012).
function invoiceCode(sale) {
    const d = String(sale.sale_date || '').replace(/-/g, '') || String(sale.created_at || '').slice(0, 10).replace(/-/g, '');
    const n = String(sale.sale_number || sale.id || 0).padStart(4, '0');
    return (sale.avance ? (sale.avance.prefix || 'AV') : '') + (d ? d + '-' : '') + n;   // facture d'avance : AV… (caisse) / AL… (livraison)
}
const fmtDay = d => d ? String(d).slice(0, 10).split('-').reverse().join('/') : '—';

// ID unique ho an'ny code-barres tsirairay
let barcodeCounter = 0;
function generateBarcodeSVG(code) {
    barcodeCounter++;
    const id = 'barcode_' + barcodeCounter;
    return `<div style="text-align:center;margin:3px 0;max-width:60mm;overflow:hidden;">
        <svg id="${id}" class="barcode-svg" style="display:block;margin:0 auto;width:100%;height:28px;"></svg>
    </div>
    <script>
        (function() {
            var tries = 0;
            var maxTries = 30;
            
            function tryBarcode() {
                try {
                    if (typeof JsBarcode !== 'undefined') {
                        JsBarcode('#${id}', '${code.replace(/'/g, "\\'")}', {
                            format: 'CODE39',
                            width: 1.3,
                            height: 28,
                            displayValue: false,
                            margin: 4,
                            background: '#ffffff',
                            lineColor: '#000000'
                        });
                    } else if (tries < maxTries) {
                        tries++;
                        setTimeout(tryBarcode, 100);
                    } else {
                        var el = document.getElementById('${id}');
                        if (el) {
                            el.outerHTML = '<div style="font-family:monospace;font-size:13px;letter-spacing:1px;font-weight:bold;text-align:center;">*${code.replace(/\*/g, '')}*</div>';
                        }
                    }
                } catch(e) {
                    var el = document.getElementById('${id}');
                    if (el) {
                        el.outerHTML = '<div style="font-family:monospace;font-size:13px;letter-spacing:1px;font-weight:bold;text-align:center;">*${code.replace(/\*/g, '')}*</div>';
                    }
                }
            }
            
            tryBarcode();
        })();
    <\/script>`;
}

// Libellé d'une ligne de paiement unitaire (plus de « référence » pour le mobile money).
function payOne(p) {
    if (p.method === 'especes') return 'Espèces';
    if (p.method === 'cheque') return `Chèque n° ${esc(p.ref)}${p.phone ? ' — ' + esc(p.phone) : ''}`;
    if (p.method === 'virement') return `Virement bancaire${p.ref ? ' — réf. ' + esc(p.ref) : ''}`;
    return `${methodLabel(p.method)}${p.phone ? ' — ' + esc(p.phone) : ''}`;
}
function payLineOf(sale) {
    const pays = Array.isArray(sale.payments) ? sale.payments : [];
    if (sale.exchange_of && !pays.length) return "Réglé par la facture d'origine (échange)";
    // Commande en ligne non encore réglée (paiement à la livraison).
    if (sale.channel === 'livraison' && !pays.length && !sale.payment_method) return 'À la livraison';
    if (pays.length > 1) return pays.map(p => `${payOne(p)} : ${fmt(p.amount)}`).join('  +  ');
    if (pays.length === 1) return payOne(pays[0]);
    if (!sale.payment_method) return 'À la livraison';
    // Repli (vente sans lignes détaillées).
    return payOne({ method: sale.payment_method, ref: sale.payment_ref, phone: sale.payment_phone });
}

const UPG_FIELD_LABELS = { storage: 'Stockage', ram: 'RAM', cpu: 'Processeur', gpu: 'Carte graphique', screen_size: 'Écran', storage_type: 'Type stockage' };
// Upgrades rattachés à une ligne de vente (par sale_item_id, repli par unit_id).
function itemUpgradesHtml(it, sale) {
    const ups = (sale.upgrades || []).filter(u => (u.sale_item_id && u.sale_item_id === it.id) || (u.pc_unit_id && u.pc_unit_id === it.unit_id));
    if (!ups.length) return '';
    const how = u => !u.old_value ? '' : (u.mode === 'ajout' ? ' (ajout — ' + esc(u.old_value) + ' conservé)' : ' (au lieu de ' + esc(u.old_value) + ', repris)');
    return ups.map(u => `<div class="spec" style="color:#1e3a5f;">▲ ${esc(UPG_FIELD_LABELS[u.field] || u.field)} : ${esc(u.new_value)}${how(u)} — écart ${fmt(u.ecart)}</div>`).join('');
}
// Ajustements entre les lignes et le TOTAL : [{ l: libellé, a: montant signé }].
function saleAdjustments(sale) {
    const rows = [];
    if (sale.discount_amount > 0) rows.push({ l: 'Remise' + (sale.discount_type === 'percent' ? ' (' + sale.discount_value + ' %)' : ''), a: '− ' + fmt(sale.discount_amount) });
    if (sale.gift_pack > 0) rows.push({ l: 'Pack cadeau (accessoires offerts)', a: '+ ' + fmt(sale.gift_pack) });
    const upTot = (sale.upgrades || []).reduce((s, u) => s + (u.ecart || 0), 0);
    if (upTot > 0) rows.push({ l: 'Upgrades composants', a: '+ ' + fmt(upTot) });
    return rows;
}
// Facture d'ÉCHANGE : le client voit le VRAI prix des articles (jamais « 0 Ar »). La vente d'échange
// n'enregistre que l'écart encaissé (CA juste) ; à l'affichage, TOTAL = prix des articles, et sous le
// total : rappel de la facture d'origine (déjà réglée) + écart payé / remboursé ce jour.
function exchangeView(sale) {
    if (!sale || !sale.exchange_of || sale._exView) return sale;
    const price = (sale.items || []).reduce((s, it) => s + (it.is_gift ? 0 : (it.unit_price || 0)), 0);
    const ex = sale.exchange || {};
    return { ...sale, _exView: true, _exPaid: sale.total || 0, total: price,
             _exRefund: Math.max(0, (ex.returned_total || 0) - price) };
}
function exchangeRows(sale) {
    if (!sale._exView) return [];
    const ex = sale.exchange || {};
    const rows = [{ l: `<b>Échange</b> — facture d'origine n° ${esc(ex.number || '')}${ex.ref ? ' (Réf. ' + esc(ex.ref) + ')' : ''}${ex.date ? ' du ' + fmtDay(ex.date) : ''}, déjà réglée`, a: '' }];
    if ((ex.returned || []).length)
        rows.push({ l: 'Article(s) rendu(s) : ' + ex.returned.map(r => esc([r.product_name, r.serial].filter(Boolean).join(' — '))).join(' ; '), a: '' });
    if (sale._exPaid > 0) rows.push({ l: '<b>Écart payé ce jour</b>', a: '<b>' + fmt(sale._exPaid) + '</b>' });
    else if (sale._exRefund > 0) rows.push({ l: '<b>Écart remboursé au client</b>', a: '<b>' + fmt(sale._exRefund) + '</b>' });
    else rows.push({ l: '<b>Échange à prix égal — rien à payer ce jour</b>', a: '' });
    return rows;
}
// Vente soldée après une avance : rappel de l'avance et du solde réglé ce jour.
function layawayRows(sale) {
    if (sale._exView) return exchangeRows(sale);
    // Service atelier payé en plusieurs fois : déjà payé + reste (ou solde réglé ensuite).
    const bp = sale.balance_payments || [];
    if (sale.balance_due > 0 || bp.length) {
        const rows = [{ l: `Payé le ${fmtDay(sale.created_at)}`, a: fmt(sale.initial_paid || 0) }];
        bp.forEach(p => rows.push({ l: `Payé le ${fmtDay(p.created_at)}`, a: fmt(p.amount) }));
        rows.push(sale.balance_due > 0
            ? { l: '<b>Reste à payer (à la récupération)</b>', a: '<b>' + fmt(sale.balance_due) + '</b>' }
            : { l: '<b>Soldé</b>', a: '<b>' + fmt(sale.total) + '</b>' });
        return rows;
    }
    // Livraison avec acompte : historique de l'acompte (date, mode, caisse) + reste + frais de livraison.
    const dv = sale.delivery;
    if (!sale.layaway && dv && dv.acompte > 0) {
        const ML = { especes: 'espèces', mvola: 'MVola', orange_money: 'Orange Money', airtel_money: 'Airtel Money', cheque: 'chèque', virement: 'virement' };
        const hist = (dv.acompte_payments || []).length ? dv.acompte_payments : [{ amount: dv.acompte, method: dv.acompte_method }];
        const fee = Number(dv.fee) || 0, rest = Math.max(0, (sale.total || 0) - dv.acompte);
        const rows = hist.map(p => ({ l: `Acompte versé${p.sale_date ? ' le ' + fmtDay(p.sale_date) : ''}${ML[p.method] ? ' (' + ML[p.method] + ')' : ''}${p.cashier_name ? ' — validé par ' + esc(p.cashier_name) : ''}`, a: '− ' + fmt(p.amount) }));
        if (sale.status === 'completed') {
            rows.push({ l: 'Solde réglé à la livraison', a: fmt(rest) });
            if (fee > 0) rows.push({ l: 'Frais de livraison', a: fmt(fee) });
            return rows;
        }
        rows.push({ l: 'Reste sur les articles', a: fmt(rest) });
        if (fee > 0) rows.push({ l: 'Frais de livraison', a: '+ ' + fmt(fee) });
        rows.push({ l: '<b>Reste à payer à la livraison</b>', a: '<b>' + fmt(rest + fee) + '</b>' });
        return rows;
    }
    if (!(sale.layaway && sale.layaway.deposit > 0)) return [];
    return [{ l: `Avance déjà versée (n° ${esc(sale.layaway.number)})`, a: fmt(sale.layaway.deposit) },
            { l: 'Solde réglé', a: fmt(Math.max(0, (sale.total || 0) - sale.layaway.deposit)) }];
}
// Facture d'AVANCE : versements, cumul, reste, échéances.
function avanceRows(sale) {
    const a = sale.avance; if (!a) return [];
    const rows = (a.groups || []).map(g => ({ l: `Versement du ${fmtDay(g.at)}`, a: fmt(g.amount) }));
    rows.push({ l: '<b>Total versé</b>', a: '<b>' + fmt(a.deposit) + '</b>' });
    rows.push({ l: '<b>Reste à payer</b>', a: '<b>' + fmt(a.balance) + '</b>' });
    return rows;
}
function avanceDueHtml(sale, compact) {
    const a = sale.avance; if (!a || a.balance <= 0) return '';
    const box = compact ? 'border:1px dashed #000;padding:5px 6px;margin:6px 0;font-size:10.5px;'
                        : 'border:1.5px solid #e0a53a;border-radius:6px;padding:8px 12px;margin:10px 0;font-size:11.5px;background:#fff8ec;';
    return `<div style="${box}">
        ${a.next_payment_date ? `<div>Prochain paiement prévu le : <b>${fmtDay(a.next_payment_date)}</b></div>` : ''}
        ${a.due_date ? `<div>Date limite pour solder : <b>${fmtDay(a.due_date)}</b></div>` : ''}
        ${a.conditions ? `<div style="margin-top:4px;color:${compact ? '#000' : '#5b6b7f'};">${esc(a.conditions)}</div>` : ''}
    </div>`;
}
// Avance (réponse /api/layaways/:id) → document facturable (dernier versement = paiement de cette facture).
function layawayDoc(l, conditions) {
    const pays = l.payments || [];
    const lastAt = pays.length ? pays[pays.length - 1].created_at : l.created_at;
    const last = pays.filter(p => p.created_at === lastAt);
    const groups = [];
    pays.forEach(p => { let g = groups.find(x => x.at === p.created_at); if (!g) groups.push(g = { at: p.created_at, amount: 0 }); g.amount += p.amount || 0; });
    return {
        avance: { number: l.layaway_number, deposit: l.deposit || 0, balance: Math.max(0, (l.total || 0) - (l.deposit || 0)),
                  paid_now: last.reduce((x, p) => x + (p.amount || 0), 0), groups, due_date: l.due_date,
                  next_payment_date: (last[0] && last[0].next_date) || l.next_payment_date, conditions: conditions || '',
                  prefix: l.code_prefix || 'AV', label: l.doc_label || 'N° avance', subtitle: l.subtitle || '' },
        sale_number: l.layaway_number, sale_date: String(l.created_at || '').slice(0, 10), created_at: lastAt,
        client_name: l.client_name, client_phone: l.client_phone, client_address: l.client_address,
        commercial_name: l.commercial_name, cashier_name: (last[0] && last[0].cashier_name) || l.cashier_name,
        total: l.total || 0, payments: last,
        discount_type: l.discount_type, discount_value: l.discount_value, discount_amount: l.discount_amount || 0,
        items: (l.items || []).map(it => ({ ...it, unit_price: it.unit_price || 0 }))
    };
}

// Montant en lettres (« Arrêtée la présente facture à la somme de … »).
function amountInWords(n) {
    const w = (window.SF && SF.numberToWords) ? SF.numberToWords(n) : '';
    return w ? w.charAt(0).toUpperCase() + w.slice(1) + ' Ariary' : '';
}

// Génère section tests selon type produits
function generateTestSection(sale) {
    const items = sale.items || [];
    if (!items.length) return '';
    
    const hasOrdinateur = items.some(it => {
        const cat = String(it.category || '').toLowerCase();
        const name = String(it.product_name || '').toLowerCase();
        return cat.includes('ordinateur') || cat.includes('laptop') || cat.includes('pc') || 
               name.includes('ordinateur') || name.includes('laptop') || name.includes('macbook');
    });
    
    const hasAccessoires = items.some(it => {
        const cat = String(it.category || '').toLowerCase();
        return cat.includes('accessoire') || cat.includes('périphérique') || 
               ['souris', 'clavier', 'casque', 'écouteur', 'cable', 'adaptateur', 'chargeur'].some(x => cat.includes(x));
    });
    
    let html = '<div class="tests">';
    html += '<div class="tests-h">TESTS EFFECTUÉS</div>';
    
    if (hasOrdinateur && hasAccessoires) {
        html += '<div style="margin-bottom:8px;"><div class="tests-sub">Ordinateur</div>';
        html += generateOrdCheckboxes();
        html += '</div>';
        html += '<div><div class="tests-sub">Accessoires</div>';
        html += generateAccessCheckbox();
        html += '</div>';
    } else if (hasOrdinateur) {
        html += generateOrdCheckboxes();
    } else {
        html += generateAccessCheckbox();
    }
    
    html += '<div class="tests-note"><strong>Remarque importante :</strong> les périphériques testés (webcam, son, clavier, trackpad, ports, etc.) ne sont pas couverts par la garantie en cas de dysfonctionnement ultérieur.</div>';
    
    html += '</div>';
    return html;
}

function generateOrdCheckboxes() {
    return `<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:6px;font-size:11px;">
        <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" style="width:14px;height:14px;"> Écran</label>
        <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" style="width:14px;height:14px;"> Son</label>
        <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" style="width:14px;height:14px;"> Clavier</label>
        <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" style="width:14px;height:14px;"> Trackpad / Souris</label>
        <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" style="width:14px;height:14px;"> Tous les ports</label>
        <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" style="width:14px;height:14px;"> Webcam (si existant)</label>
        <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" style="width:14px;height:14px;"> Chargeur</label>
        <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" style="width:14px;height:14px;"> Batterie</label>
    </div>`;
}

function generateAccessCheckbox() {
    return `<div style="font-size:11px;">
        <label style="display:flex;align-items:center;gap:6px;"><input type="checkbox" style="width:14px;height:14px;"> Test fonctionnel effectué</label>
    </div>`;
}

function generateTestSection80(sale) {
    const items = sale.items || [];
    if (!items.length) return '';
    
    const hasOrdinateur = items.some(it => {
        const cat = String(it.category || '').toLowerCase();
        const name = String(it.product_name || '').toLowerCase();
        return cat.includes('ordinateur') || cat.includes('laptop') || cat.includes('pc') || 
               name.includes('ordinateur') || name.includes('laptop') || name.includes('macbook');
    });
    
    const hasAccessoires = items.some(it => {
        const cat = String(it.category || '').toLowerCase();
        return cat.includes('accessoire') || cat.includes('périphérique') || 
               ['souris', 'clavier', 'casque', 'écouteur', 'cable', 'adaptateur', 'chargeur'].some(x => cat.includes(x));
    });
    
    let html = '<div class="hr"></div><div style="margin-top:2mm;">';
    html += '<div style="font-weight:bold;font-size:10px;text-align:center;margin-bottom:1.5mm;text-transform:uppercase;">Tests effectués</div>';
    
    if (hasOrdinateur && hasAccessoires) {
        html += '<div style="margin-bottom:1.5mm;"><div style="font-weight:600;font-size:9px;margin-bottom:1mm;">Tests Ordinateur</div>';
        html += generateOrdCheckboxes80();
        html += '</div>';
        html += '<div><div style="font-weight:600;font-size:9px;margin-bottom:1mm;">Tests Accessoires</div>';
        html += generateAccessCheckbox80();
        html += '</div>';
    } else if (hasOrdinateur) {
        html += generateOrdCheckboxes80();
    } else {
        html += generateAccessCheckbox80();
    }
    
    html += '<div style="margin-top:2mm;padding-top:2mm;border-top:1px dashed #999;font-size:8px;color:#555;font-style:italic;line-height:1.4;">';
    html += '<strong style="color:#000;">Remarque :</strong> Les périphériques testés ne sont pas couverts par la garantie.';
    html += '</div>';
    
    html += '</div>';
    return html;
}

function generateOrdCheckboxes80() {
    return `<div style="font-size:9px;line-height:1.8;">
        <label style="display:flex;align-items:center;gap:4px;"><input type="checkbox" style="width:12px;height:12px;"> Écran</label>
        <label style="display:flex;align-items:center;gap:4px;"><input type="checkbox" style="width:12px;height:12px;"> Son</label>
        <label style="display:flex;align-items:center;gap:4px;"><input type="checkbox" style="width:12px;height:12px;"> Clavier</label>
        <label style="display:flex;align-items:center;gap:4px;"><input type="checkbox" style="width:12px;height:12px;"> Trackpad / Souris</label>
        <label style="display:flex;align-items:center;gap:4px;"><input type="checkbox" style="width:12px;height:12px;"> Tous les ports</label>
        <label style="display:flex;align-items:center;gap:4px;"><input type="checkbox" style="width:12px;height:12px;"> Webcam (si existant)</label>
        <label style="display:flex;align-items:center;gap:4px;"><input type="checkbox" style="width:12px;height:12px;"> Chargeur</label>
        <label style="display:flex;align-items:center;gap:4px;"><input type="checkbox" style="width:12px;height:12px;"> Batterie</label>
    </div>`;
}

function generateAccessCheckbox80() {
    return `<div style="font-size:9px;">
        <label style="display:flex;align-items:center;gap:4px;"><input type="checkbox" style="width:12px;height:12px;"> Test fonctionnel effectué</label>
    </div>`;
}

// ── BON DE GARANTIE : ajouté AU BAS des factures contenant au moins un article
//    matériel garanti — c.-à-d. NON accessoire ET NON service (ordinateur, etc.).
//    Un service (main-d'œuvre, installation…) n'ouvre aucune garantie produit : une
//    facture de service seule n'affiche donc pas le bon de garantie. Texte compact
//    mais lisible. Rendu partagé A4 (accent navy) / 80 mm (noir, compact).
// Ordinateur apporté par le client (service atelier : diagnostic, entretien, réparation…).
function clientPcRows(sale) {
    if (!sale.client_pc) return [];
    return [
        { l: 'Ordinateur', v: sale.client_pc },
        { l: 'RAM', v: sale.client_pc_ram || '—' },
        { l: 'Stockage', v: sale.client_pc_storage || '—' },
        { l: 'Chargeur', v: sale.client_pc_charger === 'avec' ? 'Avec chargeur' : 'Sans chargeur' },
    ].concat(sale.client_pc_note ? [{ l: 'Panne / remarque', v: sale.client_pc_note }] : []);
}
function clientPcA4(sale) {
    const rows = clientPcRows(sale);
    if (!rows.length) return '';
    return `<div class="cpc"><div class="lbl">ORDINATEUR DU CLIENT</div>
        <table>${rows.map(r => `<tr><td class="k">${esc(r.l)}</td><td>${esc(r.v)}</td></tr>`).join('')}</table></div>`;
}
function clientPc80(sale) {
    const rows = clientPcRows(sale);
    if (!rows.length) return '';
    return `<div class="hr"></div><div class="cpc80"><div class="cpc80-h">ORDINATEUR DU CLIENT</div>
        ${rows.map(r => `<div class="row"><b>${esc(r.l)}</b><span>${esc(r.v)}</span></div>`).join('')}</div>`;
}

function saleHasNonAccessory(sale) {
    return (sale.items || []).some(it => !it.is_accessory && !it.is_service);
}
const WARRANTY_SECTIONS = [
    { h: '1. Durée de la garantie', body: 'Le produit est garanti contre les défauts de fabrication pendant une durée de 1 MOIS (30 jours) à compter de la date d’achat indiquée sur la présente facture.' },
    { h: '2. Champ d’application de la garantie', body: 'En cas de panne résultant d’un défaut de fabrication pendant la période de garantie, nous nous engageons à effectuer la réparation gratuitement, pièces et main-d’œuvre comprises, sous réserve des conditions ci-dessous.' },
    { h: '3. Exclusions de la garantie', intro: 'La garantie ne s’applique pas dans les cas suivants :', bullets: [
        'Dommages causés par une instabilité électrique : surtension, sous-tension, surtension impulsionnelle, foudre ou court-circuit.',
        'Dommages résultant d’une mauvaise utilisation : démontage, modification, intrusion d’eau ou de liquide, chute, choc physique, humidité excessive ou poussière.',
        'Utilisation d’un équipement d’alimentation non adapté ou branchement non conforme.',
        'Absence ou modification du numéro de série.',
        'Tout dommage résultant d’une intervention effectuée par une personne ou un réparateur non autorisé.'
    ] },
    { h: '4. Conseil d’utilisation important', body: 'Il est fortement recommandé d’utiliser un régulateur de tension ou un dispositif de protection contre les surtensions afin de protéger l’appareil. Les dommages électriques causés par une mauvaise alimentation ne sont pas couverts par la garantie.' },
    { h: '5. Procédure de réparation', bullets: [
        'La réparation sous garantie comprend les pièces et la main-d’œuvre, mais les frais de déplacement ou de transport restent à la charge du client.',
        'Pour les dommages hors garantie, un devis de réparation pourra être proposé au client.',
        'Nous nous réservons le droit de déterminer, après diagnostic, si la panne relève ou non de la garantie.'
    ] }
];
function warrantyHtml(compact, accent) {
    accent = accent || '#000';
    const fTitle = compact ? '10px' : '12px', fHead = compact ? '8px' : '9.5px', fTxt = compact ? '7.6px' : '9px', gap = compact ? '3px' : '5px';
    const sections = WARRANTY_SECTIONS.map(s => {
        let inner = '';
        if (s.body) inner += `<div>${s.body}</div>`;
        if (s.intro) inner += `<div>${s.intro}</div>`;
        if (s.bullets) inner += `<ul style="margin:2px 0 0;padding-left:${compact ? '13px' : '16px'};">${s.bullets.map(b => `<li style="margin-bottom:1px;">${b}</li>`).join('')}</ul>`;
        return `<div style="margin-top:${gap};"><div style="font-weight:700;font-size:${fHead};color:${accent};">${s.h}</div><div style="font-size:${fTxt};line-height:1.35;color:#000;">${inner}</div></div>`;
    }).join('');
    return `<div style="margin-top:${compact ? '8px' : '14px'};border:1px solid ${accent};border-radius:${compact ? '0' : '6px'};padding:${compact ? '5px 6px' : '9px 11px'};page-break-inside:avoid;">
        <div style="text-align:center;font-weight:800;font-size:${fTitle};letter-spacing:1.5px;color:${accent};border-bottom:1px solid ${accent};padding-bottom:3px;">BON DE GARANTIE</div>
        ${sections}
        <div style="text-align:center;font-weight:800;font-size:${fHead};color:${accent};margin-top:${gap};border-top:1px solid ${accent};padding-top:3px;">GARANTIE : 01 MOIS + SAV</div>
    </div>`;
}

function printA4(sale, c) {
    c = c || {};
    sale = exchangeView(sale);
    // Frais de livraison : affichés sur la facture (à payer par le client) mais ENCAISSÉS PAR LE LIVREUR,
    // donc hors recette caisse (jamais ajoutés à sale.total).
    const fee = (sale.delivery && Number(sale.delivery.fee)) || 0;
    const tagline = c.proforma_tagline || '';   // même identité visuelle que la proforma
    const items = (sale.items || []).map(it =>
        `<tr>
            <td><div class="d-t">${esc([it.brand, it.model].filter(Boolean).join(' ') || it.product_name)}${it.is_gift ? ' <b>(Cadeau)</b>' : ''}</div>${spec(it) ? `<div class="d-s">${esc(spec(it))}</div>` : ''}${it.color ? `<div class="d-s">Couleur : ${esc(it.color)}</div>` : ''}${itemUpgradesHtml(it, sale)}</td>
            <td class="mono">${esc(it.serial || '')}${it.manufacturer_sn ? `<div class="d-s">SN${it.router_id ? ' dish' : ''} : ${esc(it.manufacturer_sn)}</div>` : ''}${it.router_id ? `<div class="d-s">Routeur : ${esc(it.router_id)}</div>` : ''}</td>
            <td class="r">${it.is_gift ? '0 Ar' : fmt(it.unit_price)}</td>
        </tr>`).join('');
    // Bloc de totaux : ajustements, sous-total + frais de livraison, TOTAL, puis rappel d'avance.
    const adj = saleAdjustments(sale);
    if (fee > 0) adj.push({ l: 'Sous-total', a: fmt(sale.total), strong: true }, { l: 'Frais de livraison', a: '+ ' + fmt(fee) });
    const sumRows = adj.map(r => `<tr${r.strong ? ' class="st"' : ''}><td>${r.l}</td><td>${r.a}</td></tr>`).join('');
    const layRows = (sale.avance ? avanceRows(sale) : layawayRows(sale)).map(r => `<tr><td>${r.l}</td><td>${r.a}</td></tr>`).join('');
    const words = amountInWords(sale.avance ? sale.avance.paid_now : sale.total + fee);
    const code = invoiceCode(sale);
    // NIF / STAT du magasin : masqués par défaut, affichés seulement si la caisse coche l'option (chooser).
    const nifStat = c.showNif ? [c.nif ? 'NIF ' + esc(c.nif) : '', c.stat ? 'STAT ' + esc(c.stat) : ''].filter(Boolean).join(' · ') : '';
    const clientLn = [sale.client_phone ? 'Tél : ' + esc(sale.client_phone) : '', sale.client_address ? esc(sale.client_address) : ''].filter(Boolean).join('<br>');
    // Identifiants fiscaux du CLIENT (facture pro) — affichés uniquement s'ils sont renseignés.
    const clientFiscal = [sale.client_nif ? 'NIF : ' + esc(sale.client_nif) : '', sale.client_stat ? 'STAT : ' + esc(sale.client_stat) : '', sale.client_rcs ? 'RCS : ' + esc(sale.client_rcs) : ''].filter(Boolean).join('<br>');
    const w = window.open('', '_blank', 'width=820,height=1100');
    w.document.write(`<html><head><meta charset="utf-8"><title>Facture ${esc(sale.sale_number)}</title>
        <script src="/vendor/js/JsBarcode.all.min.js"><\/script>
        <style>
        @page { size:A4 portrait; margin:0; }
        *{ box-sizing:border-box; font-family:'Segoe UI',Arial,sans-serif; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
        body{ margin:0; color:#243244; font-size:11px; }
        .page{ position:relative; padding:0 0 22px; }
        .topbar{ height:6px; background:#e0a53a; }
        .wrap{ padding:20px 26px 0; }
        .head{ display:flex; justify-content:space-between; align-items:flex-start; }
        .co-logo{ max-height:60px; max-width:190px; display:block; margin-bottom:6px; }
        .co h1{ margin:0; font-size:22px; font-weight:800; color:#1e3a5f; letter-spacing:.5px; }
        .co .tag{ margin:2px 0 0; font-size:11px; color:#5b6b7f; }
        .title{ text-align:right; }
        .title .ref{ font-family:'Courier New',monospace; font-size:12px; font-weight:700; color:#1e3a5f; letter-spacing:.5px; margin-bottom:4px; }
        .title .t1{ font-size:26px; font-weight:800; color:#1e3a5f; line-height:1; }
        .title .t2{ font-size:13px; font-weight:800; color:#e0a53a; letter-spacing:2px; }
        .meta{ display:flex; justify-content:space-between; margin-top:12px; gap:24px; align-items:flex-start; }
        .co-info p{ margin:1px 0; color:#5b6b7f; font-size:10.5px; }
        .ref-table{ border-collapse:collapse; min-width:230px; }
        .ref-table td{ border:1px solid #dfe4ea; padding:5px 12px; font-size:10.5px; }
        .ref-table td.k{ background:#f4f6f9; color:#5b6b7f; text-align:right; }
        .ref-table td.v{ font-weight:700; color:#1e3a5f; text-align:right; }
        .barcode-wrap{ margin:6px 0 0; text-align:right; }
        .barcode-svg{ display:block; margin:0 0 0 auto; width:58mm; height:26px; }
        .bccode{ font-size:9.5px; letter-spacing:2px; color:#5b6b7f; text-align:right; }
        .parties{ display:flex; justify-content:space-between; gap:20px; margin:18px 0 0; }
        .cpc{ margin-top:14px; border:1px solid #dfe4ea; border-left:3px solid #e0a53a; border-radius:6px; padding:8px 12px; page-break-inside:avoid; }
        .cpc .lbl{ font-size:10px; font-weight:800; color:#e0a53a; letter-spacing:1.5px; margin-bottom:4px; }
        .cpc table{ border-collapse:collapse; width:100%; }
        .cpc td{ padding:2px 0; font-size:11px; color:#243244; vertical-align:top; }
        .cpc td.k{ width:130px; color:#5b6b7f; }
        .party{ padding-left:12px; border-left:3px solid #1e3a5f; flex:1; }
        .party .lbl{ font-size:10px; font-weight:800; color:#e0a53a; letter-spacing:1.5px; }
        .party .nm{ font-size:13px; font-weight:800; color:#1e3a5f; margin:3px 0 2px; }
        .party .ln{ color:#5b6b7f; font-size:10.5px; line-height:1.5; }
        table.items{ width:100%; border-collapse:collapse; margin-top:16px; }
        table.items th{ background:#1e3a5f; color:#fff; padding:9px 10px; text-align:left; font-size:10.5px; letter-spacing:.3px; }
        table.items th.r{ text-align:right; }
        table.items td{ padding:9px 10px; border-bottom:1px solid #e6eaef; vertical-align:top; }
        table.items td.r{ text-align:right; } .mono{ font-family:'Courier New',monospace; }
        .d-t{ font-weight:700; color:#243244; font-size:11.5px; } .d-s{ color:#59677a; font-size:10px; margin-top:2px; line-height:1.4; }
        .spec{ color:#59677a; font-size:10px; margin-top:2px; }
        .totals{ width:300px; margin:12px 0 0 auto; }
        .totals table{ width:100%; border-collapse:collapse; }
        .totals td{ padding:5px 4px; font-size:11px; color:#3a4a5e; border-bottom:1px solid #eef1f5; }
        .totals td:last-child{ text-align:right; white-space:nowrap; font-weight:600; color:#243244; }
        .totals tr.st td{ font-weight:700; color:#1e3a5f; }
        .total{ display:flex; justify-content:flex-end; margin-top:8px; }
        .total .box{ display:flex; align-items:center; background:#1e3a5f; color:#fff; border-radius:6px; overflow:hidden; min-width:300px; justify-content:space-between; }
        .total .lab{ padding:10px 16px; font-weight:800; font-size:12.5px; letter-spacing:.5px; }
        .total .amt{ padding:10px 16px; font-weight:800; font-size:15px; color:#fff; background:rgba(255,255,255,.10); }
        .totals.after td{ font-size:10.5px; border-bottom:none; padding:3px 4px; }
        .words{ margin-top:12px; font-size:11px; color:#3a4a5e; font-style:italic; }
        .words b{ font-style:normal; color:#1e3a5f; }
        .pay{ margin-top:6px; font-size:11px; color:#3a4a5e; }
        .pay b{ color:#1e3a5f; }
        .tests{ margin-top:18px; border:1px solid #cfd6df; border-left:3px solid #1e3a5f; border-radius:6px; padding:10px 12px; page-break-inside:avoid; }
        .tests-h{ font-weight:800; font-size:10.5px; letter-spacing:1.5px; color:#e0a53a; margin-bottom:8px; }
        .tests-sub{ font-weight:700; font-size:11px; color:#1e3a5f; margin-bottom:5px; }
        .tests input[type=checkbox]{ accent-color:#1e3a5f; }
        .tests-note{ margin-top:10px; padding-top:8px; border-top:1px solid #e6eaef; font-size:9.5px; color:#5b6b7f; line-height:1.5; }
        .tests-note strong{ color:#1e3a5f; }
        .note{ margin-top:12px; padding:10px 12px; background:#f7f9fb; border:1px solid #eef1f5; border-radius:6px; font-size:10.5px; color:#3a4a5e; }
        .signs{ display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-top:22px; }
        .sign{ background:#f7f9fb; border:1px solid #e3e8ee; border-radius:6px; height:74px; padding:8px 10px; font-size:10px; color:#8a95a3; display:flex; flex-direction:column; justify-content:space-between; }
        .sign b{ color:#1e3a5f; font-size:10.5px; }
        .sign .line{ border-top:1px solid #cfd6df; padding-top:3px; }
        .foot{ margin:22px 0 0; background:#1e3a5f; color:#cdd7e4; font-size:9.5px; padding:9px 26px; display:flex; justify-content:space-between; }
    </style></head><body>
    <div class="page">
        <div class="topbar"></div>
        <div class="wrap">
            ${c.invoice_header ? `<div style="text-align:center;font-size:10.5px;color:#5b6b7f;margin-bottom:8px;">${esc(c.invoice_header)}</div>` : ''}
            <div class="head">
                <div class="co">
                    ${c.logo ? `<img src="${c.logo}" class="co-logo">` : ''}
                    <h1>${esc(c.name || 'STOCKFLOW')}</h1>
                    ${tagline ? `<p class="tag">${esc(tagline)}</p>` : ''}
                </div>
                <div class="title"><div class="ref">Réf. ${esc(code)}</div><div class="t1">FACTURE</div>${sale.avance ? '<div class="t2">D\'AVANCE</div>' + (sale.avance.subtitle ? `<div style="font-size:11px;color:#5b6b7f;margin-top:2px;">${esc(sale.avance.subtitle)}</div>` : '') : ''}${sale.exchange_of ? '<div class="t2" style="color:#b45309;">ÉCHANGE</div>' : ''}</div>
            </div>
            <div class="meta">
                <div class="co-info">
                    ${c.address ? `<p>${esc(c.address)}</p>` : ''}
                    ${(c.phone || c.email) ? `<p>${[c.phone, c.email].filter(Boolean).map(esc).join(' · ')}</p>` : ''}
                    ${nifStat ? `<p>${nifStat}</p>` : ''}
                </div>
                <div>
                    <table class="ref-table">
                        <tr><td class="k">${sale.avance ? sale.avance.label : 'N° facture'}</td><td class="v">${esc(sale.sale_number)}</td></tr>
                        <tr><td class="k">Date</td><td class="v">${fmtDate(sale.created_at)}</td></tr>
                        <tr><td class="k">Caisse</td><td class="v">${esc(sale.cashier_name || '—')}</td></tr>
                    </table>
                    <div class="barcode-wrap">${generateBarcodeSVG(code)}<div class="bccode">${esc(code)}</div></div>
                </div>
            </div>
            <div class="parties">
                <div class="party">
                    <div class="lbl">CLIENT</div>
                    <div class="nm">${esc(sale.client_name || '—')}</div>
                    ${clientLn ? `<div class="ln">${clientLn}</div>` : ''}
                    ${clientFiscal ? `<div class="ln">${clientFiscal}</div>` : ''}
                </div>
                <div class="party">
                    <div class="lbl">VENDEUR</div>
                    <div class="nm">${esc(sale.commercial_name || '—')}</div>
                    ${sale.delivery ? `<div class="lbl" style="margin-top:8px;">LIVRAISON${sale.delivery.number ? ' N° ' + esc(sale.delivery.number) : ''}</div>
                    <div class="ln">Livreur : <b>${esc(sale.delivery.livreur || 'non assigné')}</b></div>` : ''}
                </div>
            </div>
            ${clientPcA4(sale)}
            <table class="items">
                <thead><tr><th>DÉSIGNATION</th><th>N° SÉRIE</th><th class="r">PRIX</th></tr></thead>
                <tbody>${items}</tbody>
            </table>
            ${sumRows ? `<div class="totals"><table>${sumRows}</table></div>` : ''}
            <div class="total"><div class="box"><span class="lab">TOTAL${fee > 0 ? ' À PAYER' : ''}</span><span class="amt">${fmt(sale.total + fee)}</span></div></div>
            ${layRows ? `<div class="totals after"><table>${layRows}</table></div>` : ''}
            ${words ? `<div class="words">${sale.avance ? 'Montant versé ce jour' : 'Arrêtée la présente facture à la somme de'} : <b>${esc(words)}</b>${sale.avance ? ' (' + fmt(sale.avance.paid_now) + ')' : ''}.</div>` : ''}
            <div class="pay">Mode de paiement : <b>${payLineOf(sale)}</b></div>
            ${avanceDueHtml(sale, false)}
            ${sale.avance ? '' : generateTestSection(sale)}
            ${c.invoice_note ? `<div class="note">${esc(c.invoice_note)}</div>` : ''}
            <div class="signs">
                <div class="sign"><b>Le Client</b><div class="line"></div></div>
                <div class="sign"><b>La Caisse</b><div class="line"></div></div>
                <div class="sign"><b>Responsable stock</b><div class="line"></div></div>
                <div class="sign"><b>Livreur / Remise</b><div class="line"></div></div>
            </div>
            ${saleHasNonAccessory(sale) && !sale.avance ? warrantyHtml(false, '#1e3a5f') : ''}
        </div>
        <div class="foot"><span>${esc(c.name || 'STOCKFLOW')}${c.address ? ' • ' + esc(c.address) : ''}</span><span>${c.invoice_footer ? esc(c.invoice_footer) : (sale.avance ? 'Facture d’avance ' : 'Facture ') + esc(sale.sale_number)}</span></div>
    </div>
    </body></html>`);
    w.document.close();
    // Impression une fois le logo et le code-barres prêts.
    let done = false;
    const go = () => { if (done) return; done = true; setTimeout(() => { w.focus(); w.print(); }, 300); };
    if (w.document.readyState === 'complete') go(); else { w.addEventListener('load', go); setTimeout(go, 4000); }
}

// ── Reçu thermique 80 mm : styles + corps PARTAGÉS par print80 (fenêtre) et
//    print80Direct (iframe). Optimisé imprimante thermique : NOIR sur blanc,
//    aucun fond coloré (un aplat sombre sort en pavé noir / illisible), emphase
//    par bordures + gras. Largeur 72 mm centrée (marge de sûreté sur papier 80 mm,
//    zone imprimable ~72 mm) → plus de coupe à droite. TOTAL encadré et agrandi.
//    (NIF/STAT du magasin : seulement si la caisse coche l'option dans le choix du format.)
const RECEIPT80_CSS = `
@page { size:80mm auto; margin:0; }
*{ box-sizing:border-box; margin:0; padding:0; }
body{ font-family:'Segoe UI',Arial,sans-serif; font-size:12px; line-height:1.42; width:72mm; margin:0 auto; padding:2mm 0; background:#fff; color:#000; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
.co{ text-align:center; border-bottom:1px solid #000; padding-bottom:6px; margin-bottom:6px; }
.co h1{ font-size:18px; font-weight:800; letter-spacing:.4px; }
.co p{ font-size:10.5px; margin:1px 0; }
.logo{ max-height:16mm; max-width:46mm; margin-bottom:4px; }
.doc{ text-align:center; font-size:15px; font-weight:800; letter-spacing:3px; border:2px solid #000; padding:5px 0; margin:8px 0; }
.hr{ border-top:1px dashed #999; margin:7px 0; }
.meta{ font-size:11px; }
.meta .row{ display:flex; justify-content:space-between; gap:8px; margin:2px 0; }
.meta .row b{ font-weight:700; }
.meta .row span{ text-align:right; }
.it{ padding:4px 0; border-bottom:1px dashed #c9c9c9; }
.it-n{ font-weight:700; font-size:11.5px; }
.it-s{ font-size:9.5px; color:#333; margin-top:1px; }
.it-r{ display:flex; justify-content:space-between; gap:8px; font-size:11.5px; margin-top:2px; }
.mono{ font-family:'Courier New',monospace; }
.pay{ font-size:11px; margin-top:3px; }
.total{ display:flex; justify-content:space-between; align-items:baseline; gap:8px; border:2px solid #000; padding:6px 9px; margin-top:9px; }
.total .lbl{ font-size:13px; font-weight:800; letter-spacing:.5px; }
.total .amt{ font-size:19px; font-weight:800; white-space:nowrap; }
.payment{ text-align:center; margin:9px 0; padding:5px 6px; border:1px dashed #000; font-size:11px; font-weight:700; }
.sig{ margin-top:12px; }
.sig .row{ margin-bottom:14px; }
.sig .lbl{ font-size:11px; font-weight:700; }
.sig .line{ border-bottom:1px solid #000; height:20px; margin-top:2px; }
.bcwrap{ text-align:center; margin-top:12px; }
.barcode-svg{ display:block; margin:0 auto; width:100%; max-width:58mm; height:26px; }
.bccode{ font-size:10px; letter-spacing:2px; font-weight:700; }
.foot{ text-align:center; border-top:1px dashed #000; margin-top:12px; padding-top:8px; font-size:10.5px; }
.ref{ text-align:center; font-family:'Courier New',monospace; font-size:11.5px; font-weight:700; letter-spacing:1px; margin-top:8px; }
.ref + .doc{ margin-top:3px; }
.cpc80{ font-size:11px; }
.cpc80-h{ font-weight:800; font-size:11px; letter-spacing:1px; margin-bottom:2px; }
.cpc80 .row{ display:flex; justify-content:space-between; gap:8px; margin:2px 0; }
.cpc80 .row span{ text-align:right; }
`;

function receipt80Body(sale, c) {
    sale = exchangeView(sale);
    const fee = (sale.delivery && Number(sale.delivery.fee)) || 0;
    const items = (sale.items || []).map(it => {
        const s = spec(it);
        return `<div class="it">
            <div class="it-n">${esc([it.brand, it.model].filter(Boolean).join(' ') || it.product_name)}${it.is_gift ? ' (Cadeau)' : ''}</div>
            ${s ? `<div class="it-s">${esc(s)}</div>` : ''}
            ${it.color ? `<div class="it-s">Couleur : ${esc(it.color)}</div>` : ''}
            ${it.manufacturer_sn ? `<div class="it-s">SN${it.router_id ? ' dish' : ''} : ${esc(it.manufacturer_sn)}</div>` : ''}${it.router_id ? `<div class="it-s">Routeur : ${esc(it.router_id)}</div>` : ''}
            <div class="it-r"><span class="mono">${esc(it.serial || '')}</span><span>${it.is_gift ? '0 Ar' : fmt(it.unit_price)}</span></div>
        </div>`;
    }).join('');
    const code = invoiceCode(sale);
    return `<div class="tk">
        <div class="co">
            ${c.logo ? `<img src="${c.logo}" class="logo"><br>` : ''}
            <h1>${esc(c.name || 'STOCKFLOW')}</h1>
            ${c.address ? `<p>${esc(c.address)}</p>` : ''}
            ${(c.phone || c.email) ? `<p>${[c.phone, c.email].filter(Boolean).map(esc).join(' · ')}</p>` : ''}
            ${c.invoice_header ? `<p>${esc(c.invoice_header)}</p>` : ''}
            ${c.showNif && (c.nif || c.stat) ? `<p>${[c.nif ? 'NIF ' + esc(c.nif) : '', c.stat ? 'STAT ' + esc(c.stat) : ''].filter(Boolean).join(' · ')}</p>` : ''}
        </div>
        <div class="ref">Réf. ${esc(code)}</div>
        <div class="doc">${sale.avance ? 'FACTURE D\'AVANCE' : 'FACTURE'}</div>${sale.avance && sale.avance.subtitle ? `<div style="text-align:center;font-size:11px;">${esc(sale.avance.subtitle)}</div>` : ''}
        <div class="meta">
            <div class="row"><b>N°</b><span>${esc(sale.sale_number)}</span></div>
            <div class="row"><b>Date</b><span>${fmtDate(sale.created_at)}</span></div>
            <div class="row"><b>Client</b><span>${esc(sale.client_name || '—')}</span></div>
            ${sale.client_phone ? `<div class="row"><b>Contact</b><span>${esc(sale.client_phone)}</span></div>` : ''}
            ${sale.client_nif ? `<div class="row"><b>NIF client</b><span>${esc(sale.client_nif)}</span></div>` : ''}
            ${sale.client_stat ? `<div class="row"><b>STAT client</b><span>${esc(sale.client_stat)}</span></div>` : ''}
            ${sale.client_rcs ? `<div class="row"><b>RCS client</b><span>${esc(sale.client_rcs)}</span></div>` : ''}
            ${sale.commercial_name ? `<div class="row"><b>Vendeur</b><span>${esc(sale.commercial_name)}</span></div>` : ''}
            ${sale.delivery ? `<div class="row"><b>Livraison${sale.delivery.number ? ' n° ' + esc(sale.delivery.number) : ''}</b><span>Livreur : ${esc(sale.delivery.livreur || 'non assigné')}</span></div>` : ''}
            <div class="row"><b>Caisse</b><span>${esc(sale.cashier_name || '')}</span></div>
        </div>
        ${clientPc80(sale)}
        <div class="hr"></div>
        ${items}
        ${saleAdjustments(sale).map((r, i) => `<div class="it-r"${i ? '' : ' style="margin-top:6px;"'}><span>${r.l}</span><span>${r.a}</span></div>`).join('')}
        ${(fee > 0) ? `<div class="it-r" style="margin-top:6px;"><span>Sous-total</span><span>${fmt(sale.total)}</span></div>
        <div class="it-r"><span>Frais de livraison</span><span>${fmt(fee)}</span></div>` : ''}
        <div class="total"><span class="lbl">TOTAL${fee > 0 ? ' À PAYER' : ''}</span><span class="amt">${fmt(sale.total + fee)}</span></div>
        ${(sale.avance ? avanceRows(sale) : layawayRows(sale)).map(r => `<div class="it-r"><span>${r.l}</span><span>${r.a}</span></div>`).join('')}
        <div class="payment">Paiement${sale.avance ? ' ce jour (' + fmt(sale.avance.paid_now) + ')' : ''} : ${payLineOf(sale)}</div>
        ${avanceDueHtml(sale, true)}
        ${sale.avance ? '' : generateTestSection80(sale)}
        ${c.invoice_note ? `<div class="hr"></div><div style="text-align:center;font-size:10px;">${esc(c.invoice_note)}</div>` : ''}
        <div class="sig">
            <div class="row"><div class="lbl">Le Client</div><div class="line"></div></div>
            <div class="row"><div class="lbl">La Caisse</div><div class="line"></div></div>
        </div>
        ${saleHasNonAccessory(sale) && !sale.avance ? warrantyHtml(true, '#000') : ''}
        <div class="bcwrap">
            ${generateBarcodeSVG(code)}
            <div class="bccode">${esc(code)}</div>
        </div>
        <div class="foot">${c.invoice_footer ? esc(c.invoice_footer) : 'Merci de votre visite !'}</div>
    </div>`;
}

function print80(sale, c) {
    c = c || {};
    const w = window.open('', '_blank', 'width=380,height=760');
    w.document.write(`<html><head><meta charset="utf-8"><title>Ticket ${esc(sale.sale_number)}</title>
        <script src="/vendor/js/JsBarcode.all.min.js"><\/script>
        <style>${RECEIPT80_CSS}</style></head><body>${receipt80Body(sale, c)}
    <script>
        window.onload = function() { setTimeout(function() { window.print(); }, 600); };
    <\/script>
    </body></html>`);
    w.document.close();
}

// Impression directe sans dialogue (iframe caché pour éviter le blocage popup).
function print80Direct(sale, c) {
    c = c || {};
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;top:-10000px;left:-10000px;width:1px;height:1px;border:none;';
    iframe.name = 'print_frame_' + Date.now();
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow.document;
    doc.write(`<html><head><meta charset="utf-8"><title>Ticket ${esc(sale.sale_number)}</title>
        <script src="/vendor/js/JsBarcode.all.min.js"><\/script>
        <style>${RECEIPT80_CSS}</style></head><body>${receipt80Body(sale, c)}
    <script>
        window.onload = function() {
            setTimeout(function() {
                window.print();
                setTimeout(function() { var f = window.frameElement; if (f && f.parentNode) f.parentNode.removeChild(f); }, 3000);
            }, 800);
        };
    <\/script>
    </body></html>`);
    doc.close();
}

// Petit sélecteur de format injecté dans la page courante (80 mm ou A4).
function chooser(sale, c) {
    const prev = document.getElementById('sfInvChooser'); if (prev) prev.remove();
    const ov = document.createElement('div');
    ov.id = 'sfInvChooser';
    ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;';
    ov.innerHTML = `<div style="background:var(--bg-card,#fff);color:var(--text-primary,#111);border-radius:12px;padding:22px 24px;max-width:320px;width:90%;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.35);">
        <h3 style="margin:0 0 4px;font-size:16px;">${sale.avance ? 'Facture d\'avance n° ' : 'Facture n° '}${esc(sale.sale_number || sale.id || '')}</h3>
        <p style="margin:0 0 ${c && (c.nif || c.stat) ? 12 : 16}px;font-size:12.5px;color:var(--text-muted,#666);">Choisissez le format d'impression</p>
        ${c && (c.nif || c.stat) ? `<label style="display:flex;align-items:center;justify-content:center;gap:8px;margin:0 0 14px;padding:9px 10px;border:1px solid var(--border-color,#ddd);border-radius:10px;font-size:13px;font-weight:600;cursor:pointer;">
            <input type="checkbox" id="sfInvNif" style="width:16px;height:16px;"> Afficher NIF / STAT du magasin</label>` : ''}
        <div style="display:flex;flex-direction:column;gap:10px;">
            <button id="sfInv80" class="btn btn-primary" style="width:100%;"><i class="fas fa-receipt"></i> Ticket thermique 80 mm</button>
            <button id="sfInvA4" class="btn btn-secondary" style="width:100%;"><i class="fas fa-file-invoice"></i> Facture A4 (signatures)</button>
            <button id="sfInvCancel" class="btn btn-secondary" style="width:100%;background:transparent;">Fermer</button>
        </div></div>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    ov.addEventListener('click', e => { if (e.target === ov) close(); });
    const withNif = () => { const cb = ov.querySelector('#sfInvNif'); return { ...(c || {}), showNif: !!(cb && cb.checked) }; };
    ov.querySelector('#sfInv80').onclick = () => { const cc = withNif(); close(); print80(sale, cc); };
    ov.querySelector('#sfInvA4').onclick = () => { const cc = withNif(); close(); printA4(sale, cc); };
    ov.querySelector('#sfInvCancel').onclick = close;
}

// Facture d'avance : l = détail d'une avance (/api/layaways/:id ou réponse de création/versement).
function avance(l, c, conditions) { chooser(layawayDoc(l, conditions), c); }

window.SFInvoice = { printA4, print80, print80Direct, print: printA4, chooser, avance };
})();