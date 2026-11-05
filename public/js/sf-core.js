/* ============================================================
   STOCKFLOW — Noyau client partagé par toutes les pages.
   API, session, thème, toasts, formatage (Ariary/dates),
   temps réel (SSE) et notifications.
   ============================================================ */
(function () {
'use strict';

const SF = window.SF = {};

/* ---- Rôles (libellés, secours si l'API n'a pas répondu) ---- */
SF.ROLES = {
    admin: 'Administrateur', gestion_stock: 'Gestionnaire du stock', caisse: 'Caisse',
    technicien: 'Technicien', commercial: 'Commercial (boutique)',
    commercial_ligne: 'Commercial en ligne', coordinateur: 'Coordinateur de livraison',
    securite: 'Sécurité (contrôle de sortie)'
};

/* ============================================================
   THÈME clair / sombre
   ============================================================ */
SF.Theme = {
    KEY: 'stockflow-theme',
    get() { return localStorage.getItem(this.KEY) === 'dark' ? 'dark' : 'light'; },
    apply(m) {
        document.documentElement.setAttribute('data-theme', m);
        document.querySelectorAll('[data-theme-icon]').forEach(i => {
            i.className = (m === 'dark' ? 'fas fa-sun' : 'fas fa-moon');
        });
    },
    toggle() { const n = this.get() === 'dark' ? 'light' : 'dark'; localStorage.setItem(this.KEY, n); this.apply(n); },
    init() { this.apply(this.get()); }
};
// Appliqué immédiatement (évite le flash clair→sombre).
document.documentElement.setAttribute('data-theme',
    localStorage.getItem('stockflow-theme') === 'dark' ? 'dark' : 'light');

/* ============================================================
   PERSONNALISATION (Configuration > Personnalisation, admin)
   Réglages communs à tous les postes, stockés côté serveur
   (settings.ui_prefs, JSON), mis en cache localement
   (« stockflow-ui ») et posés en attributs data-* sur <html> :
   data-look, data-radius, data-accent, data-density, data-font,
   data-sidebar, data-width, data-typeface, data-motion.
   data-look = « soft » (style 2026-10 : fond grège, cartes blanches,
   vert canard + jaune) ou « classic » (ancien rendu).
   sf.css (bloc PERSONNALISATION) applique le rendu.
   ============================================================ */
SF.UI = {
    KEY: 'stockflow-ui',
    DEFAULTS: { look: 'soft', radius: 'round', accent: 'teal', density: 'comfort', font: 'md', sidebar: 'light', width: 'limited', typeface: 'dmsans', motion: 'on' },
    clean(p) {
        const out = Object.assign({}, this.DEFAULTS);
        // Réglages enregistrés AVANT le style « soft » (pas de clé look) : leurs anciennes
        // valeurs par défaut (émeraude, menu sombre) cèdent la place aux nouvelles.
        if (p && !p.look) { p = Object.assign({}, p); if (p.accent === 'emerald') delete p.accent; if (p.sidebar === 'dark') delete p.sidebar; }
        Object.keys(this.DEFAULTS).forEach(k => { if (p && typeof p[k] === 'string' && /^[a-z]+$/.test(p[k])) out[k] = p[k]; });
        return out;
    },
    get() { try { return this.clean(JSON.parse(localStorage.getItem(this.KEY) || '{}')); } catch (e) { return this.clean({}); } },
    apply(p) {
        p = this.clean(p);
        const h = document.documentElement;
        Object.keys(p).forEach(k => h.setAttribute('data-' + k, p[k]));
    },
    cache(p) { try { localStorage.setItem(this.KEY, JSON.stringify(this.clean(p))); } catch (e) {} },
    // Relit les réglages du serveur (après connexion) et met le cache à jour.
    async sync() {
        try {
            const txt = await SF._shared('/api/settings');
            if (txt == null) return;
            const s = JSON.parse(txt);
            let p = {};
            try { p = s.ui_prefs ? JSON.parse(s.ui_prefs) : {}; } catch (e) {}
            this.cache(p); this.apply(p);
        } catch (e) {}
    }
};
SF.UI.apply(SF.UI.get());
SF.UI.cache(SF.UI.get());   // réécrit le cache nettoyé : le script anti-flash du <head> lit la bonne version

/* Taille d'interface : fait partie de la personnalisation (data-font). */
SF.applyFontScale = function () {
    document.documentElement.setAttribute('data-font', SF.UI.get().font);
};

/* Zoom désactivé : iOS Safari ignore « user-scalable=no » → on bloque aussi le pincement. */
document.addEventListener('gesturestart', e => e.preventDefault(), { passive: false });
/* ============================================================
   APERÇU DES PHOTOS PRODUIT (toutes les pages, tous les rôles)
   Un clic / toucher sur la photo d'une carte produit (.sc-img, .pcard-img) ou sur tout élément
   [data-zoom] l'affiche en grand, avec le nom du produit. Les boutons posés sur la photo
   (engrenage, +…) gardent leur action. Fermeture : clic, croix ou Échap. Un clic sur la grande
   photo l'agrandit encore (taille réelle, défilable) sur petit écran.
   ============================================================ */
SF.Lightbox = {
    el: null,
    urlOf(node) {
        if (node.tagName === 'IMG') return node.currentSrc || node.src;
        if (node.getAttribute && node.getAttribute('data-bg')) return node.getAttribute('data-bg');   // photo pas encore chargée
        const m = /url\(["']?([^"')]+)["']?\)/.exec(node.style.backgroundImage || getComputedStyle(node).backgroundImage || '');
        return m ? m[1] : null;
    },
    open(url, title) {
        if (!url) return;
        if (!this.el) {
            const st = document.createElement('style');
            st.textContent = `.sf-lb{position:fixed;inset:0;z-index:5000;background:rgba(10,14,13,.88);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:56px 14px 20px;opacity:0;transition:opacity .15s;}
                .sf-lb.on{opacity:1;} .sf-lb .lb-box{max-width:min(960px,96vw);max-height:calc(100vh - 120px);overflow:auto;border-radius:14px;background:#fff;box-shadow:0 20px 60px rgba(0,0,0,.45);-webkit-overflow-scrolling:touch;}
                .sf-lb img{display:block;max-width:min(960px,96vw);max-height:calc(100vh - 120px);object-fit:contain;cursor:zoom-in;}
                .sf-lb.zoom img{max-width:none;max-height:none;width:min(1600px,220vw);cursor:zoom-out;}
                .sf-lb .lb-t{color:#fff;font-weight:700;font-size:15px;margin-top:12px;text-align:center;max-width:92vw;}
                .sf-lb .lb-x{position:absolute;top:12px;right:14px;width:42px;height:42px;border-radius:50%;border:none;background:rgba(255,255,255,.16);color:#fff;font-size:22px;cursor:pointer;}`;
            document.head.appendChild(st);
            const el = this.el = document.createElement('div');
            el.className = 'sf-lb';
            el.innerHTML = '<button class="lb-x" aria-label="Fermer">&times;</button><div class="lb-box"><img alt=""></div><div class="lb-t"></div>';
            el.addEventListener('click', e => {
                if (e.target.tagName === 'IMG') { el.classList.toggle('zoom'); return; }
                this.close();
            });
            document.addEventListener('keydown', e => { if (e.key === 'Escape' && this.el && this.el.parentNode) this.close(); });
        }
        this.el.classList.remove('zoom', 'on');
        this.el.querySelector('img').src = url;
        this.el.querySelector('.lb-t').textContent = title || '';
        document.body.appendChild(this.el);
        requestAnimationFrame(() => this.el.classList.add('on'));
    },
    close() { if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el); }
};
// Capture : passe AVANT les onclick des cartes (ajout au panier, ouverture de fiche…), sauf boutons.
document.addEventListener('click', e => {
    const t = e.target;
    if (!t || !t.closest || t.closest('button, a, input, select, label, .sf-lb')) return;
    const node = t.closest('.sc-img, .pcard-img, [data-zoom]');
    if (!node) return;
    const url = node.getAttribute('data-zoom') || SF.Lightbox.urlOf(node);
    if (!url || url === 'none') return;   // pas de photo : la carte garde son comportement
    e.stopPropagation(); e.preventDefault();
    const card = node.closest('.stock-card, .pcard, .icard, .modal');
    const tEl = card && card.querySelector('.sc-title, .pcard-t, .ic-name, .modal-header h3');
    SF.Lightbox.open(url, node.getAttribute('data-title') || (tEl ? tEl.textContent.trim() : ''));
}, true);

document.addEventListener('touchmove', e => { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });

/* PWA : enregistrement du service worker (installable Android / desktop). */
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
    // Une fois la page chargée et au repos : préchauffer les pages voisines (barre du bas + onglets).
    window.addEventListener('load', () => setTimeout(() => {
        const sw = navigator.serviceWorker.controller; if (!sw) return;
        const urls = [...new Set([...document.querySelectorAll('.sf-bnav a[href], .page-tabs a[href], .sidebar a[href]')]
            .map(a => a.getAttribute('href')).filter(h => h && /^\/[\w-]+\.html$/.test(h) && h !== location.pathname))].slice(0, 12);
        if (urls.length) sw.postMessage({ type: 'sf-warm', urls });
    }, 4000));
    // Page servie depuis le cache et modifiée depuis (déploiement) : proposer d'actualiser.
    navigator.serviceWorker.addEventListener('message', ev => {
        const d = ev.data || {};
        if (d.type !== 'sf-page-updated' || d.path !== location.pathname || document.getElementById('sfUpdBtn')) return;
        const b = document.createElement('button');
        b.id = 'sfUpdBtn'; b.type = 'button';
        b.style.cssText = 'position:fixed;left:50%;bottom:84px;transform:translateX(-50%);z-index:3500;border:none;border-radius:999px;padding:10px 18px;background:#0f5f6b;color:#fff;font:600 13.5px inherit;box-shadow:0 6px 20px rgba(0,0,0,.25);cursor:pointer;';
        b.innerHTML = '<i class="fas fa-rotate"></i> Nouvelle version — actualiser';
        b.onclick = () => location.reload();
        (document.body || document.documentElement).appendChild(b);
    });
}

/* ============================================================
   API — fetch JSON avec gestion des erreurs et du 401
   ============================================================ */
/* Chargement À LA DEMANDE des grosses bibliothèques (jsPDF 360 Ko, Chart.js 200 Ko) : elles ne
   bloquent plus l'affichage des pages ; chargées une seule fois, au premier besoin. */
const _scripts = {};
SF.loadScript = function (src) {
    if (_scripts[src]) return _scripts[src];
    return (_scripts[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src; s.async = true;
        s.onload = () => resolve();
        s.onerror = () => { delete _scripts[src]; reject(new Error('Module non chargé (' + src.split('/').pop() + ') — vérifiez la connexion')); };
        document.head.appendChild(s);
    }));
};
SF.needPDF = async function () {
    if (!window.jspdf) await SF.loadScript('/vendor/jspdf/jspdf.umd.min.js');
    return window.jspdf;
};
SF.needChart = async function () {
    if (!window.Chart) await SF.loadScript('/vendor/chartjs/chart.umd.min.js');
    return window.Chart;
};
/* Photos envoyées au serveur : une photo de téléphone fait 2 à 4 Mo, affichée ensuite en vignette sur
   chaque carte produit (et téléchargée par chaque téléphone). Redimensionnée ici à 1600 px max en
   JPEG ~85 % (≈ 150-300 Ko, qualité identique à l'écran). PNG (logos, transparence) et GIF intacts. */
