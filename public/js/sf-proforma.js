/* ============================================================
   STOCKFLOW — Facture proforma (devis).
   Reprend la mise en page du modèle « DEVIS PROFORMA » (bandeau
   doré, en-tête bleu marine, tableau, total, conditions, signature)
   et l'imprime dans une fenêtre → impression navigateur / PDF.

   Usage : SFProforma.generate({ dest, objet, lines, ref, date }, config)
     dest  : { name, contact, address, nif, stat, email }
     lines : [{ designation, detail, qty, unit, pu }]
   ============================================================ */
(function () {
'use strict';

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, x => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[x]));
const fmt = n => new Intl.NumberFormat('fr-FR').format(Math.round(n || 0)).replace(/[  ]/g, ' ');

// Nombre → lettres : implémentation commune (sf-core) — « Arrêté … à la somme de … ».
const numberToWords = n => SF.numberToWords(n);
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

const COND_VALIDITE = "La présente facture proforma est valable pour une durée de sept (07) jours à compter de sa réception par le destinataire. Passé ce délai, les conditions pourront être révisées.";
const TAGLINE = "Réparation et vente des produits informatiques";

function generate(data, c) {
    c = c || {};
    data = data || {};
    const dest = data.dest || {};
    const lines = (data.lines || []).filter(l => l && (l.designation || l.detail));
    const total = lines.reduce((s, l) => s + (Math.round((+l.qty || 0) * (+l.pu || 0))), 0);
    const ref = data.ref || ('PRO-' + new Date().getFullYear() + '-' + String(Date.now()).slice(-4));
    const dateStr = data.date || new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    // Choix « inclure NIF & STAT » (proforma.html) : par défaut oui.
    const withTax = data.withTax !== false;
    // Textes personnalisables (Config → onglet Proforma), avec repli sur les valeurs par défaut.
    const tagline = c.proforma_tagline || TAGLINE;
    const validityDays = parseInt(c.proforma_validity_days, 10) || 7;
    const condValidity = c.proforma_conditions_validity || COND_VALIDITE;
    const condPayment = c.proforma_conditions_payment || '';

    const rows = lines.map(l => {
        const qty = +l.qty || 0, pu = +l.pu || 0, montant = Math.round(qty * pu);
        return `<tr>
            <td><div class="d-t">${esc(l.designation || '')}</div>${l.detail ? `<div class="d-s">${esc(l.detail)}</div>` : ''}${l.pitch ? `<div class="d-p">${esc(l.pitch)}</div>` : ''}</td>
            <td class="c">${fmt(qty)}</td>
            <td class="c">${esc(l.unit || 'pièce')}</td>
            <td class="r">${fmt(pu)}</td>
            <td class="r">${fmt(montant)}</td>
        </tr>`;
    }).join('');

    const destLines = [
        dest.address ? esc(dest.address) : '',
        [dest.contact ? 'Tél : ' + esc(dest.contact) : '', dest.email ? esc(dest.email) : ''].filter(Boolean).join(' — '),
        withTax ? [dest.nif ? 'NIF : ' + esc(dest.nif) : '', dest.stat ? 'STAT : ' + esc(dest.stat) : ''].filter(Boolean).join(' — ') : ''
    ].filter(Boolean).join('<br>');

    const w = window.open('', '_blank', 'width=900,height=1100');
    w.document.write(`<html><head><meta charset="utf-8"><title>Devis proforma ${esc(ref)}</title>
    <style>
    @page { size:A4 portrait; margin:0; }
    *{ box-sizing:border-box; font-family:'Segoe UI',Arial,sans-serif; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    body{ margin:0; color:#243244; font-size:11px; }
    .page{ padding:0 0 60px; position:relative; min-height:297mm; }
    .topbar{ height:6px; background:#e0a53a; }
    .wrap{ padding:22px 28px 0; }
    .head{ display:flex; justify-content:space-between; align-items:flex-start; }
    .co-logo{ max-height:64px; max-width:200px; display:block; margin-bottom:6px; }
    .co h1{ margin:0; font-size:24px; font-weight:800; color:#1e3a5f; letter-spacing:.5px; }
    .co .tag{ margin:2px 0 0; font-size:11px; color:#5b6b7f; }
    .title{ text-align:right; }
    .title .t1{ font-size:26px; font-weight:800; color:#1e3a5f; line-height:1; }
    .title .t2{ font-size:15px; font-weight:800; color:#e0a53a; letter-spacing:2px; }
    .meta{ display:flex; justify-content:space-between; margin-top:14px; gap:24px; }
    .co-info p{ margin:1px 0; color:#5b6b7f; font-size:10.5px; }
    .ref-table{ border-collapse:collapse; min-width:230px; align-self:flex-start; }
    .ref-table td{ border:1px solid #dfe4ea; padding:6px 12px; font-size:10.5px; }
    .ref-table td.k{ background:#f4f6f9; color:#5b6b7f; text-align:right; }
    .ref-table td.v{ font-weight:700; color:#1e3a5f; text-align:right; }
    .dest{ margin:20px 0 0; padding-left:12px; border-left:3px solid #1e3a5f; }
    .dest .lbl{ font-size:10px; font-weight:800; color:#e0a53a; letter-spacing:1.5px; }
    .dest .nm{ font-size:15px; font-weight:800; color:#1e3a5f; margin:3px 0 2px; }
    .dest .ln{ color:#5b6b7f; font-size:10.5px; line-height:1.5; }
    .objet{ margin:16px 0 0; padding:12px 14px; background:#f7f9fb; border:1px solid #eef1f5; border-radius:6px; font-size:11px; line-height:1.55; }
    .objet b{ color:#1e3a5f; }
    table.items{ width:100%; border-collapse:collapse; margin-top:18px; }
    table.items th{ background:#1e3a5f; color:#fff; padding:9px 10px; text-align:left; font-size:10.5px; letter-spacing:.3px; }
    table.items th.c,table.items th.r{ text-align:center; } table.items th.r{ text-align:right; }
    table.items td{ padding:10px; border-bottom:1px solid #e6eaef; vertical-align:top; }
    table.items td.c{ text-align:center; } table.items td.r{ text-align:right; }
    .d-t{ font-weight:700; color:#243244; font-size:11.5px; } .d-s{ color:#59677a; font-size:10px; margin-top:3px; line-height:1.5; }
    .d-p{ color:#1e3a5f; font-size:9.8px; font-style:italic; margin-top:3px; line-height:1.4; }
    .total{ display:flex; justify-content:flex-end; margin-top:14px; }
    .total .box{ display:flex; align-items:center; background:#1e3a5f; color:#fff; border-radius:6px; overflow:hidden; }
    .total .lab{ padding:11px 18px; font-weight:800; font-size:13px; letter-spacing:.5px; }
    .total .amt{ padding:11px 18px; font-weight:800; font-size:15px; color:#fff; background:rgba(255,255,255,.10); }
    .arrete{ margin:12px 0 0; font-style:italic; font-size:11px; color:#3a4a5e; }
    .arrete b{ font-style:normal; }
    .cols{ display:flex; gap:20px; margin-top:22px; }
    .cond{ flex:1.6; } .cond h3{ font-size:12px; color:#1e3a5f; margin:0 0 8px; letter-spacing:.5px; }
    .cond .item{ margin-bottom:8px; font-size:10.5px; line-height:1.5; color:#3a4a5e; }
    .cond .item b{ color:#1e3a5f; }
    .sign{ flex:1; background:#f7f9fb; border:1px solid #eef1f5; border-radius:6px; padding:14px; }
    .sign h3{ font-size:12px; color:#1e3a5f; margin:0 0 6px; letter-spacing:.5px; }
    .sign .for{ font-size:11px; color:#3a4a5e; }
    .sign .line{ margin-top:44px; border-top:1px solid #cfd6df; padding-top:5px; font-size:10px; color:#8a95a3; }
    .foot{ position:absolute; left:0; right:0; bottom:0; background:#1e3a5f; color:#cdd7e4; font-size:9.5px; padding:9px 28px; display:flex; justify-content:space-between; }
    </style></head><body>
    <div class="page">
        <div class="topbar"></div>
        <div class="wrap">
            <div class="head">
                <div class="co">
                    ${c.logo ? `<img src="${c.logo}" class="co-logo">` : ''}
                    <h1>${esc(c.name || 'INFINITY STORE')}</h1>
                    <p class="tag">${esc(tagline)}</p>
                </div>
                <div class="title"><div class="t1">DEVIS</div><div class="t2">PROFORMA</div></div>
            </div>
            <div class="meta">
                <div class="co-info">
                    ${c.address ? `<p>${esc(c.address)}</p>` : ''}
                    ${c.phone ? `<p>Tél : ${esc(c.phone)}</p>` : ''}
                    ${c.email ? `<p>Email : ${esc(c.email)}</p>` : ''}
                    ${(withTax && (c.nif || c.stat)) ? `<p>${[c.nif ? 'NIF ' + esc(c.nif) : '', c.stat ? 'STAT ' + esc(c.stat) : ''].filter(Boolean).join(' · ')}</p>` : ''}
                </div>
                <table class="ref-table">
                    <tr><td class="k">Référence</td><td class="v">${esc(ref)}</td></tr>
                    <tr><td class="k">Date</td><td class="v">${esc(dateStr)}</td></tr>
                    <tr><td class="k">Validité</td><td class="v">${validityDays} jours</td></tr>
                </table>
            </div>
            <div class="dest">
                <div class="lbl">DESTINATAIRE</div>
                <div class="nm">${esc(dest.name || '—')}</div>
                ${destLines ? `<div class="ln">${destLines}</div>` : ''}
            </div>
            ${data.objet ? `<div class="objet"><b>Objet :</b> ${esc(data.objet)}</div>` : ''}
            <table class="items">
                <thead><tr><th>DÉSIGNATION</th><th class="c">QTÉ</th><th class="c">UNITÉ</th><th class="r">P.U. (Ar)</th><th class="r">MONTANT (Ar)</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
            <div class="total"><div class="box"><span class="lab">TOTAL À PAYER</span><span class="amt">${fmt(total)} Ar</span></div></div>
            <div class="arrete">Arrêté le présent devis à la somme de <b>${esc(capitalize(numberToWords(total)))} Ariary</b> (${fmt(total)} Ar).</div>
            <div class="cols">
                <div class="cond">
                    <h3>CONDITIONS</h3>
                    <div class="item"><b>Validité de l'offre :</b> ${esc(condValidity)}</div>
                    <div class="item"><b>Modalités de paiement :</b> ${esc(condPayment)}</div>
                </div>
                <div class="sign">
                    <h3>SIGNATURE</h3>
                    <div class="for">Pour ${esc(c.name || 'INFINITY STORE')}</div>
                    <div class="line">Cachet &amp; signature</div>
                </div>
            </div>
        </div>
        <div class="foot">
            <span>${esc(c.name || 'INFINITY STORE')}${c.address ? ' • ' + esc(c.address) : ''}</span>
            <span>${esc(c.phone || '')} • ${esc(ref)}</span>
        </div>
    </div>
    </body></html>`);
    w.document.close();
    printWhenReady(w);
}

// Impression une fois le logo et les polices chargés (sinon il peut manquer sur le papier).
function printWhenReady(w) {
    let done = false;
    const go = () => { if (done) return; done = true; setTimeout(() => { w.focus(); w.print(); }, 250); };
    if (w.document.readyState === 'complete') go(); else { w.addEventListener('load', go); setTimeout(go, 4000); }
}

window.SFProforma = { generate, numberToWords };
})();
