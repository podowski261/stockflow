/* STOCKFLOW — Service Worker (PWA installable, cache léger de la coquille).
   Stratégie :
   - Code applicatif (/css, /js) → réseau d'abord (toujours à jour ; repli cache hors-ligne).
   - Bibliothèques (/vendor), images, polices → cache-first (rarement modifiées).
   - Pages HTML → affichées AUSSITÔT depuis le cache puis mises à jour en arrière-plan (le tunnel coûte
     ≈ 1 s par requête) ; si la page a changé (déploiement), la page ouverte propose d'actualiser.
   - API et SSE → jamais mis en cache.
*/
const CACHE = 'stockflow-v88';
const SHELL = [
    '/css/style.css', '/css/sf.css',
    '/js/sf-core.js', '/js/sf-layout.js',
    '/img/sf-logo-light.svg', '/img/sf-logo-dark.svg',
    '/vendor/fontawesome/css/all.min.css',
    '/manifest.webmanifest'
];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

// Préchauffage : la page ouverte envoie les pages voisines (barre du bas, onglets) — leur HTML est mis en
// cache s'il n'y est pas encore, pour qu'une PREMIÈRE ouverture soit aussi instantanée.
self.addEventListener('message', e => {
    const d = e.data || {};
    if (d.type !== 'sf-warm' || !Array.isArray(d.urls)) return;
    e.waitUntil(caches.open(CACHE).then(c => Promise.all(d.urls.slice(0, 12).map(async u => {
        try {
            const url = new URL(u, self.location.origin);
            if (url.origin !== self.location.origin || !/\.html$/i.test(url.pathname)) return;
            const key = url.origin + url.pathname;
            if (await c.match(key)) return;
            const res = await fetch(key, { credentials: 'include' });
            if (res && res.ok && !res.redirected) c.put(key, new Response(await res.text(), { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
        } catch (err) {}
    }))));
});

self.addEventListener('fetch', e => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== location.origin) return;

    // Jamais de cache pour l'API ni le flux SSE.
    if (url.pathname.startsWith('/api/')) return;

    // Bibliothèques et médias : cache-first (mise à jour en arrière-plan).
    const cacheFirst = url.pathname.startsWith('/vendor/')
                    || /\.(svg|png|jpg|jpeg|webp|gif|ico|woff2?|ttf)$/i.test(url.pathname);
    // Code applicatif : réseau d'abord.
    const networkFirst = /\.(css|js)$/i.test(url.pathname) && !url.pathname.startsWith('/vendor/');

    // Code applicatif VERSIONNÉ (?v=…, injecté par le serveur) : l'URL change à chaque mise à jour →
    // servi directement depuis le cache, sans aucune requête réseau ; l'ancienne version est purgée.
    if (/\.(css|js)$/i.test(url.pathname) && url.searchParams.has('v')) {
        e.respondWith(caches.open(CACHE).then(c => c.match(req).then(hit => hit || fetch(req).then(res => {
            if (res && res.ok) {
                c.put(req, res.clone());
                c.keys().then(ks => ks.forEach(k => { const u = new URL(k.url); if (u.pathname === url.pathname && u.search !== url.search) c.delete(k); }));
            }
            return res;
        }))));
        return;
    }
    if (cacheFirst) {
        e.respondWith(
            caches.match(req).then(cached => {
                const net = fetch(req).then(res => {
                    if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
                    return res;
                }).catch(() => cached);
                return cached || net;
            })
        );
        return;
    }
    if (networkFirst) {
        e.respondWith(
            fetch(req).then(res => {
                if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
                return res;
            }).catch(() => caches.match(req))
        );
        return;
    }
    // Pages HTML : cache immédiat + rafraîchissement en arrière-plan (stale-while-revalidate).
    if (req.mode === 'navigate' && /\.html$/i.test(url.pathname)) {
        const key = url.origin + url.pathname;   // une entrée par page (paramètres ignorés)
        e.respondWith(caches.open(CACHE).then(async c => {
            const hit = await c.match(key);
            const net = fetch(req).then(async res => {
                if (res && res.ok && !res.redirected && (res.headers.get('content-type') || '').includes('text/html')) {
                    const fresh = await res.clone().text();
                    if (hit) {
                        const old = await hit.clone().text();
                        if (old !== fresh) self.clients.matchAll({ type: 'window' }).then(cs => cs.forEach(cl => cl.postMessage({ type: 'sf-page-updated', path: url.pathname })));
                    }
                    await c.put(key, new Response(fresh, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }));
                }
                return res;
            });
            if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
            return net.catch(() => caches.match('/login.html'));
        }));
        return;
    }
    // Autre navigation : réseau d'abord, repli sur la connexion en cache si hors-ligne.
    e.respondWith(fetch(req).catch(() => caches.match(req).then(r => r || caches.match('/login.html'))));
});