SF.shrinkImage = async function (file, max = 1600, quality = 0.85) {
    try {
        if (!(file instanceof File) || !/^image\/(jpeg|webp)$/i.test(file.type) || file.size < 350 * 1024) return file;
        const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
        const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
        const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
        if (bmp.close) bmp.close();
        const blob = await new Promise(ok => cv.toBlob(ok, 'image/jpeg', quality));
        if (!blob || blob.size >= file.size) return file;
        return new File([blob], file.name.replace(/\.(webp|jpe?g)$/i, '') + '.jpg', { type: 'image/jpeg', lastModified: Date.now() });
    } catch (e) { return file; }
};
async function shrinkForm(fd) {
    const out = new FormData();
    for (const [k, v] of fd.entries()) {
        if (v instanceof File) { const f = await SF.shrinkImage(v); out.append(k, f, f.name); }
        else out.append(k, v);
    }
    return out;
}

/* Réglages (/api/settings) et configuration (/api/config) : demandés par presque chaque page, souvent
   l'un APRÈS l'autre avant les données de la page (3-4 allers-retours réseau sur téléphone). Ils sont
   désormais lancés dès le chargement du script, en parallèle de la session, et partagés 60 s
   (chaque appelant reçoit sa propre copie). Toute écriture (POST/PUT/DELETE) vide ce cache. */
const _shared = {};
const SHARED_GET = /^\/api\/(config|settings)$/;

/* Préchargement APPRIS par page : chaque page enchaîne souvent plusieurs requêtes l'une après l'autre
   (session → réglages → fournisseurs → stock → valeur…), soit ≈ 1 s chacune via le tunnel. On mémorise
   (localStorage) les GET lancés au chargement de la page, avant toute action de l'utilisateur ; à la visite
   suivante ils partent TOUS en même temps dès le chargement du script, et SF.api réutilise la réponse
   préchargée (une seule fois, si demandée dans les 15 s). */
const PF_KEY = 'sf-pf:' + location.pathname, PF_SKIP = /^\/api\/(events|logout|login|session|config|settings)\b|export|download|pdf|xlsx/i;
const _pf = {}, _pfSeen = new Set();
let _pfRec = !/\/login\.html$/.test(location.pathname);
const _pfT0 = Date.now();
// Lancé APRÈS la session et les réglages (voir plus bas) : en HTTP/1.1 (accès direct au serveur du magasin)
// le navigateur limite les connexions simultanées, la session passe donc en premier.
function _pfStart() {
    try {
        (JSON.parse(localStorage.getItem(PF_KEY) || '[]') || []).slice(0, 14).forEach(u => {
            if (typeof u === 'string' && u.startsWith('/api/') && !PF_SKIP.test(u))
                _pf[u] = fetch(u, { credentials: 'include' }).catch(() => null);
        });
    } catch (e) {}
}
if (_pfRec) {
    const stop = () => {
        if (!_pfRec) return; _pfRec = false;
        try { if (_pfSeen.size) localStorage.setItem(PF_KEY, JSON.stringify([..._pfSeen].slice(0, 14))); } catch (e) {}
    };
    ['pointerdown', 'keydown'].forEach(ev => window.addEventListener(ev, stop, { once: true, capture: true }));
    setTimeout(stop, 10000);
    window.addEventListener('pagehide', stop);
}
function _pfTake(path) {
    const p = _pf[path];
    if (!p) return null;
    delete _pf[path];
    return Date.now() - _pfT0 < 15000 ? p : null;
}
SF._shared = function (path) {
    const m = _shared[path];
    if (m && Date.now() - m.t < 60000) return m.p;
    const p = fetch(path, { credentials: 'include' }).then(r => r.ok ? r.text() : null).catch(() => null);
    _shared[path] = { t: Date.now(), p };
    p.then(txt => { if (txt == null && _shared[path] && _shared[path].p === p) delete _shared[path]; });
    return p;
};
if (!/\/login\.html$/.test(location.pathname)) { SF._shared('/api/config'); SF._shared('/api/settings'); }

SF.api = async function (path, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    if (method === 'GET' && SHARED_GET.test(path)) {
        const txt = await SF._shared(path);
        if (txt != null) { try { return JSON.parse(txt); } catch (e) {} }
    } else if (method !== 'GET') { Object.keys(_shared).forEach(k => delete _shared[k]); Object.keys(_pf).forEach(k => delete _pf[k]); }   // écriture : plus de réponse préchargée
    if (opts.body instanceof FormData) opts = { ...opts, body: await shrinkForm(opts.body) };
    const options = { credentials: 'include', headers: {}, ...opts };
    if (options.body && !(options.body instanceof FormData)) {
        options.headers['Content-Type'] = 'application/json';
        if (typeof options.body !== 'string') options.body = JSON.stringify(options.body);
    }
    // Timeout : évite qu'une requête bloquée fasse tourner le chargement à l'infini.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeout || 20000);
    let res;
    try {
        if (method === 'GET' && _pfRec && !PF_SKIP.test(path)) _pfSeen.add(path);
        const pre = method === 'GET' ? _pfTake(path) : null;
        res = (pre && await pre) || await fetch(path, { ...options, signal: ctrl.signal });
    } catch (e) {
        throw new Error(e && e.name === 'AbortError' ? 'Délai dépassé — vérifiez la connexion et réessayez.' : 'Connexion au serveur interrompue.');
    } finally {
        clearTimeout(timer);
    }
    if (res.status === 401) {
        if (!location.pathname.endsWith('login.html')) location.href = '/login.html';
        throw new Error('Session expirée');
    }
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) data = await res.json();
    // Journée de caisse clôturée : le serveur refuse ; l'admin peut confirmer explicitement.
    if (res.status === 409 && data && data.code === 'closed_day' && !opts._forcedClosedDay) {
        const ok = await SF.confirm(data.error + ' Continuer quand même ?', { title: 'Caisse clôturée', danger: true, okLabel: 'Continuer' });
        if (!ok) throw new Error('Opération annulée');
        return SF.api(path + (path.includes('?') ? '&' : '?') + 'force_closed_day=1', { ...opts, _forcedClosedDay: true });
    }
    if (!res.ok) throw new Error((data && data.error) || 'Erreur ' + res.status);
    return data;
};

/* Longues listes (stock, caisse, ventes…) : seules les ~50 premières cartes / lignes sont construites
   tout de suite ; les suivantes s'ajoutent quand on approche du bas (défilement). Sur téléphone, une
   liste de 750 produits passait de ~1 s de calcul (et 1,3 Mo de HTML) à quelques dizaines de ms.
   SF.renderChunks(conteneur, lignes, ligne => html) — conteneur div/grille ou <tbody>. */
SF.renderChunks = function (box, rows, fn, { first = 50, step = 100 } = {}) {
    if (box._sfObs) { box._sfObs.disconnect(); box._sfObs = null; }
    box.innerHTML = rows.slice(0, first).map(fn).join('');
    let i = first;
    if (i >= rows.length) return;
    const isBody = /^T(BODY|ABLE)$/.test(box.tagName);
    const sentinel = document.createElement(isBody ? 'tr' : 'div');
    if (isBody) sentinel.innerHTML = '<td colspan="99" style="padding:0;border:0;height:1px;"></td>';
    else sentinel.style.cssText = 'grid-column:1/-1;width:100%;height:1px;';
    sentinel.className = 'sf-more-sentinel';
    box.appendChild(sentinel);
    if (!('IntersectionObserver' in window)) { sentinel.insertAdjacentHTML('beforebegin', rows.slice(i).map(fn).join('')); sentinel.remove(); return; }
    const obs = new IntersectionObserver(ents => {
        if (!ents.some(e => e.isIntersecting)) return;
        sentinel.insertAdjacentHTML('beforebegin', rows.slice(i, i + step).map(fn).join(''));
        i += step;
        obs.unobserve(sentinel);
        if (i >= rows.length) { obs.disconnect(); sentinel.remove(); box._sfObs = null; }
        else obs.observe(sentinel);   // ré-observe : redéclenche si le bas est encore visible
    }, { rootMargin: '1500px 0px' });
    obs.observe(sentinel);
    box._sfObs = obs;
};

/* ============================================================
   CLIENT : nom + contact obligatoires partout, contact ≥ 10 chiffres
   (même règle côté serveur : clientError dans server.js).
   ============================================================ */
SF.clientError = function (name, phone) {
    if (!String(name || '').trim()) return 'Nom du client obligatoire';
    if (!String(phone || '').trim()) return 'Contact du client obligatoire';
    if (String(phone).replace(/\D/g, '').length < 10) return 'Contact du client invalide : au moins 10 chiffres (ex. 034 12 345 67)';
    return '';
};
// Vérifie deux champs (ids) : met en évidence le champ fautif + message. Renvoie true si tout est bon.
SF.checkClient = function (nameId, phoneId) {
    const n = document.getElementById(nameId), p = document.getElementById(phoneId);
    const err = SF.clientError(n && n.value, p && p.value);
    if (!err) return true;
    const el = /Nom/.test(err) ? n : p;
    if (el) { el.focus(); el.style.borderColor = 'var(--danger)'; setTimeout(() => { el.style.borderColor = ''; }, 2500); }
    SF.toast(err, 'warn');
    return false;
};

/* Photos produit chargées seulement quand la carte approche de l'écran (data-bg="url") : une page de
   centaines de cartes ne télécharge plus toutes les photos d'un coup (tunnel / données mobiles). */
SF.lazyBg = (() => {
    const show = el => { const u = el.getAttribute('data-bg'); el.removeAttribute('data-bg'); if (u) el.style.backgroundImage = `url('${u}')`; };
    const io = 'IntersectionObserver' in window
        ? new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { io.unobserve(e.target); show(e.target); } }), { rootMargin: '400px 0px' })
        : null;
    const scan = root => {
        if (!root || root.nodeType !== 1) return;
        const list = root.matches && root.matches('[data-bg]') ? [root] : [];
        root.querySelectorAll && list.push(...root.querySelectorAll('[data-bg]'));
        list.forEach(el => io ? io.observe(el) : show(el));
    };
    const start = () => { scan(document.body); new MutationObserver(ms => ms.forEach(m => m.addedNodes.forEach(scan))).observe(document.body, { childList: true, subtree: true }); };
    document.body ? start() : document.addEventListener('DOMContentLoaded', start);
    return { scan, show };
})();

/* ============================================================
   SESSION / AUTH
   ============================================================ */
