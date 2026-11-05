/* ============================================================
   STOCKFLOW — Parcours d'un article (modale timeline PARTAGÉE).
   La page doit contenir une modale :
     <div class="modal-overlay" id="traceModal"><div class="modal">
        <div class="modal-header"><h3 id="tmTitle"></h3>…</div>
        <div class="modal-body" id="tmBody"></div></div></div>
   Usage : onclick="SFTrace.open(unitId)".
   Source : GET /api/units/:id/movements.
   ============================================================ */
(function () {
'use strict';

const ACTIONS = {
    reception: 'Réception', envoi_installation: 'Envoi installation', installation_terminee: 'Installation terminée',
    presentoir: 'Mise en présentoir', presentoir_retrait: 'Retrait présentoir', sortie_boutique: 'Sortie boutique',
    reservation: 'Réservation', reservation_annulee: 'Réservation annulée', consignation_retour: 'Retour boutique réceptionné',
    retour_boutique: 'Retour boutique', vente: 'Vente', vente_echange: 'Vente (échange)', retour_vente: 'Retour de vente',
    retour_receptionne: 'Retour réceptionné', echange_retour: 'Retour pour échange', acompte_reserve: 'Avance (layaway)',
    acompte_annule: 'Avance annulée', livraison_sortie: 'Sortie livraison', livraison_livree: 'Livrée',
    livraison_facturee: 'Livraison facturée', retour_livraison: 'Retour livraison', garantie_envoi: 'Envoi garantie',
    garantie_a_renvoyer: 'Garantie — à renvoyer', retour_fournisseur: 'Retour fournisseur', garantie_retournee: 'Revenu du fournisseur',
    garantie_traitee: 'Garantie traitée', garantie_reparee: 'Réparé', remplace: 'Remplacé', supprime: 'Supprimé',
    upgrade_consomme: 'Composant monté (upgrade)'
};
// Statuts « dans le stock » (entrée/sortie = franchissement de cette frontière).
const IN = ['stock', 'preparation', 'presentoir', 'reserve', 'consignation', 'acompte'];

function dirOf(m) {
    if (m.to_status === 'stock' && m.action === 'reception') return 'in';
    const fromIn = IN.includes(m.from_status), toIn = IN.includes(m.to_status);
    if (toIn && !fromIn) return 'in';
    if (fromIn && !toIn) return 'out';
    return 'other';
}

window.SFTrace = {
    actionLabel(a) { return ACTIONS[a] || a; },
    async open(unitId) {
        SF.Modal.open('traceModal');
        const body = document.getElementById('tmBody');
        body.innerHTML = SF.skel.lines(4);
        try {
            const d = await SF.api('/api/units/' + unitId + '/movements');
            const name = [d.unit.brand, d.unit.model].filter(Boolean).join(' ') || d.unit.product_name || 'Article';
            document.getElementById('tmTitle').innerHTML = `${SF.esc(name)} — <span style="font-family:monospace;">${SF.esc(d.unit.serial || '—')}</span>`;
            const head = `<div style="margin-bottom:12px;">
                ${SF.statusBadge(d.unit.status)}
                ${d.unit.manufacturer_sn ? `<div class="text-muted" style="font-size:12px;margin-top:4px;">SN constructeur : ${SF.esc(d.unit.manufacturer_sn)}</div>` : ''}
                <div class="text-muted" style="font-size:12px;margin-top:2px;">${d.movements.length} étape(s) — de la réception à aujourd'hui.</div>
            </div>`;
            const items = d.movements.map(m => {
                const flow = `${SF.UNIT_STATUS[m.from_status] || m.from_status || '—'} → ${SF.UNIT_STATUS[m.to_status] || m.to_status}`;
                return `<li>
                    <span class="dot ${dirOf(m)}"></span>
                    <div class="when">${SF.fmt.datetime(m.created_at)}</div>
                    <div class="what">${SF.esc(this.actionLabel(m.action))}</div>
                    <div class="flow">${SF.esc(flow)}</div>
                    <div class="who"><i class="fas fa-user" style="font-size:10px;"></i> ${SF.esc(m.user_name || '—')}</div>
                    ${m.note ? `<div class="note">${SF.esc(m.note)}</div>` : ''}
                </li>`;
            }).join('');
            body.innerHTML = head + `<ul class="tl">${items}</ul>`;
        } catch (e) { body.innerHTML = `<div class="text-danger">${SF.esc(e.message)}</div>`; }
    }
};

})();
