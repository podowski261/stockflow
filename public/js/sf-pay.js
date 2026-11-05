/* ============================================================
   STOCKFLOW — Éditeur de paiement (méthode unique ou MIXTE).
   Permet de répartir un montant sur plusieurs méthodes
   (ex. 320 000 espèces + 180 000 mobile money).
   - Plus de « référence » pour le mobile money (juste le n° émetteur, facultatif).
   - Le n° de chèque reste obligatoire pour un chèque.
   - La dernière ligne se calcule automatiquement (reste), donc la somme = total.

   API :
     SFPay.mount(container, total)   → construit l'éditeur (1 ligne = total).
     SFPay.setTotal(container, total)→ met à jour le total (recalcule).
     SFPay.read(container)           → { payments:[{method,amount,phone,ref}] } ou { error }.
     SFPay.confirm(container)        → comme read(), puis, s'il y a des espèces, modale « montant reçu /
                                       monnaie à rendre » ; { cancelled:true } si la caisse annule.
   Aucun mode n'est choisi par défaut : la caisse DOIT sélectionner le mode (sauf mode déjà déclaré).
   ============================================================ */
(function () {
'use strict';
const METHODS = [
    { v: 'especes', l: 'Espèces' },
    { v: 'mvola', l: 'MVola' },
    { v: 'orange_money', l: 'Orange Money' },
    { v: 'airtel_money', l: 'Airtel Money' },
    { v: 'cheque', l: 'Chèque' },
    { v: 'virement', l: 'Virement bancaire' }
];
const MM = ['mvola', 'orange_money', 'airtel_money'];
const ar = n => new Intl.NumberFormat('fr-FR').format(Math.round(n || 0)) + ' Ar';

function state(c) { return c._sfpay || (c._sfpay = { total: 0, rows: [{ method: '', amount: 0, phone: '', ref: '' }] }); }

// Recalcule le montant de la DERNIÈRE ligne = total − somme des autres.
function balance(s) {
    if (!s.rows.length) return;
    let others = 0;
    for (let i = 0; i < s.rows.length - 1; i++) others += Math.round(parseFloat(s.rows[i].amount) || 0);
    s.rows[s.rows.length - 1].amount = Math.round(s.total) - others;
}

function render(c) {
    const s = state(c);
    // Vente à 0 Ar (remise 100 %, articles gratuits) : rien à encaisser, aucune ligne de paiement.
    if (Math.round(s.total) === 0) {
        c.innerHTML = '<div style="padding:12px;border-radius:10px;background:var(--bg-input);font-size:13px;"><i class="fas fa-circle-info"></i> Vente à <b>0 Ar</b> : aucun encaissement.</div>';
        return;
    }
    balance(s);
    const single = s.rows.length === 1;
    let html = '<div class="sfpay-rows" style="display:flex;flex-direction:column;gap:8px;">';
    s.rows.forEach((r, i) => {
        const last = i === s.rows.length - 1;
        const isMM = MM.includes(r.method), isChq = r.method === 'cheque', isVir = r.method === 'virement';
        const amtRO = single || last;               // 1 ligne = total ; dernière ligne = reste (auto)
        const neg = r.amount < 0;
        html += `<div class="sfpay-row" data-i="${i}" style="border:1px solid var(--border,#2a2a3a);border-radius:10px;padding:8px 10px;">
            <div style="display:flex;gap:8px;align-items:center;">
                <select class="form-control sfpay-method" style="flex:1;min-width:120px;${r.method ? '' : 'border-color:#f59e0b;'}">
                    <option value=""${r.method ? '' : ' selected'} disabled>— Mode de paiement * —</option>
                    ${METHODS.map(m => `<option value="${m.v}"${m.v === r.method ? ' selected' : ''}>${m.l}</option>`).join('')}
                </select>
                <input type="text" inputmode="numeric" class="form-control sfpay-amount money-input" ${amtRO ? '' : 'data-keypad'} value="${(window.SF && SF.money) ? SF.money.group(r.amount) : (Math.round(r.amount) || 0)}"
                    ${amtRO ? 'readonly tabindex="-1"' : ''} style="width:130px;text-align:right;${neg ? 'color:#e5484d;border-color:#e5484d;' : ''}${amtRO ? 'opacity:.75;' : ''}">
                ${s.rows.length > 1 ? `<button type="button" class="sfpay-del" title="Retirer" style="background:none;border:none;color:var(--text-secondary,#888);cursor:pointer;font-size:16px;padding:2px 6px;">&times;</button>` : ''}
            </div>
            ${(isMM || isChq || isVir) ? `<div style="margin-top:6px;">
                <input type="text" class="form-control sfpay-phone" placeholder="${isChq ? 'N° du chèque *' : isVir ? 'Réf. du virement (facultatif)' : 'N° émetteur (facultatif)'}" value="${((isChq || isVir) ? r.ref : r.phone) || ''}">
            </div>` : ''}
        </div>`;
    });
    html += '</div>';
    const sum = s.rows.reduce((a, r) => a + (Math.round(parseFloat(r.amount) || 0)), 0);
    const bad = s.rows[s.rows.length - 1].amount < 0;
    html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;">
        <button type="button" class="sfpay-add btn btn-secondary" style="padding:5px 10px;font-size:12.5px;"><i class="fas fa-plus"></i> Ajouter un paiement</button>
        <span class="sfpay-status" style="font-size:12.5px;font-weight:600;color:${bad ? '#e5484d' : 'var(--text-secondary,#888)'};">
            ${bad ? 'Répartition dépasse le total' : ('Total : ' + ar(sum))}
        </span>
    </div>`;
    c.innerHTML = html;
    bind(c);
}

function bind(c) {
    const s = state(c);
    c.querySelectorAll('.sfpay-row').forEach(row => {
        const i = +row.dataset.i;
        row.querySelector('.sfpay-method').addEventListener('change', e => { s.rows[i].method = e.target.value; s.rows[i].phone = ''; s.rows[i].ref = ''; render(c); });
        const amt = row.querySelector('.sfpay-amount');
        if (amt && !amt.readOnly) amt.addEventListener('input', e => { s.rows[i].amount = Math.round(parseFloat(e.target.value.replace(/\s/g, '')) || 0); balance(s); updateStatus(c); });
        const ph = row.querySelector('.sfpay-phone');
        if (ph) ph.addEventListener('input', e => { if (s.rows[i].method === 'cheque' || s.rows[i].method === 'virement') s.rows[i].ref = e.target.value; else s.rows[i].phone = e.target.value; });
        const del = row.querySelector('.sfpay-del');
        if (del) del.addEventListener('click', () => { s.rows.splice(i, 1); render(c); });
    });
    c.querySelector('.sfpay-add').addEventListener('click', () => {
        // La nouvelle ligne devient la « ligne reste » ; l'ancienne dernière devient éditable.
        s.rows.push({ method: '', amount: 0, phone: '', ref: '' });
        render(c);
    });
}

// Met à jour uniquement l'affichage du reste (sans re-render, pour ne pas perdre le focus).
function updateStatus(c) {
    const s = state(c);
    const sum = s.rows.reduce((a, r) => a + (Math.round(parseFloat(r.amount) || 0)), 0);
    const bad = s.rows[s.rows.length - 1].amount < 0;
    const st = c.querySelector('.sfpay-status');
    if (st) { st.textContent = bad ? 'Répartition dépasse le total' : ('Total : ' + ar(sum)); st.style.color = bad ? '#e5484d' : 'var(--text-secondary,#888)'; }
    // Reflète le reste calculé dans la dernière ligne (readonly).
    const rows = c.querySelectorAll('.sfpay-row');
    const lastAmt = rows[rows.length - 1] && rows[rows.length - 1].querySelector('.sfpay-amount');
    if (lastAmt) { const la = Math.round(s.rows[s.rows.length - 1].amount) || 0; lastAmt.value = (window.SF && SF.money && la >= 0) ? SF.money.group(la) : la; lastAmt.style.color = s.rows[s.rows.length - 1].amount < 0 ? '#e5484d' : ''; }
}

const SFPay = {
    // preset (facultatif) : { method, phone, ref } pré-remplit la 1re ligne (ex. paiement mobile money
    // déjà déclaré par le commercial et confirmé par la caisse). La réf. MM n'a pas de champ visible
    // mais est conservée (déclarative) et ressort dans read().
    mount(c, total, preset) {
        if (!c) return;
        const p = preset || {};
        const method = (p.method && METHODS.some(m => m.v === p.method)) ? p.method : '';   // pas d'espèces par défaut
        c._sfpay = { total: Math.round(total || 0), rows: [{ method, amount: Math.round(total || 0), phone: p.phone || '', ref: p.ref || '' }] };
        render(c);
    },
    setTotal(c, total) { const s = state(c); s.total = Math.round(total || 0); render(c); },
    read(c) {
        const s = state(c);
        if (Math.round(s.total) === 0) return { payments: [] };   // vente à 0 Ar
        balance(s);
        const payments = [];
        for (const r of s.rows) {
            const amount = Math.round(parseFloat(r.amount) || 0);
            if (!r.method) return { error: 'Choisissez le mode de paiement (espèces, MVola, Orange Money…).' };
            if (amount <= 0) return { error: 'Chaque paiement doit être supérieur à 0 (vérifiez la répartition).' };
            if (r.method === 'cheque' && !((r.ref || '').trim())) return { error: 'N° du chèque obligatoire.' };
            // Réf. conservée pour le chèque (n° chèque) ET le mobile money (réf. déclarée) ; nulle sinon.
            const ref = (r.method === 'cheque' || r.method === 'virement' || MM.includes(r.method)) ? ((r.ref || '').trim() || null) : null;
            payments.push({ method: r.method, amount, phone: (r.phone || '').trim() || null, ref });
        }
        const sum = payments.reduce((a, p) => a + p.amount, 0);
        if (Math.abs(sum - Math.round(s.total)) > 1) return { error: 'La répartition des paiements ne correspond pas au total.' };
        return { payments };
    },
    // read() + modale espèces : montant reçu du client et monnaie à rendre. « Encaisser » sans saisie =
    // le client a donné le montant exact.
    async confirm(c) {
        const pr = SFPay.read(c);
        if (pr.error || !pr.payments) return pr;
        const due = pr.payments.filter(p => p.method === 'especes').reduce((a, p) => a + p.amount, 0);
        if (due <= 0) return pr;
        const cash = await cashModal(due);
        if (!cash) return { cancelled: true };
        return { ...pr, cash };
    }
};

// ── Modale « Paiement en espèces » ──
function cashModal(due) {
    return new Promise(resolve => {
        let ov = document.getElementById('sfCashModal');
        if (ov) ov.remove();
        ov = document.createElement('div');
        ov.id = 'sfCashModal'; ov.className = 'modal-overlay active';
        ov.style.zIndex = '3000';
        // Billets probables : montant exact puis arrondis supérieurs usuels.
        const sugg = [...new Set([1000, 5000, 10000, 20000, 50000, 100000].map(st => Math.ceil(due / st) * st).filter(v => v > due))].sort((a, b) => a - b).slice(0, 4);
        ov.innerHTML = `<div class="modal" style="max-width:420px;">
            <div class="modal-header"><h3><i class="fas fa-money-bill-wave"></i> Paiement en espèces</h3><button type="button" class="modal-close" data-x>&times;</button></div>
            <div class="modal-body">
                <div style="text-align:center;padding:10px;border-radius:12px;background:var(--bg-input);margin-bottom:12px;">
                    <div style="font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.4px;font-weight:700;">À encaisser en espèces</div>
                    <div style="font-size:26px;font-weight:800;">${ar(due)}</div></div>
                <div class="form-group" style="margin-bottom:8px;"><label>Montant reçu du client (Ar)</label>
                    <input type="text" inputmode="numeric" class="form-control money-input" id="sfCashGiven" placeholder="${ar(due)} (montant exact)" style="font-size:18px;font-weight:700;text-align:right;"></div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">
                    <button type="button" class="btn btn-secondary btn-sm" data-v="${due}">Montant exact</button>
                    ${sugg.map(v => `<button type="button" class="btn btn-secondary btn-sm" data-v="${v}">${ar(v)}</button>`).join('')}</div>
                ${keypadHtml()}
                <div id="sfCashBack" style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;border-radius:12px;background:rgba(22,163,74,.1);border:1px solid rgba(22,163,74,.35);">
                    <span style="font-weight:700;">Monnaie à rendre</span><span id="sfCashChange" style="font-size:22px;font-weight:800;color:#15803d;">0 Ar</span></div>
            </div>
            <div class="modal-footer"><button type="button" class="btn btn-secondary" data-x>Annuler</button><button type="button" class="btn btn-primary" id="sfCashOk"><i class="fas fa-check"></i> Encaisser</button></div>
        </div>`;
        document.body.appendChild(ov);
        const inp = ov.querySelector('#sfCashGiven'), out = ov.querySelector('#sfCashChange'), box = ov.querySelector('#sfCashBack');
        const given = () => { const v = Math.round(parseFloat(String(inp.value).replace(/[^\d]/g, '')) || 0); return v || due; };
        const upd = () => {
            const g = given(), ch = g - due;
            out.textContent = ch < 0 ? 'Manque ' + ar(-ch) : ar(ch);
            out.style.color = ch < 0 ? '#b91c1c' : '#15803d';
            box.style.background = ch < 0 ? 'rgba(220,38,38,.08)' : 'rgba(22,163,74,.1)';
            box.style.borderColor = ch < 0 ? 'rgba(220,38,38,.35)' : 'rgba(22,163,74,.35)';
        };
        const done = v => { ov.remove(); document.removeEventListener('keydown', key); resolve(v); };
        const ok = () => { const g = given(); if (g < due) { inp.focus(); return; } done({ received: g, change: g - due }); };
        const key = e => { if (e.key === 'Escape') done(null); if (e.key === 'Enter') { e.preventDefault(); ok(); } };
        inp.addEventListener('input', () => { const d = String(inp.value).replace(/[^\d]/g, ''); inp.value = d && window.SF && SF.money ? SF.money.group(+d) : d; upd(); });
        bindKeypad(ov, inp, upd);
        ov.querySelectorAll('[data-v]').forEach(b => b.addEventListener('click', () => { inp.value = window.SF && SF.money ? SF.money.group(+b.dataset.v) : b.dataset.v; upd(); }));
        ov.querySelectorAll('[data-x]').forEach(b => b.addEventListener('click', () => done(null)));
        ov.querySelector('#sfCashOk').addEventListener('click', ok);
        document.addEventListener('keydown', key);
        upd(); setTimeout(() => inp.focus(), 50);
    });
}

// ── Pavé numérique type calculatrice (modale espèces + champs montant marqués data-keypad) ──
const TOUCH = typeof window !== 'undefined' && ('ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0);
function kpCss() {
    if (document.getElementById('sfKpCss')) return;
    const st = document.createElement('style'); st.id = 'sfKpCss';
    st.textContent = `.sfkp{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;margin:4px 0 12px;user-select:none}
.sfkp button{height:52px;border:1px solid var(--border-color,#d4d4d8);border-radius:12px;background:var(--bg-card,#fff);color:var(--text-primary,#111);font-size:21px;font-weight:700;font-family:inherit;cursor:pointer;touch-action:manipulation;transition:transform .06s,background .1s}
.sfkp button:active{transform:scale(.95);background:var(--bg-input,#f1f1f1)}
.sfkp .k0{grid-column:span 3}
.sfkp .kfn{background:var(--bg-input,#f4f4f5);font-size:17px}
.sfkp .kdel{color:#b45309}.sfkp .kclr{color:#b91c1c}
@media (max-width:420px){.sfkp button{height:48px;font-size:19px}}
.sfkp-wrap{position:relative;display:block}
.sfkp-wrap>input{padding-right:42px !important}
.sfkp-btn{position:absolute;right:5px;top:50%;transform:translateY(-50%);width:32px;height:32px;border:none;border-radius:8px;background:var(--bg-input,#f4f4f5);color:var(--text-secondary,#555);cursor:pointer}`;
    document.head.appendChild(st);
}
function keypadHtml() {
    kpCss();
    const b = (k, l, c) => `<button type="button" data-k="${k}" class="${c || ''}">${l}</button>`;
    return `<div class="sfkp">${b('7', '7')}${b('8', '8')}${b('9', '9')}${b('del', '<i class="fas fa-delete-left"></i>', 'kfn kdel')}
        ${b('4', '4')}${b('5', '5')}${b('6', '6')}${b('clr', 'C', 'kfn kclr')}
        ${b('1', '1')}${b('2', '2')}${b('3', '3')}${b('00', '00', 'kfn')}
        ${b('0', '0', 'k0')}${b('000', '000', 'kfn')}</div>`;
}
// Relie un pavé (dans root) à un champ : saisie des chiffres, effacement, remise à zéro.
function bindKeypad(root, inp, onChange) {
    if (TOUCH) inp.setAttribute('inputmode', 'none');   // le pavé remplace le clavier du téléphone
    const fmtv = d => d && window.SF && SF.money && inp.type !== 'number' ? SF.money.group(+d) : d;
    root.querySelectorAll('.sfkp [data-k]').forEach(btn => btn.addEventListener('click', () => {
        let d = String(inp.value).replace(/[^\d]/g, '');
        const k = btn.dataset.k;
        if (k === 'del') d = d.slice(0, -1);
        else if (k === 'clr') d = '';
        else if (d.length < 12) d = (d + k).replace(/^0+(?=\d)/, '');
        inp.value = fmtv(d);
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        if (onChange) onChange();
    }));
}
// Pavé en fenêtre pour un champ montant quelconque (bouton calculatrice à droite du champ).
function openKeypad(inp) {
    let ov = document.getElementById('sfKpModal'); if (ov) ov.remove();
    ov = document.createElement('div'); ov.id = 'sfKpModal'; ov.className = 'modal-overlay active'; ov.style.zIndex = '3100';
    const label = (inp.closest('.form-group') && inp.closest('.form-group').querySelector('label')) ? inp.closest('.form-group').querySelector('label').textContent.trim() : 'Montant';
    ov.innerHTML = `<div class="modal" style="max-width:360px;">
        <div class="modal-header"><h3><i class="fas fa-calculator"></i> ${label.replace(/[<>&]/g, '')}</h3><button type="button" class="modal-close" data-x>&times;</button></div>
        <div class="modal-body"><input type="text" class="form-control" id="sfKpVal" readonly style="font-size:24px;font-weight:800;text-align:right;height:54px;margin-bottom:10px;">${keypadHtml()}</div>
        <div class="modal-footer"><button type="button" class="btn btn-secondary" data-x>Annuler</button><button type="button" class="btn btn-primary" id="sfKpOk"><i class="fas fa-check"></i> Valider</button></div></div>`;
    document.body.appendChild(ov);
    const v = ov.querySelector('#sfKpVal');
    const d0 = String(inp.value).replace(/[^\d]/g, '');
    v.value = d0 && window.SF && SF.money ? SF.money.group(+d0) : d0;
    bindKeypad(ov, v);
    const close = () => { ov.remove(); document.removeEventListener('keydown', key); };
    const ok = () => { const d = String(v.value).replace(/[^\d]/g, ''); inp.value = inp.type === 'number' ? d : (d && window.SF && SF.money ? SF.money.group(+d) : d);
        inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); close(); };
    const key = e => {
        if (e.key === 'Escape') close();
        else if (e.key === 'Enter') { e.preventDefault(); ok(); }
        else if (/^\d$/.test(e.key)) { const d = (String(v.value).replace(/[^\d]/g, '') + e.key).replace(/^0+(?=\d)/, ''); v.value = window.SF && SF.money ? SF.money.group(+d) : d; }
        else if (e.key === 'Backspace') { const d = String(v.value).replace(/[^\d]/g, '').slice(0, -1); v.value = d && window.SF && SF.money ? SF.money.group(+d) : d; }
    };
    ov.querySelectorAll('[data-x]').forEach(b => b.addEventListener('click', close));
    ov.querySelector('#sfKpOk').addEventListener('click', ok);
    document.addEventListener('keydown', key);
}
// Ajoute le bouton calculatrice aux champs marqués data-keypad (y compris ajoutés dynamiquement).
function enhance(root) {
    (root.querySelectorAll ? root.querySelectorAll('input[data-keypad]:not([data-kp-done])') : []).forEach(inp => {
        if (inp.readOnly) return;
        kpCss(); inp.setAttribute('data-kp-done', '1');
        const w = document.createElement('span'); w.className = 'sfkp-wrap';
        inp.parentNode.insertBefore(w, inp); w.appendChild(inp);
        const b = document.createElement('button'); b.type = 'button'; b.className = 'sfkp-btn'; b.title = 'Pavé numérique'; b.innerHTML = '<i class="fas fa-calculator"></i>';
        b.addEventListener('click', () => openKeypad(inp));
        w.appendChild(b);
    });
}
if (typeof document !== 'undefined') {
    const start = () => { enhance(document); new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1) enhance(n.matches && n.matches('input[data-keypad]') ? n.parentNode : n); }))).observe(document.body, { childList: true, subtree: true }); };
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
}
SFPay.keypad = openKeypad;
window.SFPay = SFPay;
})();