// Page de connexion : on oublie l'utilisateur mémorisé (changement de compte).
if (/\/login\.html$/.test(location.pathname)) { try { sessionStorage.removeItem('sf-user2'); } catch (e) {} }
// /api/session lancé dès le chargement du script (en parallèle du reste de la page).
const _sessionP = /\/login\.html$/.test(location.pathname) ? null : fetch('/api/session', { credentials: 'include' }).then(r => r.ok ? r.json() : null).catch(() => null);
if (_pfRec) _pfStart();
SF.Auth = {
    user: null,
    // Utilisateur mémorisé pour l'onglet (10 min) : la page n'attend plus l'aller-retour de session (≈ 1 s via
    // le tunnel) avant de charger ses données ; la session est revérifiée en arrière-plan (expirée → connexion).
    _cached() {
        try { const c = JSON.parse(sessionStorage.getItem('sf-user2') || 'null'); return c && Date.now() - c.t < 600000 ? c.user : null; } catch (e) { return null; }
    },
    _remember(user) { try { sessionStorage.setItem('sf-user2', JSON.stringify({ user, t: Date.now() })); } catch (e) {} },
    forget() { try { sessionStorage.removeItem('sf-user2'); } catch (e) {} },
    async require(roles) {
        try {
            let user = this._cached();
            const check = (_sessionP || Promise.resolve(null)).then(r => {
                if (!r || !r.user) { this.forget(); location.href = '/login.html'; return null; }
                this._remember(r.user); this.user = r.user; return r.user;
            });
            if (!user) user = await check;
            if (!user) return null;
            this.user = user;
            const mine = (user && Array.isArray(user.roles) && user.roles.length) ? user.roles : [user && user.role];
            if (roles && roles.length && user.role !== 'admin' && !roles.some(r => mine.includes(r))) {
                SF.toast("Accès non autorisé pour votre rôle", 'error');
                setTimeout(() => location.href = user.home || '/index.html', 800);
                return null;
            }
            if (user.default_admin_password) this.defaultPasswordBanner();
            if (user.role === 'admin' || mine.includes('gestion_stock')) SF.UpgradeBanner.init();
            return user;
        } catch (e) { location.href = '/login.html'; return null; }
    },
    // Bandeau (admins) : le compte admin par défaut garde son mot de passe initial.
    defaultPasswordBanner() {
        if (document.getElementById('sfDefaultPwdBanner')) return;
        const b = document.createElement('div');
        b.id = 'sfDefaultPwdBanner';
        b.style.cssText = 'position:sticky;top:0;z-index:2000;background:#b45309;color:#fff;padding:8px 16px;font-size:14px;text-align:center;';
        b.innerHTML = '<i class="fas fa-triangle-exclamation"></i> Le compte <b>admin</b> par défaut utilise encore un mot de passe par défaut connu : '
            + 'aucune modification n\'est possible tant qu\'il n\'est pas changé. <a href="#" style="color:#fff;text-decoration:underline;font-weight:700;">Changer le mot de passe</a>';
        b.querySelector('a').onclick = e => { e.preventDefault(); if (SF.Profile && SF.Profile.open) SF.Profile.open(); };
        const add = () => document.body.prepend(b);
        document.body ? add() : document.addEventListener('DOMContentLoaded', add);
        // Compte admin par défaut lui-même connecté : ouvre directement « Mon profil ».
        if (SF.Auth.user && SF.Auth.user.username === 'admin' && !sessionStorage.getItem('sf-pwd-asked')) {
            try { sessionStorage.setItem('sf-pwd-asked', '1'); } catch (e) {}
            setTimeout(() => { if (SF.Profile && SF.Profile.open) SF.Profile.open(); }, 600);
        }
    },
    async logout() {
        this.forget();
        try { await SF.api('/api/logout', { method: 'POST' }); } catch (e) {}
        location.href = '/login.html';
    }
};
// Bandeau PERMANENT (stock + admin) : composants repris lors d'un upgrade (ancienne RAM, ancien disque…)
// pas encore réceptionnés au dépôt. Aucune croix : il ne disparaît qu'une fois la réception validée
// (page Retour). Rafraîchi en temps réel (stock:update) et chaque minute.
SF.UpgradeBanner = {
    started: false,
    init() {
        if (this.started) return; this.started = true;
        this.refresh();
        try { SF.on('stock:update', () => this.refresh()); } catch (e) {}
        setInterval(() => this.refresh(), 60000);
    },
    async refresh() {
        let r; try { r = await SF.api('/api/upgrades/pending'); } catch (e) { return; }
        let b = document.getElementById('sfUpgBanner');
        if (!r || !r.count) { if (b) b.remove(); return; }
        if (!b) {
            b = document.createElement('div'); b.id = 'sfUpgBanner';
            b.style.cssText = 'position:sticky;top:0;z-index:1999;background:#b91c1c;color:#fff;padding:8px 16px;font-size:13.5px;line-height:1.45;text-align:center;';
            const add = () => { const pwd = document.getElementById('sfDefaultPwdBanner'); pwd ? pwd.after(b) : document.body.prepend(b); };
            document.body ? add() : document.addEventListener('DOMContentLoaded', add);
        }
        const list = r.items.slice(0, 4).map(i => `${SF.esc(i.product_name || 'Composant')}${i.sale_number ? ` (vente n° ${SF.esc(i.sale_number)})` : ''}`).join(' · ');
        b.innerHTML = `<i class="fas fa-screwdriver-wrench"></i> <b>${r.count} composant(s) repris lors d'un upgrade</b> à réceptionner au dépôt : ${list}${r.count > 4 ? ' …' : ''}
            ${location.pathname === '/retour.html' ? '' : ' <a href="/retour.html" style="color:#fff;text-decoration:underline;font-weight:800;margin-left:6px;">Réceptionner</a>'}`;
    }
};

/* ============================================================
   FORMATAGE
   ============================================================ */
SF.fmt = {
    ar(n) {
        n = Number(n) || 0;
        return new Intl.NumberFormat('fr-FR').format(Math.round(n)) + ' Ar';
    },
    int(n) { return new Intl.NumberFormat('fr-FR').format(Math.round(Number(n) || 0)); },
    // Date du jour à Madagascar (UTC+3), format AAAA-MM-JJ — cohérent avec le serveur.
    today() { const d = new Date(Date.now() + 3 * 3600000); return d.toISOString().slice(0, 10); },
    date(s) {
        if (!s) return '—';
        const d = new Date(String(s).replace(' ', 'T'));
        if (isNaN(d)) return s;
        return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    },
    datetime(s) {
        if (!s) return '—';
        const d = new Date(String(s).replace(' ', 'T'));
        if (isNaN(d)) return s;
        return d.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    },
    relative(s) {
        if (!s) return '';
        const d = new Date(String(s).replace(' ', 'T'));
        const sec = Math.round((Date.now() - d.getTime()) / 1000);
        if (sec < 60) return "à l'instant";
        if (sec < 3600) return `il y a ${Math.floor(sec / 60)} min`;
        if (sec < 86400) return `il y a ${Math.floor(sec / 3600)} h`;
        return `il y a ${Math.floor(sec / 86400)} j`;
    },
    // Durée HH:MM:SS à partir de secondes (compte à rebours).
    duration(sec) {
        const neg = sec < 0; sec = Math.abs(Math.floor(sec));
        const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
        const p = n => String(n).padStart(2, '0');
        return (neg ? '-' : '') + `${p(h)}:${p(m)}:${p(s)}`;
    },
    roleLabel(r) { return (SF.ROLES && SF.ROLES[r]) || r || '—'; }
};

/* Échappe le HTML (anti-XSS dans les rendus). */
SF.esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
};

/* Emplacement(s) au dépôt : un produit peut en avoir plusieurs (liste séparée par des virgules).
   SF.empList('E04, D03') → ['E04','D03']. */
// Tuile d'indicateur au modèle du tableau de bord (libellé + carré d'icône, grande valeur, sous-texte).
// { label, value, icon, tone (teal|yellow|blue|violet|green|coral, sinon rotation), sub, onclick, active, title, cls, valCls }
// label / value / sub sont du HTML : échapper les données utilisateur avant l'appel.
SF.tile = function (o) {
    const cls = ['scard', o.tone ? 'tone-' + o.tone : '', o.active ? 'active' : '', o.cls || ''].filter(Boolean).join(' ');
    const act = o.onclick ? ` role="button" tabindex="0" onclick="${o.onclick}" onkeydown="if(event.key==='Enter')this.click()"` : '';
    return `<div class="${cls}"${act}${o.title ? ` title="${SF.esc(o.title)}"` : ''}>`
        + `<div class="k-top"><div class="lbl">${o.label}</div>${o.icon ? `<span class="sf-ico"><i class="fas ${o.icon}"></i></span>` : ''}</div>`
        + `<div class="val${o.valCls ? ' ' + o.valCls : ''}">${o.value}</div>${o.sub ? `<div class="sub">${o.sub}</div>` : ''}</div>`;
};
// En-tête + grille d'un groupe de tuiles (carte .dash-card).
SF.tileGroup = function (title, icon, inner, right = '') {
    return `<div class="card dash-card"><div class="card-header"><h3><i class="fas ${icon}"></i> ${title}</h3>${right}</div>`
        + `<div class="card-body"><div class="stats-grid">${inner}</div></div></div>`;
};
SF.empList = function (s) { return String(s == null ? '' : s).split(/[,;]+/).map(x => x.trim()).filter(Boolean); };
// Code couleur fournisseur (stable par id) — Stock dépôt, Commande en ligne : puce + bandeau de carte.
SF.supColor = function (id) {
    const pal = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5', '#0d9488', '#a16207'];
    id = parseInt(id, 10) || 0;
    return id >= 1 && id <= pal.length ? pal[id - 1] : `hsl(${Math.round((id * 137.508) % 360)} 62% 45%)`;
};
// Bandeau : une couleur, ou segments égaux si la fiche a plusieurs fournisseurs.
SF.supBar = function (sups) {
    return sups.length === 1 ? SF.supColor(sups[0].id)
        : `linear-gradient(90deg, ${sups.map((s, i) => `${SF.supColor(s.id)} ${(i * 100 / sups.length).toFixed(1)}% ${((i + 1) * 100 / sups.length).toFixed(1)}%`).join(', ')})`;
};

/* Skeletons de chargement réutilisables (CSS : .sf-skel* dans sf.css).
   rows(colspan) → lignes de tableau ; cards()/lines() → blocs pour grilles/listes. */
SF.skel = {
    rows(colspan, n = 1) {
        const cell = `<td colspan="${colspan}" class="sf-skel-cell"><span class="sf-skel sf-skel-line"></span><span class="sf-skel sf-skel-line"></span><span class="sf-skel sf-skel-line"></span></td>`;
        return `<tr>${cell}</tr>`.repeat(Math.max(1, n));
    },
    cards(n = 3) { return '<div class="sf-skel sf-skel-card"></div>'.repeat(n); },
    lines(n = 3) { return '<div class="sf-skel sf-skel-line"></div>'.repeat(n); }
};

