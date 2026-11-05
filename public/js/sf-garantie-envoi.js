/* ============================================================
   STOCKFLOW — Bon de retour en garantie (envoi fournisseur).
   Document officiel remis au fournisseur lors du renvoi d'unités
   sous garantie : en-tête société, coordonnées fournisseur, tableau
   des unités (n° série, désignation, panne, fin de garantie) et
   blocs de signature. Une page A4 par fournisseur.

   Usage : SFGarantieEnvoi.generate({ groups, ref, date }, config)
     groups : [{ supplier:{name,phone,address,contact}, units:[
                 { serial, designation, detail, note, warranty_end } ] }]
   ============================================================ */
(function () {
'use strict';

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[x]));
const fmtDate = d => {
    if (!d) return '—';
    try { return new Date(String(d).replace(' ', 'T')).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
    catch (e) { return String(d); }
};
const TAGLINE = 'Réparation et vente des produits informatiques';

function page(group, meta, c, isLast) {
    const sup = group.supplier || {};
    const supLines = [
        sup.address ? esc(sup.address) : '',
        [sup.phone ? 'Tél : ' + esc(sup.phone) : '', sup.contact ? 'Contact : ' + esc(sup.contact) : ''].filter(Boolean).join(' — ')
    ].filter(Boolean).join('<br>');

    const rows = (group.units || []).map((u, i) => `<tr>
        <td class="c">${i + 1}</td>
        <td class="mono">${esc(u.serial || '—')}</td>
        <td><div class="d-t">${esc(u.designation || '—')}</div>${u.detail ? `<div class="d-s">${esc(u.detail)}</div>` : ''}</td>
        <td>${u.note ? esc(u.note) : '<span class="muted">Panne à préciser</span>'}</td>
        <td class="c">${fmtDate(u.warranty_end)}</td>
    </tr>`).join('');

    return `<div class="page${isLast ? '' : ' brk'}">
        <div class="topbar"></div>
        <div class="wrap">
            <div class="head">
                <div class="co">
                    ${c.logo ? `<img src="${c.logo}" class="co-logo">` : ''}
                    <h1>${esc(c.name || 'STOCKFLOW')}</h1>
                    <p class="tag">${esc(TAGLINE)}</p>
                </div>
                <div class="title"><div class="t1">BON DE RETOUR</div><div class="t2">GARANTIE</div></div>
            </div>
            <div class="meta">
                <div class="co-info">
                    ${c.address ? `<p>${esc(c.address)}</p>` : ''}
                    ${c.phone ? `<p>Tél : ${esc(c.phone)}</p>` : ''}
                    ${c.email ? `<p>Email : ${esc(c.email)}</p>` : ''}
                    ${(c.nif || c.stat) ? `<p>${[c.nif ? 'NIF ' + esc(c.nif) : '', c.stat ? 'STAT ' + esc(c.stat) : ''].filter(Boolean).join(' · ')}</p>` : ''}
                </div>
                <table class="ref-table">
                    <tr><td class="k">Référence</td><td class="v">${esc(meta.ref)}</td></tr>
                    <tr><td class="k">Date</td><td class="v">${esc(meta.date)}</td></tr>
                    <tr><td class="k">Unités</td><td class="v">${(group.units || []).length}</td></tr>
                </table>
            </div>
            <div class="dest">
                <div class="lbl">FOURNISSEUR</div>
                <div class="nm">${esc(sup.name || '—')}</div>
                ${supLines ? `<div class="ln">${supLines}</div>` : ''}
            </div>
            <div class="objet">Nous vous retournons, <b>au titre de la garantie</b>, les unité(s) ci-dessous pour prise en charge (réparation ou remplacement). Merci de nous confirmer leur bonne réception.</div>
            <table class="items">
                <thead><tr><th class="c">#</th><th>N° SÉRIE</th><th>DÉSIGNATION</th><th>PANNE / MOTIF</th><th class="c">FIN GARANTIE</th></tr></thead>
                <tbody>${rows || '<tr><td colspan="5" class="c muted" style="padding:16px;">Aucune unité</td></tr>'}</tbody>
            </table>
            <div class="cols">
                <div class="sign">
                    <div class="for">Remis par (expéditeur)</div>
                    <div class="line">Nom &amp; signature</div>
                </div>
                <div class="sign">
                    <div class="for">Reçu par (fournisseur)</div>
                    <div class="line">Nom, date &amp; signature</div>
                </div>
            </div>
        </div>
        <div class="foot">
            <span>${esc(c.name || 'STOCKFLOW')}${c.address ? ' • ' + esc(c.address) : ''}</span>
            <span>${esc(c.phone || '')} • ${esc(meta.ref)}</span>
        </div>
    </div>`;
}

function generate(data, c) {
    c = c || {};
    data = data || {};
    const groups = (data.groups || []).filter(g => g && (g.units || []).length);
    if (!groups.length) { if (window.SF) SF.toast('Aucune unité à envoyer', 'error'); return; }
    const ref = data.ref || ('BRG-' + new Date().getFullYear() + '-' + String(Date.now()).slice(-4));
    const date = data.date || new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    const meta = { ref, date };
    const body = groups.map((g, i) => page(g, meta, c, i === groups.length - 1)).join('');

    const w = window.open('', '_blank', 'width=900,height=1100');
    w.document.write(`<html><head><meta charset="utf-8"><title>Bon de retour garantie ${esc(ref)}</title>
    <style>
    @page { size:A4 portrait; margin:0; }
    *{ box-sizing:border-box; font-family:'Segoe UI',Arial,sans-serif; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
    body{ margin:0; color:#243244; font-size:11px; }
    .page{ padding:0 0 60px; position:relative; min-height:297mm; }
    .page.brk{ page-break-after:always; }
    .topbar{ height:6px; background:#e0a53a; }
    .wrap{ padding:22px 28px 0; }
    .head{ display:flex; justify-content:space-between; align-items:flex-start; }
    .co-logo{ max-height:64px; max-width:200px; display:block; margin-bottom:6px; }
    .co h1{ margin:0; font-size:24px; font-weight:800; color:#1e3a5f; letter-spacing:.5px; }
    .co .tag{ margin:2px 0 0; font-size:11px; color:#5b6b7f; }
    .title{ text-align:right; }
    .title .t1{ font-size:24px; font-weight:800; color:#1e3a5f; line-height:1; }
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
    table.items th.c{ text-align:center; }
    table.items td{ padding:9px 10px; border-bottom:1px solid #e6eaef; vertical-align:top; }
    table.items td.c{ text-align:center; } td.mono{ font-family:'Courier New',monospace; font-weight:700; }
    .d-t{ font-weight:700; color:#243244; font-size:11.5px; } .d-s{ color:#59677a; font-size:10px; margin-top:2px; }
    .muted{ color:#9aa6b4; }
    .cols{ display:flex; gap:20px; margin-top:34px; }
    .sign{ flex:1; background:#f7f9fb; border:1px solid #eef1f5; border-radius:6px; padding:14px; }
    .sign .for{ font-size:11px; font-weight:700; color:#1e3a5f; }
    .sign .line{ margin-top:40px; border-top:1px solid #cfd6df; padding-top:5px; font-size:10px; color:#8a95a3; }
    .foot{ position:absolute; left:0; right:0; bottom:0; background:#1e3a5f; color:#cdd7e4; font-size:9.5px; padding:9px 28px; display:flex; justify-content:space-between; }
    </style></head><body>${body}</body></html>`);
    w.document.close();
    let done = false;
    const go = () => { if (done) return; done = true; setTimeout(() => { w.focus(); w.print(); }, 250); };
    if (w.document.readyState === 'complete') go(); else { w.addEventListener('load', go); setTimeout(go, 4000); }
}

window.SFGarantieEnvoi = { generate };
})();
