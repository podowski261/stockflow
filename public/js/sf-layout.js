/* ============================================================
   STOCKFLOW — Construction de l'ossature (barre latérale + topbar).
   Le menu est défini une seule fois ici, filtré par rôle et par
   phase de développement. Chaque page appelle :
       const user = await SF.Auth.require([...roles]);
       SF.layout({ active: '/users.html' });
   ============================================================ */
(function () {
'use strict';

// Phase maximale déployée : les entrées de menu au-delà sont masquées.
// (Incrémentée à chaque phase livrée.)
const MAX_PHASE = 6;

// Ordre : chaque section a un titre et des entrées. Une entrée peut regrouper plusieurs pages
// liées (`tabs`) : une seule ligne dans le menu, des onglets en tête de page.
// role : rôles voyant l'entrée / l'onglet (l'admin voit tout). short : libellé de la barre basse.
const MENU = [
    { title: 'Principal', items: [
        { label: 'Tableau de bord', short: 'Accueil', icon: 'fa-gauge-high', tabs: [
            { label: "Vue d'ensemble", title: 'Tableau de bord', href: '/index.html', phase: 0, role: '*' },
            { label: 'Supervision', href: '/supervision.html', phase: 6, role: [] },
            { label: 'Profits', href: '/profits.html', phase: 6, role: [], fullCA: true },
        ]},
    ]},
    { title: 'Stock', items: [
        { label: 'Stock dépôt', short: 'Stock', icon: 'fa-boxes-stacked', href: '/stock.html', phase: 2, role: ['gestion_stock', 'commercial'] },
        { label: 'Batteries', icon: 'fa-car-battery', href: '/batteries.html', phase: 2, role: '*', exclude: ['securite'] },
        { label: 'Approvisionnement', short: 'Réception', icon: 'fa-truck-ramp-box', tabs: [
            { label: 'Réception', href: '/reception.html', phase: 1, role: ['gestion_stock'] },
            { label: 'Bons de commande', short: 'Bons cde', href: '/commandes-fournisseurs.html', phase: 1, role: ['gestion_stock'], special: 'commande_responsible' },
            { label: 'Réassort', title: 'Réapprovisionnement', href: '/appro.html', phase: 1, role: ['gestion_stock'] },
        ]},
        { label: 'Mouvements', icon: 'fa-arrow-right-arrow-left', tabs: [
            { label: 'Retours à valider', href: '/retour.html', phase: 2, role: ['gestion_stock'] },
            { label: 'Entrées & sorties', title: 'Mouvements de stock', href: '/movements.html', phase: 6, role: ['gestion_stock'] },
            { label: 'Ordinateurs sortis', title: 'Sorties du dépôt', href: '/sorties-depot.html', phase: 3, role: ['gestion_stock'] },
            { label: "Parcours d'un article", href: '/reports.html', phase: 6, role: ['gestion_stock'] },
            { label: 'Corbeille', href: '/corbeille.html', phase: 6, role: ['gestion_stock'] },
        ]},
        { label: 'Suivi commerciaux', short: 'Suivi', icon: 'fa-people-carry-box', tabs: [
            { label: 'Boutique', title: 'Suivi boutique', href: '/suivi-boutique.html', phase: 2, role: ['gestion_stock'] },
            { label: 'En ligne', title: 'Suivi sorties en ligne', href: '/suivi-enligne.html', phase: 2, role: ['gestion_stock'] },
            { label: 'Échanges & défectueux', short: 'Échanges', href: '/echanges.html', phase: 2, role: ['gestion_stock'] },
        ]},
        { label: 'Installation & Préparation', short: 'Atelier', icon: 'fa-screwdriver-wrench', href: '/installation.html', phase: 2, role: ['technicien', 'gestion_stock'] },
        { label: 'Service atelier', short: 'Service atelier', icon: 'fa-laptop-medical', href: '/service-atelier.html', phase: 2, role: [], special: 'atelier_responsible' },
        { label: 'Garantie', icon: 'fa-shield-halved', href: '/garantie.html', phase: 4, role: ['gestion_stock'], special: 'garantie_responsible' },
        { label: 'Inventaire', icon: 'fa-barcode', tabs: [
            { label: 'Ordinateurs', title: 'Inventaire', href: '/inventaire.html', phase: 6, role: ['gestion_stock'] },
            { label: 'Composants', title: 'Inventaire composants', href: '/inventaire-composants.html', phase: 6, role: ['gestion_stock'] },
        ]},
    ]},
    { title: 'Ventes', items: [
        { label: 'Caisse', icon: 'fa-cash-register', tabs: [
            { label: 'Point de vente', short: 'Caisse', href: '/pos.html', phase: 3, role: ['caisse'] },
            { label: 'Proforma', title: 'Facture proforma', href: '/proforma.html', phase: 3, role: ['caisse'] },
        ]},
        { label: 'Ventes', icon: 'fa-receipt', tabs: [
            { label: 'Toutes les ventes', title: 'Ventes', href: '/sales.html', phase: 3, role: ['caisse', 'gestion_stock', 'commercial'] },
            { label: 'Rapport journalier', short: 'Journée', href: '/ventes-journalieres.html', phase: 3, role: ['caisse', 'gestion_stock'] },
            { label: 'Top ventes (semaine)', title: 'Top ventes', short: 'Top', href: '/top-ventes.html', phase: 3, role: [] },
            { label: 'Clients Starlink', short: 'Starlink', href: '/starlink-clients.html', phase: 3, role: [] },
            { label: 'Réseaux sociaux', short: 'Réseaux', href: '/reseaux-sociaux.html', phase: 3, role: [] },
        ]},
        { label: 'Encaissements', short: 'Encaisser', icon: 'fa-hand-holding-dollar', tabs: [
            { label: 'Livraisons à encaisser', title: 'Encaissement en attente', short: 'Encaisser', href: '/encaissement.html', phase: 3, role: ['caisse'] },
            { label: 'Ventes avec avance', title: 'Engagements clients', short: 'Clients', href: '/engagements.html', phase: 3, role: ['caisse', 'commercial', 'commercial_ligne', 'gestion_stock'] },
            { label: 'Atelier (reste à payer)', title: 'Atelier — reste à payer', short: 'Atelier', href: '/atelier-paiements.html', phase: 3, role: ['caisse'] },
        ]},
        { label: 'Trésorerie', icon: 'fa-wallet', href: '/treasury.html', phase: 3, role: ['caisse'] },
        { label: 'Contrôle de sortie', short: 'Sortie', icon: 'fa-door-open', href: '/controle-sortie.html', phase: 3, role: ['securite'] },
        { label: 'Ma boutique', short: 'Boutique', icon: 'fa-store', href: '/consignations.html', phase: 3, role: ['commercial'] },
    ]},
    { title: 'Livraison', items: [
        { label: 'Commande en ligne', short: 'Commandes', icon: 'fa-globe', href: '/online.html', phase: 5, role: ['commercial_ligne'] },
        { label: 'Demandes clients', short: 'Demandes', icon: 'fa-comments', href: '/demandes-clients.html', phase: 5, role: ['commercial_ligne'], special: 'commande_responsible' },
        { label: 'Livraisons', icon: 'fa-boxes-packing', tabs: [
            { label: 'Livraisons', href: '/deliveries.html', phase: 5, role: ['caisse', 'gestion_stock', 'commercial_ligne', 'coordinateur'] },
            { label: 'Coordination', href: '/coordination.html', phase: 5, role: ['coordinateur'] },
            { label: 'Annulations', href: '/annulations.html', phase: 5, role: [] },
        ]},
    ]},
    { title: 'Administration', items: [
        { label: 'Utilisateurs', icon: 'fa-users-gear', tabs: [
            { label: 'Utilisateurs', href: '/users.html', phase: 0, role: [] },
            { label: "Journal d'activité", short: 'Journal', href: '/journal.html', phase: 0, role: [] },
        ]},
        { label: 'Configuration', icon: 'fa-gear', href: '/config.html', phase: 0, role: [] },
    ]},
];

function canSee(item, role, user) {
    if (item.phase > MAX_PHASE) return false;
    if (item.fullCA && !(user && user.full_ca)) return false;   // Profits : accès complet aux chiffres seulement
    // Entrées à visibilité spéciale (utilisateur désigné, indépendamment du rôle).
    if (item.special === 'garantie_responsible' && user && user.garantie_responsible) return true;
    if (item.special === 'commande_responsible' && user && user.commande_responsible) return true;
    if (item.special === 'atelier_responsible' && user && user.atelier_responsible) return true;
    if (role === 'admin') return true;
    if (item.role === '*') return !(item.exclude || []).includes(role);
    // Un compte peut cumuler plusieurs rôles (ex. commercial boutique + en ligne) : l'entrée est
    // visible s'il possède AU MOINS un des rôles autorisés.
    const mine = (user && Array.isArray(user.roles) && user.roles.length) ? user.roles : [role];
    return Array.isArray(item.role) && item.role.some(r => mine.includes(r));
}

function pagesOf(item) { return item.tabs || [item]; }

// Page d'arrivée d'une entrée regroupée : celle que le rôle utilise le plus (raccourcis), sinon la première.
function landingOf(pages, user) {
    for (const href of BNAV_PREF[user.role] || []) {
        const pg = pages.find(p => p.href === href);
        if (pg) return pg;
    }
    return pages[0];
}

// Menu prêt à l'affichage : entrées visibles, avec leurs pages visibles (onglets).
// Une entrée dont une seule page est visible reprend le nom de cette page.
function menuFor(user) {
    return MENU.map(sec => ({
        title: sec.title,
        items: sec.items.map(it => {
            const pages = pagesOf(it).filter(p => canSee(p, user.role, user));
            if (!pages.length) return null;
            const solo = pages.length === 1 ? pages[0] : null;
            return {
                label: solo ? (solo.title || solo.label) : it.label,
                short: solo ? (solo.short || it.short || solo.title || solo.label) : (it.short || it.label),
                icon: it.icon, href: landingOf(pages, user).href,
                pages, hrefs: pages.map(p => p.href)
            };
        }).filter(Boolean)
    })).filter(sec => sec.items.length);
}

function initials(name) {
    const parts = String(name || '').trim().split(/\s+/);
    return ((parts[0] || '')[0] || '') + ((parts[1] || '')[0] || (parts[0] || '')[1] || '');
}

// Avatar : photo de profil si présente, sinon initiales. `extraClass` ajoute une classe.
function avatarMarkup(user, extraClass) {
    const cls = 'user-avatar' + (extraClass ? ' ' + extraClass : '');
    if (user && user.profile_photo)
        return `<div class="${cls} has-photo"><img src="${SF.esc(user.profile_photo)}" alt=""></div>`;
    return `<div class="${cls}">${SF.esc(initials((user && (user.full_name || user.username)) || '').toUpperCase())}</div>`;
}

// Replie/déplie une section du menu et mémorise le choix (localStorage).
SF.toggleNavSection = function (btn) {
    const sec = btn.closest('.nav-section'); if (!sec) return;
    const collapsed = sec.classList.toggle('collapsed');
    btn.setAttribute('aria-expanded', String(!collapsed));
    let map = {};
    try { map = JSON.parse(localStorage.getItem('stockflow-nav-collapsed') || '{}'); } catch (e) {}
    map[sec.dataset.section] = collapsed;
    localStorage.setItem('stockflow-nav-collapsed', JSON.stringify(map));
};

// ============================================================
//  MON PROFIL — fenêtre accessible depuis la topbar et le pied de barre.
//  Chaque utilisateur modifie son nom, téléphone, photo, mot de passe et
//  sa question secrète (utilisée pour récupérer un mot de passe oublié).
// ============================================================
SF.Profile = {
    QUESTIONS: [
        "Nom de votre premier animal de compagnie ?",
        "Ville de naissance de votre mère ?",
        "Nom de votre école primaire ?",
        "Votre plat préféré ?",
        "Surnom d'enfance ?"
    ],
    data: null,
    async open() {
        SF.Modal.open('sfProfileModal');
        const body = document.getElementById('sfProfileBody');
        body.innerHTML = SF.skel.lines(5);
        try { this.data = await SF.api('/api/profile'); this.render(); }
        catch (e) { body.innerHTML = `<div class="text-danger">${SF.esc(e.message)}</div>`; }
    },
    render() {
        const d = this.data || {};
        const roleTxt = (Array.isArray(d.roles) && d.roles.length ? d.roles : [d.role]).map(r => SF.fmt.roleLabel(r)).join(' + ');
        const avatar = d.profile_photo
            ? `<img src="${SF.esc(d.profile_photo)}" alt="" id="sfAvatarPreview">`
            : `<span id="sfAvatarPreview" class="ph">${SF.esc(initials(d.full_name || d.username).toUpperCase())}</span>`;
        const opts = this.QUESTIONS.map(q =>
            `<option value="${SF.esc(q)}"${d.security_question === q ? ' selected' : ''}>${SF.esc(q)}</option>`).join('');
        const customSelected = d.security_question && !this.QUESTIONS.includes(d.security_question);
        document.getElementById('sfProfileBody').innerHTML = `
            <div class="sf-prof-head">
                <div class="sf-prof-avatar">${avatar}</div>
                <div>
                    <div class="sf-prof-name">${SF.esc(d.full_name || d.username)}</div>
                    <div class="sf-prof-sub">@${SF.esc(d.username)} · ${SF.esc(roleTxt)}</div>
                    <label class="btn btn-sm btn-secondary" style="margin-top:8px;cursor:pointer;">
                        <i class="fas fa-camera"></i> Changer la photo
                        <input type="file" accept="image/*" style="display:none;" onchange="SF.Profile.uploadPhoto(this)">
                    </label>
                </div>
            </div>

            <div class="sf-prof-sec">
                <h4><i class="fas fa-id-card"></i> Informations</h4>
                <div class="form-group"><label>Nom complet</label>
                    <input type="text" id="pfName" class="form-control" value="${SF.esc(d.full_name || '')}"></div>
                <div class="form-group"><label>Téléphone</label>
                    <input type="text" id="pfPhone" class="form-control" value="${SF.esc(d.phone || '')}" inputmode="tel"></div>
            </div>

            <div class="sf-prof-sec">
                <h4><i class="fas fa-lock"></i> Mot de passe <span class="sf-prof-opt">(laisser vide pour ne pas changer)</span></h4>
                <div class="form-group"><label>Mot de passe actuel</label>
                    <input type="password" id="pfCur" class="form-control" autocomplete="current-password"></div>
                <div class="form-group"><label>Nouveau mot de passe</label>
                    <input type="password" id="pfNew" class="form-control" autocomplete="new-password"></div>
            </div>

            <div class="sf-prof-sec">
                <h4><i class="fas fa-key"></i> Question secrète
                    <span class="sf-prof-opt">${d.has_security_question ? '(configurée)' : '(non configurée)'}</span></h4>
                <p class="text-muted" style="font-size:12px;margin:0 0 10px;">Sert à récupérer votre compte si vous oubliez votre mot de passe.</p>
                <div class="form-group"><label>Question</label>
                    <select id="pfQ" class="form-control">
                        ${opts}
                        <option value="__custom__"${customSelected ? ' selected' : ''}>Autre… (personnalisée)</option>
                    </select></div>
                <div class="form-group" id="pfQCustomWrap" style="${customSelected ? '' : 'display:none;'}">
                    <label>Votre question</label>
                    <input type="text" id="pfQCustom" class="form-control" value="${customSelected ? SF.esc(d.security_question) : ''}"></div>
                <div class="form-group"><label>Réponse ${d.has_security_question ? '<span class="sf-prof-opt">(vide = garder l’actuelle)</span>' : ''}</label>
                    <input type="text" id="pfA" class="form-control" autocomplete="off" placeholder="${d.has_security_question ? '••••••' : 'Votre réponse'}"></div>
            </div>

            <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:6px;">
                <button class="btn btn-secondary" onclick="SF.Modal.close('sfProfileModal')">Fermer</button>
                <button class="btn btn-primary" id="pfSave" onclick="SF.Profile.save()"><i class="fas fa-check"></i> Enregistrer</button>
            </div>`;
        document.getElementById('pfQ').addEventListener('change', function () {
            document.getElementById('pfQCustomWrap').style.display = this.value === '__custom__' ? '' : 'none';
        });
    },
    async uploadPhoto(input) {
        const file = input.files && input.files[0];
        if (!file) return;
        const fd = new FormData(); fd.append('photo', file);
        try {
            const r = await SF.api('/api/profile/photo', { method: 'POST', body: fd });
            this.applyAvatar(r.photo);
            if (this.data) this.data.profile_photo = r.photo;
            SF.toast('Photo mise à jour', 'success');
        } catch (e) { SF.toast(e.message, 'error'); }
    },
    // Rafraîchit l'avatar partout où il apparaît (aperçu, bouton topbar, pied de barre).
    applyAvatar(photo) {
        if (SF.Auth.user) SF.Auth.user.profile_photo = photo;
        const prev = document.getElementById('sfAvatarPreview');
        if (prev) { const img = document.createElement('img'); img.src = photo; img.id = 'sfAvatarPreview'; prev.replaceWith(img); }
        const btn = document.getElementById('sfProfileBtn');
        if (btn) btn.innerHTML = `<img src="${SF.esc(photo)}" alt="Profil">`;
        document.querySelectorAll('.sf-side-avatar').forEach(el => {
            el.classList.add('has-photo'); el.innerHTML = `<img src="${SF.esc(photo)}" alt="">`;
        });
    },
    async save() {
        const payload = {
            full_name: document.getElementById('pfName').value.trim(),
            phone: document.getElementById('pfPhone').value.trim()
        };
        const cur = document.getElementById('pfCur').value, nw = document.getElementById('pfNew').value;
        if (nw) {
            if (!cur) return SF.toast('Entrez votre mot de passe actuel', 'error');
            payload.current_password = cur; payload.new_password = nw;
        }
        const ans = document.getElementById('pfA').value.trim();
        if (ans) {
            const sel = document.getElementById('pfQ').value;
            const q = sel === '__custom__' ? document.getElementById('pfQCustom').value.trim() : sel;
            if (!q) return SF.toast('Choisissez ou saisissez une question secrète', 'error');
            payload.security_question = q; payload.security_answer = ans;
        }
        const btn = document.getElementById('pfSave'); btn.disabled = true;
        try {
            await SF.api('/api/profile', { method: 'PUT', body: payload }); if (SF.Auth.forget) SF.Auth.forget();
            if (SF.Auth.user) SF.Auth.user.full_name = payload.full_name;
            document.querySelectorAll('.sidebar-footer .user-details h4').forEach(h => h.textContent = payload.full_name || (this.data && this.data.username) || '');
            SF.toast('Profil enregistré', 'success');
            SF.Modal.close('sfProfileModal');
        } catch (e) { SF.toast(e.message, 'error'); }
        finally { btn.disabled = false; }
    }
};

// Icône de chaque onglet de page (rangée sous le titre).
const TAB_ICONS = {
    '/index.html': 'fa-gauge-high', '/supervision.html': 'fa-binoculars', '/profits.html': 'fa-sack-dollar',
    '/reception.html': 'fa-truck-ramp-box', '/commandes-fournisseurs.html': 'fa-file-invoice', '/appro.html': 'fa-arrows-rotate',
    '/retour.html': 'fa-rotate-left', '/movements.html': 'fa-arrow-right-arrow-left', '/sorties-depot.html': 'fa-right-from-bracket',
    '/reports.html': 'fa-route', '/corbeille.html': 'fa-trash-can',
    '/suivi-boutique.html': 'fa-store', '/suivi-enligne.html': 'fa-globe', '/echanges.html': 'fa-right-left',
    '/inventaire.html': 'fa-laptop', '/inventaire-composants.html': 'fa-microchip',
    '/pos.html': 'fa-cash-register', '/proforma.html': 'fa-file-lines',
    '/sales.html': 'fa-receipt', '/ventes-journalieres.html': 'fa-calendar-day', '/top-ventes.html': 'fa-ranking-star', '/starlink-clients.html': 'fa-satellite-dish', '/reseaux-sociaux.html': 'fa-share-nodes',
    '/encaissement.html': 'fa-hand-holding-dollar', '/engagements.html': 'fa-user-tag',
    '/deliveries.html': 'fa-truck-fast', '/coordination.html': 'fa-route', '/annulations.html': 'fa-ban', '/journal.html': 'fa-clipboard-list',
};

/* ============================================================
   MOBILE — barre de navigation basse + menu d'actions « ⋮ ».
   Tout est construit en permanence ; le CSS (≤ 768 px) décide
   de l'affichage. Le rendu desktop est inchangé.
   Le menu complet s'ouvre par le hamburger en haut à gauche ;
   la barre basse porte les 5 pages les plus utilisées.
   ============================================================ */
// Pages de départ par rôle (avant que l'usage réel soit connu ; aussi page d'arrivée des entrées regroupées).
const BNAV_PREF = {
    admin:            ['/index.html', '/stock.html', '/sales.html', '/deliveries.html', '/pos.html'],
    gestion_stock:    ['/stock.html', '/reception.html', '/deliveries.html', '/ventes-journalieres.html', '/retour.html'],
    caisse:           ['/pos.html', '/encaissement.html', '/sales.html', '/deliveries.html', '/treasury.html'],
    commercial:       ['/consignations.html', '/stock.html', '/sales.html', '/engagements.html', '/index.html'],
    commercial_ligne: ['/online.html', '/demandes-clients.html', '/deliveries.html', '/engagements.html', '/index.html'],
    coordinateur:     ['/coordination.html', '/deliveries.html', '/index.html'],
    securite:         ['/controle-sortie.html'],
    technicien:       ['/installation.html', '/index.html'],
    livreur:          ['/index.html'],
};
const BNAV_MAX = 5;
// Fréquentation des pages, par compte et par appareil (localStorage) : la barre basse
// s'adapte à ce que la personne ouvre réellement. Décroissance douce pour suivre les habitudes.
SF.Usage = {
    key(user) { return 'sf-usage-' + (user && (user.id || user.username) || 'x'); },
    get(user) { try { return JSON.parse(localStorage.getItem(this.key(user)) || '{}') || {}; } catch (e) { return {}; } },
    hit(user, href) {
        if (!href) return;
        try {
            const u = this.get(user);
            Object.keys(u).forEach(k => { u[k] = Math.round(u[k] * 0.98 * 100) / 100; if (u[k] < 0.05) delete u[k]; });
            u[href] = (u[href] || 0) + 1;
            localStorage.setItem(this.key(user), JSON.stringify(u));
        } catch (e) {}
    }
};
SF.BottomNav = {
    build(user, active) {
        if (document.getElementById('sfBottomNav')) return;
        const visible = [];
        menuFor(user).forEach(sec => sec.items.forEach(it => visible.push(it)));
        // Score = visites réelles + petit bonus aux pages de départ du rôle (départage, nouveaux comptes).
        const usage = SF.Usage.get(user), pref = BNAV_PREF[user.role] || [];
        const score = it => it.hrefs.reduce((t, h) => t + (usage[h] || 0), 0)
            + it.hrefs.reduce((b, h) => { const i = pref.indexOf(h); return i < 0 ? b : Math.max(b, (pref.length - i) * 0.6); }, 0);
        const picks = visible.map((it, i) => ({ it, i, s: score(it) }))
            .sort((a, b) => b.s - a.s || a.i - b.i).slice(0, BNAV_MAX)
            .sort((a, b) => a.i - b.i).map(x => x.it);   // affichage dans l'ordre du menu : les boutons ne « sautent » pas
        if (picks.length < 2) return;            // un seul écran : le menu suffit
        const nav = document.createElement('nav');
        nav.id = 'sfBottomNav'; nav.className = 'sf-bnav'; nav.setAttribute('aria-label', 'Navigation rapide');
        nav.innerHTML = picks.map(it => `
            <a href="${it.href}" class="sf-bnav-item ${it.hrefs.includes(active) ? 'active' : ''}">
                <span class="sf-bnav-ico"><i class="fas ${it.icon}"></i><span class="nav-badge sf-bnav-badge" data-badge-href="${it.hrefs.join(' ')}" style="display:none;"></span></span>
                <span class="sf-bnav-lbl">${SF.esc(it.short)}</span>
            </a>`).join('');
        document.body.appendChild(nav);
        document.body.classList.add('sf-has-bnav');
        // Point rouge sur le hamburger si une entrée hors barre basse attend une action.
        const inBar = new Set(picks.map(it => it.hrefs.join(' ')));
        SF.on('navbadges', () => {
            const any = [...document.querySelectorAll('#sfSidebar .nav-badge[data-badge-href]')]
                .some(b => b.style.display !== 'none' && !inBar.has(b.getAttribute('data-badge-href')));
            const dot = document.querySelector('.mobile-menu-btn .sf-menu-dot'); if (dot) dot.style.display = any ? 'block' : 'none';
        });
    }
};

SF.MobileActions = {
    // Boutons/liens de .page-actions (hors outils topbar) : masqués sur téléphone
    // et proposés dans une feuille d'actions « ⋮ » (libellés complets).
    btns() {
        const pa = document.querySelector('.page-header .page-actions');
        if (!pa) return [];
        return [...pa.querySelectorAll(':scope > .btn, :scope > a.btn, :scope > button')]
            .filter(b => b.id !== 'sfTools' && !b.closest('#sfTools'));
    },
    init() {
        const header = document.querySelector('.page-header');
        if (!header || header.querySelector('.sf-more-btn')) return;
        if (!this.btns().length) return;
        header.classList.add('sf-has-more');
        const more = document.createElement('button');
        more.type = 'button'; more.className = 'icon-btn sf-more-btn'; more.title = 'Actions';
        more.setAttribute('aria-label', 'Actions de la page');
        more.innerHTML = '<i class="fas fa-ellipsis-vertical"></i>';
        more.onclick = () => this.open();
        header.appendChild(more);
    },
    open() {
        const items = this.btns().filter(b => b.style.display !== 'none' && !b.hidden && !b.disabled);
        let sheet = document.getElementById('sfActionSheet');
        if (!sheet) {
            sheet = document.createElement('div');
            sheet.id = 'sfActionSheet'; sheet.className = 'sf-sheet-overlay';
            sheet.innerHTML = '<div class="sf-sheet" role="menu"><div class="sf-sheet-grip"></div><div class="sf-sheet-list"></div><button type="button" class="sf-sheet-cancel">Fermer</button></div>';
            sheet.addEventListener('click', e => { if (e.target === sheet || e.target.closest('.sf-sheet-cancel')) sheet.classList.remove('active'); });
            document.body.appendChild(sheet);
        }
        const list = sheet.querySelector('.sf-sheet-list');
        list.innerHTML = '';
        if (!items.length) list.innerHTML = '<div class="sf-sheet-empty">Aucune action disponible</div>';
        items.forEach(b => {
            const it = document.createElement('button');
            it.type = 'button'; it.className = 'sf-sheet-item' + (b.classList.contains('btn-primary') ? ' primary' : '') + (b.classList.contains('btn-danger') ? ' danger' : '');
            const ico = b.querySelector('i');
            const label = (b.textContent || '').replace(/\s+/g, ' ').trim() || b.title || b.getAttribute('aria-label') || 'Action';
            it.innerHTML = `<i class="${ico ? SF.esc(ico.className) : 'fas fa-circle'}"></i><span>${SF.esc(label)}</span>`;
            it.onclick = () => { sheet.classList.remove('active'); b.click(); };
            list.appendChild(it);
        });
        sheet.classList.add('active');
    }
};

SF.layout = function (opts = {}) {
    const user = SF.Auth.user;
    if (!user) return;
    const active = opts.active || location.pathname;

    /* ---- Barre latérale ---- */
    const sidebar = document.getElementById('sfSidebar');
    if (sidebar) {
        // Sections repliables (accordion) : réservées à l'ADMIN (seul à voir toutes les entrées,
        // menu sinon très long). Les autres rôles gardent le menu simple, tout ouvert, comme avant.
        // Mémoire du pli par section (localStorage) ; la section de la page active reste ouverte.
        const isAdmin = user.role === 'admin';
        let collapseMap = {};
        try { collapseMap = JSON.parse(localStorage.getItem('stockflow-nav-collapsed') || '{}'); } catch (e) {}
        const nav = menuFor(user).map(sec => {
            const items = sec.items;
            const itemsHtml = items.map(it => `
                    <a href="${it.href}" class="nav-item ${it.hrefs.includes(active) ? 'active' : ''}">
                        <i class="fas ${it.icon}"></i><span>${SF.esc(it.label)}</span>
                        <span class="nav-badge" data-badge-href="${it.hrefs.join(' ')}" style="display:none;"></span>
                    </a>`).join('');
            // Menu simple (non-admin, ou section à une seule entrée) : titre statique, tout ouvert.
            if (!isAdmin || items.length === 1)
                return `<div class="nav-section"><div class="nav-section-title nav-section-static">${sec.title}</div>${itemsHtml}</div>`;
            // Admin : section repliable (active ouverte ; sinon mémoire, défaut = fermée).
            const hasActive = items.some(it => it.hrefs.includes(active));
            const collapsed = hasActive ? false : (sec.title in collapseMap ? collapseMap[sec.title] : true);
            return `<div class="nav-section${collapsed ? ' collapsed' : ''}" data-section="${SF.esc(sec.title)}">
                <button type="button" class="nav-section-title nav-section-toggle" onclick="SF.toggleNavSection(this)" aria-expanded="${!collapsed}">
                    <span>${sec.title}</span><i class="fas fa-chevron-down nav-caret"></i>
                </button>
                <div class="nav-section-items">${itemsHtml}</div>
            </div>`;
        }).join('');

        sidebar.className = 'sidebar';
        sidebar.innerHTML = `
            <div class="sidebar-header"><div class="sidebar-logo"></div></div>
            <nav class="sidebar-nav">${nav}</nav>
            <div class="sidebar-footer">
                <div class="user-info" title="Mon profil" style="cursor:pointer;" onclick="SF.Profile.open()">
                    ${avatarMarkup(user, 'sf-side-avatar')}
                    <div class="user-details">
                        <h4>${SF.esc(user.full_name || user.username)}</h4>
                        <span>${SF.esc((Array.isArray(user.roles) && user.roles.length ? user.roles : [user.role]).map(r => SF.fmt.roleLabel(r)).join(' + '))}</span>
                    </div>
                </div>
                <button class="btn-logout" onclick="SF.Auth.logout()">
                    <i class="fas fa-sign-out-alt"></i> Déconnexion
                </button>
            </div>`;
    }

    /* ---- Topbar : cloche + thème + bascule mobile ---- */
    const tools = document.getElementById('sfTools');
    if (tools) {
        tools.classList.add('topbar-tools');
        tools.innerHTML = `
            <button class="topbar-search" title="Rechercher (Ctrl+K)" onclick="SF.Palette.open()">
                <i class="fas fa-magnifying-glass"></i>
                <span>Rechercher…</span>
                <kbd>Ctrl K</kbd>
            </button>
            <button class="icon-btn" title="Notifications" onclick="SF.Notifications.toggle()">
                <i class="fas fa-bell"></i>
                <span class="notif-badge" id="sfNotifBadge">0</span>
            </button>
            <button class="icon-btn" title="Changer de thème" onclick="SF.Theme.toggle()">
                <i data-theme-icon class="fas fa-moon"></i>
            </button>
            <button class="icon-btn sf-profile-btn" id="sfProfileBtn" title="Mon profil" onclick="SF.Profile.open()">
                ${user.profile_photo ? `<img src="${SF.esc(user.profile_photo)}" alt="Profil">` : '<i class="fas fa-circle-user"></i>'}
            </button>`;
    }

    /* ---- Recherche globale : pages accessibles au rôle courant ---- */
    SF.Palette.items = [];
    menuFor(user).forEach(sec => sec.items.forEach(it => it.pages.forEach(pg => SF.Palette.items.push({
        label: it.pages.length > 1 ? (pg.title || pg.label) : it.label, href: pg.href, icon: it.icon,
        section: it.pages.length > 1 ? it.label : sec.title
    }))));
    SF.Palette.ensure();

    /* ---- Hamburger + overlay mobile (conventions de style.css) ---- */
    const closeSidebar = () => {
        document.getElementById('sfSidebar')?.classList.remove('active');
        document.getElementById('sfOverlay')?.classList.remove('active');
    };
    const toggleSidebar = () => {
        document.getElementById('sfSidebar')?.classList.toggle('active');
        document.getElementById('sfOverlay')?.classList.toggle('active');
    };
    const header = document.querySelector('.page-header');
    if (!document.querySelector('.mobile-menu-btn')) {
        const btn = document.createElement('button');
        btn.className = 'mobile-menu-btn';
        btn.setAttribute('aria-label', 'Menu');
        btn.innerHTML = '<i class="fas fa-bars"></i><span class="sf-menu-dot" style="display:none;"></span>';
        btn.onclick = toggleSidebar;
        // Dans la barre de titre (en flux) : ne recouvre plus le titre. Repli : flottant.
        if (header) header.insertBefore(btn, header.firstChild);
        else document.body.appendChild(btn);
    }
    if (header) header.classList.add('sf-has-burger');

    /* ---- Pages regroupées : titre du groupe + onglets sous la barre de titre ---- */
    let group = null;
    menuFor(user).forEach(sec => sec.items.forEach(it => { if (it.pages.length > 1 && it.hrefs.includes(active)) group = it; }));
    if (group && header && !header.querySelector('.sf-subnav')) {
        const h1 = header.querySelector('.page-title h1');
        if (h1) h1.textContent = group.label;
        const sub = document.createElement('nav');
        sub.className = 'sf-subnav';
        sub.setAttribute('aria-label', group.label);
        sub.innerHTML = group.pages.map(pg => `<a href="${pg.href}" class="sf-subnav-item${pg.href === active ? ' active" aria-current="page' : ''}">
                <i class="fas ${TAB_ICONS[pg.href] || group.icon}"></i><span>${SF.esc(pg.label)}</span><span class="nav-badge" data-badge-href="${pg.href}" style="display:none;"></span></a>`).join('');
        header.appendChild(sub);
        header.classList.add('sf-has-subnav');
        // Onglet actif visible quand la rangée défile (téléphone).
        const cur = sub.querySelector('.active');
        if (cur) requestAnimationFrame(() => { sub.scrollLeft = Math.max(0, cur.offsetLeft - (sub.clientWidth - cur.offsetWidth) / 2); });
    }

    /* ---- Mobile : outils supplémentaires dans le tiroir (recherche + thème, retirés de la topbar) ---- */
    if (sidebar && !sidebar.querySelector('.sf-drawer-tools')) {
        const dt = document.createElement('div');
        dt.className = 'sf-drawer-tools';
        dt.innerHTML = `
            <button type="button" onclick="SF.Palette.open()"><i class="fas fa-magnifying-glass"></i> Rechercher</button>
            <button type="button" onclick="SF.Theme.toggle()"><i data-theme-icon class="fas fa-moon"></i> Thème</button>`;
        sidebar.querySelector('.sidebar-header')?.after(dt);
    }

    /* ---- Mobile : actions de la page regroupées dans un menu « ⋮ » ---- */
    SF.MobileActions.init();

    /* ---- Mobile : barre de navigation basse (raccourcis du rôle + Menu) ---- */
    SF.Usage.hit(user, active);
    SF.BottomNav.build(user, active);
    if (!document.getElementById('sfOverlay')) {
        const ov = document.createElement('div');
        ov.id = 'sfOverlay'; ov.className = 'sidebar-overlay';
        ov.onclick = closeSidebar;
        document.body.appendChild(ov);
    }
    // Referme la barre après un clic sur un lien (mobile).
    sidebar?.querySelectorAll('.nav-item').forEach(a => a.addEventListener('click', closeSidebar));
    if (!document.getElementById('sfNotifPanel')) {
        const panel = document.createElement('div');
        panel.id = 'sfNotifPanel'; panel.className = 'notif-panel';
        panel.innerHTML = `
            <div class="notif-panel-head">
                <h4><i class="fas fa-bell"></i> Notifications</h4>
                <button class="btn btn-sm btn-secondary" onclick="SF.Notifications.markAll()">Tout marquer lu</button>
            </div>
            <div id="sfNotifList"></div>`;
        document.body.appendChild(panel);
        // Fermeture au clic extérieur.
        document.addEventListener('click', e => {
            const p = document.getElementById('sfNotifPanel');
            if (p && p.classList.contains('show') && !p.contains(e.target) && !e.target.closest('.icon-btn'))
                p.classList.remove('show');
        });
    }

    // Fenêtre « Mon profil » (injectée une seule fois, disponible sur toutes les pages).
    if (!document.getElementById('sfProfileModal')) {
        const m = document.createElement('div');
        m.id = 'sfProfileModal'; m.className = 'modal-overlay';
        m.innerHTML = `
            <div class="modal" style="max-width:540px;">
                <div class="modal-header">
                    <h3><i class="fas fa-circle-user"></i> Mon profil</h3>
                    <button class="modal-close" onclick="SF.Modal.close('sfProfileModal')">&times;</button>
                </div>
                <div class="modal-body" id="sfProfileBody"></div>
            </div>`;
        document.body.appendChild(m);
    }

    SF.Theme.init();
    SF.applyFontScale();
    SF.UI.sync();
    SF.Notifications.init();
    // Responsable stock : badge persistant « commandes fournisseurs pas encore vues » (disparaît à l'ouverture du détail).
    const myRoles = (Array.isArray(user.roles) && user.roles.length) ? user.roles : [user.role];
    if (user.role === 'admin' || myRoles.includes('gestion_stock')) {
        SF.refreshSupplierOrdersPending();
        SF.on('supplier-order:update', () => SF.refreshSupplierOrdersPending());
    }
    // Service atelier : badge persistant « étiquettes à imprimer » (admin + responsable désigné).
    if (user.role === 'admin' || user.atelier_responsible) {
        SF.refreshAtelierPending();
        SF.on('atelier:update', () => SF.refreshAtelierPending());
    }

    // Hauteur réelle de la barre de titre collante → décalage exact des en-têtes
    // de tableaux collants (--topbar-h), quelle que soit la page.
    const setTopbar = () => {
        const ph = document.querySelector('.page-header');
        document.documentElement.style.setProperty('--topbar-h', (ph ? ph.offsetHeight : 74) + 'px');
    };
    setTopbar();
    window.addEventListener('resize', setTopbar);

    // (Retour automatique de la caisse vers « Encaissement » après inactivité : supprimé le 15/10/2026
    //  à la demande de l'utilisateur — la caisse reste sur la dernière page ouverte.)
};

// Redirige vers `targetHref` après `ms` d'inactivité totale (souris/clavier/tactile).
// Le minuteur se réinitialise à chaque interaction ; inactif si déjà sur la cible.
SF.idleRedirect = function (targetHref, ms) {
    if (location.pathname === targetHref) return;
    if (SF._idleCleanup) SF._idleCleanup();
    let timer = null;
    const reset = () => { clearTimeout(timer); timer = setTimeout(() => { location.href = targetHref; }, ms); };
    const evs = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel', 'click'];
    evs.forEach(ev => window.addEventListener(ev, reset, { passive: true }));
    const onVis = () => { if (!document.hidden) reset(); };
    document.addEventListener('visibilitychange', onVis);
    SF._idleCleanup = () => { clearTimeout(timer); evs.forEach(ev => window.removeEventListener(ev, reset)); document.removeEventListener('visibilitychange', onVis); };
    reset();
};

/* ============================================================
   RECHERCHE GLOBALE (palette de commandes) — Ctrl/Cmd + K.
   Navigation rapide vers n'importe quelle page accessible au rôle.
   Les entrées sont renseignées par SF.layout() (SF.Palette.items).
   ============================================================ */
SF.Palette = {
    items: [], filtered: [], sel: 0,
    ensure() {
        if (document.getElementById('sfPalette')) return;
        const ov = document.createElement('div');
        ov.id = 'sfPalette';
        ov.className = 'cmd-overlay';
        ov.innerHTML = `
            <div class="cmd-box" role="dialog" aria-label="Recherche">
                <div class="cmd-input-wrap">
                    <i class="fas fa-magnifying-glass"></i>
                    <input id="sfPaletteInput" class="cmd-input" type="text" placeholder="Rechercher une page…" autocomplete="off" spellcheck="false">
                    <kbd>Échap</kbd>
                </div>
                <div id="sfPaletteList" class="cmd-list"></div>
            </div>`;
        document.body.appendChild(ov);
        ov.addEventListener('click', e => { if (e.target === ov) SF.Palette.close(); });
        const input = ov.querySelector('#sfPaletteInput');
        input.addEventListener('input', () => SF.Palette.render());
        input.addEventListener('keydown', e => SF.Palette.onKey(e));
    },
    open() {
        this.ensure();
        document.getElementById('sfPalette').classList.add('show');
        const input = document.getElementById('sfPaletteInput');
        input.value = ''; this.sel = 0; this.render();
        setTimeout(() => input.focus(), 20);
    },
    close() { document.getElementById('sfPalette')?.classList.remove('show'); },
    render() {
        const q = (document.getElementById('sfPaletteInput').value || '').trim().toLowerCase();
        this.filtered = !q ? this.items.slice()
            : this.items.filter(it => (it.label + ' ' + it.section).toLowerCase().includes(q));
        if (this.sel >= this.filtered.length) this.sel = 0;
        const list = document.getElementById('sfPaletteList');
        list.innerHTML = this.filtered.length
            ? this.filtered.map((it, i) => `
                <a href="${it.href}" class="cmd-item ${i === this.sel ? 'active' : ''}" data-i="${i}">
                    <i class="fas ${it.icon}"></i>
                    <span class="cmd-label">${SF.esc(it.label)}</span>
                    <span class="cmd-sec">${SF.esc(it.section)}</span>
                </a>`).join('')
            : `<div class="cmd-empty">Aucune page trouvée</div>`;
        list.querySelectorAll('.cmd-item').forEach(a =>
            a.addEventListener('mousemove', () => { SF.Palette.sel = +a.dataset.i; SF.Palette._paint(); }));
    },
    _paint() {
        document.querySelectorAll('#sfPaletteList .cmd-item').forEach((a, i) => a.classList.toggle('active', i === this.sel));
    },
    _scroll() {
        const a = document.querySelectorAll('#sfPaletteList .cmd-item')[this.sel];
        if (a) a.scrollIntoView({ block: 'nearest' });
    },
    onKey(e) {
        if (e.key === 'ArrowDown')      { e.preventDefault(); this.sel = Math.min(this.sel + 1, this.filtered.length - 1); this._paint(); this._scroll(); }
        else if (e.key === 'ArrowUp')   { e.preventDefault(); this.sel = Math.max(this.sel - 1, 0); this._paint(); this._scroll(); }
        else if (e.key === 'Enter')     { e.preventDefault(); const it = this.filtered[this.sel]; if (it) location.href = it.href; }
        else if (e.key === 'Escape')    { e.preventDefault(); this.close(); }
    }
};
// Raccourci global d'ouverture.
document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); SF.Palette.open(); }
});

})();