/* Statuts d'unité (cycle de vie) + rendu en badge. */
SF.UNIT_STATUS = {
    stock: 'En stock', preparation: 'En préparation', presentoir: 'En boutique', reserve: 'Réservé',
    acompte: 'Réservé (avance)', consignation: 'En boutique',
    livraison: 'En livraison', vendu: 'Vendu', garantie_client: 'Garantie client',
    garantie_fournisseur: 'Garantie fournisseur', garantie_exceptionnel: 'Garantie exceptionnelle',
    retour_fournisseur: 'Retour fournisseur', retour_attente: 'Retour à réceptionner', defectueux: 'Stock défectueux',
    usage_magasin: 'Usage magasin', retire: 'Retiré'
};
SF.statusBadge = function (s) {
    const cls = { stock: 'badge-success', preparation: 'badge-warning', presentoir: 'badge-info',
        reserve: 'badge-warning', acompte: 'badge-warning', consignation: 'badge-info', livraison: 'badge-info', vendu: 'badge-secondary',
        garantie_client: 'badge-danger', garantie_fournisseur: 'badge-danger', garantie_exceptionnel: 'badge-danger',
        retour_fournisseur: 'badge-danger', retour_attente: 'badge-warning', retire: 'badge-secondary' }[s] || 'badge-secondary';
    return `<span class="badge ${cls}">${SF.UNIT_STATUS[s] || s}</span>`;
};

/* Statuts de livraison + badge. */
SF.DELIVERY_STATUS = {
    nouvelle: 'Nouvelle', assignee: 'Assignée', acceptee: 'Assignée — à facturer', facturee: 'Facturée',
    en_livraison: 'En livraison', livree: 'Livrée', annulee: 'Annulée', retournee: 'Retournée'
};
// Une couleur + une icône par étape : à facturer (orange), facturée (violet), en livraison (bleu)…
SF.DELIVERY_ICON = {
    nouvelle: 'fa-inbox', assignee: 'fa-user-check', acceptee: 'fa-file-invoice', facturee: 'fa-box-open',
    en_livraison: 'fa-truck-fast', livree: 'fa-circle-check', annulee: 'fa-ban', retournee: 'fa-rotate-left'
};
SF.deliveryBadge = function (s) {
    const ico = SF.DELIVERY_ICON[s];
    return `<span class="badge dl-badge dl-${SF.esc(s || '')}">${ico ? `<i class="fas ${ico}"></i> ` : ''}${SF.DELIVERY_STATUS[s] || SF.esc(s || '')}</span>`;
};

/* Montant en toutes lettres (factures, proformas) : 1 250 000 → « un million deux cent cinquante mille ». */
SF.numberToWords = (function () {
    const U = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize',
               'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'];
    const T = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante', 'soixante', 'quatre-vingt', 'quatre-vingt'];
    const b100 = n => {
        if (n < 20) return U[n];
        const t = Math.floor(n / 10), u = n % 10;
        if (t === 7 || t === 9) return (t === 7 ? 'soixante' : 'quatre-vingt') + (t === 7 && u === 1 ? '-et-' : '-') + U[10 + u];
        if (u === 1 && t < 8) return T[t] + '-et-un';
        if (t === 8 && u === 0) return 'quatre-vingts';
        return T[t] + (u ? '-' + U[u] : '');
    };
    const b1000 = n => {
        if (n < 100) return b100(n);
        const c = Math.floor(n / 100), r = n % 100;
        const cent = c === 1 ? 'cent' : U[c] + ' cent';
        return r === 0 ? (c > 1 ? cent + 's' : cent) : cent + ' ' + b100(r);
    };
    return function (n) {
        n = Math.round(Math.abs(Number(n) || 0));
        if (!n) return 'zéro';
        const parts = [];
        [['milliard', 1e9], ['million', 1e6], ['mille', 1e3]].forEach(([name, val]) => {
            const q = Math.floor(n / val);
            if (!q) return;
            // « mille » est invariable et ne laisse pas le « s » à cent/vingt (deux cent mille).
            if (name === 'mille') parts.push(q === 1 ? 'mille' : b1000(q).replace(/(cent|vingt)s$/, '$1') + ' mille');
            else parts.push(b1000(q) + ' ' + name + (q > 1 ? 's' : ''));
            n %= val;
        });
        if (n) parts.push(b1000(n));
        return parts.join(' ');
    };
})();

/* Jours restants jusqu'à une date AAAA-MM-JJ (négatif = passé). */
SF.daysUntil = function (dateStr) {
    if (!dateStr) return null;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const d = new Date(String(dateStr).replace(' ', 'T')); d.setHours(0, 0, 0, 0);
    if (isNaN(d)) return null;
    return Math.round((d - today) / 86400000);
};

/* Rendu d'une pastille de garantie à partir d'une date de fin. */
SF.warrantyBadge = function (endDate) {
    const days = SF.daysUntil(endDate);
    const st = SF.warrantyStatus(days);
    if (!st.cls) return '<span class="text-muted">—</span>';
    return `<span class="warranty ${st.cls}"><span class="dot"></span>${st.label}</span>`;
};

/* Statut de garantie à partir de jours restants → { cls, label } */
SF.warrantyStatus = function (days) {
    if (days == null) return { cls: '', label: '—' };
    if (days < 0)  return { cls: 'expired', label: 'Expirée' };
    if (days <= 7) return { cls: 'soon',    label: days === 0 ? "Expire aujourd'hui" : `${days} j restants` };
    return { cls: 'ok', label: `${days} j restants` };
};

/* ============================================================
   TOASTS
   ============================================================ */
