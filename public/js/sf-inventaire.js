/* ============================================================
   STOCKFLOW — Moteur d'inventaire physique (stock-take par scan),
   partagé entre deux pages :
     • Ordinateurs  (inventaire.html)            — kind 'pc',        ADMIN + gestion du stock.
     • Composants   (inventaire-composants.html) — kind 'composant', ADMIN + gestion du stock.
   Une seule logique ; le « kind » choisit le périmètre (côté serveur)
   et est transmis à chaque appel /api/inventaire/*.

   Usage dans la page :
     SF.Inventaire({ kind: 'pc'|'composant', active: '/inventaire.html', roles: ['admin', ...] });
   ============================================================ */
(function () {
'use strict';

const STATUS_LABEL = {
    stock: 'Stock dépôt', preparation: 'En préparation', presentoir: 'Présentoir',
    reserve: 'Réservé', consignation: 'Consignation (boutique)', vendu: 'Vendu',
    garantie_fournisseur: 'Garantie fournisseur', garantie_exceptionnel: 'Garantie exceptionnelle',
    garantie_a_renvoyer: 'Garantie — à renvoyer', retour_fournisseur: 'Retour fournisseur',
    garantie_retournee: 'Garantie revenue', usage_magasin: 'Usage magasin', retire: 'Retiré'
};
const sLabel = s => STATUS_LABEL[s] || s || '—';

// Ventilation par emplacement (récap). Boutique = présentoir + consignation ;
// Stock dépôt = stock + préparation ; puis Réservé et Garantie exceptionnelle.
const BUCKETS = [
    { key: 'stock',        label: 'Stock dépôt',             statuses: ['stock', 'preparation'] },
    { key: 'boutique',     label: 'Boutique',                statuses: ['presentoir', 'consignation'] },
    { key: 'reserve',      label: 'Réservé',                 statuses: ['reserve'] },
    { key: 'garantie_exc', label: 'Garantie exceptionnelle', statuses: ['garantie_exceptionnel'] }
];
const bucketOf = status => (BUCKETS.find(b => b.statuses.includes(status)) || {}).key || 'autre';

// Zone physique d'un statut (scan en 2 étapes). Boutique = présentoir + consignation ;
// Dépôt = stock, préparation, réservé, garantie exceptionnelle.
const ZONE_OF = {
    presentoir: 'boutique', consignation: 'boutique',
    stock: 'depot', preparation: 'depot', reserve: 'depot', garantie_exceptionnel: 'depot'
};
const zoneOf = status => ZONE_OF[status] || null;
const zoneLabel = z => z === 'boutique' ? 'Boutique' : z === 'depot' ? 'Dépôt' : '—';

SF.Inventaire = function (config) {
    config = config || {};
    const KIND = config.kind === 'composant' ? 'composant' : 'pc';
    const ROLES = config.roles || ['admin'];
    const ACTIVE = config.active || location.pathname;

    // Chaque appel /api/inventaire/* porte son « kind » (query pour GET, corps sinon).
    const withKind = path => KIND === 'pc' ? path : (path + (path.includes('?') ? '&' : '?') + 'kind=' + KIND);
    const invApi = (path, opts) => {
        opts = Object.assign({}, opts);
        if (opts.body && typeof opts.body === 'object' && !Array.isArray(opts.body)) opts.body = Object.assign({}, opts.body, { kind: KIND });
        return SF.api(withKind(path), opts);
    };

    const Inv = {
        user: null,
        expMap: new Map(),      // norm série -> unité attendue
        knownMap: new Map(),    // norm série -> unité connue hors périmètre
        scanned: new Map(),     // norm série -> { serial, kind, unit, loc }
        expectedTotal: 0,
        phase: 'boutique',      // étape de scan en cours : 'boutique' puis 'depot'

        async init() {
            this.user = await SF.Auth.require(ROLES);
            if (!this.user) return;
            SF.layout({ active: ACTIVE });
            await this.loadData();
            // Reprise auto d'un inventaire mis en pause (brouillon serveur), avant le temps réel.
            await this.resumeDraft();
            // Temps réel : toute vente / mouvement de stock met à jour les chiffres attendus.
            SF.on('stock:update', () => this.liveRefresh());
            const inp = document.getElementById('scanInput');
            let scanTimer = null, burstStart = 0;
            const submit = () => {
                clearTimeout(scanTimer); scanTimer = null; burstStart = 0;
                const v = inp.value;
                inp.value = '';
                if (v.trim()) this.processScan(v);
            };
            // Entrée : scanner avec suffixe Entrée, ou validation manuelle.
            inp.addEventListener('keydown', e => {
                if (e.key === 'Enter') { e.preventDefault(); submit(); }
            });
            // Auto-validation SANS Entrée : UNIQUEMENT si la saisie arrive en rafale (scanner).
            // La saisie MANUELLE (lente) n'est jamais auto-validée → évite d'envoyer une série tronquée.
            inp.addEventListener('input', () => {
                if (!burstStart) burstStart = Date.now();
                clearTimeout(scanTimer);
                scanTimer = setTimeout(() => {
                    const v = inp.value.trim();
                    const perChar = v.length ? (Date.now() - burstStart) / v.length : 999;
                    if (v.length >= 5 && perChar < 55) submit();   // rafale scanner détectée
                }, 220);
            });
            // Scanner physique (HID) actif sur TOUTE la page : indépendant du focus du champ.
            SF.Scanner.init(code => this.processScan(code));
            // Garde le focus sur le champ de scan (sauf si une modale est ouverte).
            document.addEventListener('click', () => {
                if (document.getElementById('scanPhase').style.display !== 'none'
                    && !document.querySelector('.modal-overlay.active')) inp.focus();
            });
        },

        // Remplit les index (attendus / connus) à partir des données serveur — partagé loadData/liveRefresh.
        _applyData(d) {
            this.expMap.clear(); this.knownMap.clear();
            (d.expected || []).forEach(u => this.expMap.set(this.norm(u.serial), u));
            (d.known || []).forEach(u => this.knownMap.set(this.norm(u.serial), u));
            this.expectedTotal = (d.expected || []).length;
            document.getElementById('kExp').textContent = SF.fmt.int(this.expectedTotal);
        },

        async loadData() {
            try {
                const d = await invApi('/api/inventaire/data');
                this._applyData(d);
                document.getElementById('loadInfo').textContent = `${SF.fmt.int(this.expectedTotal)} unité(s) attendue(s) sur place`;
                const inp = document.getElementById('scanInput');
                inp.disabled = false; inp.focus();
                // Bouton caméra : visible seulement si le scan par caméra est supporté (Android Chrome…).
                const camBtn = document.getElementById('camScanBtn');
                if (camBtn) { if (SF.CamScan && SF.CamScan.supported()) camBtn.disabled = false; else camBtn.style.display = 'none'; }
                document.getElementById('lastResult').textContent = 'Prêt. Scannez — la validation est automatique (aucune touche Entrée requise).';
                this.renderPhase();
                this.updateKpis();
            } catch (e) { SF.toast(e.message, 'error'); document.getElementById('lastResult').textContent = 'Erreur de chargement.'; }
        },

        // ── Scan en 2 étapes : Boutique puis Dépôt (détection des mauvais emplacements). ──
        renderPhase() {
            const p = this.phase;
            const banner = document.getElementById('phaseBanner');
            if (banner) {
                banner.className = 'phase-banner ' + p;
                banner.innerHTML = p === 'boutique'
                    ? '<i class="fas fa-store"></i> Scan BOUTIQUE — présentoir + consignation <span class="step">Étape 1 / 2</span>'
                    : '<i class="fas fa-warehouse"></i> Scan DÉPÔT — stock, préparation, réservé, garantie <span class="step">Étape 2 / 2</span>';
            }
            const next = document.getElementById('nextPhaseBtn');
            const prev = document.getElementById('prevPhaseBtn');
            const fin = document.getElementById('finishBtn');
            if (next) next.style.display = p === 'boutique' ? '' : 'none';
            if (prev) prev.style.display = p === 'depot' ? '' : 'none';
            if (fin) fin.style.display = p === 'depot' ? '' : 'none';
            const inp = document.getElementById('scanInput');
            if (inp) inp.placeholder = p === 'boutique'
                ? 'Scannez les articles EN BOUTIQUE…'
                : 'Scannez les articles AU DÉPÔT (+ réservé, garantie)…';
        },

        async nextPhase() {
            if (!await SF.confirm('Terminer le scan de la BOUTIQUE et passer au scan du DÉPÔT ? (Vous pourrez revenir en arrière — aucun scan n\'est perdu.)', { okLabel: 'Passer au dépôt' })) return;
            this.phase = 'depot';
            this.renderPhase();
            this.saveDraft();
            document.getElementById('lastResult').innerHTML = '<span class="ibadge ok">ÉTAPE 2 — DÉPÔT</span> Un article enregistré en boutique mais scanné ici sera signalé « à envoyer en boutique ».';
            document.getElementById('scanInput').focus();
        },

        prevPhase() {
            this.phase = 'boutique';
            this.renderPhase();
            this.saveDraft();
            document.getElementById('lastResult').innerHTML = '<span class="ibadge ok">ÉTAPE 1 — BOUTIQUE</span> Retour au scan boutique.';
            document.getElementById('scanInput').focus();
        },

        // Rechargement temps réel (SSE stock:update) : met à jour les attendus SANS perdre les scans en cours.
        _liveTimer: null,
        liveRefresh() {
            clearTimeout(this._liveTimer);
            this._liveTimer = setTimeout(async () => {
                if (document.getElementById('scanPhase').style.display === 'none') return;   // pas en phase rapport
                try {
                    const d = await invApi('/api/inventaire/data');
                    this._applyData(d);
                    document.getElementById('loadInfo').textContent = `${SF.fmt.int(this.expectedTotal)} unité(s) attendue(s) · mis à jour à ${new Date().toLocaleTimeString('fr-FR')}`;
                    this.updateKpis();
                } catch (e) { /* silencieux : l'inventaire reste utilisable */ }
            }, 400);
        },

        norm(s) { return String(s || '').trim().toUpperCase(); },

        // fromCam : le scan vient de la caméra (qui émet déjà son propre bip) → on n'en rajoute pas.
        // opts.silent  : pas de bip / message (utilisé pour rejouer un brouillon repris).
        // opts.noSave  : ne déclenche pas l'autosave du brouillon (rejeu en masse).
        // opts.deferKpi: ne recalcule pas les KPI (l'appelant le fera une seule fois à la fin).
        processScan(raw, fromCam, opts = {}) {
            const silent = !!opts.silent;
            const n = this.norm(raw);
            if (!n) return;
            const res = document.getElementById('lastResult');
            if (this.scanned.has(n)) {
                if (!silent) {
                    if (!fromCam) this.beep('dup');
                    this.flash(res, `<span class="ibadge dup">DÉJÀ SCANNÉ</span> ${SF.esc(n)}`);
                    this.pushFeed(n, this.scanned.get(n).unit, 'dup');
                }
                return;
            }
            // Code inconnu (absent de la base) : IGNORÉ — non enregistré, non compté. Notice brève seulement.
            if (!this.expMap.has(n) && !this.knownMap.has(n)) {
                if (!silent) {
                    if (!fromCam) this.beep('error');
                    this.flash(res, `<span class="ibadge unk">INCONNU — ignoré</span> ${SF.esc(n)} (absent de la base)`);
                }
                return;
            }
            let kind, unit;
            if (this.expMap.has(n)) { kind = 'present'; unit = this.expMap.get(n); }
            else { kind = 'surplus_known'; unit = this.knownMap.get(n); }
            const loc = opts.loc || this.phase;   // emplacement physique du scan (étape en cours)
            this.scanned.set(n, { serial: raw.trim(), kind, unit, loc });
            // Mauvais emplacement : présent mais zone enregistrée ≠ zone physique du scan.
            const zone = kind === 'present' ? zoneOf(unit.status) : null;
            const misplaced = !!(zone && zone !== loc);
            this.pushFeed(n, unit, kind, misplaced);
            if (!silent) {
                if (misplaced) {
                    if (!fromCam) this.beep('warn');
                    const msg = loc === 'boutique'
                        ? `<span class="ibadge loc">⚠ EMPLACEMENT</span> ${SF.esc(unit.product_name || '')} — en boutique, mais base = ${sLabel(unit.status)} (dépôt)`
                        : `<span class="ibadge loc">⚠ À ENVOYER BOUTIQUE</span> ${SF.esc(unit.product_name || '')} — au dépôt, mais base = ${sLabel(unit.status)} (boutique)`;
                    this.flash(res, msg);
                } else if (kind === 'present') { if (!fromCam) this.beep('ok'); this.flash(res, `<span class="ibadge ok">PRÉSENT ✓</span> ${SF.esc(unit.product_name || '')} · ${sLabel(unit.status)}`); }
                else { if (!fromCam) this.beep('warn'); this.flash(res, `<span class="ibadge sur">SURPLUS</span> ${SF.esc(unit.product_name || '')} — statut base : ${sLabel(unit.status)}`); }
            }
            if (!opts.noSave) this.saveDraft();
            if (!opts.deferKpi) this.updateKpis();
        },

        // ── Brouillon (pause / reprendre) : autosave côté serveur, débruité (débounce). ──
        _saveTimer: null,
        saveDraft() {
            clearTimeout(this._saveTimer);
            this._saveTimer = setTimeout(() => this._flushDraft(), 1200);
        },
        async _flushDraft() {
            clearTimeout(this._saveTimer); this._saveTimer = null;
            const items = [...this.scanned.values()].map(x => ({ serial: x.serial, loc: x.loc || null }));
            try { await invApi('/api/inventaire/draft', { method: 'PUT', body: { items, phase: this.phase } }); }
            catch (e) { /* silencieux : l'inventaire local reste utilisable */ }
        },

        // Reprend un inventaire mis en pause (brouillon serveur) — rejoue les scans (avec emplacement), sans bip.
        async resumeDraft() {
            let draft;
            try { draft = await invApi('/api/inventaire/draft'); } catch (e) { return; }
            if (!draft || !draft.exists) return;
            if (draft.phase) this.phase = draft.phase;
            const items = Array.isArray(draft.items) ? draft.items : [];
            items.forEach(it => this.processScan(it.serial, false, { silent: true, noSave: true, deferKpi: true, loc: it.loc }));
            this.renderPhase();
            this.updateKpis();
            if (!items.length) return;
            const when = draft.updated_at ? SF.fmt.datetime(draft.updated_at) : '';
            document.getElementById('lastResult').innerHTML =
                `<span class="ibadge ok">REPRIS</span> ${this.scanned.size} scan(s) restauré(s) · étape ${this.phase === 'depot' ? 'DÉPÔT' : 'BOUTIQUE'}${when ? ' · ' + when : ''}. Continuez.`;
            SF.toast(`Inventaire repris — ${this.scanned.size} scan(s) restauré(s)`, 'success');
        },

        // Met explicitement en pause (flush immédiat du brouillon) — réassurance pour l'utilisateur.
        async pause() {
            if (!this.scanned.size) { SF.toast('Aucun scan à mettre en pause pour le moment.', 'info'); return; }
            const btn = document.getElementById('pauseBtn');
            if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Enregistrement…'; }
            try {
                await this._flushDraft();
                SF.toast(`Inventaire mis en pause — ${this.scanned.size} scan(s) enregistrés. Reprenez quand vous voulez.`, 'success', 4500);
            } catch (e) { SF.toast(e.message, 'error'); }
            finally { if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-pause"></i> Mettre en pause'; } }
        },

        // Retour sonore + haptique par scan (lecteur physique / saisie). ok=présent, warn=surplus,
        // dup=déjà scanné, error=inconnu. La caméra a déjà son propre bip.
        beep(kind) {
            try {
                const ac = this._ac || (this._ac = new (window.AudioContext || window.webkitAudioContext)());
                const o = ac.createOscillator(), g = ac.createGain();
                o.frequency.value = { ok: 880, warn: 620, dup: 440, error: 220 }[kind] || 700;
                o.type = kind === 'error' ? 'sawtooth' : 'square';
                o.connect(g); g.connect(ac.destination);
                g.gain.value = 0.06; o.start(); o.stop(ac.currentTime + (kind === 'error' ? 0.22 : 0.08));
            } catch (e) {}
            if (navigator.vibrate) { try { navigator.vibrate(kind === 'error' ? [50, 40, 50] : 35); } catch (e) {} }
        },

        flash(el, html) { el.innerHTML = html; },

        pushFeed(n, unit, kind, misplaced) {
            const feed = document.getElementById('feed');
            if (feed.dataset.empty !== '0') { feed.innerHTML = ''; feed.dataset.empty = '0'; }
            const badge = misplaced ? '<span class="ibadge loc">EMPLACEMENT</span>'
                        : kind === 'present' ? '<span class="ibadge ok">PRÉSENT</span>'
                        : kind === 'surplus_known' ? '<span class="ibadge sur">SURPLUS</span>'
                        : '<span class="ibadge dup">DOUBLON</span>';
            const name = unit ? SF.esc([unit.product_name, unit.brand, unit.model].filter(Boolean).join(' ')) : '—';
            const row = document.createElement('div');
            row.className = 'feed-row';
            row.innerHTML = `<span class="sn">${SF.esc(n)}</span><span class="nm">${name}${kind === 'surplus_known' && unit ? ' · ' + sLabel(unit.status) : ''}</span>${badge}`;
            feed.insertBefore(row, feed.firstChild);
            // Plafonne l'affichage aux 80 derniers scans (le comptage réel reste complet).
            while (feed.childElementCount > 80) feed.removeChild(feed.lastElementChild);
        },

        counts() {
            let pre = 0, sur = 0, mis = 0;
            for (const s of this.scanned.values()) {
                if (s.kind === 'present') {
                    pre++;
                    const z = zoneOf(s.unit && s.unit.status);
                    if (s.loc && z && z !== s.loc) mis++;
                }
                else if (s.kind === 'surplus_known' || s.kind === 'surplus_unknown') sur++;
            }
            return { pre, sur, mis, man: Math.max(0, this.expectedTotal - pre) };
        },

        updateKpis() {
            const c = this.counts();
            document.getElementById('kPre').textContent = SF.fmt.int(c.pre);
            document.getElementById('kSur').textContent = SF.fmt.int(c.sur);
            document.getElementById('kMan').textContent = SF.fmt.int(c.man);
            const kMis = document.getElementById('kMis'); if (kMis) kMis.textContent = SF.fmt.int(c.mis);
            const pct = this.expectedTotal ? Math.min(100, Math.round(c.pre / this.expectedTotal * 100)) : 0;
            document.getElementById('progBar').style.width = pct + '%';
            document.getElementById('finishBtn').disabled = this.scanned.size === 0;
            this.renderEmpRecap();
        },

        // Ventilation temps réel : attendus / présents / manquants par emplacement.
        renderEmpRecap() {
            const exp = {}, pre = {};
            BUCKETS.forEach(b => { exp[b.key] = 0; pre[b.key] = 0; });
            for (const u of this.expMap.values()) { const k = bucketOf(u.status); if (exp[k] != null) exp[k]++; }
            for (const s of this.scanned.values()) {
                if (s.kind === 'present' && s.unit) { const k = bucketOf(s.unit.status); if (pre[k] != null) pre[k]++; }
            }
            const tb = document.querySelector('#empRecapTable tbody');
            if (!tb) return;
            tb.innerHTML = BUCKETS.map(b => {
                const e = exp[b.key], p = pre[b.key], m = Math.max(0, e - p);
                return `<tr>
                    <td>${b.label}</td>
                    <td>${SF.fmt.int(e)}</td>
                    <td style="font-weight:700;color:var(--success-dark);">${SF.fmt.int(p)}</td>
                    <td>${m ? `<span style="color:#dc2626;font-weight:700;">${SF.fmt.int(m)}</span>` : '0'}</td>
                </tr>`;
            }).join('');
        },

        async reset() {
            if (this.scanned.size && !await SF.confirm('Vider tous les scans en cours ? Le brouillon mis en pause sera lui aussi supprimé (nouvel inventaire à zéro).', { okLabel: 'Vider', danger: true })) return;
            this.scanned.clear();
            this.phase = 'boutique';
            clearTimeout(this._saveTimer); this._saveTimer = null;
            try { await invApi('/api/inventaire/draft', { method: 'DELETE' }); } catch (e) { /* silencieux */ }
            const feed = document.getElementById('feed');
            feed.innerHTML = '<div class="feed-row"><span class="nm">Aucun scan pour le moment.</span></div>';
            feed.dataset.empty = '1';
            document.getElementById('lastResult').textContent = 'Réinitialisé. Scannez un numéro de série.';
            this.renderPhase();
            this.updateKpis();
            document.getElementById('scanInput').focus();
        },

        async finish() {
            if (!this.scanned.size) return;
            // Annule un autosave en attente : le serveur supprime le brouillon à la clôture,
            // un PUT tardif le recréerait à tort.
            clearTimeout(this._saveTimer); this._saveTimer = null;
            const scanned = [...this.scanned.values()].map(x => ({ serial: x.serial, loc: x.loc || null }));
            const btn = document.getElementById('finishBtn');
            btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Calcul…';
            try {
                const rep = await invApi('/api/inventaire/finish', { method: 'POST', body: { scanned } });
                this.renderReport(rep, false);
                SF.toast('Inventaire enregistré', 'success');
            } catch (e) { SF.toast(e.message, 'error'); }
            finally { btn.disabled = false; btn.innerHTML = '<i class="fas fa-clipboard-check"></i> Terminer l\'inventaire'; }
        },

        // ── Rapport ──
        renderReport(rep, readonly) {
            document.getElementById('scanPhase').style.display = 'none';
            const box = document.getElementById('reportPhase');
            box.style.display = '';
            const missing = rep.missing || [], surplus = rep.surplus || [], present = rep.present || [], misplaced = rep.misplaced || [];
            const dateStr = SF.fmt.datetime(rep.created_at);
            // Ventilation des présents par emplacement.
            const presCount = {}; BUCKETS.forEach(b => presCount[b.key] = 0);
            present.forEach(u => { const k = bucketOf(u.status); if (presCount[k] != null) presCount[k]++; });

            box.innerHTML = `
                <div class="toolbar no-print">
                    <button class="btn btn-secondary" onclick="Inv.backToScan()"><i class="fas fa-arrow-left"></i> ${readonly ? 'Retour' : 'Nouvel inventaire'}</button>
                    <button class="btn btn-secondary" onclick="Inv.openHistory()"><i class="fas fa-clock-rotate-left"></i> Historique</button>
                    <button class="btn btn-secondary" onclick="window.print()"><i class="fas fa-print"></i> Imprimer</button>
                    <span class="muted" style="margin-left:auto;">${readonly ? 'Inventaire n°' + rep.id + ' · ' : ''}${dateStr}${rep.admin_name ? ' · ' + SF.esc(rep.admin_name) : ''}</span>
                </div>
                <div class="inv-kpis">
                    <div class="inv-kpi exp"><h4>Attendus</h4><div class="v">${SF.fmt.int(rep.expected_count)}</div></div>
                    <div class="inv-kpi pre"><h4>Présents</h4><div class="v">${SF.fmt.int(present.length)}</div></div>
                    <div class="inv-kpi man"><h4>Manquants</h4><div class="v">${SF.fmt.int(missing.length)}</div></div>
                    <div class="inv-kpi sur"><h4>Surplus</h4><div class="v">${SF.fmt.int(surplus.length)}</div></div>
                    <div class="inv-kpi mis"><h4>Mauvais emplacement</h4><div class="v">${SF.fmt.int(misplaced.length)}</div></div>
                </div>

                <div class="inv-sec">
                    <div class="inv-sec-h man"><i class="fas fa-triangle-exclamation"></i> Manquants — attendus mais non scannés <span class="cnt">${missing.length}</span></div>
                    ${!readonly && missing.length ? '<div class="muted" style="padding:2px 4px 8px;">Une unité attendue mais non scannée est probablement déjà vendue (non enregistrée). Utilisez « Retirer » pour l\'ôter du stock (récupérable).</div>' : ''}
                    ${missing.length ? `<div class="inv-wrap"><table class="inv-table">
                        <thead><tr><th>Produit</th><th>N° série</th><th>Statut base</th><th>Dernier emplacement</th><th>Responsable</th><th>Date</th>${readonly ? '' : '<th>Action</th>'}</tr></thead>
                        <tbody>${missing.map((u, i) => `<tr id="missrow-${i}">
                            <td>${SF.esc([u.product_name, u.brand, u.model].filter(Boolean).join(' ') || u.product_name || '')}</td>
                            <td class="sn">${SF.esc(u.serial)}</td>
                            <td>${sLabel(u.status)}</td>
                            <td>${sLabel(u.last_status || u.status)}${u.location ? ' · ' + SF.esc(u.location) : ''}</td>
                            <td>${SF.esc(u.holder_full || u.holder_username || u.last_by || '—')}</td>
                            <td class="muted">${u.last_at ? SF.fmt.datetime(u.last_at) : '—'}</td>
                            ${readonly ? '' : `<td>${this.missingActions(u, i)}</td>`}
                        </tr>`).join('')}</tbody></table></div>`
                        : '<div class="muted" style="padding:10px 4px;">Aucun manquant. 🎉</div>'}
                </div>

                <div class="inv-sec">
                    <div class="inv-sec-h sur"><i class="fas fa-plus"></i> Surplus — scannés mais hors stock attendu <span class="cnt">${surplus.length}</span></div>
                    ${surplus.length ? `<div class="inv-wrap"><table class="inv-table">
                        <thead><tr><th>N° série</th><th>Produit</th><th>Type</th><th>Statut base</th>${readonly ? '' : '<th>Action</th>'}</tr></thead>
                        <tbody>${surplus.map((u, i) => `<tr id="surrow-${i}">
                            <td class="sn">${SF.esc(u.serial)}</td>
                            <td>${u.product_name ? SF.esc([u.product_name, u.brand, u.model].filter(Boolean).join(' ')) : '<em class="muted">Non répertorié</em>'}</td>
                            <td>${u.kind === 'unknown' ? '<span class="ibadge unk">Inconnu</span>' : '<span class="ibadge sur">Statut ≠ stock</span>'}</td>
                            <td>${u.status ? sLabel(u.status) : '—'}</td>
                            ${readonly ? '' : `<td>${this.surplusActions(u, i)}</td>`}
                        </tr>`).join('')}</tbody></table></div>`
                        : '<div class="muted" style="padding:10px 4px;">Aucun surplus.</div>'}
                </div>

                <div class="inv-sec">
                    <div class="inv-sec-h loc"><i class="fas fa-location-crosshairs"></i> Mauvais emplacement — trouvés ailleurs que dans la base <span class="cnt">${misplaced.length}</span></div>
                    ${misplaced.length ? `<div class="muted" style="padding:2px 4px 8px;">Correction manuelle : déplacez physiquement l'article, puis mettez à jour son emplacement via son opération habituelle (aucun changement automatique ici).</div>
                        <div class="inv-wrap"><table class="inv-table">
                        <thead><tr><th>Produit</th><th>N° série</th><th>Trouvé (scan)</th><th>Enregistré (base)</th><th>À faire</th></tr></thead>
                        <tbody>${misplaced.map(u => `<tr>
                            <td>${SF.esc([u.product_name, u.brand, u.model].filter(Boolean).join(' ') || u.product_name || '')}</td>
                            <td class="sn">${SF.esc(u.serial)}</td>
                            <td>${u.scan_loc === 'boutique' ? '🏬 Boutique' : '🏭 Dépôt'}</td>
                            <td>${sLabel(u.status)} <span class="muted">(${zoneLabel(u.recorded_zone)})</span></td>
                            <td>${u.scan_loc === 'depot' && u.recorded_zone === 'boutique'
                                ? '<span class="ibadge loc">À envoyer en boutique</span>'
                                : '<span class="muted">Mettre à jour l\'emplacement (base = dépôt)</span>'}</td>
                        </tr>`).join('')}</tbody></table></div>`
                        : '<div class="muted" style="padding:10px 4px;">Aucun mauvais emplacement. 👍</div>'}
                </div>

                <div class="inv-sec">
                    <div class="inv-sec-h pre"><i class="fas fa-check"></i> Présents <span class="cnt">${present.length}</span></div>
                    <div class="inv-wrap"><table class="inv-table">
                        <thead><tr><th>Emplacement</th><th>Présents</th></tr></thead>
                        <tbody>${BUCKETS.map(b => `<tr><td>${b.label}</td><td style="font-weight:700;color:var(--success-dark);">${SF.fmt.int(presCount[b.key])}</td></tr>`).join('')}</tbody>
                    </table></div>
                    <div class="muted" style="padding:6px 4px;">${present.length} unité(s) attendue(s) et retrouvée(s).</div>
                </div>`;
            window.scrollTo(0, 0);
        },

        surplusActions(u, i) {
            if (!u.unit_id) {
                return `<button class="btn btn-sm btn-secondary" onclick="Inv.dismissSurplus(${i})"><i class="fas fa-xmark"></i> Retirer de la liste</button>`;
            }
            return `<button class="btn btn-sm btn-success" onclick="Inv.resolve(${u.unit_id}, 'restock', 'surrow-${i}')"><i class="fas fa-rotate-left"></i> Remettre en stock</button>
                    <button class="btn btn-sm btn-danger" onclick="Inv.resolve(${u.unit_id}, 'retire', 'surrow-${i}')"><i class="fas fa-box-archive"></i> Retirer du stock</button>`;
        },

        // Action sur un MANQUANT (attendu mais non scanné) : le retirer du stock car probablement vendu.
        missingActions(u, i) {
            if (!u.unit_id) return '<span class="muted">—</span>';
            return `<button class="btn btn-sm btn-danger" onclick="Inv.resolve(${u.unit_id}, 'retire', 'missrow-${i}', 'manquant')" title="Ôter du stock (probablement vendu non enregistré)"><i class="fas fa-box-archive"></i> Retirer (vendu ?)</button>`;
        },

        dismissSurplus(i) {
            const row = document.getElementById('surrow-' + i);
            if (row) row.remove();
        },

        // rowId : id de la ligne à mettre à jour ('surrow-N' ou 'missrow-N').
        // reason : 'manquant' adapte le message et la note serveur ; sinon écart de comptage (surplus).
        async resolve(unit_id, action, rowId, reason) {
            if (action === 'retire') {
                const msg = reason === 'manquant'
                    ? 'Retirer cette unité du stock ? Attendue mais non scannée — probablement déjà vendue (non enregistrée). Elle passera en « Retiré » (hors stock et inventaire), récupérable.'
                    : 'Retirer cette unité du stock ? Elle passera en « Retiré » (hors stock et inventaire) — la ligne et l\'historique restent conservés (récupérable).';
                if (!await SF.confirm(msg, { danger: true, okLabel: 'Retirer' })) return;
            }
            try {
                await invApi('/api/inventaire/resolve', { method: 'POST', body: { unit_id, action, reason } });
                const row = rowId ? document.getElementById(rowId) : null;
                if (row) {
                    const cell = row.querySelector('td:last-child');
                    if (cell) cell.innerHTML = action === 'restock'
                        ? '<span class="ibadge ok">Remis en stock ✓</span>'
                        : '<span class="ibadge dup">Retiré ✓</span>';
                }
                SF.toast(action === 'restock' ? 'Unité remise en stock' : 'Unité retirée du stock', 'success');
            } catch (e) { SF.toast(e.message, 'error'); }
        },

        backToScan() {
            document.getElementById('reportPhase').style.display = 'none';
            document.getElementById('scanPhase').style.display = '';
            this.scanned.clear();
            this.phase = 'boutique';
            const feed = document.getElementById('feed');
            feed.innerHTML = '<div class="feed-row"><span class="nm">Aucun scan pour le moment.</span></div>';
            feed.dataset.empty = '1';
            this.renderPhase();
            this.loadData();   // recharge (le stock a pu changer via resolve)
        },

        // ── Historique ──
        async openHistory() {
            SF.Modal.open('invHistModal');
            const box = document.getElementById('histList');
            box.innerHTML = '<div class="muted" style="padding:14px;">Chargement…</div>';
            try {
                const rows = await invApi('/api/inventaire/history');
                if (!rows.length) { box.innerHTML = '<div class="muted" style="padding:14px;">Aucun inventaire enregistré.</div>'; return; }
                box.innerHTML = rows.map(r => `<div class="hist-row" onclick="Inv.viewHistory(${r.id})">
                    <div style="flex:1;">
                        <div style="font-weight:700;">${SF.fmt.datetime(r.created_at)}</div>
                        <div class="muted" style="font-size:12px;">${SF.esc(r.admin_name || '')} · ${r.scanned_count} scannés / ${r.expected_count} attendus</div>
                    </div>
                    <div style="text-align:right; font-size:12px;">
                        <span style="color:#dc2626; font-weight:700;">${r.missing_count} manq.</span> ·
                        <span style="color:var(--warning-dark); font-weight:700;">${r.surplus_count} surpl.</span>
                    </div>
                    <i class="fas fa-chevron-right muted"></i>
                </div>`).join('');
            } catch (e) { box.innerHTML = `<div class="muted" style="padding:14px;">${SF.esc(e.message)}</div>`; }
        },

        async viewHistory(id) {
            try {
                const s = await invApi('/api/inventaire/history/' + id);
                SF.Modal.close('invHistModal');
                const d = s.data || {};
                this.renderReport({
                    id: s.id, created_at: s.created_at, admin_name: s.admin_name,
                    expected_count: s.expected_count, present: d.present || [], missing: d.missing || [], surplus: d.surplus || [], misplaced: d.misplaced || []
                }, true);
            } catch (e) { SF.toast(e.message, 'error'); }
        },

        // ── Unités retirées : recherche + restaurer un retrait accidentel (remet en stock via /resolve restock). ──
        retiredRows: [],
        async openRetired() {
            SF.Modal.open('invRetiredModal');
            const box = document.getElementById('retiredList');
            box.innerHTML = '<div class="muted" style="padding:14px;">Chargement…</div>';
            try {
                this.retiredRows = await invApi('/api/inventaire/retired');
                if (!this.retiredRows.length) { box.innerHTML = '<div class="muted" style="padding:14px;">Aucune unité retirée. 👍</div>'; return; }
                // Champ de recherche PERSISTANT (hors zone re-rendue → ne perd pas le focus).
                box.innerHTML = `
                    <div style="margin-bottom:10px;">
                        <input type="text" id="retSearch" class="form-control" autocomplete="off" spellcheck="false"
                               placeholder="Rechercher : n° série, produit, config (i5, 8G, 256 SSD…), motif…" oninput="Inv.filterRetired(this.value)">
                    </div>
                    <div id="retiredResults"></div>`;
                this.filterRetired('');
                const inp = document.getElementById('retSearch'); if (inp) inp.focus();
            } catch (e) { box.innerHTML = `<div class="muted" style="padding:14px;">${SF.esc(e.message)}</div>`; }
        },

        // Configuration lisible d'une unité (pour affichage + recherche).
        _retCfg(u) {
            return [u.cpu, u.ram, u.storage ? (u.storage + (u.storage_type ? ' ' + u.storage_type : '')) : '', u.gpu, u.screen_size].filter(Boolean).join(' · ');
        },

        // Filtre client (n° série, produit, marque/modèle, catégorie, config, motif, auteur).
        filterRetired(q) {
            const box = document.getElementById('retiredResults'); if (!box) return;
            const rows = this.retiredRows || [];
            const nq = this.norm(q || '');
            const filtered = !nq ? rows : rows.filter(u =>
                this.norm([u.serial, u.product_name, u.brand, u.model, u.category, u.condition, this._retCfg(u), u.note, u.retired_by].join(' ')).includes(nq));
            box.innerHTML = `<div class="muted" style="font-size:11.5px;margin-bottom:8px;">${filtered.length} / ${rows.length} unité(s) retirée(s)${nq ? ' · filtre appliqué' : ''}</div>
                ${filtered.length ? `<div class="inv-wrap"><table class="inv-table">
                    <thead><tr><th>Produit / configuration</th><th>N° série</th><th>Retiré le</th><th>Motif</th><th>Action</th></tr></thead>
                    <tbody>${filtered.map(u => `<tr id="retrow-${u.unit_id}">
                        <td>${SF.esc([u.product_name, u.brand, u.model].filter(Boolean).join(' ') || u.product_name || '')}${this._retCfg(u) ? `<div class="muted" style="font-size:11.5px;">${SF.esc(this._retCfg(u))}</div>` : ''}</td>
                        <td class="sn">${SF.esc(u.serial)}</td>
                        <td class="muted">${u.retired_at ? SF.fmt.datetime(u.retired_at) : (u.updated_at ? SF.fmt.datetime(u.updated_at) : '—')}</td>
                        <td class="muted" style="font-size:12px;">${SF.esc(u.note || '—')}</td>
                        <td>${u.active_sale
                            ? '<span class="ibadge unk" title="Liée à une vente non retournée — annulez la vente d\'abord">Vente active</span>'
                            : `<button class="btn btn-sm btn-success" onclick="Inv.restoreRetired(${u.unit_id}, '${SF.esc(u.serial)}')"><i class="fas fa-rotate-left"></i> Restaurer</button>`}</td>
                    </tr>`).join('')}</tbody></table></div>`
                    : '<div class="muted" style="padding:14px;">Aucun résultat pour ce filtre.</div>'}`;
        },

        async restoreRetired(unit_id, serial) {
            if (!await SF.confirm(`Restaurer l'unité « ${serial} » au stock ? Elle repassera en « disponible » (dépôt).`, { okLabel: 'Restaurer' })) return;
            try {
                await invApi('/api/inventaire/resolve', { method: 'POST', body: { unit_id, action: 'restock' } });
                this.retiredRows = (this.retiredRows || []).filter(u => u.unit_id !== unit_id);   // retire de la liste filtrable
                const row = document.getElementById('retrow-' + unit_id);
                if (row) { const cell = row.querySelector('td:last-child'); if (cell) cell.innerHTML = '<span class="ibadge ok">Restaurée ✓</span>'; }
                SF.toast(`Unité ${serial} restaurée au stock`, 'success');
            } catch (e) { SF.toast(e.message, 'error'); }
        }
    };

    window.Inv = Inv;   // exposé pour les onclick="Inv.…" du HTML
    Inv.init();
    return Inv;
};

})();