SF.toast = function (message, type = 'info', ms = 3200) {
    let box = document.getElementById('sf-toasts');
    if (!box) { box = document.createElement('div'); box.id = 'sf-toasts'; document.body.appendChild(box); }
    const icons = { success: 'fa-check-circle', error: 'fa-exclamation-circle', warn: 'fa-exclamation-triangle', info: 'fa-info-circle' };
    const el = document.createElement('div');
    el.className = 'sf-toast ' + type;
    el.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i><span>${SF.esc(message)}</span>`;
    box.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateX(20px)'; el.style.transition = 'all .2s'; setTimeout(() => el.remove(), 200); }, ms);
};

/* ============================================================
   BUS D'ÉVÉNEMENTS TEMPS RÉEL (SSE)
   Les pages s'abonnent via SF.on('event', fn). Le serveur pousse
   'notification' et, dans les phases suivantes, des événements
   métier (stock:update, install:tick, delivery:new, ...).
   ============================================================ */
const listeners = {};
SF.on = function (event, fn) { (listeners[event] = listeners[event] || []).push(fn); };
SF.emit = function (event, data) { (listeners[event] || []).forEach(fn => { try { fn(data); } catch (e) {} }); };

SF.SSE = {
    es: null, _retry: 0, _lost: false,
    EVENTS: ['stock:update', 'battery:update', 'install:update', 'sale:new', 'delivery:update', 'garantie:update', 'warranty:update', 'reception:new',
             'supplier-order:update', 'consignment:update', 'reservation:update', 'layaway:update', 'exchange:update', 'atelier:update', 'client-request:update'],
    // Après une coupure, des événements ont pu être manqués : chaque page recharge ses données.
    resync() { this.EVENTS.forEach(ev => SF.emit(ev, { resync: true })); },
    connect() {
        if (this.es && this.es.readyState !== 2) return;   // déjà connecté / en connexion
        try {
            const es = this.es = new EventSource('/api/events');
            es.addEventListener('open', () => {
                this._retry = 0;
                if (this._lost) { this._lost = false; this.resync(); }
            });
            es.addEventListener('notification', e => {
                try { const n = JSON.parse(e.data); SF.Notifications.add(n); SF.emit('notification', n); } catch (x) {}
            });
            // Résolution : la notification disparaît dès que l'action liée est faite.
            es.addEventListener('notif:resolved', e => {
                try { const d = JSON.parse(e.data); SF.Notifications.resolve(d.ref); } catch (x) {}
            });
            // Ré-émet tout événement nommé vers le bus interne.
            // Page masquée (autre onglet, téléphone en veille) : les événements métier ne déclenchent aucun
            // rechargement (économie de données / batterie) ; une seule resynchronisation au retour.
            this.EVENTS.forEach(ev => es.addEventListener(ev, e => {
                if (document.hidden) { this._missed = true; return; }
                try { SF.emit(ev, JSON.parse(e.data)); } catch (x) {}
            }));
            es.onerror = () => {
                this._lost = true;
                // Coupure : on borne les reconnexions (backoff) pour éviter tout emballement.
                if (es.readyState === 2) {
                    this.es = null;
                    if (this._retry++ < 12) setTimeout(() => this.connect(), Math.min(30000, 2000 * this._retry));
                }
            };
        } catch (e) { /* SSE indisponible : l'application reste utilisable */ }
    },
    close() { if (this.es) { try { this.es.close(); } catch (e) {} this.es = null; } }
};
// Libère la connexion SSE en quittant la page (évite la saturation des connexions).
window.addEventListener('beforeunload', () => SF.SSE.close());
// Retour au premier plan (téléphone en veille, onglet masqué) : connexion rétablie si elle a été fermée.
document.addEventListener('visibilitychange', () => {
    if (document.hidden || !SF.Auth || !SF.Auth.user) return;
    if (SF.SSE._missed) { SF.SSE._missed = false; SF.SSE.resync(); }
    if (!SF.SSE.es || SF.SSE.es.readyState === 2) { SF.SSE._lost = true; SF.SSE._retry = 0; SF.SSE.connect(); }
});

/* ============================================================
   NOTIFICATIONS (cloche + panneau)
   ============================================================ */
// Badges de menu persistants par lien (ex. commandes fournisseurs pas encore vues) : { href: nombre }.
SF.navCounts = {};
// Anciennes adresses (pages fusionnées) → page actuelle : badges et lecture des notifications qui y pointent encore.
SF.LEGACY_PAGES = {
    '/layaways.html': '/engagements.html', '/reservations.html': '/engagements.html', '/garantie-envoi.html': '/garantie.html',
    '/livraisons.html': '/deliveries.html', '/caisse-history.html': '/treasury.html', '/rapport-caisse.html': '/ventes-journalieres.html',
    '/sortie.html': '/movements.html', '/suppliers.html': '/config.html', '/etiquettes.html': '/service-atelier.html'
};
SF.pageOf = function (link) {
    const path = String(link || '').split(/[?#]/)[0];
    return SF.LEGACY_PAGES[path] || path;
};
// Stock : nombre de bons de commande fournisseurs pas encore vus (badge menu persistant).
SF.refreshSupplierOrdersPending = async function () {
    try {
        const r = await SF.api('/api/supplier-orders/pending');
        SF.navCounts['/commandes-fournisseurs.html'] = r.count || 0;
        SF.Notifications.render();
        return r;
    } catch (e) { return null; }
};
// Service atelier : étiquettes des ordinateurs clients encore à imprimer.
SF.refreshAtelierPending = async function () {
    try {
        const r = await SF.api('/api/atelier-labels/pending');
        SF.navCounts['/service-atelier.html'] = r.count || 0;
        SF.Notifications.render();
        return r;
    } catch (e) { return null; }
};
SF.Notifications = {
    items: [],
    async load() {
        try { this.items = await SF.api('/api/notifications'); this.render(); this.markCurrentPage(); } catch (e) {}
    },
    // En visitant un module, ses notifications sont considérées vues → le badge disparaît.
    async markCurrentPage() {
        const path = location.pathname;
        const toRead = this.items.filter(n => !n.is_read && n.link && SF.pageOf(n.link) === path);
        if (!toRead.length) return;
        toRead.forEach(n => n.is_read = 1);
        this.render();
        for (const link of new Set([path].concat(toRead.map(n => n.link)))) {
            try { await SF.api('/api/notifications/read-link', { method: 'POST', body: { link } }); } catch (e) {}
        }
    },
    add(n) {
        // Remplace une éventuelle notification précédente de même cause (ref).
        if (n.ref) this.items = this.items.filter(x => x.ref !== n.ref);
        if (!this.items.find(x => x.id === n.id)) this.items.unshift(n);
        this.render();
        SF.toast(n.title || 'Nouvelle notification', n.type === 'danger' ? 'error' : (n.type === 'warn' ? 'warn' : 'info'));
    },
    resolve(ref) {
        if (!ref) return;
        const before = this.items.length;
        this.items = this.items.filter(n => n.ref !== ref);
        if (this.items.length !== before) this.render();
    },
    unreadCount() { return this.items.filter(n => !n.is_read).length; },
    render() {
        const badge = document.getElementById('sfNotifBadge');
        const list  = document.getElementById('sfNotifList');
        const c = this.unreadCount();
        if (badge) { badge.textContent = c > 99 ? '99+' : c; badge.classList.toggle('show', c > 0); }
        // Badges par module dans le menu : nombre de notifications NON LUES par lien.
        const perLink = {};
        this.items.forEach(n => { if (n.link && !n.is_read) { const k = SF.pageOf(n.link); perLink[k] = (perLink[k] || 0) + 1; } });
        document.querySelectorAll('.nav-badge[data-badge-href]').forEach(b => {
            // Compteurs « à traiter » persistants (ne disparaissent qu'une fois la tâche faite) ;
            // une entrée de menu regroupant plusieurs pages additionne leurs compteurs.
            const n = b.getAttribute('data-badge-href').split(' ')
                .reduce((t, href) => t + Math.max(perLink[href] || 0, SF.navCounts[href] || 0), 0);
            b.textContent = n > 9 ? '9+' : n;
            b.style.display = n > 0 ? 'inline-flex' : 'none';
        });
        SF.emit('navbadges');
        if (!list) return;
        if (!this.items.length) { list.innerHTML = '<div class="notif-empty"><i class="fas fa-bell-slash"></i><br>Aucune notification</div>'; return; }
        const icoCls = { danger: 'danger', warn: 'warn', success: 'ok' };
        const ico = { danger: 'fa-triangle-exclamation', warn: 'fa-clock', success: 'fa-check', info: 'fa-info' };
        list.innerHTML = this.items.map(n => `
            <div class="notif-item ${n.is_read ? '' : 'unread'}" data-id="${n.id}" data-link="${SF.esc(n.link || '')}">
                <div class="ni-icon ${icoCls[n.type] || ''}"><i class="fas ${ico[n.type] || ico.info}"></i></div>
                <div class="ni-body">
                    <div class="ni-title">${SF.esc(n.title)}</div>
                    ${n.message ? `<div class="ni-msg">${SF.esc(n.message)}</div>` : ''}
                    <div class="ni-time">${SF.fmt.relative(n.created_at)}</div>
                </div>
            </div>`).join('');
        list.querySelectorAll('.notif-item').forEach(el => {
            el.addEventListener('click', () => {
                const id = +el.dataset.id, link = el.dataset.link;
                this.markRead(id);
                if (link) location.href = link;
            });
        });
    },
    async markRead(id) {
        const n = this.items.find(x => x.id === id);
        if (n && !n.is_read) { n.is_read = 1; this.render(); try { await SF.api(`/api/notifications/${id}/read`, { method: 'POST' }); } catch (e) {} }
    },
    async markAll() {
        this.items.forEach(n => n.is_read = 1); this.render();
        try { await SF.api('/api/notifications/read-all', { method: 'POST' }); } catch (e) {}
    },
    toggle() { document.getElementById('sfNotifPanel')?.classList.toggle('show'); },
    init() { this.load(); SF.SSE.connect(); }
};

/* ============================================================
   MODALES + CONFIRMATION
   ============================================================ */
SF.Modal = {
    open(id)  {
        const ov = document.getElementById(id); if (!ov) return;
        // Chaque ouverture repart du haut du formulaire (sinon on rouvre au défilement précédent).
        if (!ov.classList.contains('active')) ov.querySelectorAll('.modal, .modal-body').forEach(el => { el.scrollTop = 0; });
        ov.classList.add('active');
    },
    close(id) { document.getElementById(id)?.classList.remove('active'); }
};

/* ============================================================
   TABLEAUX → CARTES SUR TÉLÉPHONE
   Chaque cellule reçoit le libellé de sa colonne (data-label) ;
   sous 768 px, le CSS affiche chaque ligne comme une carte
   « libellé : valeur » au lieu d'un tableau à faire défiler.
   Exclure un tableau : classe .sf-no-stack (sur lui ou un parent).
   ============================================================ */
SF.Stack = {
    label(table) {
        if (table.classList.contains('sf-no-stack') || table.closest('.sf-no-stack')) return;
        const head = table.tHead;
        if (!head || !head.rows.length) return;
        // Libellé par colonne, en-têtes sur plusieurs lignes compris (colspan/rowspan) :
        // « Entrées » au-dessus de « Acc. » → « Entrées · Acc. ».
        const grid = [];                          // grid[ligne][colonne] = texte
        [...head.rows].forEach((tr, r) => {
            grid[r] = grid[r] || [];
            let c = 0;
            [...tr.cells].forEach(th => {
                while (grid[r][c] !== undefined) c++;
                const t = th.textContent.replace(/\s+/g, ' ').trim();
                for (let dr = 0; dr < (th.rowSpan || 1); dr++)
                    for (let dc = 0; dc < (th.colSpan || 1); dc++) {
                        grid[r + dr] = grid[r + dr] || [];
                        grid[r + dr][c + dc] = t;
                    }
                c += th.colSpan || 1;
            });
        });
        const ncol = Math.max(...grid.map(row => row.length));
        const labels = [];
        for (let c = 0; c < ncol; c++) {
            const parts = [];
            grid.forEach(row => { const t = row[c]; if (t && !parts.includes(t)) parts.push(t); });
            labels.push(parts.join(' · '));
        }
        if (labels.length < 3) return;           // 2 colonnes : le tableau tient déjà
        table.classList.add('sf-stack');
        [...table.tBodies, table.tFoot].filter(Boolean).forEach(tb => [...tb.rows].forEach(tr => {
            let idx = 0, titled = false;
            [...tr.cells].forEach(td => {
                // Montants et dates : jamais coupés sur deux lignes (« 59 000 / Ar »).
                const txt = td.textContent.replace(/\s+/g, ' ').trim();
                if (txt.length < 28 && (/^[-−+]?[\d\s .,]+\s?Ar$/.test(txt) || /^\d{2}\/\d{2}\/\d{4}( \d{2}:\d{2})?$/.test(txt)))
                    td.classList.add('sf-nowrap');
                const span = td.colSpan || 1;
                if (span > 1 || tr.cells.length === 1) td.classList.add('sf-td-full');
                else {
                    let l = labels[idx] || '';
                    // Cellule d'actions (que des boutons, ou colonne « Actions ») : pied de carte sans libellé.
                    const onlyBtns = td.querySelector('button, a.btn') && !td.textContent.replace(/\s+/g, '').length;
                    if (onlyBtns || /^actions?$/i.test(l)) l = '';
                    if (td.getAttribute('data-label') !== l) td.setAttribute('data-label', l);
                    if (!titled && l && td.textContent.trim() && !td.querySelector('input[type=checkbox],button,select')) {
                        td.classList.add('sf-td-title'); titled = true;
                    }
                }
                idx += span;
            });
        }));
    },
    scan(tables) {
        (tables || document.querySelectorAll('table')).forEach(t => { try { this.label(t); } catch (e) {} });
        // Champs numériques / montants : pavé numérique sur téléphone.
        document.querySelectorAll('input[type=number]:not([inputmode]), input.money-input:not([inputmode])')
            .forEach(i => i.setAttribute('inputmode', i.step && i.step !== '1' && i.step !== 'any' ? 'decimal' : 'numeric'));
        document.querySelectorAll('input[type=tel]:not([inputmode])').forEach(i => i.setAttribute('inputmode', 'tel'));
    },
    init() {
        // Performance : avant, CHAQUE modification du DOM (compte à rebours chaque seconde, toast…)
        // relisait TOUS les tableaux de la page. Maintenant : seulement les tableaux touchés.
        let queued = false, all = true;
        const dirty = new Set();
        const run = () => {
            queued = false;
            const list = all ? null : [...dirty].filter(t => t.isConnected);
            all = false; dirty.clear();
            this.scan(list);   // liste vide : seulement les champs (pavé numérique)
        };
        // setTimeout (et non requestAnimationFrame, suspendu quand l'onglet est en arrière-plan).
        const queue = () => { if (!queued) { queued = true; setTimeout(run, 30); } };
        new MutationObserver(recs => {
            let hit = false;
            for (const r of recs) {
                const t = r.target.nodeType === 1 && (r.target.tagName === 'TABLE' ? r.target : r.target.closest && r.target.closest('table'));
                if (t) { dirty.add(t); hit = true; continue; }
                for (const n of r.addedNodes) {
                    if (n.nodeType !== 1) continue;
                    if (n.tagName === 'TABLE') { dirty.add(n); hit = true; }
                    else { for (const tb of n.getElementsByTagName('table')) dirty.add(tb); hit = true; }
                }
            }
            if (hit) queue();
        }).observe(document.body, { childList: true, subtree: true });
        queue();
    }
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => SF.Stack.init());
else SF.Stack.init();

// Code de modèle partagé d'un accessoire (même modèle = même code). Ex : produit 123 → 'A000123'.
SF.accCode = function (productId) { return 'A' + String(productId).padStart(6, '0'); };

// Serial d'affichage d'une ligne/unité : le n° de série réel s'il existe, sinon le code de
// modèle partagé pour un accessoire (serial NULL en base), sinon « — ». Évite les « — » vides
// dans les historiques (suivi, ventes, livraisons…). Sans regression : si is_accessory/product_id
// manquent, renvoie « — » comme avant.
SF.serialLabel = function (o) {
    if (!o) return '—';
    if (o.serial) return o.serial;
    return (o.is_accessory && o.product_id) ? SF.accCode(o.product_id) : '—';
};

// ============================================================
//  Saisie de montants — séparateur de milliers AUTOMATIQUE.
//  Un <input class="money-input"> (type text, inputmode numeric) affiche
//  « 1 200 000 » pendant la frappe. Le formatage est délégué au document :
//  les champs ajoutés dynamiquement (modales) fonctionnent sans branchement.
//  Lire la valeur numérique : SF.money.val(input) ou SF.money.parse(str).
//  Poser une valeur : SF.money.set(input, 50000).
// ============================================================
SF.money = {
    parse(v) {
        if (typeof v === 'number') return Math.round(v) || 0;
        const d = String(v == null ? '' : v).replace(/\D/g, '');
        return d ? parseInt(d, 10) : 0;
    },
    val(input) { return input ? this.parse(input.value) : 0; },
    // Groupe par milliers avec une ESPACE SIMPLE (pas d'insécable → collage propre).
    group(v) { return String(this.parse(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); },
    set(input, n) { if (input) input.value = this.group(n); },
    refresh(input) { if (input && String(input.value).replace(/\D/g, '')) input.value = this.group(input.value); },
    // Reformate en préservant au mieux la position du curseur.
    _reformat(input) {
        const raw = input.value, sel = input.selectionStart || 0;
        const digitsBefore = raw.slice(0, sel).replace(/\D/g, '').length;
        const digits = raw.replace(/\D/g, '');
        input.value = digits ? this.group(digits) : '';
        if (input === document.activeElement) {
            let pos = 0, seen = 0;
            while (pos < input.value.length && seen < digitsBefore) {
                const cc = input.value.charCodeAt(pos); if (cc >= 48 && cc <= 57) seen++; pos++;
            }
            try { input.setSelectionRange(pos, pos); } catch (e) {}
        }
    }
};
// Formatage délégué : marche pour tout .money-input, présent ou futur (modales incluses).
document.addEventListener('input', function (e) {
    const el = e.target;
    if (el && el.matches && el.matches('input.money-input')) SF.money._reformat(el);
});
// Formate les champs déjà remplis (valeurs par défaut) au chargement.
document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('input.money-input').forEach(el => SF.money.refresh(el));
});

// ============================================================
//  Fourchette de prix (filtre) — POS, commande en ligne, boutique,
//  ventes, livraisons. SF.PriceRange.mount(el, onChange) pose deux
//  champs « min – max » ; SF.PriceRange.test(el, prix) dit si un prix
//  est dans la fourchette (bornes incluses, une borne vide = ouverte).
// ============================================================
SF.PriceRange = {
    mount(el, onChange, { label = 'Prix' } = {}) {
        if (!el) return;
        el.classList.add('sf-prange');
        el.innerHTML = `<i class="fas fa-coins" title="${label}"></i><span class="pr-lbl">${label}</span>`
            + `<input type="text" inputmode="numeric" class="money-input pr-min" placeholder="Min" aria-label="${label} minimum">`
            + `<span class="pr-sep">–</span>`
            + `<input type="text" inputmode="numeric" class="money-input pr-max" placeholder="Max" aria-label="${label} maximum">`
            + `<span class="pr-unit">Ar</span>`
            + `<button type="button" class="pr-clear" title="Effacer la fourchette">&times;</button>`;
        let t = null;
        const fire = () => { el.classList.toggle('on', !!(this.get(el).min || this.get(el).max)); if (onChange) onChange(); };
        el.querySelectorAll('input').forEach(i => i.addEventListener('input', () => { clearTimeout(t); t = setTimeout(fire, 250); }));
        el.querySelector('.pr-clear').addEventListener('click', () => { el.querySelectorAll('input').forEach(i => { i.value = ''; }); fire(); });
    },
    get(el) {
        if (!el || !el.querySelector('.pr-min')) return { min: 0, max: 0 };
        let min = SF.money.val(el.querySelector('.pr-min')), max = SF.money.val(el.querySelector('.pr-max'));
        if (min && max && min > max) [min, max] = [max, min];   // bornes saisies à l'envers
        return { min, max };
    },
    test(el, price) {
        const { min, max } = this.get(el);
        const v = Number(price) || 0;
        return (!min || v >= min) && (!max || v <= max);
    }
};

/* ============================================================
   Détail produit — modale PARTAGÉE (stock, boutique, commande en ligne, POS).
   Clic sur le TITRE d'une carte → SF.productDetail(produit). La modale est
   injectée une seule fois ; le contenu s'adapte aux champs présents sur l'objet.
   ============================================================ */
SF.productDetail = function (p) {
    if (!p) return;
    let ov = document.getElementById('sfDetailModal');
    if (!ov) {
        ov = document.createElement('div');
        ov.className = 'modal-overlay';
        ov.id = 'sfDetailModal';
        ov.innerHTML = '<div class="modal" style="max-width:560px;">'
            + '<div class="modal-header"><h3 id="sfDetailTitle">Produit</h3>'
            + '<button class="modal-close" onclick="SF.Modal.close(\'sfDetailModal\')">&times;</button></div>'
            + '<div class="modal-body" id="sfDetailBody"></div></div>';
        document.body.appendChild(ov);
    }
    const esc = SF.esc, ar = SF.fmt.ar;
    const title = [p.brand, p.model].filter(Boolean).join(' ') || p.product_name || p.name || 'Produit';
    const spec = [p.cpu, p.ram, (p.storage ? p.storage + (p.storage_type ? ' ' + p.storage_type : '') : null)].filter(Boolean).join(' · ');
    const feats = [];
    if (p.touchscreen) feats.push('Tactile');
    if (p.webcam) feats.push('Webcam');
    if (p.wifi) feats.push('Wi-Fi');
    if (p.bluetooth) feats.push('Bluetooth');
    if (p.numpad) feats.push('Pavé num.');
    // Disponibilités : uniquement les champs présents (>0) sur l'objet fourni.
    const stk = [];
    const pos = v => (v || v === 0) && Number(v) > 0;
    if (pos(p.available))       stk.push(`${p.available} disponible(s)`);
    if (pos(p.in_presentation)) stk.push(`${p.in_presentation} en boutique`);
    if (pos(p.presentoir))      stk.push(`${p.presentoir} en présentation`);
    if (pos(p.reserved))        stk.push(`${p.reserved} réservé(s)`);
    if (pos(p.in_prep))         stk.push(`${p.in_prep} en préparation`);
    if (!stk.length && pos(p.sellable)) stk.push(`${p.sellable} disponible(s)`);
    const price = (p.sale_price != null) ? p.sale_price : (p.price != null ? p.price : (p.unit_price != null ? p.unit_price : null));
    const img = p.image ? `background-image:url('${p.image}')` : '';
    document.getElementById('sfDetailTitle').textContent = title;
    document.getElementById('sfDetailBody').innerHTML =
        '<div style="display:flex;gap:16px;flex-wrap:wrap;">'
        + `<div style="width:130px;height:130px;border-radius:12px;background:var(--bg-input) center/cover no-repeat;${img};display:flex;align-items:center;justify-content:center;color:var(--text-dark);font-size:32px;">${p.image ? '' : '<i class="fas fa-' + (p.is_accessory ? 'plug' : 'laptop') + '"></i>'}</div>`
        + '<div style="flex:1;min-width:200px;font-size:13px;line-height:1.75;">'
        + (p.category ? `<div><strong>Type :</strong> ${esc(p.category)}${p.subcategory ? ' · ' + esc(p.subcategory) : ''}</div>` : '')
        + ((!p.is_accessory && spec) ? `<div><strong>Configuration :</strong> ${esc(spec)}</div>` : '')
        + (p.gpu ? `<div><strong>Carte graphique :</strong> ${esc(p.gpu)}</div>` : '')
        + (p.screen_size ? `<div><strong>Écran :</strong> ${esc(p.screen_size)}</div>` : '')
        + (feats.length ? `<div><strong>Options :</strong> ${esc(feats.join(', '))}</div>` : '')
        + (p.is_accessory ? `<div><strong>Code modèle :</strong> <span style="font-family:monospace;">${esc(SF.accCode((p.product_id || p.id)))}</span></div>` : (p.serial ? `<div><strong>N° série :</strong> <span style="font-family:monospace;">${esc(p.serial)}</span></div>` : ''))
        + (price != null ? `<div><strong>Prix :</strong> ${ar(price)}</div>` : '')
        + (stk.length ? `<div><strong>Stock :</strong> ${esc(stk.join(' · '))}</div>` : '')
        + '</div></div>'
        + (p.description ? `<div style="margin-top:14px;"><strong>Description :</strong><div style="margin-top:4px;color:var(--text-secondary);white-space:pre-wrap;">${esc(p.description)}</div></div>` : '');
    SF.Modal.open('sfDetailModal');
};
// Fermeture des modales au clic sur le fond ou touche Échap.
// Une modale marquée [data-no-dismiss] ne peut PAS être fermée ainsi (action obligatoire à valider).
document.addEventListener('click', e => {
    if (e.target.classList && e.target.classList.contains('modal-overlay') && !e.target.hasAttribute('data-no-dismiss')) e.target.classList.remove('active');
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.active:not([data-no-dismiss])').forEach(m => m.classList.remove('active'));
});

/* ============================================================
   COMPTES À REBOURS — un seul intervalle pour tous les éléments.
   Usage : après un rendu, appeler SF.Countdown.refresh() ; chaque
   élément [data-deadline] (epoch ms) est mis à jour chaque seconde.
   ============================================================ */
SF.Countdown = {
    _interval: null,
    refresh() {
        this._tick();
        if (!this._interval) this._interval = setInterval(() => this._tick(), 1000);
    },
    _tick() {
        const els = document.querySelectorAll('[data-deadline]');
        if (!els.length) { if (this._interval) { clearInterval(this._interval); this._interval = null; } return; }
        els.forEach(el => {
            const d = parseInt(el.getAttribute('data-deadline'), 10);
            const rem = Math.round((d - Date.now()) / 1000);
            el.textContent = SF.fmt.duration(rem);
            el.classList.remove('warn', 'over');
            if (rem <= 0) el.classList.add('over');
            else if (rem < 300) el.classList.add('warn');
        });
    }
};

/* Boîte de confirmation → Promise<boolean>. */
SF.confirm = function (message, { title = 'Confirmation', danger = false, okLabel = 'Confirmer' } = {}) {
    return new Promise(resolve => {
        let ov = document.getElementById('sfConfirm');
        if (!ov) {
            ov = document.createElement('div');
            ov.id = 'sfConfirm'; ov.className = 'modal-overlay';
            ov.innerHTML = `<div class="modal" style="max-width:420px;">
                <div class="modal-header"><h3 id="sfConfirmTitle"></h3><button class="modal-close" data-act="no">&times;</button></div>
                <div class="modal-body"><p id="sfConfirmMsg" style="color:var(--text-secondary);line-height:1.6;"></p></div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" data-act="no">Annuler</button>
                    <button class="btn" id="sfConfirmOk" data-act="yes"></button>
                </div></div>`;
            document.body.appendChild(ov);
        }
        ov.querySelector('#sfConfirmTitle').textContent = title;
        ov.querySelector('#sfConfirmMsg').textContent = message;
        const ok = ov.querySelector('#sfConfirmOk');
        ok.textContent = okLabel;
        ok.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
        ov.classList.add('active');
        const handler = e => {
            const act = e.target.getAttribute('data-act');
            if (!act) return;
            ov.classList.remove('active');
            ov.removeEventListener('click', handler);
            resolve(act === 'yes');
        };
        ov.addEventListener('click', handler);
    });
};

// Saisie de texte dans une modale stylée (remplace prompt() natif).
// Renvoie une Promise<string|null> : null si annulé. `required` refuse le vide.
SF.prompt = function (message, { title = 'Saisie', okLabel = 'Valider', placeholder = '', defaultValue = '', required = false, multiline = false, money = false } = {}) {
    return new Promise(resolve => {
        let ov = document.getElementById('sfPrompt');
        if (!ov) {
            ov = document.createElement('div');
            ov.id = 'sfPrompt'; ov.className = 'modal-overlay';
            ov.innerHTML = `<div class="modal" style="max-width:440px;">
                <div class="modal-header"><h3 id="sfPromptTitle"></h3><button class="modal-close" data-act="cancel">&times;</button></div>
                <div class="modal-body">
                    <p id="sfPromptMsg" style="color:var(--text-secondary);line-height:1.6;margin-bottom:10px;"></p>
                    <div id="sfPromptField"></div>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-secondary" data-act="cancel">Annuler</button>
                    <button class="btn btn-primary" id="sfPromptOk" data-act="ok"></button>
                </div></div>`;
            document.body.appendChild(ov);
        }
        ov.querySelector('#sfPromptTitle').textContent = title;
        ov.querySelector('#sfPromptMsg').textContent = message;
        const field = ov.querySelector('#sfPromptField');
        field.innerHTML = multiline ? '<textarea id="sfPromptInput" class="form-control" rows="3"></textarea>'
                                    : `<input id="sfPromptInput" type="text" ${money ? 'inputmode="numeric" class="form-control money-input"' : 'class="form-control"'}>`;
        const input = ov.querySelector('#sfPromptInput');
        input.placeholder = placeholder; input.value = defaultValue; if (money) SF.money.refresh(input);
        ov.querySelector('#sfPromptOk').textContent = okLabel;
        ov.classList.add('active');
        setTimeout(() => { input.focus(); input.select && input.select(); }, 50);
        const finish = val => { ov.classList.remove('active'); ov.removeEventListener('click', handler); input.removeEventListener('keydown', onKey); resolve(val); };
        const submit = () => {
            if (money) {
                const digits = input.value.replace(/\D/g, '');
                if (required && !digits) { input.style.borderColor = 'var(--danger)'; input.focus(); return; }
                finish(String(SF.money.parse(input.value)));
                return;
            }
            const v = input.value.trim();
            if (required && !v) { input.style.borderColor = 'var(--danger)'; input.focus(); return; }
            finish(v);
        };
        const handler = e => { const act = e.target.getAttribute('data-act'); if (!act) return; act === 'cancel' ? finish(null) : submit(); };
        const onKey = e => { if (e.key === 'Enter' && !multiline) { e.preventDefault(); submit(); } else if (e.key === 'Escape') finish(null); };
        ov.addEventListener('click', handler);
        input.addEventListener('keydown', onKey);
    });
};

/* Dialogue de DEMANDE D'ÉCHANGE d'une unité déjà sortie (livraison / boutique).
   Motif OBLIGATOIRE + disposition de l'ancienne pièce (selon le type de produit).
   Renvoie { reason, disposition } ou null si annulé.
   opts : { is_accessory, title } */
SF.exchangeDialog = function ({ is_accessory = false, title = 'Demander un échange', serial = '' } = {}) {
    return new Promise(resolve => {
        // PC → garantie | stock ; accessoire → stock défectueux | stock.
        const dispoOpt = is_accessory
            ? { key: 'defectueux', label: 'Mettre l\'ancienne en stock défectueux', icon: 'fa-triangle-exclamation' }
            : { key: 'garantie',   label: 'Envoyer l\'ancienne en garantie',        icon: 'fa-shield-halved' };
        let ov = document.getElementById('sfExchange');
        if (ov) ov.remove();
        ov = document.createElement('div');
        ov.id = 'sfExchange'; ov.className = 'modal-overlay';
        ov.innerHTML = `<div class="modal" style="max-width:460px;">
            <div class="modal-header"><h3>${SF.esc(title)}</h3><button class="modal-close" data-act="cancel">&times;</button></div>
            <div class="modal-body">
                <p style="color:var(--text-secondary);font-size:13px;line-height:1.6;margin-bottom:10px;">
                    Remplacement par une autre pièce du <strong>même modèle</strong> (n° de série différent)${serial ? ` — pièce actuelle <strong style="font-family:monospace;">${SF.esc(serial)}</strong>` : ''}. Le stock scanne la pièce de remplacement et vous la remet ; l'ancienne est à rapporter au dépôt.</p>
                <div class="form-group"><label>Motif de l'échange <span style="color:var(--danger);">*</span></label>
                    <textarea id="sfExReason" class="form-control" rows="3" placeholder="Pourquoi remplacer cette pièce ? (obligatoire)"></textarea></div>
                <div class="form-group"><label>Que faire de l'ancienne pièce ?</label>
                    <label style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border-color);border-radius:8px;margin-bottom:6px;cursor:pointer;">
                        <input type="radio" name="sfExDispo" value="${dispoOpt.key}" checked> <i class="fas ${dispoOpt.icon}"></i> ${dispoOpt.label}</label>
                    <label style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border-color);border-radius:8px;cursor:pointer;">
                        <input type="radio" name="sfExDispo" value="stock"> <i class="fas fa-box"></i> La remettre en stock (pas de défaut)</label>
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" data-act="cancel">Annuler</button>
                <button class="btn btn-primary" data-act="ok"><i class="fas fa-right-left"></i> Envoyer la demande</button>
            </div></div>`;
        document.body.appendChild(ov);
        ov.classList.add('active');
        const reasonEl = ov.querySelector('#sfExReason');
        setTimeout(() => reasonEl.focus(), 50);
        const finish = v => { ov.classList.remove('active'); ov.remove(); resolve(v); };
        ov.addEventListener('click', e => {
            const act = e.target.getAttribute('data-act'); if (!act) return;
            if (act === 'cancel') return finish(null);
            const reason = reasonEl.value.trim();
            if (!reason) { reasonEl.style.borderColor = 'var(--danger)'; reasonEl.focus(); return; }
            const disposition = (ov.querySelector('input[name="sfExDispo"]:checked') || {}).value || 'stock';
            finish({ reason, disposition });
        });
    });
};

/* Annulation PARTIELLE d'une livraison pas encore sortie (caisse) : quantité à retirer par article
   (ex. 4 souris sur 10), motif obligatoire. Résout le résultat de l'API ou null si abandon. */
SF.partialCancelDelivery = async function (deliveryId) {
    let d;
    try { d = await SF.api('/api/deliveries/' + deliveryId); } catch (e) { SF.toast(e.message, 'error'); return null; }
    const items = (d.items || []).filter(it => it.quantity > 0);
    return new Promise(resolve => {
        let ov = document.getElementById('sfPartCancel'); if (ov) ov.remove();
        ov = document.createElement('div'); ov.id = 'sfPartCancel'; ov.className = 'modal-overlay';
        const row = it => `<div class="pc-row" data-id="${it.id}" data-max="${it.quantity}" data-price="${it.unit_price || 0}" style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border-color);">
            <div style="flex:1;min-width:0;"><div style="font-weight:700;overflow-wrap:anywhere;">${SF.esc(it.product_name)}</div>
                <div class="text-muted" style="font-size:12px;">${it.quantity} pièce(s) × ${SF.fmt.ar(it.unit_price)}</div></div>
            <div style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
                <button type="button" class="btn btn-sm btn-secondary" data-act="minus">−</button>
                <input type="number" class="form-control pc-q" min="0" max="${it.quantity}" value="0" style="width:58px;text-align:center;padding:6px;">
                <button type="button" class="btn btn-sm btn-secondary" data-act="plus">+</button>
                <button type="button" class="btn btn-sm btn-secondary" data-act="all" title="Tout ce produit">Tout</button>
            </div></div>`;
        ov.innerHTML = `<div class="modal" style="max-width:560px;">
            <div class="modal-header"><h3><i class="fas fa-scissors"></i> Annulation partielle — livraison #${SF.esc(String(d.delivery_number))}</h3><button class="modal-close" data-act="cancel">&times;</button></div>
            <div class="modal-body">
                <p class="text-muted" style="font-size:12.5px;margin-bottom:6px;">Indiquez combien de pièces RETIRER de la commande. Les autres restent à livrer.</p>
                <div>${items.map(row).join('')}</div>
                <div id="pcSum" style="margin:10px 0;font-size:13.5px;"></div>
                <div class="form-group"><label>Motif <span style="color:var(--danger);">*</span></label><textarea id="pcReason" class="form-control" rows="2" placeholder="Pourquoi ces articles sont retirés ?"></textarea></div>
            </div>
            <div class="modal-footer"><button class="btn btn-secondary" data-act="cancel">Fermer</button>
                <button class="btn btn-danger" data-act="ok"><i class="fas fa-scissors"></i> Retirer ces articles</button></div></div>`;
        document.body.appendChild(ov); ov.classList.add('active');
        const sum = () => {
            let q = 0, amt = 0;
            ov.querySelectorAll('.pc-row').forEach(r => { const inp = r.querySelector('.pc-q'); let v = Math.max(0, Math.min(+r.dataset.max, parseInt(inp.value, 10) || 0)); inp.value = v; q += v; amt += v * (+r.dataset.price); });
            const paid = d.payment_status === 'paye';
            ov.querySelector('#pcSum').innerHTML = q ? `<b>${q}</b> pièce(s) retirée(s) · <b>${SF.fmt.ar(amt)}</b> en moins → nouveau total <b>${SF.fmt.ar(Math.max(0, (d.total || 0) - amt))}</b>${paid ? ` · <span style="color:var(--danger);font-weight:700;">${SF.fmt.ar(amt)} à rembourser au client</span>` : ''}` : '<span class="text-muted">Aucune pièce retirée pour l\'instant.</span>';
        };
        sum();
        const finish = v => { ov.classList.remove('active'); ov.remove(); resolve(v); };
        ov.addEventListener('input', e => { if (e.target.classList.contains('pc-q')) sum(); });
        ov.addEventListener('click', async e => {
            const btn = e.target.closest('[data-act]'); if (!btn) return;
            const act = btn.dataset.act, r = btn.closest('.pc-row');
            if (r) { const inp = r.querySelector('.pc-q'); const v = parseInt(inp.value, 10) || 0;
                inp.value = act === 'plus' ? v + 1 : act === 'minus' ? v - 1 : act === 'all' ? r.dataset.max : v; return sum(); }
            if (act === 'cancel') return finish(null);
            const lines = [...ov.querySelectorAll('.pc-row')].map(x => ({ item_id: +x.dataset.id, qty: parseInt(x.querySelector('.pc-q').value, 10) || 0 })).filter(l => l.qty > 0);
            const reasonEl = ov.querySelector('#pcReason'), reason = reasonEl.value.trim();
            if (!lines.length) return SF.toast('Indiquez au moins une pièce à retirer', 'error');
            if (!reason) { reasonEl.style.borderColor = 'var(--danger)'; reasonEl.focus(); return; }
            btn.disabled = true;
            try {
                const res = await SF.api(`/api/deliveries/${deliveryId}/cancel-items`, { method: 'POST', body: { lines, reason } });
                SF.toast(`Retiré : ${res.removed.join(', ')}${res.refund ? ` · rembourser ${SF.fmt.ar(res.refund)} au client` : ''}`, 'success', 6000);
                finish(res);
            } catch (err) { SF.toast(err.message, 'error'); btn.disabled = false; }
        });
    });
};

/* ============================================================
   Scanner code-barres physique (clavier HID) actif sur TOUTE la page.
   Un lecteur tape le code très vite puis envoie Entrée. On détecte cette
   rafale rapide et on appelle le handler avec le code — quel que soit le
   focus (pas besoin d'être dans la barre de recherche).
   Usage : SF.Scanner.init(code => Page.onScan(code));
   ============================================================ */
SF.Scanner = {
    buffer: '', startTime: 0, lastTime: 0, fast: true, handler: null, minLen: 4, skipInModal: false, _bound: null,
    // opts.skipInModal : ne rien intercepter quand une fenêtre (modale) est ouverte — ses propres champs
    // de scan (ex. upgrade) gardent la main et un scan ne remplit pas le panier derrière.
    init(handler, opts = {}) {
        this.handler = handler;
        this.minLen = opts.minLen || 4;
        this.skipInModal = !!opts.skipInModal;
        if (this._bound) return;                 // un seul écouteur global
        this._bound = e => this._onKey(e);
        document.addEventListener('keydown', this._bound, true);   // phase capture
    },
    // Champ où l'on peut taper (sinon : corps de page, bouton, carte… → toute saisie + Entrée = scan).
    _editable(el) { return !!el && (el.tagName === 'TEXTAREA' || el.isContentEditable || (el.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color'].includes(el.type))); },
    _onKey(e) {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (this.skipInModal && document.querySelector('.modal-overlay.active')) { this.buffer = ''; return; }
        const now = Date.now(), gap = now - this.lastTime;
        this.lastTime = now;
        if (e.key === 'Enter' || (e.key === 'Tab' && this.buffer.length >= this.minLen && this.fast)) {
            const code = this.buffer.trim(), total = now - this.startTime;
            const el = document.activeElement, inField = this._editable(el);
            // Hors champ de saisie : tout code + Entrée est un scan (lecteur lent compris). Dans un champ :
            // rafale rapide + longueur plausible => scan (sinon saisie humaine laissée au champ).
            const scanned = code.length >= this.minLen && (!inField || (this.fast && total < code.length * 60 + 120));
            this.buffer = '';
            if (scanned && this.handler) {
                e.preventDefault(); e.stopPropagation();
                // Efface les caractères qui auraient fui dans un champ focalisé.
                if (inField && el.value && el.value.replace(/\s/g, '').endsWith(code.replace(/\s/g, ''))) el.value = '';
                try { this.handler(code); } catch (err) { /* ignore */ }
            }
            return;
        }
        if (e.key.length !== 1) return;          // Shift, flèches, F-keys…
        if (!this.buffer || gap > 120) { this.buffer = e.key; this.startTime = now; this.fast = true; }
        else { this.buffer += e.key; if (gap > 90) this.fast = false; }
    }
};

/* ============================================================
   Scan code-barres par CAMÉRA (téléphone) — même rôle que le lecteur
   physique, mais via l'appareil photo (caméra arrière). Utilise l'API
   native BarcodeDetector (Android Chrome…). Scan CONTINU : chaque code
   détecté appelle le handler (anti-doublon 1,5 s) — bip + vibration.
   Usage : SF.CamScan.open(code => Page.onScan(code));
   ============================================================ */
SF.CamScan = {
    _stream: null, _timer: null, _detector: null, _running: false, _last: '', _lastAt: 0, _cb: null, _ac: null, _zxing: null, _zxingPromise: null,
    supported() {
        return this._reason() === '';
    },
    // Retourne '' si le scan caméra est possible, sinon le motif précis du blocage.
    _reason() {
        const host = location.hostname;
        const localHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
        // getUserMedia n'existe QUE dans un contexte sécurisé (HTTPS ou localhost).
        // Sur téléphone, on ouvre souvent l'app via http://192.168.x.x → bloqué.
        if (!window.isSecureContext && !localHost)
            return "Caméra bloquée : la page n'est pas en HTTPS. Sur téléphone, ouvrir l'app par son adresse IP (http://…) empêche l'accès caméra. Ouvrez-la en https:// (ou via localhost).";
        if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia))
            return "Ce navigateur ne donne pas accès à la caméra. Essayez Chrome sur Android.";
        // La lecture des codes-barres se fait soit via BarcodeDetector natif (Android
        // Chrome), soit via la bibliothèque ZXing embarquée (Safari iPhone, Firefox…).
        // Les deux exigent seulement un contexte sécurisé + accès caméra, déjà vérifiés.
        return '';
    },
    _build() {
        let ov = document.getElementById('sfCamScan');
        if (ov) return ov;
        ov = document.createElement('div');
        ov.id = 'sfCamScan';
        ov.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.92);display:none;flex-direction:column;align-items:center;justify-content:center;';
        ov.innerHTML =
            '<div style="position:absolute;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;padding:14px 16px;color:#fff;">' +
                '<span style="font-weight:700;font-size:15px;"><i class="fas fa-camera"></i> Scan caméra</span>' +
                '<button type="button" id="sfCamClose" style="background:rgba(255,255,255,.15);border:none;color:#fff;width:38px;height:38px;border-radius:50%;font-size:20px;line-height:1;cursor:pointer;">&times;</button>' +
            '</div>' +
            '<div style="position:relative;width:min(92vw,460px);aspect-ratio:3/4;max-height:66vh;border-radius:16px;overflow:hidden;background:#000;">' +
                '<video id="sfCamVideo" playsinline muted style="width:100%;height:100%;object-fit:cover;"></video>' +
                '<div style="position:absolute;inset:14% 9%;border:3px solid var(--accent,#c8f94b);border-radius:12px;box-shadow:0 0 0 100vmax rgba(0,0,0,.35);"></div>' +
            '</div>' +
            '<div id="sfCamStatus" style="color:#fff;margin-top:16px;font-size:14px;text-align:center;min-height:22px;padding:0 20px;">Visez le code-barres…</div>' +
            '<button type="button" id="sfCamDone" class="btn btn-primary" style="margin-top:14px;"><i class="fas fa-check"></i> Terminer</button>';
        document.body.appendChild(ov);
        ov.querySelector('#sfCamClose').onclick = () => this.close();
        ov.querySelector('#sfCamDone').onclick = () => this.close();
        return ov;
    },
    async open(handler) {
        const reason = this._reason();
        if (reason) {
            SF.toast(reason, 'error', 6000);
            return false;
        }
        this._cb = handler;
        const ov = this._build();
        ov.style.display = 'flex';
        const status = ov.querySelector('#sfCamStatus');
        const video = ov.querySelector('#sfCamVideo');
        status.textContent = 'Activation de la caméra…';
        this._running = true; this._last = ''; this._lastAt = 0;
        // Android Chrome : détecteur natif (rapide). iPhone Safari / Firefox : repli ZXing.
        if (typeof window.BarcodeDetector !== 'undefined') return this._openNative(video, status);
        return this._openZxing(video, status);
    },
    // Chemin natif : BarcodeDetector (Chromium/Android).
    async _openNative(video, status) {
        try {
            this._stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        } catch (e) {
            status.textContent = 'Accès à la caméra refusé.';
            SF.toast('Accès à la caméra refusé.', 'error');
            this.close(); return false;
        }
        video.srcObject = this._stream; video.muted = true;
        try { await video.play(); } catch (e) {}
        try { this._detector = new BarcodeDetector({ formats: ['code_39', 'code_128', 'code_93', 'ean_13', 'ean_8', 'itf', 'codabar', 'qr_code'] }); }
        catch (e) { try { this._detector = new BarcodeDetector(); } catch (e2) { SF.toast('Détecteur de code-barres indisponible.', 'error'); this.close(); return false; } }
        status.textContent = 'Visez le code-barres…';
        this._loop(video, status);
        return true;
    },
    // Chemin de repli : bibliothèque ZXing (Safari iPhone, Firefox…). ZXing gère
    // lui-même le flux caméra (getUserMedia) et l'attache à notre <video>.
    async _openZxing(video, status) {
        try { await this._loadZxing(); }
        catch (e) { status.textContent = 'Lecteur indisponible.'; SF.toast('Impossible de charger le lecteur de code-barres.', 'error'); this.close(); return false; }
        if (typeof window.ZXing === 'undefined' || !window.ZXing.BrowserMultiFormatReader) {
            SF.toast('Lecteur de code-barres indisponible.', 'error'); this.close(); return false;
        }
        try {
            this._zxing = new window.ZXing.BrowserMultiFormatReader(undefined, 300);
            const constraints = { video: { facingMode: { ideal: 'environment' } }, audio: false };
            await this._zxing.decodeFromConstraints(constraints, video, (result) => {
                if (!this._running || !result) return;
                const raw = String(result.getText ? result.getText() : (result.text || '')).trim();
                const now = Date.now();
                if (raw && (raw !== this._last || now - this._lastAt > 1500)) {
                    this._last = raw; this._lastAt = now;
                    this._feedback(status, raw);
                    try { this._cb && this._cb(raw); } catch (e) {}
                }
            });
            status.textContent = 'Visez le code-barres…';
        } catch (e) {
            status.textContent = 'Accès à la caméra refusé.';
            SF.toast('Accès à la caméra refusé ou indisponible.', 'error');
            this.close(); return false;
        }
        return true;
    },
    // Charge la bibliothèque ZXing embarquée (une seule fois), à la demande.
    _loadZxing() {
        if (window.ZXing && window.ZXing.BrowserMultiFormatReader) return Promise.resolve();
        if (this._zxingPromise) return this._zxingPromise;
        this._zxingPromise = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = '/vendor/js/zxing.min.js';
            s.async = true;
            s.onload = () => resolve();
            s.onerror = () => { this._zxingPromise = null; reject(new Error('zxing load failed')); };
            document.head.appendChild(s);
        });
        return this._zxingPromise;
    },
    async _loop(video, status) {
        if (!this._running) return;
        try {
            const codes = await this._detector.detect(video);
            if (codes && codes.length) {
                const raw = String(codes[0].rawValue || '').trim();
                const now = Date.now();
                if (raw && (raw !== this._last || now - this._lastAt > 1500)) {
                    this._last = raw; this._lastAt = now;
                    this._feedback(status, raw);
                    try { this._cb && this._cb(raw); } catch (e) {}
                }
            }
        } catch (e) { /* image pas prête */ }
        this._timer = setTimeout(() => this._loop(video, status), 140);
    },
    _feedback(status, code) {
        if (status) status.innerHTML = '<span style="color:var(--accent,#c8f94b);font-weight:700;"><i class="fas fa-check"></i> ' + SF.esc(code) + '</span>';
        try {
            const ac = this._ac || (this._ac = new (window.AudioContext || window.webkitAudioContext)());
            const o = ac.createOscillator(), g = ac.createGain();
            o.type = 'square'; o.frequency.value = 880; o.connect(g); g.connect(ac.destination);
            g.gain.value = 0.08; o.start(); o.stop(ac.currentTime + 0.08);
        } catch (e) {}
        if (navigator.vibrate) { try { navigator.vibrate(40); } catch (e) {} }
    },
    close() {
        this._running = false;
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        if (this._zxing) { try { this._zxing.reset(); } catch (e) {} this._zxing = null; }
        if (this._stream) { this._stream.getTracks().forEach(t => t.stop()); this._stream = null; }
        const ov = document.getElementById('sfCamScan');
        if (ov) { const v = ov.querySelector('#sfCamVideo'); if (v) { try { v.srcObject = null; } catch (e) {} } ov.style.display = 'none'; }
    }
};

})();
