'use strict';

// ============================================================
//  STOCKFLOW — Serveur (Express + SQLite + SSE temps réel)
//  Magasin d'ordinateurs : neuf / occasion / reconditionné.
//  Port par défaut: 4300 | Timezone: Madagascar (UTC+3) | Devise: Ariary
//  Fonctionne sous Linux (Ubuntu) et Windows.
// ============================================================

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt  = require('bcryptjs');
const session = require('express-session');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');

const app  = express();
const PORT = process.env.PORT || 4300;
// Le tunnel Cloudflare (cloudflared) se connecte en local : on ne fait confiance aux en-têtes
// X-Forwarded-* que s'ils viennent de la boucle locale (req.ip = vraie IP client).
app.set('trust proxy', 'loopback');

// Répertoire de données : à côté de l'exécutable une fois empaqueté (.exe),
// sinon le dossier du projet. Les fichiers modifiables (base, uploads, secret)
// vivent ici — jamais dans le snapshot en lecture seule de pkg.
const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;

// ============================================================
//  TIMEZONE MADAGASCAR (UTC+3, pas d'heure d'été)
//  Source unique de vérité, indépendante du fuseau de la machine.
// ============================================================
const MG_OFFSET_MS = 3 * 60 * 60 * 1000;
function mgNow() { return new Date(Date.now() + MG_OFFSET_MS); }
function getDateTime() {
    const d = mgNow(), p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
         + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
function getDate() {
    const d = mgNow(), p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
// Code-barres PARTAGÉ d'un accessoire : même modèle = même code (ex : produit 123 → 'A000123').
// Les ordinateurs gardent un n° de série UNIQUE par unité ; les accessoires n'en ont pas
// (serial NULL en base) et sont identifiés/scannés par ce code de modèle.
function accCode(productId) { return 'A' + String(productId).padStart(6, '0'); }
// Emplacement(s) au dépôt : un produit peut occuper PLUSIEURS emplacements (ex. « E04, D03 »).
// Stocké en liste séparée par des virgules ; normalisée (trim, sans doublon, casse ignorée).
function normEmplacement(s) {
    const parts = String(s || '').split(/[,;\n]+/).map(x => x.trim().replace(/\s+/g, ' ')).filter(Boolean);
    const seen = new Set(), out = [];
    for (const p of parts) { const k = p.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(p); } }
    return out.join(', ') || null;
}
function parseAccCode(code) { const m = /^A0*(\d+)$/i.exec(String(code || '').trim()); return m ? parseInt(m[1], 10) : null; }
// Normalise un texte pour comparaison (minuscules, sans accents).
function normText(s) { return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
// Accessoires SUIVIS À L'UNITÉ : la RAM et les disques durs reçoivent un numéro de série
// UNIQUE par pièce (comme les ordinateurs), pour faciliter leur suivi individuel — au lieu
// du code de modèle partagé des autres accessoires. Détection par la catégorie saisie.
function isSerializedCategory(category) {
    const c = normText(category);
    if (!c) return false;
    return /\b(ram|memoire|barrette)\b/.test(c) || /\b(disque|ssd|hdd|nvme)\b/.test(c);
}
// Serial d'affichage d'une unité :
//  - une unité qui a un serial (ordinateur, OU ancien accessoire déjà étiqueté) → son serial réel
//    (l'étiquette physique porte ce numéro, on le respecte) ;
//  - un accessoire SANS serial (nouveau, non étiqueté individuellement) → le code de modèle partagé.
function displaySerial(u) { return u.serial || (u.is_accessory ? accCode(u.product_id) : null); }
// Ajoute N jours (ou mois) à une date AAAA-MM-JJ et renvoie AAAA-MM-JJ.
function addDays(dateStr, days) {
    const t = Date.parse((dateStr || getDate()) + 'T00:00:00Z');
    const d = new Date(t + days * 86400000), p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
// Jours restants jusqu'à dateStr (négatif = expiré).
function daysUntil(dateStr) {
    if (!dateStr) return null;
    const a = Date.parse(getDate() + 'T00:00:00Z');
    const b = Date.parse(dateStr + 'T00:00:00Z');
    if (isNaN(a) || isNaN(b)) return null;
    return Math.round((b - a) / 86400000);
}

// ============================================================
//  RÔLES
// ============================================================
// Clé technique → libellé affiché. Sert à la validation (serveur) et au menu (client).
const ROLES = {
    admin:            'Administrateur',
    gestion_stock:    'Gestionnaire du stock',
    caisse:           'Caisse',
    technicien:       'Technicien',
    commercial:       'Commercial (boutique)',
    commercial_ligne: 'Commercial en ligne',
    coordinateur:     'Coordinateur de livraison',
    securite:         'Sécurité (contrôle de sortie)'
    // NB : plus de rôle « livreur » — le livreur n'a pas de compte, seul son nom est assigné.
};
const ROLE_KEYS = Object.keys(ROLES);
// Page d'accueil par rôle après connexion.
const ROLE_HOME = {
    admin:            '/index.html',
    gestion_stock:    '/index.html',
    caisse:           '/encaissement.html',
    technicien:       '/index.html',
    commercial:       '/index.html',
    commercial_ligne: '/index.html',
    coordinateur:     '/index.html',
    securite:         '/controle-sortie.html'
};
function normalizeRole(r) {
    r = String(r || '').trim();
    return ROLE_KEYS.includes(r) ? r : 'caisse';
}
// Rôles MULTIPLES : un compte a un rôle principal (`role`) + d'éventuels rôles supplémentaires
// (`extra_roles`, clés séparées par des virgules). Ex. : un commercial à la fois « boutique » ET
// « en ligne ». Les rôles supplémentaires ne peuvent pas être « admin » ni dupliquer le principal.
function parseExtraRoles(raw, primary) {
    return String(raw || '').split(',').map(s => s.trim())
        .filter(r => ROLE_KEYS.includes(r) && r !== 'admin' && r !== primary)
        .filter((r, i, a) => a.indexOf(r) === i);
}
// Liste complète des rôles d'un enregistrement utilisateur (principal en tête).
function rolesOf(userRow) {
    const primary = normalizeRole(userRow && userRow.role);
    return [primary, ...parseExtraRoles(userRow && userRow.extra_roles, primary)];
}
// L'utilisateur possède-t-il AU MOINS un des rôles demandés ? (n'accorde pas admin implicitement —
// les appelants qui veulent le bypass admin le testent séparément, cf. requireRole.)
function hasRole(u, ...want) {
    if (!u) return false;
    const set = Array.isArray(u.roles) && u.roles.length ? u.roles : [u.role];
    return want.some(r => set.includes(r));
}
// Retire le prix d'achat (purchase_price) des données envoyées aux non-admins.
function stripCost(rows, user) {
    if (user && user.role === 'admin') return rows;
    const clean = r => { if (r && typeof r === 'object' && 'purchase_price' in r) { const c = { ...r }; delete c.purchase_price; return c; } return r; };
    return Array.isArray(rows) ? rows.map(clean) : clean(rows);
}

// ============================================================
//  SSE — TEMPS RÉEL (notifications, comptes à rebours, mouvements)
//  Chaque client authentifié ouvre /api/events. On peut diffuser à
//  tout le monde, à un rôle précis, ou à un utilisateur précis.
// ============================================================
const sseClients = new Map();   // id → { res, userId, role, roles }
let   sseNextId  = 1;

function sseSend(res, event, data) {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); return true; }
    catch { return false; }
}

/**
 * Diffuse un événement SSE.
 * @param {string} event
 * @param {object} data
 * @param {object} [target] - { role } ou { userId } ou { roles:[...] }. Absent = tous.
 */
function broadcast(event, data, target) {
    for (const [id, c] of sseClients) {
        if (target) {
            // Rôles multiples : un compte reçoit les diffusions de TOUS ses rôles (principal + supplémentaires).
            const mine = c.roles && c.roles.length ? c.roles : [c.role];
            if (target.userId && c.userId !== target.userId) continue;
            if (target.role   && !mine.includes(target.role)) continue;
            if (target.roles  && !target.roles.some(r => mine.includes(r))) continue;
        }
        if (!sseSend(c.res, event, data)) sseClients.delete(id);
    }
}

// Keepalive anti-timeout (Nginx / proxies).
setInterval(() => {
    for (const [id, c] of sseClients)
        if (!sseSend(c.res, 'ping', {})) sseClients.delete(id);
}, 25_000);

// ============================================================
//  MIDDLEWARE
// ============================================================
const IS_PROD = process.env.NODE_ENV === 'production';
// Requêtes API lentes (> 400 ms côté serveur) : tracées dans le journal pour cibler les optimisations.
app.use((req, res, next) => {
    if (!req.path.startsWith('/api/') || req.path === '/api/events') return next();
    const t0 = process.hrtime.bigint();
    res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if (ms > 400) console.log(`[lent] ${req.method} ${req.originalUrl.slice(0, 120)} ${Math.round(ms)} ms ${res.statusCode} ${res.getHeader('Content-Length') || ''}`);
    });
    next();
});
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
// Réponses JSON volumineuses compressées (gzip) : le tunnel Cloudflare transporte sinon le JSON brut
// depuis la connexion du magasin (≈ 1,4 Mo → 150 Ko pour les pages d'analyse, stock, ventes…).
app.use((req, res, next) => {
    if (!/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return next();
    const json = res.json.bind(res);
    res.json = body => {
        const s = JSON.stringify(body);
        if (s === undefined || s.length < 8192 || res.headersSent) return json(body);
        require('zlib').gzip(s, { level: 6 }, (err, buf) => {
            if (res.headersSent) return;
            if (err) return json(body);
            res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' });
            res.end(buf);
        });
        return res;
    };
    next();
});

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    // CSP : scripts, styles, polices et appels réseau UNIQUEMENT depuis ce serveur (aucun script tiers ne
    // peut être chargé ni recevoir de données). 'unsafe-inline' reste nécessaire : les pages ont leur
    // code et leurs gestionnaires onclick en ligne. Images : ce serveur + fonds de carte (Starlink).
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://server.arcgisonline.com",
        "font-src 'self' data:",
        "connect-src 'self'",
        "media-src 'self' blob:",
        "worker-src 'self' blob:",
        "frame-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'self'"
    ].join('; '));
    // HTTPS (tunnel Cloudflare) : le navigateur n'utilisera plus que HTTPS pour ce domaine.
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    next();
});

// Pages HTML : chaque /js/… et /css/… local reçoit ?v=<date de modification>. Le proxy (Cloudflare)
// impose 4 h de cache navigateur aux .js/.css ; avec une URL qui change à chaque mise à jour, les
// navigateurs chargent aussitôt la nouvelle version (les pages HTML, elles, ne sont jamais en cache).
const PUBLIC_DIR = path.join(APP_DIR, 'public');
function assetVersion(rel) {
    try { return Math.floor(fs.statSync(path.join(PUBLIC_DIR, rel)).mtimeMs / 1000).toString(36); } catch (e) { return null; }
}
app.use((req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !/\.html$/i.test(req.path)) return next();
    let file;
    try { file = path.resolve(PUBLIC_DIR, '.' + decodeURIComponent(req.path)); } catch (e) { return next(); }
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return next();
    fs.readFile(file, 'utf8', (err, html) => {
        if (err) return next();
        const out = html.replace(/(<(?:script|link)\b[^>]*?\b(?:src|href)=")(\/(?:js|css)\/[^"?#]+\.(?:js|css))(")/g, (m, a, url, b) => {
            const v = assetVersion(url);
            return v ? `${a}${url}?v=${v}${b}` : m;
        });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        res.send(out);
    });
});

// Cache navigateur (mobile : moins de requêtes, ouverture des pages plus rapide) :
//  - /js /css appelés avec ?v=<version> (injecté ci-dessus) : l'URL change à chaque mise à jour
//    → gardés 1 an sans revalidation ; sans ?v= : toujours revalidés.
//  - /vendor (bibliothèques figées), /uploads (noms uniques horodatés) : 30 jours ; icônes / images : 7 jours.
app.use(express.static(path.join(APP_DIR, 'public'), {
    setHeaders: (res, filePath) => {
        const rel = filePath.slice(PUBLIC_DIR.length).split(path.sep).join('/');
        const versioned = res.req && res.req.query && res.req.query.v;
        if (/\.html$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        else if (/^\/(js|css)\//.test(rel)) res.setHeader('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'no-cache, must-revalidate');
        else if (/^\/(vendor|uploads)\//.test(rel)) res.setHeader('Cache-Control', 'public, max-age=2592000');
        else if (/\.js$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache, must-revalidate');   // sw.js
        else if (/\.(png|ico|svg|webp|jpe?g|woff2?)$/i.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=604800');
    }
}));

// Secret de session : env prioritaire, sinon secret aléatoire persistant par installation.
let SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
    const secretFile = path.join(APP_DIR, '.session-secret');
    try {
        if (fs.existsSync(secretFile)) SESSION_SECRET = fs.readFileSync(secretFile, 'utf8').trim();
        else { SESSION_SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(secretFile, SESSION_SECRET); }
    } catch { SESSION_SECRET = 'dev_only_insecure_secret'; }
}
// Sessions persistées en base (table sessions) : un redémarrage du serveur ne déconnecte plus personne.
// touch() est limité à une écriture par minute et par session (sinon une écriture SQL par requête).
class SqliteSessionStore extends session.Store {
    constructor() { super(); this.touched = new Map(); }
    static expiresOf(sess) {
        const e = sess && sess.cookie && sess.cookie.expires;
        return e ? new Date(e).getTime() : Date.now() + 24 * 60 * 60 * 1000;
    }
    get(sid, cb) {
        db.get('SELECT sess, expires FROM sessions WHERE sid = ?', [sid], (err, row) => {
            if (err) return cb(err);
            if (!row) return cb(null, null);
            if (row.expires < Date.now()) { this.destroy(sid); return cb(null, null); }
            let sess = null; try { sess = JSON.parse(row.sess); } catch (e) {}
            cb(null, sess);
        });
    }
    set(sid, sess, cb) {
        this.touched.set(sid, Date.now());
        db.run(`INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
                ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires`,
            [sid, JSON.stringify(sess), SqliteSessionStore.expiresOf(sess)], err => cb && cb(err || null));
    }
    destroy(sid, cb) {
        this.touched.delete(sid);
        db.run('DELETE FROM sessions WHERE sid = ?', [sid], err => cb && cb(err || null));
    }
    touch(sid, sess, cb) {
        const last = this.touched.get(sid);
        if (last && Date.now() - last < 60 * 1000) return cb && cb(null);
        this.touched.set(sid, Date.now());
        db.run('UPDATE sessions SET expires = ? WHERE sid = ?', [SqliteSessionStore.expiresOf(sess), sid], err => cb && cb(err || null));
    }
    purge() {
        const now = Date.now();
        for (const [sid, t] of this.touched) if (now - t > 60 * 60 * 1000) this.touched.delete(sid);
        db.run('DELETE FROM sessions WHERE expires < ?', [now], () => {});
    }
}
const sessionStore = new SqliteSessionStore();
setInterval(() => sessionStore.purge(), 60 * 60 * 1000);

app.use(session({
    store: sessionStore,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    // 'auto' : cookie « Secure » dès que la requête arrive en HTTPS (tunnel, X-Forwarded-Proto de confiance),
    // sans casser l'accès local en http://localhost. IS_PROD force Secure dans tous les cas.
    cookie: { secure: IS_PROD ? true : 'auto', httpOnly: true, sameSite: 'lax', maxAge: 24 * 60 * 60 * 1000 }
}));

// ─── Journal complet des actions (admin › Journal d'activité) ───
// Toute écriture réussie (POST/PUT/PATCH/DELETE) d'un utilisateur connecté est tracée, même si la route
// n'appelle pas logActivity : la route qui le fait déjà (action métier détaillée) n'est pas doublée.
// Le corps de la requête n'est JAMAIS stocké (mots de passe, codes…) : seulement la route et l'IP.
const LOG_SKIP = /^\/api\/(notifications\/|pos\/drafts|inventaire\/draft|login$|forgot\/|events$)/;
app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || !req.path.startsWith('/api/') || LOG_SKIP.test(req.path)) return next();
    const u = req.session && req.session.user;   // capturé AVANT (la déconnexion détruit la session)
    if (!u) return next();
    res.on('finish', () => {
        if (req._logged || res.statusCode >= 400) return;
        const m = /\/(\d+)(?:\/|$)/.exec(req.path);
        db.run(`INSERT INTO activity_log (user_id, user_name, action, entity, entity_id, details, created_at, ip, path) VALUES (?,?,?,?,?,?,?,?,?)`,
            [u.id, u.full_name || u.username, req.path === '/api/logout' ? 'logout' : 'api', null, m ? m[1] : null, null, getDateTime(), clientIp(req), `${req.method} ${req.path}`.slice(0, 200)], () => {});
    });
    next();
});

// ─── Uploads (images produits / logo) ───────────────────────
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(APP_DIR, 'public/uploads');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = { 'image/jpeg': '.jpg', 'image/png': '.png',
                      'image/webp': '.webp', 'image/gif': '.gif' }[file.mimetype] || '';
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + ext);
    }
});
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const UPLOADS_DIR = path.join(APP_DIR, 'public', 'uploads');
// Chemin d'image accepté depuis le client : uniquement « /uploads/<nom de fichier> » (pas de « .. », pas
// de sous-dossier, pas d'URL externe). Tout le reste → null (protège la suppression et l'affichage).
function safeUploadPath(p) {
    const s = String(p == null ? '' : p).trim();
    return /^\/uploads\/[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/.test(s) && !s.includes('..') ? s : null;
}
// Supprime un fichier uploadé : uniquement à l'intérieur de public/uploads (nom de fichier seul).
function unlinkUpload(rel) {
    if (!safeUploadPath(rel)) return;
    const full = path.join(UPLOADS_DIR, path.basename(rel));
    if (full.startsWith(UPLOADS_DIR + path.sep)) fs.unlink(full, () => {});
}
const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) =>
        ALLOWED_IMAGE_TYPES.includes(file.mimetype) ? cb(null, true)
        : cb(new Error('Type de fichier non autorisé (images uniquement)'))
});

// ============================================================
//  BASE DE DONNÉES
// ============================================================
const DB_PATH = path.join(APP_DIR, 'database.sqlite');
// Mot de passe initial du compte admin créé à la 1re installation : variable d'environnement
// ADMIN_DEFAULT_PASSWORD, sinon tiré AU HASARD et écrit (une seule fois) dans le fichier
// .admin-initial-password à côté de la base — jamais dans le code (dépôt public) ni dans les logs.
const ADMIN_PWD_FILE = path.join(APP_DIR, '.admin-initial-password');
function adminInitialPassword() {
    if (process.env.ADMIN_DEFAULT_PASSWORD) return process.env.ADMIN_DEFAULT_PASSWORD;
    try { const s = fs.readFileSync(ADMIN_PWD_FILE, 'utf8').trim(); if (s) return s; } catch (e) {}
    const pwd = crypto.randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 14);
    try { fs.writeFileSync(ADMIN_PWD_FILE, pwd + '\n', { mode: 0o600 }); } catch (e) {}
    return pwd;
}
// Mots de passe d'admin FAIBLES connus (anciennes versions publiques du code) : un compte admin par
// défaut qui en utilise encore un doit le changer avant toute autre action.
const WEAK_ADMIN_PASSWORDS = ['admin_26', 'admin', 'admin123'];
let db = new sqlite3.Database(DB_PATH, err => {
    if (err) console.error('❌ Erreur connexion DB:', err);
    else     console.log('✅ Base de données connectée');
});

// ============================================================
//  TRANSACTIONS SÉRIALISÉES (connexion sqlite3 UNIQUE)
// ============================================================
// Avec une seule connexion, un BEGIN « capte » toutes les requêtes émises pendant qu'il est
// ouvert, y compris celles des autres requêtes HTTP (et un ROLLBACK les annulerait aussi).
// withTx(fn) prend donc un verrou exclusif : il attend la fin des requêtes en cours, ouvre la
// transaction, et pendant celle-ci seules les requêtes de SON contexte (AsyncLocalStorage) passent ;
// les autres sont mises en file et repartent, dans l'ordre, après COMMIT/ROLLBACK.
const { AsyncLocalStorage, AsyncResource } = require('async_hooks');
const txContext = new AsyncLocalStorage();
let txActive = null;        // jeton de la transaction en cours (ou en attente de démarrage)
let txInflight = 0;         // requêtes SQL en cours d'exécution
let txDrainWaiter = null;
const txPending = [];       // requêtes d'autres contextes, différées jusqu'à la fin de la transaction
let txChain = Promise.resolve();

function gateDb(database) {
    for (const m of ['run', 'get', 'all', 'exec']) {
        const orig = database[m];
        database[m] = function (...args) {
            if (txActive && txContext.getStore() !== txActive) {
                const ctx = new AsyncResource('sf-db-wait');
                txPending.push(() => ctx.runInAsyncScope(() => database[m](...args)));
                return database;
            }
            txInflight++;
            const ctx = new AsyncResource('sf-db');
            const done = () => {
                if (--txInflight === 0 && txDrainWaiter) { const w = txDrainWaiter; txDrainWaiter = null; w(); }
            };
            const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
            args.push(function (err, ...rest) {
                try {
                    if (cb) return ctx.runInAsyncScope(cb, this, err, ...rest);
                    if (err) console.error('SQL :', err.message);
                } finally { done(); }
            });
            return orig.apply(database, args);
        };
    }
}
gateDb(db);

function withTx(fn) {
    // Déjà dans la transaction (appel imbriqué) : on exécute simplement.
    if (txActive && txContext.getStore() === txActive) return fn();
    const run = txChain.then(async () => {
        const token = {};
        txActive = token;
        if (txInflight > 0) await new Promise(r => { txDrainWaiter = r; });
        try {
            return await txContext.run(token, async () => {
                await dbRun('BEGIN IMMEDIATE');
                try { const r = await fn(); await dbRun('COMMIT'); return r; }
                catch (e) { await dbRun('ROLLBACK').catch(() => {}); throw e; }
            });
        } finally {
            txActive = null;
            txPending.splice(0).forEach(f => f());
        }
    });
    txChain = run.catch(() => {});
    return run;
}
// Erreur métier levée dans une transaction → réponse HTTP avec ce statut (ROLLBACK fait).
function txError(status, message) { const e = new Error(message); e.status = status; return e; }

// ============================================================
//  TÂCHES DE DÉMARRAGE (migrations)
// ============================================================
// Exécutées UNE PAR UNE dans l'ordre de leur rang (ancien délai en ms), chacune attendant que
// toutes ses requêtes SQL soient terminées ; le serveur n'écoute qu'ensuite → plus de requête
// servie sur un schéma incomplet, plus de déduplication pendant les ventes.
const startupTasks = [];
function startupTask(fn, order) { startupTasks.push({ fn, order, seq: startupTasks.length }); }
function dbIdle() {
    return new Promise(resolve => {
        const check = () => (txInflight === 0 && !txActive) ? resolve() : setTimeout(check, 10);
        setTimeout(check, 10);
    });
}
async function runStartupTasks() {
    await dbIdle();                       // schéma de base (initSchema) terminé
    while (startupTasks.length) {         // une tâche peut en ajouter d'autres (ordre recalculé)
        startupTasks.sort((a, b) => a.order - b.order || a.seq - b.seq);
        const t = startupTasks.shift();
        try { await t.fn(); } catch (e) { console.error('Démarrage :', e.message); }
        await dbIdle();
    }
}

db.run('PRAGMA foreign_keys = ON');

// ============================================================
//  SAUVEGARDE AUTOMATIQUE QUOTIDIENNE (le soir)
// ============================================================
const BACKUP_DIR = path.join(APP_DIR, 'backups');
const BACKUP_HOUR = 20;   // à partir de 20h (heure Madagascar)
const BACKUP_KEEP = 30;   // conserve les 30 dernières sauvegardes

// Un backup existe-t-il déjà pour aujourd'hui ? (survit aux redémarrages du serveur)
function hasBackupToday() {
    try {
        const d = mgNow(), p = n => String(n).padStart(2, '0');
        const today = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
        return fs.readdirSync(BACKUP_DIR).some(f => f.startsWith('database.backup-' + today));
    } catch (e) { return false; }
}
function pruneBackups() {
    try {
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('database.backup-') && f.endsWith('.sqlite')).sort();
        while (files.length > BACKUP_KEEP) { try { fs.unlinkSync(path.join(BACKUP_DIR, files.shift())); } catch (e) {} }
    } catch (e) {}
}
// Copie cohérente de la base (VACUUM INTO) — sûr même pendant l'utilisation. Renvoie le nom du fichier.
function runDailyBackup(reason) {
    return new Promise((resolve, reject) => {
        try {
            if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
            const d = mgNow(), p = n => String(n).padStart(2, '0');
            const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
            const dest = path.join(BACKUP_DIR, `database.backup-${stamp}.sqlite`);
            db.run(`VACUUM INTO ?`, [dest], err => {
                if (err) { console.error('💾 Sauvegarde échouée:', err.message); return reject(err); }
                console.log(`💾 Sauvegarde ${reason || ''} → ${path.basename(dest)}`);
                pruneBackups();
                resolve(path.basename(dest));
            });
        } catch (e) { console.error('💾 Sauvegarde échouée:', e.message); reject(e); }
    });
}
// Vérifie toutes les 5 min : le soir (≥ 20h) et aucun backup aujourd'hui → sauvegarde.
setInterval(() => {
    if (mgNow().getUTCHours() >= BACKUP_HOUR && !hasBackupToday()) runDailyBackup('quotidienne');
}, 5 * 60 * 1000);

function initSchema() {
  db.serialize(() => {
    // ── Utilisateurs ──
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        username   TEXT    UNIQUE NOT NULL,
        password   TEXT    NOT NULL,
        role       TEXT    DEFAULT 'caisse',
        full_name  TEXT,
        phone      TEXT,
        active     INTEGER DEFAULT 1,
        created_at TEXT,
        is_default INTEGER DEFAULT 0
    )`);

    // ── Configuration de l'entreprise (facture, rapports) ──
    db.run(`CREATE TABLE IF NOT EXISTS company_config (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        name          TEXT DEFAULT '',
        logo          TEXT,
        address       TEXT,
        phone         TEXT,
        email         TEXT,
        website       TEXT,
        nif           TEXT,
        stat          TEXT,
        rcs           TEXT,
        tva_rate      REAL DEFAULT 0,
        invoice_note  TEXT,
        invoice_header TEXT,
        invoice_footer TEXT,
        currency      TEXT DEFAULT 'Ar',
        setup_done    INTEGER DEFAULT 0
    )`);

    // ── Paramètres divers (clé/valeur) : délai garantie, durées installation, etc. ──
    db.run(`CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
    )`);

    // ── Sessions de connexion (store express-session persistant) ──
    db.run(`CREATE TABLE IF NOT EXISTS sessions (
        sid     TEXT PRIMARY KEY,
        sess    TEXT NOT NULL,
        expires INTEGER NOT NULL
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires)`);

    // ── Fournisseurs (référentiel géré par l'admin) ──
    db.run(`CREATE TABLE IF NOT EXISTS suppliers (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        name           TEXT NOT NULL,
        contact        TEXT,
        phone          TEXT,
        email          TEXT,
        address        TEXT,
        warranty_days  INTEGER,      -- délai garantie propre au fournisseur (jours) ; sinon défaut global
        note           TEXT,
        active         INTEGER DEFAULT 1,
        created_at     TEXT
    )`);

    // ── Notifications (temps réel + persistance) ──
    // target_user OU target_role (l'un des deux) désigne le destinataire.
    db.run(`CREATE TABLE IF NOT EXISTS notifications (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        target_user  INTEGER,
        target_role  TEXT,
        type         TEXT,
        title        TEXT,
        message      TEXT,
        link         TEXT,
        data         TEXT,
        persistent   INTEGER DEFAULT 0,   -- 1 = reste tant que la cause n'est pas résolue
        resolved     INTEGER DEFAULT 0,
        is_read      INTEGER DEFAULT 0,
        ref          TEXT,                -- clé de l'entité liée (ex. "delivery:5") pour auto-résolution
        created_at   TEXT
    )`);

    // ── Trésorerie admin : retraits mobile money / chèque ──
    db.run(`CREATE TABLE IF NOT EXISTS admin_finance (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        operator   TEXT,     -- mvola | orange_money | airtel_money | cheque
        amount     REAL,     -- montant du retrait (positif)
        note       TEXT,
        user_id    INTEGER,
        user_name  TEXT,
        created_at TEXT
    )`);

    // ── Journal d'activité (audit / suivi des mouvements) ──
    db.run(`CREATE TABLE IF NOT EXISTS activity_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER,
        user_name  TEXT,
        action     TEXT,
        entity     TEXT,
        entity_id  TEXT,
        details    TEXT,
        created_at TEXT
    )`);

    // ── Référentiels (listes déroulantes : type, marque, RAM, stockage…) ──
    db.run(`CREATE TABLE IF NOT EXISTS referentiels (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        category   TEXT NOT NULL,
        value      TEXT NOT NULL,
        active     INTEGER DEFAULT 1,
        created_at TEXT,
        UNIQUE(category, value)
    )`);

    // ── Modèles produits (une carte de stock = un jeu de specs identiques) ──
    db.run(`CREATE TABLE IF NOT EXISTS products (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        signature    TEXT UNIQUE,
        is_accessory INTEGER DEFAULT 0,
        name         TEXT,
        category     TEXT,           -- type : UC, Portable, All-in-One…
        brand        TEXT,
        model        TEXT,
        condition    TEXT,           -- neuf | occasion | reconditionne
        cpu          TEXT,
        ram          TEXT,
        storage      TEXT,
        storage_type TEXT,
        gpu          TEXT,           -- 2e graphique (optionnel)
        screen_size  TEXT,
        touchscreen  INTEGER DEFAULT 0,
        webcam       INTEGER DEFAULT 0,
        wifi         INTEGER DEFAULT 0,
        bluetooth    INTEGER DEFAULT 0,
        numpad       INTEGER DEFAULT 0,
        sale_price   REAL DEFAULT 0,
        image        TEXT,
        description  TEXT,
        created_at   TEXT
    )`);

    // ── Réceptions (en-tête) ──
    db.run(`CREATE TABLE IF NOT EXISTS receptions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        reference   TEXT,            -- n° de facture fournisseur
        supplier_id INTEGER,
        user_id     INTEGER,
        user_name   TEXT,
        note        TEXT,
        total_units INTEGER DEFAULT 0,
        created_at  TEXT
    )`);

    // ── Lignes de réception ──
    db.run(`CREATE TABLE IF NOT EXISTS reception_items (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        reception_id  INTEGER,
        product_id    INTEGER,
        quantity      INTEGER DEFAULT 1,
        unit_price    REAL DEFAULT 0,
        warranty_days INTEGER,
        created_at    TEXT
    )`);

    // ── Unités physiques (une ligne = un numéro de série local) ──
    db.run(`CREATE TABLE IF NOT EXISTS stock_units (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        serial         TEXT UNIQUE,
        product_id     INTEGER,
        supplier_id    INTEGER,
        reception_id   INTEGER,
        status         TEXT DEFAULT 'stock',
        location       TEXT DEFAULT 'depot',
        holder_user_id INTEGER,       -- technicien / livreur qui détient l'unité
        sale_price     REAL DEFAULT 0,
        warranty_start TEXT,
        warranty_end   TEXT,
        note           TEXT,
        created_at     TEXT,
        updated_at     TEXT
    )`);

    // ── Tâches d'installation / préparation (envoi vers un technicien) ──
    db.run(`CREATE TABLE IF NOT EXISTS installation_tasks (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        technician_id   INTEGER,
        technician_name TEXT,
        created_by_id   INTEGER,
        created_by_name TEXT,
        purpose         TEXT DEFAULT 'installation',
        status          TEXT DEFAULT 'envoye',   -- envoye | en_cours | termine | clos
        unit_count      INTEGER DEFAULT 0,
        minutes_allowed INTEGER DEFAULT 0,
        started_at      TEXT,
        deadline_ms     INTEGER,
        overdue_reason  TEXT,
        last_reminder_at INTEGER,
        note            TEXT,
        created_at      TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS install_items (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id      INTEGER,
        unit_id      INTEGER,
        serial       TEXT,
        product_name TEXT,
        result       TEXT DEFAULT 'pending',  -- pending | termine | probleme
        problem_note TEXT,
        decided_at   TEXT
    )`);
    // ── Factures proforma (devis) — générées par la caisse, historisées et réimprimables ──
    db.run(`CREATE TABLE IF NOT EXISTS proformas (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ref           TEXT,
        dest_name     TEXT,
        dest_contact  TEXT,
        dest_address  TEXT,
        dest_nif      TEXT,
        dest_stat     TEXT,
        dest_email    TEXT,
        objet         TEXT,
        lines         TEXT,      -- JSON : [{ designation, detail, pitch, qty, unit, pu }]
        total         REAL DEFAULT 0,
        created_by_id INTEGER,
        created_by_name TEXT,
        created_at    TEXT
    )`);

    // ── Clients ──
    db.run(`CREATE TABLE IF NOT EXISTS clients (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT,
        phone      TEXT,
        address    TEXT,
        created_at TEXT
    )`);

    // ── Ventes (en-tête de facture) ──
    db.run(`CREATE TABLE IF NOT EXISTS sales (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_number     INTEGER,          -- n° de vente du jour
        sale_date       TEXT,             -- AAAA-MM-JJ (pour la numérotation)
        client_id       INTEGER,
        client_name     TEXT,
        client_phone    TEXT,
        client_address  TEXT,
        commercial_id   INTEGER,
        commercial_name TEXT,
        cashier_id      INTEGER,
        cashier_name    TEXT,
        total           REAL DEFAULT 0,
        payment_method  TEXT,             -- especes | mvola | orange_money | airtel_money | cheque | virement
        payment_ref     TEXT,             -- référence mobile money / n° de chèque
        payment_phone   TEXT,             -- n° émetteur mobile money / bénéficiaire chèque
        channel         TEXT DEFAULT 'boutique',  -- boutique | livraison
        status          TEXT DEFAULT 'completed', -- completed | returned | exchanged
        exchange_of     INTEGER,          -- vente d'origine (échange)
        exchange_fee    REAL DEFAULT 0,
        note            TEXT,
        created_at      TEXT
    )`);

    // ── Paiements d'une vente (permet le paiement mixte : espèces + mobile money, etc.) ──
    // Une vente possède 1..n lignes de paiement. La somme des montants = total de la vente.
    // sales.payment_method reste renseigné (méthode unique, ou 'mixte' si plusieurs lignes)
    // pour l'affichage/compat ; la trésorerie s'appuie sur cette table pour ventiler.
    db.run(`CREATE TABLE IF NOT EXISTS sale_payments (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id    INTEGER NOT NULL,
        method     TEXT NOT NULL,     -- especes | mvola | orange_money | airtel_money | cheque | virement
        amount     REAL NOT NULL DEFAULT 0,
        phone      TEXT,              -- n° émetteur mobile money / bénéficiaire chèque (facultatif)
        ref        TEXT,              -- n° de chèque uniquement (mobile money : plus de référence)
        created_at TEXT
    )`);

    // ── Ventes avec avance (acompte / layaway) ──
    // Le client verse une avance ; l'unité est mise de côté (statut 'acompte', non vendable)
    // jusqu'au règlement du solde (→ vente créée) ou à l'annulation (→ unité au stock, avance conservée).
    db.run(`CREATE TABLE IF NOT EXISTS layaways (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        layaway_number  INTEGER,
        client_id       INTEGER,
        client_name     TEXT,
        client_phone    TEXT,
        client_address  TEXT,
        commercial_id   INTEGER,
        commercial_name TEXT,
        cashier_id      INTEGER,
        cashier_name    TEXT,
        total           REAL DEFAULT 0,     -- prix total des unités réservées
        deposit         REAL DEFAULT 0,     -- cumul des avances versées
        status          TEXT DEFAULT 'active',  -- active | vendu | annule
        sale_id         INTEGER,            -- vente finale (au solde)
        note            TEXT,
        created_at      TEXT,
        resolved_at     TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS layaway_items (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        layaway_id   INTEGER,
        unit_id      INTEGER,
        serial       TEXT,
        product_id   INTEGER,
        product_name TEXT,
        unit_price   REAL DEFAULT 0
    )`);
    // Avances encaissées par la caisse sur une LIVRAISON (à la facturation ou après) : comptées en trésorerie
    // le jour de l'encaissement ; le reste est payé à la livraison.
    db.run(`CREATE TABLE IF NOT EXISTS delivery_payments (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        delivery_id  INTEGER,
        method       TEXT NOT NULL,
        amount       REAL NOT NULL DEFAULT 0,
        phone        TEXT,
        ref          TEXT,
        sale_date    TEXT,
        created_at   TEXT,
        next_date    TEXT,
        cashier_name TEXT
    )`);
    // Contrôle de sortie à la porte (agent de sécurité) : chaque facture vérifiée, avec l'heure de sortie.
    db.run(`CREATE TABLE IF NOT EXISTS exit_checks (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id         INTEGER,
        sale_ref        TEXT,
        delivery_id     INTEGER,
        kind            TEXT,       -- client | livraison
        payment_state   TEXT,       -- paid | cod | balance | not_released | invalid
        amount_due      REAL DEFAULT 0,
        items_total     INTEGER DEFAULT 0,
        items_checked   INTEGER DEFAULT 0,
        status          TEXT,       -- ok | anomalie
        note            TEXT,
        checked_by_id   INTEGER,
        checked_by_name TEXT,
        checked_at      TEXT
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_exit_checks_sale ON exit_checks(sale_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_exit_checks_at ON exit_checks(checked_at)`);
    // Service atelier payé en partie : le RESTE est encaissé plus tard (à la récupération de l'ordinateur),
    // compté en trésorerie le jour de cet encaissement.
    db.run(`CREATE TABLE IF NOT EXISTS sale_balance_payments (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id      INTEGER,
        method       TEXT NOT NULL,
        amount       REAL NOT NULL DEFAULT 0,
        phone        TEXT,
        ref          TEXT,
        sale_date    TEXT,
        created_at   TEXT,
        cashier_name TEXT
    )`);
    // Versements d'avance (comptés dans la trésorerie du jour où ils sont encaissés).
    db.run(`CREATE TABLE IF NOT EXISTS layaway_payments (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        layaway_id INTEGER,
        method     TEXT NOT NULL,
        amount     REAL NOT NULL DEFAULT 0,
        phone      TEXT,
        ref        TEXT,
        sale_date  TEXT,     -- AAAA-MM-JJ de l'encaissement (pour la trésorerie)
        created_at TEXT
    )`);

    // ── Upgrades de composants à la vente (échange d'un composant : Stockage/RAM/…) ──
    // Le composant neuf sort du stock (accessoire), l'ancien y revient (réception), le client paie l'écart.
    db.run(`CREATE TABLE IF NOT EXISTS sale_upgrades (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id        INTEGER,
        sale_item_id   INTEGER,   -- ligne de l'ordinateur upgradé
        pc_unit_id     INTEGER,
        field          TEXT,      -- ram | storage | cpu | gpu | screen_size
        old_value      TEXT,
        new_value      TEXT,
        new_unit_id    INTEGER,   -- unité accessoire (neuve) consommée
        old_unit_id    INTEGER,   -- unité accessoire (ancienne) reçue au stock
        new_price      REAL DEFAULT 0,
        old_price      REAL DEFAULT 0,
        ecart          REAL DEFAULT 0,
        created_at     TEXT
    )`);

    // ── Lignes de vente ──
    db.run(`CREATE TABLE IF NOT EXISTS sale_items (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id      INTEGER,
        unit_id      INTEGER,
        serial       TEXT,
        product_id   INTEGER,
        product_name TEXT,
        unit_price   REAL DEFAULT 0,
        returned     INTEGER DEFAULT 0
    )`);

    // ── Réservations « à vendre » (le gestionnaire sort des pièces pour un commercial) ──
    db.run(`CREATE TABLE IF NOT EXISTS reservations (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        commercial_id   INTEGER,
        commercial_name TEXT,
        created_by_id   INTEGER,
        created_by_name TEXT,
        status          TEXT DEFAULT 'active',   -- active | vendu | annule
        note            TEXT,
        sale_id         INTEGER,
        created_at      TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS reservation_items (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        reservation_id INTEGER,
        unit_id        INTEGER,
        serial         TEXT,
        product_id     INTEGER,
        product_name   TEXT,
        unit_price     REAL DEFAULT 0
    )`);

    // ── Retours / remboursements / échanges ──
    db.run(`CREATE TABLE IF NOT EXISTS sale_returns (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id       INTEGER,
        unit_id       INTEGER,
        serial        TEXT,
        type          TEXT,     -- remboursement | retour_stock | garantie | echange
        destination   TEXT,     -- stock | garantie_client
        refund_amount REAL DEFAULT 0,
        reason        TEXT,
        user_id       INTEGER,
        user_name     TEXT,
        created_at    TEXT
    )`);

    // ── Brouillons de panier (POS) : factures en préparation, enregistrées par caissier ──
    db.run(`CREATE TABLE IF NOT EXISTS pos_drafts (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        cashier_id   INTEGER,
        cashier_name TEXT,
        label        TEXT,
        item_count   INTEGER DEFAULT 0,
        total        REAL DEFAULT 0,
        data         TEXT,     -- JSON : { items:[...], discount:{...} }
        created_at   TEXT
    )`);

    // ── Inventaire physique (stock-take par scan) — ADMIN uniquement ──
    db.run(`CREATE TABLE IF NOT EXISTS inventaire_sessions (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        admin_id       INTEGER,
        admin_name     TEXT,
        expected_count INTEGER DEFAULT 0,
        scanned_count  INTEGER DEFAULT 0,
        present_count  INTEGER DEFAULT 0,
        missing_count  INTEGER DEFAULT 0,
        surplus_count  INTEGER DEFAULT 0,
        data           TEXT,   -- JSON : { present:[...], missing:[...], surplus:[...], scope:[...] }
        created_at     TEXT
    )`);

    // ── Brouillon d'inventaire EN COURS (pause / reprendre) — un seul partagé pour le magasin.
    //    Permet de mettre en pause un comptage long puis de le reprendre depuis n'importe quel
    //    appareil (ordinateur / téléphone). id figé à 1 → jamais plus d'un brouillon actif.
    db.run(`CREATE TABLE IF NOT EXISTS inventaire_draft (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        admin_id      INTEGER,
        admin_name    TEXT,
        scanned       TEXT,          -- JSON : [ "SERIE1", "SERIE2", … ] (séries brutes scannées)
        scanned_count INTEGER DEFAULT 0,
        started_at    TEXT,
        updated_at    TEXT
    )`);

    // ── Trésorerie : mouvements de caisse (fond, dépenses, remboursements) ──
    db.run(`CREATE TABLE IF NOT EXISTS cash_movements (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_date  TEXT,
        kind       TEXT,        -- fond | depense | remboursement
        amount     REAL,        -- positif = entrée, négatif = sortie
        method     TEXT DEFAULT 'especes',
        reason     TEXT,
        ref_id     INTEGER,     -- vente/retour lié éventuel
        user_id    INTEGER,
        user_name  TEXT,
        created_at TEXT
    )`);

    // ── Clôtures de caisse ──
    db.run(`CREATE TABLE IF NOT EXISTS cash_closures (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_date      TEXT UNIQUE,
        cash_sales     REAL DEFAULT 0,
        mm_sales       REAL DEFAULT 0,
        cheque_sales   REAL DEFAULT 0,
        fond_total     REAL DEFAULT 0,
        expenses_total REAL DEFAULT 0,
        refunds_total  REAL DEFAULT 0,
        expected_cash  REAL DEFAULT 0,
        sales_count    INTEGER DEFAULT 0,
        note           TEXT,
        closed_by      TEXT,
        closed_at      TEXT
    )`);

    // ── Livraisons (commande en ligne) ──
    db.run(`CREATE TABLE IF NOT EXISTS deliveries (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        delivery_number  INTEGER,
        delivery_date    TEXT,
        client_name      TEXT,
        client_phone     TEXT,
        client_address   TEXT,
        delivery_time    TEXT,
        delivery_fee     REAL DEFAULT 0,
        priority         INTEGER DEFAULT 0,      -- 1 = prioritaire
        commercial_id    INTEGER,
        commercial_name  TEXT,
        coordinator_id   INTEGER,
        coordinator_name TEXT,
        livreur_id       INTEGER,
        livreur_name     TEXT,
        status           TEXT DEFAULT 'nouvelle', -- nouvelle|assignee|acceptee|facturee|en_livraison|livree|annulee|retournee
        payment_status   TEXT,                    -- paye | a_livraison
        total            REAL DEFAULT 0,
        sale_id          INTEGER,
        released_at      INTEGER,                 -- epoch ms de la sortie du stock
        deferred_date    TEXT,                    -- date de report (clôture caisse)
        defer_reason     TEXT,
        cancel_reason    TEXT,
        note             TEXT,
        created_at       TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS delivery_items (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        delivery_id  INTEGER,
        product_id   INTEGER,
        product_name TEXT,
        quantity     INTEGER DEFAULT 1,
        unit_price   REAL DEFAULT 0,
        unit_id      INTEGER,     -- affecté par la caisse
        serial       TEXT
    )`);

    // ── Journal de garantie (entrées, retours fournisseur, traitements, réparations) ──
    db.run(`CREATE TABLE IF NOT EXISTS garantie_actions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        unit_id         INTEGER,
        serial          TEXT,
        supplier_id     INTEGER,
        supplier_name   TEXT,
        garantie_type   TEXT,     -- fournisseur | exceptionnel
        action          TEXT,     -- entree | retour_fournisseur | traite | repare | remplace | supprime
        sender_name     TEXT,     -- personne qui renvoie au fournisseur
        technician_name TEXT,     -- réparateur (exceptionnel)
        reason          TEXT,
        user_id         INTEGER,
        user_name       TEXT,
        created_at      TEXT
    )`);

    // ── Historique de mouvements par unité (base du « suivi ») ──
    db.run(`CREATE TABLE IF NOT EXISTS unit_movements (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        unit_id     INTEGER,
        serial      TEXT,
        from_status TEXT,
        to_status   TEXT,
        action      TEXT,
        user_id     INTEGER,
        user_name   TEXT,
        ref_type    TEXT,
        ref_id      TEXT,
        note        TEXT,
        created_at  TEXT
    )`);

    // ── Corbeille : produits supprimés par l'admin (restaurables) ──
    // Chaque suppression de produit archive ici un instantané JSON complet (produit + unités +
    // mouvements + actions garantie + lignes de réception + liens ventes) pour restauration.
    db.run(`CREATE TABLE IF NOT EXISTS trash_products (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id   INTEGER,      -- id d'origine du produit supprimé
        product_name TEXT,
        unit_count   INTEGER DEFAULT 0,
        sold_kept    INTEGER DEFAULT 0,
        snapshot     TEXT,         -- JSON { product, units, movements, garantie, receptions, sale_links }
        deleted_by   TEXT,
        deleted_at   TEXT
    )`);

    db.run(`CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(target_user, is_read)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_notif_role ON notifications(target_role, is_read)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_log_created ON activity_log(created_at)`);
    db.run(`ALTER TABLE activity_log ADD COLUMN ip TEXT`, () => {});     // journal : IP réelle (Cloudflare) — ignoré si déjà là
    db.run(`ALTER TABLE activity_log ADD COLUMN path TEXT`, () => {});   // journal : route appelée
    db.run(`CREATE INDEX IF NOT EXISTS idx_log_user ON activity_log(user_id, created_at)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_log_entity ON activity_log(entity, entity_id)`);   // historique par fiche produit
    db.run(`CREATE INDEX IF NOT EXISTS idx_units_status  ON stock_units(status)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_units_product ON stock_units(product_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_units_serial  ON stock_units(serial)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_recep_created ON receptions(created_at)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mov_serial    ON unit_movements(serial)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_mov_unit      ON unit_movements(unit_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sales_date    ON sales(sale_date)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_sitems_sale   ON sale_items(sale_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_cash_date     ON cash_movements(sale_date)`);

    // ── Seeds ──
    // Compte admin créé UNE fois (1re installation) avec un mot de passe aléatoire (voir adminInitialPassword).
    db.get(`SELECT id FROM users WHERE username = 'admin'`, (e, row) => {
        if (e || row) return;
        const initial = adminInitialPassword();
        db.run(`INSERT OR IGNORE INTO users (username, password, role, full_name, is_default, created_at)
                VALUES ('admin', ?, 'admin', 'Administrateur', 1, ?)`, [bcrypt.hashSync(initial, 10), getDateTime()], err => {
            if (!err && !process.env.ADMIN_DEFAULT_PASSWORD)
                console.log(`🔑 Compte « admin » créé : mot de passe initial dans ${ADMIN_PWD_FILE} (à changer à la 1re connexion).`);
        });
    });
    db.run(`INSERT OR IGNORE INTO company_config (id, name) VALUES (1, '')`);
    // Paramètres par défaut.
    const defaults = {
        default_warranty_days: '30',        // garantie fournisseur par défaut (jours)
        install_minutes_per_unit: '3',      // minutes par pièce en installation/préparation
        exchange_free_days: '5',            // échange gratuit sous N jours
        exchange_fee: '20000',              // droit d'échange au-delà (Ar)
        delivery_alert_hours: '3',          // alerte livraison impayée après N heures
        delivery_alert_amount: '50000',     // seuil montant chez livreur → alerte admin (Ar)
        install_reminder_minutes: '5',      // fréquence des rappels d'installation en retard
        gift_pack_amount: '50000',          // forfait « pack cadeau » : montant fixe ajouté quand des accessoires sont offerts
        layaway_max_days: '30',             // vente avec avance : délai maximum pour solder (jours)
        layaway_conditions: "Les articles restent réservés jusqu'à la date limite. Passé ce délai sans règlement du solde, la vente avec avance peut être annulée et les articles remis en vente.",
        // ── Proforma / facture (personnalisables dans Config → onglet Proforma) ──
        proforma_tagline: 'Réparation et vente des produits informatiques',
        proforma_validity_days: '7',        // validité affichée dans le tableau de référence
        proforma_conditions_validity: "La présente facture proforma est valable pour une durée de sept (07) jours à compter de sa réception par le destinataire. Passé ce délai, les conditions pourront être révisées.",
        proforma_conditions_payment: "Le règlement peut être effectué par Mobile Money, en espèces ou par chèque. La commande ne sera considérée comme ferme et définitive qu'après réception du paiement intégral."
    };
    for (const [k, v] of Object.entries(defaults))
        db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [k, v]);

    // Référentiels par défaut (listes déroulantes proposées à la réception).
    const refDefaults = {
        product_type: ['UC', 'Mini-UC', 'Ordinateur portable', 'All-in-One', 'PC Tablet', 'Écran', 'Serveur', 'Imprimante', 'Accessoire'],
        condition:    ['neuf', 'occasion', 'reconditionne'],
        brand:        ['HP', 'Dell', 'Lenovo', 'Asus', 'Acer', 'Apple', 'MSI', 'Toshiba', 'Samsung', 'Autre'],
        ram:          ['2 Go', '4 Go', '8 Go', '12 Go', '16 Go', '32 Go', '64 Go'],
        storage_size: ['64 Go', '128 Go', '256 Go', '500 Go', '512 Go', '1 To', '2 To'],
        storage_type: ['HDD', 'SSD SATA', 'SSD NVMe', 'eMMC'],
        screen_size:  ['11.6"', '13.3"', '14"', '15.6"', '17.3"', '19.5"', '21.5"', '24"', '27"'],
        // Catégories d'accessoires proposées. RAM / Disque dur sont suivis à l'unité (n° de série).
        acc_category: ['RAM', 'Disque dur', 'Réseau', 'Périphérique', 'Câble', 'Onduleur']
    };
    for (const [cat, vals] of Object.entries(refDefaults))
        vals.forEach(v => db.run(`INSERT OR IGNORE INTO referentiels (category, value, created_at) VALUES (?, ?, ?)`, [cat, v, getDateTime()]));
  });
}
initSchema();

// Migration unique : convertit les anciens numéros de série au format date
// (AAMMJJ + séquence du jour) et répercute sur l'historique et les tâches.
function migrateSerials() {
    db.get(`SELECT value FROM settings WHERE key = 'serial_format_v2'`, (e, row) => {
        if (row && row.value === '1') return;
        db.all(`SELECT id, serial, created_at FROM stock_units ORDER BY created_at, id`, [], (e2, rows) => {
            if (e2 || !rows) return;
            const counters = {}, tasks = [];
            rows.forEach(r => {
                const d = (r.created_at || getDateTime()).slice(2, 10).replace(/-/g, '');  // AAMMJJ
                counters[d] = (counters[d] || 0) + 1;
                const ns = d + String(counters[d]).padStart(4, '0');
                if (ns !== r.serial) tasks.push([ns, r.id]);
            });
            db.serialize(() => {
                tasks.forEach(([ns, id]) => {
                    db.run(`UPDATE stock_units   SET serial = ? WHERE id = ?`, [ns, id]);
                    db.run(`UPDATE unit_movements SET serial = ? WHERE unit_id = ?`, [ns, id]);
                    db.run(`UPDATE install_items  SET serial = ? WHERE unit_id = ?`, [ns, id]);
                });
                db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('serial_format_v2', '1')`);
                if (tasks.length) console.log(`🔢 ${tasks.length} numéro(s) de série migré(s) vers le format date.`);
            });
        });
    });
}
startupTask(migrateSerials, 800);

// Migration unique : alimente sale_payments depuis les ventes existantes (une ligne = une
// vente, avec sa méthode et son total) afin que la trésorerie ventile aussi l'historique.
async function backfillSalePayments() {
    try {
        const flag = await dbGet(`SELECT value FROM settings WHERE key = 'sale_payments_v1'`);
        if (flag && flag.value === '1') return;
        const sales = await dbAll(
            `SELECT id, total, payment_method, payment_ref, payment_phone, created_at
             FROM sales WHERE payment_method IS NOT NULL AND payment_method != ''`);
        let n = 0;
        for (const s of sales) {
            const has = await dbGet('SELECT id FROM sale_payments WHERE sale_id = ? LIMIT 1', [s.id]);
            if (has) continue;
            const ref = s.payment_method === 'cheque' ? (s.payment_ref || null) : null;
            await dbRun(`INSERT INTO sale_payments (sale_id, method, amount, phone, ref, created_at) VALUES (?,?,?,?,?,?)`,
                [s.id, s.payment_method, s.total || 0, s.payment_phone || null, ref, s.created_at || getDateTime()]);
            n++;
        }
        await dbRun(`INSERT OR REPLACE INTO settings (key, value) VALUES ('sale_payments_v1', '1')`);
        if (n) console.log(`💳 ${n} paiement(s) de vente initialisé(s) (sale_payments).`);
    } catch (e) { console.error('backfillSalePayments:', e.message); }
}
startupTask(backfillSalePayments, 1800);

// Index UNIQUE (sale_date, sale_number) : posé seulement si la base ne contient aucun doublon ;
// sinon les doublons sont signalés (log + notification admin) pour correction manuelle.
async function ensureUniqueSaleNumbers() {
    try {
        const has = await dbGet(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'ux_sales_date_number'`);
        if (has) return;
        const dups = await dbAll(`SELECT sale_date, sale_number, COUNT(*) AS n, GROUP_CONCAT(id) AS ids FROM sales
                                  WHERE sale_number IS NOT NULL GROUP BY sale_date, sale_number HAVING COUNT(*) > 1
                                  ORDER BY sale_date`);
        if (dups.length) {
            const list = dups.slice(0, 10).map(d => `${d.sale_date} n°${d.sale_number} (ventes ${d.ids})`).join(' ; ');
            console.warn(`⚠️  ${dups.length} numéro(s) de vente en double — index unique non créé : ${list}`);
            const ref = 'sales:duplicate_numbers';
            const already = await dbGet(`SELECT 1 FROM notifications WHERE ref = ? AND resolved = 0 LIMIT 1`, [ref]);
            if (!already) pushNotification({ target_role: 'admin', type: 'warn', title: 'Numéros de vente en double',
                message: `${dups.length} doublon(s) : ${list}`, link: '/sales.html', ref, persistent: true });
            return;
        }
        await dbRun(`CREATE UNIQUE INDEX IF NOT EXISTS ux_sales_date_number ON sales(sale_date, sale_number)`);
        console.log('🔢 Index unique des numéros de vente créé.');
    } catch (e) { console.error('ensureUniqueSaleNumbers:', e.message); }
}
startupTask(ensureUniqueSaleNumbers, 3000);

// Avances en cours créées avant l'échéancier : date limite = création + délai paramétré.
startupTask(async () => {
    const s = await getSettingsAsync();
    const days = Math.max(1, parseInt(s.layaway_max_days, 10) || 30);
    const r = await dbRun(`UPDATE layaways SET due_date = date(created_at, '+' || ? || ' days') WHERE due_date IS NULL`, [days]);
    if (r.changes) console.log(`📅 ${r.changes} avance(s) : date limite de paiement initialisée.`);
}, 3100);

// Migration : flague les produits accessoires RAM / disque dur existants comme « suivis à
// l'unité » (products.serialized = 1). Les unités DÉJÀ en stock gardent leur code de modèle
// partagé (serial NULL) ; seules les prochaines réceptions seront numérotées à l'unité.
// Différée (colonne `serialized` ajoutée par ensureColumn) et jouée une seule fois (flag).
async function migrateSerializedAccessories() {
    try {
        const flag = await dbGet(`SELECT value FROM settings WHERE key = 'serialized_acc_v1'`);
        if (flag && flag.value === '1') return;
        const r = await dbRun(
            `UPDATE products SET serialized = 1 WHERE is_accessory = 1 AND COALESCE(serialized, 0) = 0 AND (
                  lower(category) LIKE '%ram%'     OR lower(category) LIKE '%memoire%' OR lower(category) LIKE '%mémoire%'
               OR lower(category) LIKE '%barrette%' OR lower(category) LIKE '%disque%'  OR lower(category) LIKE '%ssd%'
               OR lower(category) LIKE '%hdd%'      OR lower(category) LIKE '%nvme%')`);
        await dbRun(`INSERT OR REPLACE INTO settings (key, value) VALUES ('serialized_acc_v1', '1')`);
        if (r && r.changes) console.log(`🧩 ${r.changes} produit(s) accessoire(s) RAM/disque marqués « suivis à l'unité ».`);
    } catch (e) { console.error('migrateSerializedAccessories:', e.message); }
}
startupTask(migrateSerializedAccessories, 2000);

// Migration v2 : TOUS les accessoires deviennent « suivis à l'unité » (serialized = 1), pas
// seulement RAM / disque. Comme en v1, les unités DÉJÀ en stock gardent leur code de modèle
// partagé (serial NULL) ; seules les prochaines réceptions seront numérotées à l'unité.
async function migrateSerializedAccessoriesAll() {
    try {
        const flag = await dbGet(`SELECT value FROM settings WHERE key = 'serialized_acc_v2'`);
        if (flag && flag.value === '1') return;
        const r = await dbRun(`UPDATE products SET serialized = 1 WHERE is_accessory = 1 AND COALESCE(serialized, 0) = 0`);
        await dbRun(`INSERT OR REPLACE INTO settings (key, value) VALUES ('serialized_acc_v2', '1')`);
        if (r && r.changes) console.log(`🧩 ${r.changes} produit(s) accessoire(s) supplémentaires marqués « suivis à l'unité » (v2, tous accessoires).`);
    } catch (e) { console.error('migrateSerializedAccessoriesAll:', e.message); }
}
startupTask(migrateSerializedAccessoriesAll, 2500);

// Ajoute une colonne si absente (migration douce, base existante).
function ensureColumn(table, column, defSql) {
    db.all(`PRAGMA table_info(${table})`, [], (e, cols) => {
        if (e || !cols) return;
        if (!cols.find(c => c.name === column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${defSql}`);
    });
}

// ── Services atelier (ordinateur apporté par le client) ──
// Un service « atelier » (diagnostic, entretien, réparation, installation système…) exige à la
// caisse la fiche de l'ordinateur du client ; la vente crée une étiquette 60×40 à imprimer par
// la coordination, collée sur l'ordinateur. La fiche est aussi imprimée sur la facture.
startupTask(() => {
    ensureColumn('products', 'service_atelier', 'service_atelier INTEGER');
    ensureColumn('sales', 'client_pc', 'client_pc TEXT');                 // référence de l'ordinateur du client
    ensureColumn('sales', 'client_pc_ram', 'client_pc_ram TEXT');
    ensureColumn('sales', 'client_pc_storage', 'client_pc_storage TEXT');
    ensureColumn('sales', 'client_pc_charger', 'client_pc_charger TEXT'); // avec | sans
    ensureColumn('sales', 'client_pc_note', 'client_pc_note TEXT');       // panne signalée / remarque
    db.run(`CREATE TABLE IF NOT EXISTS atelier_labels (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        sale_id         INTEGER,
        services        TEXT,
        status          TEXT DEFAULT 'a_imprimer',   -- a_imprimer | imprimee | annulee
        created_at      TEXT,
        created_by_name TEXT,
        printed_at      TEXT,
        printed_by_name TEXT,
        print_count     INTEGER DEFAULT 0,
        sale_number INTEGER, sale_date TEXT, sale_created_at TEXT, client_name TEXT, client_phone TEXT, client_pc TEXT,
        client_pc_ram TEXT, client_pc_storage TEXT, client_pc_charger TEXT, client_pc_note TEXT, cashier_name TEXT, commercial_name TEXT
    )`);
    // Copie des informations de la vente : l'étiquette reste lisible dans l'historique même si la vente est supprimée.
    ['sale_number', 'sale_date', 'sale_created_at', 'client_name', 'client_phone', 'client_pc', 'client_pc_ram', 'client_pc_storage', 'client_pc_charger', 'client_pc_note', 'cashier_name', 'commercial_name']
        .forEach(c => ensureColumn('atelier_labels', c, `${c} ${c === 'sale_number' ? 'INTEGER' : 'TEXT'}`));
}, 600);
// Demandes clients (réseaux sociaux) saisies par le commercial en ligne.
startupTask(() => {
    db.run(`CREATE TABLE IF NOT EXISTS client_requests (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        commercial_id        INTEGER,
        commercial_name      TEXT,
        client_name          TEXT,
        client_phone         TEXT,
        channel              TEXT,                         -- facebook | whatsapp | tiktok | instagram | autre
        product_text         TEXT,                         -- produit demandé, en clair (analysé par mots-clés)
        quantity             INTEGER DEFAULT 1,
        budget               REAL,
        note                 TEXT,
        status               TEXT DEFAULT 'en_attente',    -- en_attente | disponible | commandee | abandonnee
        matched_product_id   INTEGER,
        matched_product_name TEXT,
        matched_at           TEXT,
        matched_source       TEXT,                         -- reception | stock
        delivery_id          INTEGER,
        created_at           TEXT,
        updated_at           TEXT
    )`);
}, 650);
// Services existants : diagnostic, entretien, réparation et installations système marqués « atelier »
// (une seule fois : seuls les services jamais qualifiés, service_atelier NULL).
startupTask(async () => {
    try {
        const r = await dbRun(`UPDATE products SET service_atelier = CASE WHEN (
                name LIKE '%diagnos%' OR name LIKE '%entretien%' OR name LIKE '%reparation%' OR name LIKE '%réparation%' OR name LIKE '%RÉPARATION%'
                OR (name LIKE '%installation%' AND name NOT LIKE '%reseau%' AND name NOT LIKE '%réseau%' AND name NOT LIKE '%RÉSEAU%')
            ) THEN 1 ELSE 0 END WHERE is_service = 1 AND service_atelier IS NULL`);
        if (r && r.changes) console.log(`🔧 ${r.changes} service(s) qualifié(s) atelier / hors atelier.`);
    } catch (e) { console.error('service_atelier:', e.message); }
}, 4500);
startupTask(() => {
    ensureColumn('users', 'extra_roles', 'extra_roles TEXT');   // rôles supplémentaires (clés séparées par des virgules)
    ensureColumn('users', 'profile_photo', 'profile_photo TEXT');       // photo de profil (chemin /uploads/…)
    ensureColumn('users', 'security_question', 'security_question TEXT'); // question secrète (récupération mot de passe)
    ensureColumn('users', 'security_answer', 'security_answer TEXT');    // réponse HACHÉE (bcrypt)
    ensureColumn('notifications', 'ref', 'ref TEXT');
    // Upgrade : ajout (slot libre, l'ancien reste) | remplacement (l'ancien est retiré et repris au dépôt).
    ensureColumn('sale_upgrades', 'mode', 'mode TEXT');
    // Avances : date limite (création + délai paramétré) et date de prochain paiement promise par le client.
    ensureColumn('layaways', 'due_date', 'due_date TEXT');
    ensureColumn('layaways', 'next_payment_date', 'next_payment_date TEXT');
    ensureColumn('layaway_payments', 'next_date', 'next_date TEXT');          // date promise annoncée à ce versement
    ensureColumn('layaway_payments', 'cashier_name', 'cashier_name TEXT');
    ensureColumn('layaway_items', 'is_service', 'is_service INTEGER DEFAULT 0');   // service (sans unité) inclus dans l'avance
    ensureColumn('layaways', 'discount_type', 'discount_type TEXT');
    ensureColumn('layaways', 'discount_value', 'discount_value REAL DEFAULT 0');
    ensureColumn('layaways', 'discount_amount', 'discount_amount REAL DEFAULT 0');
    // Livraison avec avance encaissée par la caisse (deliveries.acompte = cumul de delivery_payments).
    ensureColumn('deliveries', 'acompte_paid', 'acompte_paid INTEGER DEFAULT 0');
    ensureColumn('sales', 'balance_due', 'balance_due REAL DEFAULT 0');   // reste à payer (service atelier payé en partie)
    ensureColumn('deliveries', 'avance_due_date', 'avance_due_date TEXT');
    ensureColumn('deliveries', 'avance_next_date', 'avance_next_date TEXT');
    ensureColumn('deliveries', 'status_at', 'status_at TEXT');       // date d'entrée dans le statut courant
    ensureColumn('deliveries', 'stuck_notified', 'stuck_notified INTEGER DEFAULT 0');
    // Paiement déclaré par le commercial à la création (indicatif) — la caisse confirme le vrai
    // statut (payment_status) à la facturation. Sert surtout à alerter le livreur sur l'étiquette.
    ensureColumn('deliveries', 'payment_declared', "payment_declared TEXT DEFAULT 'a_livraison'");
    // Date de livraison PRÉVUE (choisie par le commercial, défaut = jour de création ; peut être future).
    ensureColumn('deliveries', 'planned_date', 'planned_date TEXT');
    // Acompte déjà versé (commande en ligne) : montant + mode ; le reste est encaissé à la livraison.
    ensureColumn('deliveries', 'acompte', 'acompte REAL DEFAULT 0');
    ensureColumn('deliveries', 'acompte_method', 'acompte_method TEXT');
    // Commande « déjà payée » (en ligne) réglée par mobile money : opérateur + n° expéditeur (obligatoire)
    // + référence (facultative), déclarés par le commercial. La caisse les confirme à la facturation :
    // c'est SEULEMENT à ce moment que la vente entre en caisse comme encaissement mobile money.
    ensureColumn('deliveries', 'paid_method', 'paid_method TEXT');   // mvola | orange_money | airtel_money
    ensureColumn('deliveries', 'paid_phone', 'paid_phone TEXT');     // n° de l'expéditeur du paiement
    ensureColumn('deliveries', 'paid_ref', 'paid_ref TEXT');         // référence de la transaction (option.)
    // Prix d'achat par produit (admin uniquement, masqué aux autres rôles).
    ensureColumn('products', 'purchase_price', 'purchase_price REAL DEFAULT 0');
    // Numéro de série constructeur (facultatif) — suivi si l'étiquette code-barres est retirée.
    ensureColumn('stock_units', 'manufacturer_sn', 'manufacturer_sn TEXT');
    // Kit STARLINK : une unité = antenne (dish, n° constructeur dans manufacturer_sn) + routeur (ID ci-dessous),
    // vendus ensemble à un prix unique ; deux étiquettes (dish / routeur) portent le même code-barres.
    ensureColumn('stock_units', 'router_id', 'router_id TEXT');
    // Position GPS du lieu d'installation (Starlink) : précise là où l'adresse texte ne suffit pas.
    ensureColumn('sales', 'client_lat', 'client_lat REAL');
    ensureColumn('sales', 'client_lng', 'client_lng REAL');
    ensureColumn('layaways', 'client_lat', 'client_lat REAL');
    // Où était l'unité avant la mise de côté (boutique / présentoir…) : elle y retourne à l'expiration.
    ensureColumn('layaway_items', 'prev_status', 'prev_status TEXT');
    ensureColumn('layaway_items', 'prev_holder', 'prev_holder INTEGER');
    ensureColumn('layaways', 'client_lng', 'client_lng REAL');
    // Sous-catégorie (surtout accessoires : Réseau → Routeur).
    ensureColumn('products', 'subcategory', 'subcategory TEXT');
    // Accessoire suivi à l'unité (RAM / disque dur) : ses unités reçoivent un n° de série UNIQUE
    // (comme un ordinateur) au lieu du code de modèle partagé. Calculé depuis la catégorie.
    ensureColumn('products', 'serialized', 'serialized INTEGER DEFAULT 0');
    // Montant remboursé par le fournisseur lors d'un traitement « remboursé » (action = rembourse).
    ensureColumn('garantie_actions', 'amount', 'amount REAL DEFAULT 0');
    // Services (diagnostic, installation, réinstallation…) : « produits » SANS stock (illimité) ;
    // le prix entre en caisse à CHAQUE utilisation. Pas d'unité physique en stock_units.
    ensureColumn('products', 'is_service', 'is_service INTEGER DEFAULT 0');
    // Emplacement physique au dépôt (ex. « C03 ») — saisi à la main par le responsable stock,
    // affiché partout (stock, catalogue, livraison) pour retrouver vite le produit dans le dépôt.
    ensureColumn('products', 'emplacement', 'emplacement TEXT');
    ensureColumn('cash_closures', 'virement_sales', 'virement_sales REAL DEFAULT 0');   // virement bancaire (hors caisse)
    ensureColumn('cash_closures', 'counted_cash', 'counted_cash REAL');                 // espèces réellement comptées à la clôture
    ensureColumn('cash_closures', 'ecart', 'ecart REAL');                               // comptées − attendues (négatif = manque)
    // Nombre d'étiquettes à imprimer par produit pour ce fournisseur (défaut 1).
    ensureColumn('suppliers', 'label_count', 'label_count INTEGER DEFAULT 1');
    // Remise sur vente (point de vente) + article offert (cadeau, prix 0).
    ensureColumn('sales', 'discount_type', 'discount_type TEXT');            // percent | value
    ensureColumn('sales', 'discount_value', 'discount_value REAL DEFAULT 0');
    ensureColumn('sales', 'discount_amount', 'discount_amount REAL DEFAULT 0');
    ensureColumn('sale_items', 'is_gift', 'is_gift INTEGER DEFAULT 0');
    // Couleur du produit (commande en ligne) : reportée sur l'étiquette de livraison et la facture.
    ensureColumn('delivery_items', 'color', 'color TEXT');
    ensureColumn('sale_items', 'color', 'color TEXT');
    ensureColumn('sale_items', 'is_service', 'is_service INTEGER DEFAULT 0');
    // Demande d'upgrade (commande en ligne) : le commercial signale le composant à changer ;
    // la CAISSE réalise l'upgrade (écart) à la facturation/livraison, le STOCK valide l'ancien composant.
    ensureColumn('delivery_items', 'upgrade_note', 'upgrade_note TEXT');
    // Forfait « pack cadeau » ajouté à la vente quand des accessoires sont offerts (montant fixe paramétrable).
    ensureColumn('sales', 'gift_pack', 'gift_pack REAL DEFAULT 0');
    ensureColumn('sales', 'client_nif', 'client_nif TEXT');     // identifiants fiscaux du CLIENT (facture pro : NIF/STAT/RCS)
    ensureColumn('sales', 'client_stat', 'client_stat TEXT');
    ensureColumn('sales', 'client_rcs', 'client_rcs TEXT');
    ensureColumn('install_items', 'validated_at', 'validated_at TEXT');
    ensureColumn('install_items', 'started_at', 'started_at TEXT');
    ensureColumn('install_items', 'tech_remark', 'tech_remark TEXT');     // remarque libre du technicien sur CE produit (visible gestionnaire)       // heure de début de l'installation de CETTE unité (technicien)   // envoi au stock/garantie unité par unité (gestionnaire)
    // Inventaire : distingue le comptage des ordinateurs ('pc') de celui des composants RAM/disque ('composant').
    ensureColumn('inventaire_sessions', 'kind', "kind TEXT DEFAULT 'pc'");
    // Brouillon d'inventaire des COMPOSANTS (pause/reprendre) — séparé de celui des ordinateurs.
    db.run(`CREATE TABLE IF NOT EXISTS inventaire_comp_draft (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        admin_id      INTEGER,
        admin_name    TEXT,
        scanned       TEXT,
        scanned_count INTEGER DEFAULT 0,
        started_at    TEXT,
        updated_at    TEXT
    )`);
    // Consignations : sorties de présentation/test remises à un commercial, à encaisser.
    db.run(`CREATE TABLE IF NOT EXISTS consignments (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        commercial_id   INTEGER,
        commercial_name TEXT,
        created_by_id   INTEGER,
        created_by_name TEXT,
        status          TEXT DEFAULT 'sent',   -- sent | received | sold | cancelled | returned
        sale_id         INTEGER,
        cancel_reason   TEXT,
        note            TEXT,
        created_at      TEXT,
        received_at     TEXT,
        last_reminder_at INTEGER,
        resolved_at     TEXT
    )`);
    // Migration « sortie boutique » (APRÈS la création de la table) : les anciennes présentations
    // (à réceptionner / reçues) deviennent des sorties boutique immédiates (statut 'boutique').
    db.run(`UPDATE consignments SET status = 'boutique', received_at = COALESCE(received_at, created_at) WHERE status IN ('sent','received')`);
    db.run(`CREATE TABLE IF NOT EXISTS consignment_items (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        consignment_id INTEGER,
        unit_id        INTEGER,
        serial         TEXT,
        product_id     INTEGER,
        product_name   TEXT,
        unit_price     REAL DEFAULT 0
    )`);
    // Demandes d'échange d'une unité DÉJÀ sortie (livraison ou boutique/consignation) : le commercial
    // demande à remplacer la pièce par une AUTRE du même modèle (n° de série différent), le stock valide.
    db.run(`CREATE TABLE IF NOT EXISTS exchange_requests (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        kind              TEXT,            -- 'delivery' | 'consignation'
        ref_id            INTEGER,         -- delivery_id | consignment_id
        ref_label         TEXT,
        old_unit_id       INTEGER,
        serial            TEXT,
        product_id        INTEGER,
        product_name      TEXT,
        is_accessory      INTEGER DEFAULT 0,
        reason            TEXT,            -- motif OBLIGATOIRE
        disposition       TEXT,            -- 'garantie' | 'defectueux' | 'stock'
        status            TEXT DEFAULT 'pending',   -- pending | validated | rejected | cancelled
        requested_by_id   INTEGER,
        requested_by_name TEXT,
        new_unit_id       INTEGER,
        new_serial        TEXT,
        validated_by_id   INTEGER,
        validated_by_name TEXT,
        reject_reason     TEXT,
        created_at        TEXT,
        resolved_at       TEXT
    )`);
    // Bons de commande fournisseurs (saisis par le responsable commande, consultés par le stock).
    // Indépendant des réceptions : le stock n'est alimenté QUE par la réception.
    db.run(`CREATE TABLE IF NOT EXISTS supplier_orders (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        order_number     INTEGER,
        supplier_id      INTEGER,
        supplier_name    TEXT,
        order_date       TEXT,
        expected_date    TEXT,
        reference        TEXT,            -- n° proforma / bon de commande du fournisseur
        currency         TEXT DEFAULT 'MGA',
        status           TEXT DEFAULT 'en_attente',  -- en_attente (pas encore vu par le stock) | vu | annulee
        total            REAL DEFAULT 0,
        paid_amount      REAL DEFAULT 0,
        note             TEXT,
        created_by_id    INTEGER,
        created_by_name  TEXT,
        created_at       TEXT,
        updated_at       TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS supplier_order_items (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id     INTEGER,
        product_id   INTEGER,
        designation  TEXT,
        quantity     INTEGER DEFAULT 1,
        unit_price   REAL DEFAULT 0      -- prix de vente prévu
    )`);
    // Photos / PDF de la facture fournisseur (fichiers dans private_uploads/, hors public/).
    db.run(`CREATE TABLE IF NOT EXISTS supplier_order_files (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id         INTEGER,
        filename         TEXT,
        original_name    TEXT,
        mime             TEXT,
        uploaded_by_id   INTEGER,
        uploaded_by_name TEXT,
        created_at       TEXT
    )`);
    startupTask(() => {   // après création des tables ci-dessus
        ensureColumn('supplier_orders', 'verify_note', 'verify_note TEXT');
        ensureColumn('supplier_orders', 'verified_by_id', 'verified_by_id INTEGER');
        ensureColumn('supplier_orders', 'verified_by_name', 'verified_by_name TEXT');
        ensureColumn('supplier_orders', 'verified_at', 'verified_at TEXT');
        ensureColumn('supplier_order_items', 'received_qty', 'received_qty INTEGER');   // (inutilisé : plus de vérification par le stock)
        // Anciens statuts → workflow « vu par le stock » (en_attente = pas encore vu | vu | annulee).
        // verified_by_* = qui (du stock) a consulté le bon, et quand.
        db.run(`UPDATE supplier_orders SET status = CASE WHEN status IN ('commandee','partielle') THEN 'en_attente'
                ELSE 'vu' END WHERE status IN ('commandee','partielle','recue','verifiee','ecart')`);
    }, 1900);
    // Batteries : ordinateurs compatibles (recherche internet automatique ou saisie manuelle).
    db.run(`CREATE TABLE IF NOT EXISTS battery_compat (
        product_id  INTEGER PRIMARY KEY,
        query_key   TEXT,               -- marque|référence recherchée (une modif de la fiche relance la recherche)
        models      TEXT,               -- JSON : ["HP ProBook 640 645 650 655 G0 G1", …]
        source      TEXT DEFAULT 'auto', -- auto | manuel
        status      TEXT,               -- ok | vide | erreur
        error       TEXT,
        searched_at TEXT,
        edited_by   TEXT
    )`);
    // Codes d'inscription à usage unique (un code = un compte, rôle imposé par l'admin).
    db.run(`CREATE TABLE IF NOT EXISTS registration_codes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        code        TEXT UNIQUE NOT NULL,
        role        TEXT NOT NULL,
        note        TEXT,
        status      TEXT NOT NULL DEFAULT 'active',   -- active | used | revoked
        created_by  TEXT,
        created_at  TEXT,
        used_by     TEXT,
        used_at     TEXT
    )`);
}, 400);

// Migration : recalcule les signatures produits au format courant (avec subcategory)
// et FUSIONNE les doublons de config (dédoublonnage cassé par l'ajout de subcategory).
// Corrige le ré-appro qui créait un nouveau produit au lieu d'incrémenter l'existant.
async function dedupProductsBySignature() {
    try {
        const flag = await dbGet(`SELECT value FROM settings WHERE key = 'product_sig_v4'`);
        if (flag && flag.value === '1') return;
        const products = await dbAll(`SELECT * FROM products ORDER BY id`);
        if (!products.length) { await dbRun(`INSERT OR REPLACE INTO settings (key, value) VALUES ('product_sig_v4', '1')`); return; }
        // Neutralise d'abord toutes les signatures (contrainte UNIQUE).
        await dbRun(`UPDATE products SET signature = NULL`);
        const groups = new Map();
        for (const p of products) {
            const sig = productSignature(p);
            if (!groups.has(sig)) groups.set(sig, []);
            groups.get(sig).push(p);
        }
        const FK = ['stock_units', 'reception_items', 'sale_items', 'reservation_items', 'consignment_items', 'delivery_items'];
        let merged = 0;
        for (const [sig, list] of groups) {
            const canonical = list[0];   // plus petit id
            for (let i = 1; i < list.length; i++) {
                const dup = list[i];
                for (const tbl of FK) await dbRun(`UPDATE ${tbl} SET product_id = ? WHERE product_id = ?`, [canonical.id, dup.id]);
                // Complète l'image / description manquante depuis le doublon.
                await dbRun(`UPDATE products SET image = COALESCE(image, ?), description = COALESCE(description, ?) WHERE id = ?`,
                    [dup.image || null, dup.description || null, canonical.id]);
                await dbRun(`DELETE FROM products WHERE id = ?`, [dup.id]);
                merged++;
            }
            await dbRun(`UPDATE products SET signature = ? WHERE id = ?`, [sig, canonical.id]);
        }
        await dbRun(`INSERT OR REPLACE INTO settings (key, value) VALUES ('product_sig_v4', '1')`);
        if (merged) console.log(`🔀 ${merged} produit(s) doublon(s) fusionné(s) (config identique).`);
    } catch (e) { console.error('dedupProducts:', e.message); }
}
startupTask(dedupProductsBySignature, 1500);

// ============================================================
//  PHOTOS PRODUIT AUTOMATIQUES (Internet)
// ============================================================
// Toute fiche SANS photo (ordinateurs d'abord) reçoit une photo trouvée sur Internet : service de
// vignettes de Bing (image la plus pertinente pour la requête, recadrée 800×600, ~30 Ko). La photo
// est copiée dans public/uploads (aucun lien externe). Une photo importée à la main n'est jamais
// remplacée automatiquement ; « Autre photo » (stock / commercial en ligne) en propose une autre.
// Requête PRÉCISE sur le TYPE de produit : sans lui, un nom de modèle seul renvoie souvent une pièce
// détachée vendue sous ce nom (carte mère, coque, clavier…). Validé sur des modèles difficiles
// (ASUS X555 LD, W519 L, TUF FX86F, Panasonic CF-SV…) : « laptop notebook PC » = ordinateur entier.
// La configuration (processeur, écran) n'est PAS dans la 1re requête : elle fait dériver vers un autre
// modèle (ex. Panasonic CF-SV → Toughbook) ; elle sert de variante pour « Autre photo ».
const AUTO_IMG_LAPTOP = ['laptop notebook PC', 'notebook computer product image', 'laptop', 'laptop front view', null /* config */, 'laptop open screen'];
const AUTO_IMG_DESKTOP = ['desktop computer PC tower', 'desktop PC product image', 'all in one desktop computer', 'computer case tower'];
// Type précis d'ordinateur (catégorie, sous-catégorie, nom, série) : un PC tablette, un tout-en-un, un
// mini-PC ou un portable gamer ne se ressemblent pas — le type est dans TOUTES les variantes de requête.
const PC_KINDS = [
    [/tablet|tablette|convertible|x360|flip|yoga|2.?en.?1|2.?in.?1|detachable|d[eé]tachable|surface pro/i,
        ['2-in-1 tablet PC', 'convertible laptop tablet', '2-in-1 laptop', 'tablet PC keyboard', null, 'detachable tablet laptop']],
    [/all.?in.?one|tout.?en.?un|\baio\b/i, ['all in one desktop computer', 'all in one PC', 'all in one computer screen', 'AIO desktop PC']],
    [/mini.?(uc|pc)|\bnuc\b|micro.?pc|tiny/i, ['mini PC', 'mini desktop computer', 'mini PC small form factor', 'tiny desktop PC']],
    [/\buc\b|unit[ée] centrale|bureau|desktop|tour\b|tower|sff/i, AUTO_IMG_DESKTOP],
    [/gaming|gamer|\btuf\b|\brog\b|nitro|predator|omen|legion|victus|alienware|katana|thin gf|\bgf63\b/i,
        ['gaming laptop', 'gaming laptop notebook PC', 'gaming laptop front view', 'gaming notebook', null, 'gaming laptop open screen']],
];
// Qualificatifs d'accessoire utiles à la recherche (couleur, connectique, variante) — tirés de la
// catégorie, de la sous-catégorie et du nom, traduits en anglais.
const ACC_QUALIF = [
    [/m[eé]cani/i, 'mechanical'], [/gam(ing|er)/i, 'gaming'], [/sans.?fil|wireless|bluetooth/i, 'wireless'], [/filaire|wired/i, 'wired'],
    [/ngff|m\.?2\b/i, 'M.2'], [/nvme/i, 'NVMe'], [/\bsata\b/i, 'SATA'], [/\brgb\b|\bled\b/i, 'RGB'], [/magsafe/i, 'MagSafe'],
    [/type.?c|usb.?c|c to c/i, 'USB-C'], [/hdmi/i, 'HDMI'], [/\bvga\b/i, 'VGA'], [/rj45|r[eé]seau|ethernet/i, 'RJ45'],
    [/wifi ?6/i, 'WiFi 6'], [/\bnoir|black/i, 'black'], [/\bblanc|white/i, 'white'], [/\bgris|grey|gray/i, 'grey'],
    [/\brouge|\bred\b/i, 'red'], [/\bbleu|\bblue/i, 'blue'], [/\balu/i, 'aluminium'], [/mini\b/i, 'mini'],
];
// Accessoires : type en anglais déduit de la catégorie (ordre = du plus précis au plus général).
const ACC_TYPES = [
    [/prot[eé]ge.?clavier/, 'laptop keyboard cover protector'], [/tapis|mouse ?pad/, 'mouse pad'],
    [/batt/, 'laptop battery'], [/powerbank|power ?bank|battery pack/, 'power bank'],
    [/chargeur.*type.?c|type.?c.*chargeur/, 'USB-C charger'], [/chargeur|alimentation|adapter? secteur/, 'laptop charger power adapter'],
    [/clavier|azerty|keyboard/, 'keyboard'], [/souris|mouse/, 'computer mouse'],
    [/[eé]cran.*pin|[eé]cran.*laptop|dalle/, 'laptop LCD screen panel'], [/moniteur|[eé]cran/, 'computer monitor'],
    [/disque|ssd|hdd|seag|nvme|m\.?2/, 'hard drive SSD'], [/\bram\b|barrette/, 'RAM memory module'],
    [/coolingpad|cooling ?pad/, 'laptop cooling pad'], [/watercool|ventirad|venti|fan|ventilateur/, 'PC cooling fan'],
    [/casque|headset/, 'headset'], [/[eé]couteur|air ?pod|earphone/, 'earphones'],
    [/micro(phone|cravat|condens|fil| )|microphone/, 'microphone'], [/webcam/, 'webcam'], [/cam[eé]ra/, 'camera'],
    [/manette|gamepad/, 'gamepad controller'], [/routeur|router|modem/, 'wifi router'], [/r[eé]p[eé]teur/, 'wifi repeater'],
    [/acc[eè]s point|access point/, 'wifi access point'], [/switch/, 'network switch'], [/dongle|capteur wifi|nano wifi/, 'USB wifi dongle'],
    [/hub/, 'USB hub'], [/otg|adapt|convert|to (vga|hdmi|rj45|dvi)|splitter|docking/, 'adapter'], [/c[aâ]ble|cable/, 'cable'],
    [/housse|sacoche|sleeve/, 'laptop sleeve bag'], [/support|stand|bras/, 'stand'], [/onduleur|stabilisateur/, 'UPS power'],
    [/rack/, 'hard drive enclosure'], [/haut.?parleur|speaker/, 'speaker'], [/lecteur dvd/, 'external DVD drive'],
    [/lecteur carte/, 'card reader'], [/led|light|lumi/, 'LED light'], [/thermique|thermal/, 'thermal pad'],
];
const CONFIG_GEN = c => {
    const m = /\b(i[3579])\s*[-– ]?\s*(\d{1,2})/i.exec(String(c || ''));
    if (m) { const n = +m[2]; return `${m[1].toLowerCase()} ${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'} gen`; }
    const o = /(pentium|celeron|ryzen\s*\d|athlon|xeon|core\s*2\s*duo|core\s*m\d?)\s*[\w-]*/i.exec(String(c || ''));
    return o ? o[0].trim() : '';
};
// « W519 L » → « W519L », « X550 CC » → « X550CC » (une lettre isolée après des chiffres fait partie du modèle).
const compactModel = m => String(m || '').trim().split(/\s+/).reduce((acc, t) => {
    if (acc.length && /^[A-Za-z]{1,2}$/.test(t) && /\d$/.test(acc[acc.length - 1])) acc[acc.length - 1] += t; else acc.push(t);
    return acc;
}, []).join(' ');
function autoImageQuery(p, variant = 0) {
    const clean = s => String(s || '').replace(/[^\p{L}\p{N}+.\-\/ ]/gu, ' ').replace(/\s+/g, ' ').trim();
    const brand = clean(p.brand), model = compactModel(clean(p.model));
    if (!model) return null;                               // sans modèle : requête trop vague → pas de photo au hasard
    const v = Math.abs(variant || 0);
    if (!p.is_accessory) {
        if (!brand) return null;
        const kind = PC_KINDS.find(([re]) => re.test(`${p.category || ''} ${p.subcategory || ''} ${p.name || ''} ${p.model || ''}`));
        const list = kind ? kind[1] : AUTO_IMG_LAPTOP;
        let suffix = list[v % list.length];
        if (suffix === null) {   // variante « config » : génération du processeur + taille d'écran
            const scr = String(p.screen_size || '').replace(/[^0-9.]/g, '');
            suffix = [list[0], CONFIG_GEN(p.cpu), scr ? scr + '"' : ''].filter(Boolean).join(' ');
        }
        return `${brand} ${model} ${suffix}`;
    }
    const catRaw = String(p.category || '').trim();
    const hay = `${catRaw} ${p.brand || ''} ${p.model || ''} ${p.name || ''}`.toLowerCase();
    const hit = ACC_TYPES.find(([re]) => re.test(hay));
    const cat = /^accessoires?$/i.test(catRaw) ? '' : clean(catRaw);
    const words = [];
    for (const w of `${brand} ${model} ${hit ? '' : cat}`.split(' '))
        if (w && !words.some(x => x.toLowerCase() === w.toLowerCase())) words.push(w);
    if (words.join('').length < 4) return null;
    let type = hit ? hit[1] : '';
    // Qualificatifs (sous-catégorie, nom) absents de la requête : mécanique, sans fil, M.2, couleur…
    const qual = ACC_QUALIF.filter(([re]) => re.test(`${catRaw} ${p.subcategory || ''} ${p.name || ''}`)).map(([, w]) => w)
        .filter(w => !`${words.join(' ')} ${type}`.toLowerCase().includes(w.toLowerCase()));
    if (qual.length) type = `${qual.join(' ')} ${type}`.trim();
    const extra = ['', ' product photo', ' white background', ' original'][v % 4];
    return `${words.join(' ')}${type ? ' ' + type : ''}${extra}`;
}
// Photo automatique faite avec une ANCIENNE version de la recherche (à refaire) : source 'auto' (pas
// 'auto_choix' = choisie par un utilisateur via « Autre photo ») et requête ≠ requête actuelle.
const autoImageStale = p => p.image_source === 'auto' && p.image && p.image_query !== autoImageQuery(p, 0);
async function fetchAutoImage(p, variant = 0) {
    const q = autoImageQuery(p, variant);
    if (!q) return null;
    const url = `https://tse1.mm.bing.net/th?q=${encodeURIComponent(q)}&w=800&h=600&c=7&rs=1&p=0&pid=1.7&mkt=fr-FR&adlt=strict`;
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 15000);
    try {
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (STOCKFLOW catalogue)' }, signal: ac.signal });
        const ct = r.headers.get('content-type') || '';
        if (!r.ok || !/^image\/(jpeg|png|webp)/.test(ct)) return null;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length < 4000 || buf.length > 3000000) return null;
        const name = `auto-${p.id}-${Date.now()}${ct.includes('png') ? '.png' : ct.includes('webp') ? '.webp' : '.jpg'}`;
        fs.mkdirSync(UPLOADS_DIR, { recursive: true });
        fs.writeFileSync(path.join(UPLOADS_DIR, name), buf);
        return { rel: '/uploads/' + name, query: q };
    } catch (e) { return null; } finally { clearTimeout(timer); }
}
// force = false : seulement si la fiche n'a toujours pas de photo (file automatique).
// force = true  : « Autre photo » demandée par un utilisateur (remplace même une photo importée).
// refresh = fiche modifiée (nom / type / config) : nouvelle recherche avec les nouvelles infos, remplace
// toute photo Internet (même choisie via « Autre photo ») — jamais une photo importée à la main.
async function applyAutoImage(productId, { variant = 0, force = false, redo = false, refresh = false } = {}) {
    const p = await dbGet('SELECT * FROM products WHERE id = ?', [productId]);
    if (!p || p.is_service) return null;
    if (refresh ? (p.image && (p.image_source === 'manuel' || !p.image_source)) : redo ? !autoImageStale(p) : (!force && p.image)) return null;
    const got = await fetchAutoImage(p, variant);
    if (!got) return null;
    const cond = force ? '' : refresh ? " AND (image IS NULL OR image = '' OR image_source LIKE 'auto%')"
        : redo ? " AND image_source = 'auto'" : " AND (image IS NULL OR image = '')";
    const up = await dbRun(`UPDATE products SET image = ?, image_source = ?, image_query = ? WHERE id = ?${cond}`,
        [got.rel, force ? 'auto_choix' : 'auto', got.query, p.id]);
    if (!up.changes) { unlinkUpload(got.rel); return null; }
    if (p.image && p.image !== got.rel) {
        const shared = await dbGet('SELECT 1 FROM products WHERE image = ? AND id <> ? LIMIT 1', [p.image, p.id]);
        if (!shared) unlinkUpload(p.image);
    }
    // Seulement pour une demande explicite : la file automatique (une photo toutes les 2,5 s) ne fait pas
    // recharger tous les écrans ouverts — les photos apparaissent au prochain chargement normal.
    if (force || refresh) broadcast('stock:update', { product_id: p.id });
    return got;
}
// File d'attente : une recherche toutes les 2,5 s (sans surcharger le service), en arrière-plan.
// Après 6 échecs d'affilée (pas d'Internet…), pause de 15 min.
const AutoImgQueue = {
    pending: new Set(), running: false, fails: 0,
    // Suivi (indicateur admin, Stock dépôt) : depuis le dernier démarrage du serveur.
    done: 0, failed: 0, skipped: 0, last: null, pausedUntil: 0,
    add(id, urgent) {
        id = Number(id); if (!id) return;
        if (urgent) { const rest = [...this.pending].filter(x => x !== id); this.pending = new Set([id, ...rest]); }
        else this.pending.add(id);
        this.run();
    },
    async run() {
        if (this.running) return;
        this.running = true;
        try {
            while (this.pending.size) {
                const id = this.pending.values().next().value;
                this.pending.delete(id);
                const p = await dbGet('SELECT * FROM products WHERE id = ?', [id]).catch(() => null);
                const redo = !!(p && autoImageStale(p));                             // photo d'une ancienne recherche
                if (!p || p.is_service || (p.image && !redo)) continue;            // déjà une photo entre-temps
                if (!autoImageQuery(p)) { this.skipped++; continue; }              // sans modèle : ignoré (pas un échec réseau)
                let ok = null;
                try { ok = await applyAutoImage(id, { redo }); } catch (e) {}
                if (ok) { this.done++; this.fails = 0; this.last = { id, name: [p.brand, p.model].filter(Boolean).join(' ') || p.name, at: Date.now() }; }
                else { this.failed++; this.fails++; }
                if (this.fails >= 6) {                                               // plus d'Internet ? pause 15 min
                    this.pausedUntil = Date.now() + 15 * 60000;
                    await new Promise(r => setTimeout(r, 15 * 60000));
                    this.pausedUntil = 0; this.fails = 0;
                } else await new Promise(r => setTimeout(r, 2500));
            }
        } finally { this.running = false; }
    }
};
async function autoImageSweep() {
    const s = await getSettingsAsync().catch(() => ({}));
    if (String(s.auto_product_images || '1') === '0') return;
    // Ordinateurs d'abord (sans photo, puis photo d'une ancienne recherche à refaire), puis accessoires.
    const rows = await dbAll(`SELECT * FROM products WHERE COALESCE(is_service, 0) = 0
                              AND (image IS NULL OR image = '' OR image_source = 'auto')
                              ORDER BY is_accessory, (image IS NOT NULL AND image <> ''), id`).catch(() => []);
    rows.filter(p => !p.image || autoImageStale(p)).forEach(r => AutoImgQueue.add(r.id));
}
startupTask(() => {
    ensureColumn('products', 'image_source', 'image_source TEXT');   // 'auto' (Internet) | 'manuel' (importée)
    ensureColumn('products', 'image_query', 'image_query TEXT');     // requête utilisée pour la photo automatique
    // Photos déjà choisies par un utilisateur via « Autre photo » (requête avec suffixe de variante) :
    // marquées 'auto_choix' pour ne jamais être refaites automatiquement.
    db.run(`UPDATE products SET image_source = 'auto_choix' WHERE image_source = 'auto'
            AND (image_query LIKE '% front view' OR image_query LIKE '% official product photo' OR image_query LIKE '% white background'
                 OR image_query LIKE '% side view' OR image_query LIKE '% product')`);
    setTimeout(() => autoImageSweep().catch(() => {}), 30000);        // rattrapage des fiches sans photo
    setInterval(() => autoImageSweep().catch(() => {}), 6 * 3600000);
}, 4700);

// Index des jointures / recherches les plus fréquentes (unités vendues, notifications par ref,
// livraison d'une vente, lignes par unité…) : évite des parcours complets de tables qui grossissent.
startupTask(() => {
    ensureColumn('delivery_items', 'catalog_price', 'catalog_price REAL');   // prix de la fiche au moment de la commande
    [
        'idx_sitems_unit ON sale_items(unit_id)',
        'idx_notif_ref ON notifications(ref, resolved)',
        'idx_deliv_sale ON deliveries(sale_id)',
        'idx_deliv_status ON deliveries(status)',
        'idx_spay_sale ON sale_payments(sale_id)',
        'idx_lay_sale ON layaways(sale_id)',
        'idx_dpay_deliv ON delivery_payments(delivery_id)',
        'idx_lpay_lay ON layaway_payments(layaway_id)',
        'idx_citems_unit ON consignment_items(unit_id)',
        'idx_citems_cons ON consignment_items(consignment_id)',
        'idx_ritems_unit ON reservation_items(unit_id)',
        'idx_ritems_resa ON reservation_items(reservation_id)',
        'idx_litems_unit ON layaway_items(unit_id)',
        'idx_litems_lay ON layaway_items(layaway_id)',
        'idx_iitems_task ON install_items(task_id)',
        'idx_ditems_deliv ON delivery_items(delivery_id)',
        'idx_sret_unit ON sale_returns(unit_id)',
        'idx_sret_sale ON sale_returns(sale_id)',
        'idx_gar_unit ON garantie_actions(unit_id)',
        'idx_mov_to ON unit_movements(to_status)',
        'idx_units_msn ON stock_units(manufacturer_sn)'
    ].forEach(ix => db.run(`CREATE INDEX IF NOT EXISTS ${ix}`));
    // Nettoyage unique : anciennes alertes « Livraison impayée en cours » créées SANS ref (impossibles à
    // résoudre, empilées toutes les 10 min). Les nouvelles alertes portent une ref et sont dédoublonnées.
    db.run(`UPDATE notifications SET resolved = 1 WHERE ref IS NULL AND resolved = 0 AND title = 'Livraison impayée en cours'`);
}, 4600);

// ============================================================
//  HELPERS
// ============================================================
function logActivity(req, action, entity, entityId, details) {
    const u = req.session && req.session.user;
    req._logged = true;   // le journal automatique (middleware) ne double pas cette action
    db.run(`INSERT INTO activity_log (user_id, user_name, action, entity, entity_id, details, created_at, ip, path)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [u ? u.id : null, u ? u.full_name || u.username : 'système',
         action, entity || null, entityId != null ? String(entityId) : null,
         details ? JSON.stringify(details) : null, getDateTime(),
         typeof req.get === 'function' ? clientIp(req) : null, req.method ? `${req.method} ${req.path}`.slice(0, 200) : null], () => {});
}

/**
 * Crée une notification (persistée) et la diffuse en SSE au destinataire.
 * @param {object} n - { target_user?, target_role?, type, title, message, link?, data?, persistent? }
 */
function pushNotification(n) {
    const row = {
        target_user: n.target_user || null,
        target_role: n.target_role || null,
        type: n.type || 'info',
        title: n.title || '',
        message: n.message || '',
        link: n.link || null,
        data: n.data ? JSON.stringify(n.data) : null,
        persistent: n.persistent ? 1 : 0,
        ref: n.ref || null,
        created_at: getDateTime()
    };
    db.run(`INSERT INTO notifications (target_user, target_role, type, title, message, link, data, persistent, ref, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.target_user, row.target_role, row.type, row.title, row.message, row.link, row.data, row.persistent, row.ref, row.created_at],
        function () {
            const payload = { id: this.lastID, ...row, data: n.data || null, is_read: 0 };
            const target = row.target_user ? { userId: row.target_user }
                         : row.target_role ? { role: row.target_role } : undefined;
            broadcast('notification', payload, target);
        });
}

// Résout (fait disparaître) les notifications liées à une entité dès que
// l'action attendue est réalisée — sans attendre une lecture manuelle.
function resolveNotifs(ref) {
    if (!ref) return;
    db.run(`UPDATE notifications SET resolved = 1 WHERE ref = ? AND resolved = 0`, [ref], () => {
        broadcast('notif:resolved', { ref });
    });
}

function getSettings(cb) {
    db.all('SELECT key, value FROM settings', [], (err, rows) => {
        const s = {};
        (rows || []).forEach(r => s[r.key] = r.value);
        cb(s);
    });
}
function getSettingsAsync() { return new Promise(res => getSettings(res)); }

// Responsable de l'envoi des garanties fournisseur (utilisateur désigné par l'admin).
function garantieResponsibleId(cb) {
    db.get("SELECT value FROM settings WHERE key = 'garantie_responsible_id'", [], (e, r) => {
        cb(r && r.value ? parseInt(r.value, 10) : null);
    });
}
// Responsable de la boutique (commercial désigné par l'admin) : SEUL autorisé à recevoir une
// « sortie boutique » (stock partagé de la boutique, vendable par la caisse à tout client). Les
// autres commerciaux BOUTIQUE passent par « Réservé à vendre » (unités à leur nom, à rendre si non
// vendues). Les commerciaux EN LIGNE gardent leur prise au dépôt (canal séparé, suivi en ligne).
function boutiqueResponsibleId(cb) {
    db.get("SELECT value FROM settings WHERE key = 'boutique_responsible_id'", [], (e, r) => {
        cb(r && r.value ? parseInt(r.value, 10) : null);
    });
}
function boutiqueResponsibleIdAsync() { return new Promise(res => boutiqueResponsibleId(res)); }

// Middleware : admin OU l'utilisateur désigné responsable garantie.
function requireGarantieResponsible(req, res, next) {
    const u = req.session && req.session.user;
    if (!u) return res.status(401).json({ error: 'Non authentifié' });
    if (u.role === 'admin') return next();
    garantieResponsibleId(rid => {
        if (rid === u.id) return next();
        res.status(403).json({ error: 'Réservé au responsable des garanties' });
    });
}
// Middleware : consultation garantie (récap/historique) — admin, gestionnaire du stock OU responsable.
function requireGarantieViewer(req, res, next) {
    const u = req.session && req.session.user;
    if (!u) return res.status(401).json({ error: 'Non authentifié' });
    if (u.role === 'admin' || hasRole(u, 'gestion_stock')) return next();
    garantieResponsibleId(rid => {
        if (rid === u.id) return next();
        res.status(403).json({ error: 'Accès non autorisé' });
    });
}

// ─── Client : nom + contact OBLIGATOIRES partout ; contact = au moins 10 chiffres ───
function clientError(name, phone) {
    if (!String(name == null ? '' : name).trim()) return 'Nom du client obligatoire';
    if (!String(phone == null ? '' : phone).trim()) return 'Contact du client obligatoire';
    if (String(phone).replace(/\D/g, '').length < 10) return 'Contact du client invalide : au moins 10 chiffres (ex. 034 12 345 67)';
    return null;
}

// ─── Wrappers Promise pour un code de transactions lisible ───
function dbRun(sql, params = []) {
    return new Promise((resolve, reject) =>
        db.run(sql, params, function (e) { e ? reject(e) : resolve(this); }));
}
function dbGet(sql, params = []) {
    return new Promise((resolve, reject) =>
        db.get(sql, params, (e, r) => e ? reject(e) : resolve(r)));
}
function dbAll(sql, params = []) {
    return new Promise((resolve, reject) =>
        db.all(sql, params, (e, r) => e ? reject(e) : resolve(r || [])));
}

// ─── Numéro de vente du jour (unique par date) ───
// Le numéro est RÉSERVÉ en mémoire de façon synchrone après la lecture du MAX : deux ventes
// simultanées ne peuvent plus obtenir le même numéro (un numéro réservé puis abandonné laisse
// un trou, sans conséquence). Pas de promesse partagée : un appel depuis une transaction ne
// peut pas attendre une lecture mise en file derrière elle.
const _saleNumberHigh = new Map();   // date → plus grand numéro déjà attribué
async function nextSaleNumber(date) {
    const row = await dbGet('SELECT MAX(sale_number) AS mx FROM sales WHERE sale_date = ?', [date]);
    const n = Math.max((row && row.mx) || 0, _saleNumberHigh.get(date) || 0) + 1;
    _saleNumberHigh.set(date, n);
    if (_saleNumberHigh.size > 8) _saleNumberHigh.delete(_saleNumberHigh.keys().next().value);
    return n;
}

// ============================================================
//  CYCLE DE VIE D'UNE UNITÉ (numéro de série) — statuts partagés
// ============================================================
const UNIT_STATUS = {
    stock:                 'En stock',
    preparation:           'En préparation',
    presentoir:            'En présentoir',
    reserve:               'Réservé',
    acompte:               'Réservé (avance)',
    consignation:          'En boutique',
    livraison:             'En livraison',
    vendu:                 'Vendu',
    garantie_client:       'Garantie (client)',
    garantie_fournisseur:  'Garantie (fournisseur)',
    garantie_exceptionnel: 'Garantie exceptionnelle',
    garantie_a_renvoyer:   'Garantie — à renvoyer',
    retour_fournisseur:    'Retour fournisseur',
    garantie_retournee:    'Garantie — revenue (à réceptionner)',
    remboursement_attente: 'Remboursement — à valider (stock)',
    retour_attente:        'Retour à réceptionner',
    defectueux:            'Stock défectueux',
    usage_magasin:         'Usage magasin',
    retire:                'Retiré'
};

// Enregistre un mouvement dans l'historique d'une unité (base du « suivi »).
function recordMovement(unit, toStatus, action, req, extra = {}) {
    const u = req && req.session && req.session.user;
    return dbRun(
        `INSERT INTO unit_movements (unit_id, serial, from_status, to_status, action, user_id, user_name, ref_type, ref_id, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [unit.id, unit.serial, extra.from || unit.status || null, toStatus, action,
         u ? u.id : null, u ? (u.full_name || u.username) : 'système',
         extra.ref_type || null, extra.ref_id != null ? String(extra.ref_id) : null,
         extra.note || null, getDateTime()]);
}

// Résout les unités à sortir du dépôt pour une sortie (installation / boutique / réservation).
// Priorité aux n° de série SCANNÉS (unit_ids) : ce sont EXACTEMENT ces unités qui sortent,
// jamais une autre du même modèle. Repli : sélection auto par produit+quantité (lines).
// Renvoie { units } (avec product_name) ou { error }.
async function resolveDepotUnits(unit_ids, lines) {
    if (Array.isArray(unit_ids) && unit_ids.length) {
        const ph = unit_ids.map(() => '?').join(',');
        const rows = await dbAll(
            `SELECT u.*, p.name AS product_name FROM stock_units u LEFT JOIN products p ON p.id = u.product_id
             WHERE u.id IN (${ph})`, unit_ids);
        if (rows.length !== unit_ids.length) return { error: 'Certaines unités sont introuvables.' };
        const bad = rows.find(u => u.status !== 'stock');
        if (bad) return { error: `L'unité ${bad.serial} n'est plus disponible au dépôt (${bad.status}).` };
        // Conserve l'ordre des scans.
        const byId = new Map(rows.map(u => [u.id, u]));
        return { units: unit_ids.map(id => byId.get(Number(id)) || byId.get(id)).filter(Boolean) };
    }
    if (Array.isArray(lines) && lines.length) {
        const units = [];
        for (const l of lines) {
            const qty = Math.max(1, parseInt(l.quantity, 10) || 1);
            const avail = await dbAll(
                `SELECT u.*, p.name AS product_name FROM stock_units u LEFT JOIN products p ON p.id = u.product_id
                 WHERE u.product_id = ? AND u.status = 'stock' ORDER BY u.id LIMIT ?`, [l.product_id, qty]);
            if (avail.length < qty) {
                const pr = await dbGet('SELECT name FROM products WHERE id = ?', [l.product_id]);
                return { error: `Stock insuffisant pour « ${pr ? pr.name : 'produit'} » (${avail.length}/${qty}).` };
            }
            units.push(...avail);
        }
        return { units };
    }
    return { error: 'Aucun produit sélectionné.' };
}

// Journalise une action de garantie (pour l'historique et le rapport PDF).
async function logGarantie(unit, action, type, req, extra = {}) {
    const u = req && req.session && req.session.user;
    let supplierName = extra.supplier_name || null;
    if (!supplierName && unit && unit.supplier_id) {
        const s = await dbGet('SELECT name FROM suppliers WHERE id = ?', [unit.supplier_id]);
        supplierName = s ? s.name : null;
    }
    return dbRun(
        `INSERT INTO garantie_actions (unit_id, serial, supplier_id, supplier_name, garantie_type, action, sender_name, technician_name, reason, amount, user_id, user_name, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [unit.id, unit.serial, unit.supplier_id || null, supplierName, type || null, action,
         extra.sender_name || null, extra.technician_name || null, extra.reason || null, extra.amount || 0,
         u ? u.id : null, u ? (u.full_name || u.username) : 'système', getDateTime()]);
}

// Calcule le nom d'affichage d'un modèle produit.
function productDisplayName(p) {
    const parts = [p.brand, p.model].filter(Boolean);
    let name = parts.join(' ').trim();
    if (!name) name = p.model || p.subcategory || p.category || 'Produit';
    return name;
}
// Signature de dédoublonnage d'un modèle (mêmes specs → même carte de stock).
// Normalisée pour ignorer les simples différences d'écriture : casse, accents, espaces et
// ponctuation (« Latitude 5490 » = « LATITUDE 5490 »), génération CPU (« i5 - 8eme generation » =
// « i5-8th » = « I5-8e »), capacités (« 500 » = « 500Go » = « 500 Go »), écran (« 14".0 » = « 14. 0" »)
// et GPU intégré (« intel hd » = « Intel UHD » = non renseigné).
const sigBase = v => String(v == null ? '' : v).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const sigAlnum = v => sigBase(v).replace(/[^a-z0-9]/g, '');
const sigNum = v => { const m = sigBase(v).replace(/,/g, '.').replace(/[^0-9.]/g, '').match(/\d+(\.\d+)?/); return m ? String(parseFloat(m[0])) : sigAlnum(v); };
const sigCap = v => { const m = sigBase(v).replace(/,/g, '.').match(/(\d+(?:\.\d+)?)\s*(to|tb)?/); return m ? String(parseFloat(m[1]) * (m[2] ? 1000 : 1)) : sigAlnum(v); };
const sigCpu = v => sigAlnum(sigBase(v).replace(/\b(core|intel|processeur|generation|gen)\b/g, ' ').replace(/(\d+)\s*(eme|e|th|nd|rd|st|me|ere|er)\b/g, '$1'));
const sigGpu = v => { const s = sigAlnum(v); return (!s || s.includes('intel')) ? '' : s; };
function productSignature(p) {
    return [p.is_accessory ? 'acc' : 'pc', sigAlnum(p.category), sigAlnum(p.subcategory), sigAlnum(p.brand), sigAlnum(p.model),
            sigCpu(p.cpu), sigCap(p.ram), sigCap(p.storage), sigAlnum(p.storage_type), sigGpu(p.gpu), sigNum(p.screen_size),
            p.touchscreen ? 1 : 0, p.webcam ? 1 : 0, p.wifi ? 1 : 0, p.bluetooth ? 1 : 0, p.numpad ? 1 : 0].join('|');
}

// ─── Nouveau prix d'un produit → toutes ses unités pas encore vendues ───
// Dépôt, présentoir, boutique (consignation), réservé, installation, garantie, retours, retirées :
// le prix suit la fiche. Exclues : vendues, en livraison (facturées) et en avance (prix convenu avec
// le client). Les prix figés des sorties boutique / réservations en cours suivent aussi. Les
// détenteurs (commercial, technicien) sont prévenus : étiquettes à remplacer.
const PRICE_FROZEN = ['vendu', 'livraison', 'acompte'];
async function syncUnitPrices(productId, price, req) {
    price = Number(price) || 0;
    const units = await dbAll(
        `SELECT u.id, u.serial, u.status, u.holder_user_id, u.sale_price AS old_price FROM stock_units u
         WHERE u.product_id = ? AND u.status NOT IN (${PRICE_FROZEN.map(() => '?').join(',')}) AND COALESCE(u.sale_price, -1) <> ?`,
        [productId, ...PRICE_FROZEN, price]);
    if (!units.length) return [];
    const ids = units.map(u => u.id), ph = ids.map(() => '?').join(',');
    await dbRun(`UPDATE stock_units SET sale_price = ? WHERE id IN (${ph})`, [price, ...ids]);
    await dbRun(`UPDATE consignment_items SET unit_price = ? WHERE unit_id IN (${ph}) AND unit_id IN (SELECT id FROM stock_units WHERE status = 'consignation')`, [price, ...ids]);
    await dbRun(`UPDATE reservation_items SET unit_price = ? WHERE unit_id IN (${ph}) AND unit_id IN (SELECT id FROM stock_units WHERE status = 'reserve')`, [price, ...ids]);
    const prod = await dbGet('SELECT name FROM products WHERE id = ?', [productId]);
    const me = req && req.session && req.session.user ? req.session.user.id : null;
    const byHolder = new Map();
    units.filter(u => u.holder_user_id && u.holder_user_id !== me).forEach(u => {
        if (!byHolder.has(u.holder_user_id)) byHolder.set(u.holder_user_id, []);
        byHolder.get(u.holder_user_id).push(u);
    });
    for (const [uid, list] of byHolder)
        pushNotification({ target_user: uid, type: 'warn', title: 'Nouveau prix — étiquettes à remplacer',
            message: `${prod ? prod.name : 'Produit'} : ${Math.round(price).toLocaleString('fr-FR')} Ar · ${list.length} pièce(s) chez vous (${list.map(u => u.serial).filter(Boolean).slice(0, 6).join(', ')}${list.length > 6 ? '…' : ''})`,
            data: { product_id: productId, unit_ids: list.map(u => u.id) } });
    if (req) logActivity(req, 'price_sync', 'product', productId, { price, units: units.length });
    return units;
}

// ─── Fusion automatique des fiches produit IDENTIQUES ───
// Deux fiches (hors services) sont identiques si elles ont la même signature (type, catégorie,
// sous-catégorie, marque, modèle, configuration…) ET le même prix de vente. Cas typique : un
// produit modifié qui devient la copie d'un autre. La fiche la plus ANCIENNE (plus petit id) est
// conservée ; tout ce qui pointe vers le doublon (unités, ventes, réceptions, livraisons,
// réservations, bons de commande…) y est rattaché, puis le doublon est supprimé.
async function mergeProductInto(keepId, dupId) {
    if (!keepId || !dupId || keepId === dupId) return null;
    const keep = await dbGet('SELECT * FROM products WHERE id = ?', [keepId]);
    const dup = await dbGet('SELECT * FROM products WHERE id = ?', [dupId]);
    if (!keep || !dup) return null;
    const tables = (await dbAll(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'products'`)).map(t => t.name);
    const oldCode = accCode(dupId), newCode = accCode(keepId);
    const moved = {};
    await withTx(async () => {
        for (const t of tables) {
            const cols = (await dbAll(`PRAGMA table_info(${t})`)).map(c => c.name);
            if (cols.includes('product_id')) {
                const r = await dbRun(`UPDATE ${t} SET product_id = ? WHERE product_id = ?`, [keepId, dupId]);
                if (r.changes) moved[t] = r.changes;
            }
            // Code de modèle accessoire figé dans l'historique (A000dup → A000keep) — remplacement exact.
            if (cols.includes('serial')) await dbRun(`UPDATE ${t} SET serial = ? WHERE serial = ?`, [newCode, oldCode]);
        }
        // Complète la fiche conservée (image, description, emplacements, prix d'achat manquants).
        await dbRun(`UPDATE products SET image = COALESCE(image, ?), description = COALESCE(NULLIF(description, ''), ?), emplacement = ?,
                     purchase_price = CASE WHEN COALESCE(purchase_price, 0) = 0 THEN ? ELSE purchase_price END WHERE id = ?`,
            [dup.image || null, dup.description || null, normEmplacement([keep.emplacement, dup.emplacement].filter(Boolean).join(', ')),
             dup.purchase_price || 0, keepId]);
        await dbRun('DELETE FROM products WHERE id = ?', [dupId]);
    });
    logActivity({}, 'product_merge', 'product', keepId, { kept: keepId, merged: dupId, name: keep.name, price: keep.sale_price, moved });
    console.log(`🔀 Produit #${dupId} « ${dup.name} » fusionné dans #${keepId} (identiques)`, moved);
    return moved;
}

// Signatures stockées (clé de rattachement de la réception) : chaque signature est portée par la
// fiche la plus ancienne qui y correspond ; les autres (même config mais prix différent) n'en ont pas.
async function refreshProductSignatures() {
    const prods = await dbAll(`SELECT id, signature, is_accessory, category, subcategory, brand, model, cpu, ram, storage, storage_type, gpu,
                                      screen_size, touchscreen, webcam, wifi, bluetooth, numpad FROM products WHERE COALESCE(is_service, 0) = 0 ORDER BY id`);
    const holder = new Map(), want = new Map();
    for (const p of prods) { const s = productSignature(p); if (!holder.has(s)) holder.set(s, p.id); want.set(p.id, holder.get(s) === p.id ? s : null); }
    const changed = prods.filter(p => (p.signature || null) !== want.get(p.id));
    for (const p of changed) if (p.signature != null) await dbRun('UPDATE products SET signature = NULL WHERE id = ?', [p.id]);
    for (const p of changed) if (want.get(p.id) != null)
        await dbRun('UPDATE products SET signature = ? WHERE id = ?', [want.get(p.id), p.id]).catch(() => {});
    return changed.length;
}

// Une seule écriture par marque et par modèle : « Lenovo » / « LENOVO », « X555L » / « X555 L »
// désignaient le même produit sous des noms différents (recherche en ligne infructueuse, noms
// divergents entre stock, livraisons et commandes). L'écriture la plus utilisée (nb d'unités)
// l'emporte, sauf pour la fiche preferId (modification volontaire) dont l'écriture s'applique à tout
// le groupe. Le nom affiché (products.name) est ensuite recalculé = marque + modèle.
async function harmonizeProductNames(preferId) {
    const prods = await dbAll(`SELECT p.id, p.name, p.brand, p.model, p.subcategory, p.category,
            (SELECT COUNT(*) FROM stock_units u WHERE u.product_id = p.id) AS n
        FROM products p WHERE COALESCE(p.is_service, 0) = 0`);
    const pick = (list, field) => {
        const pref = preferId && list.find(p => p.id === +preferId);
        if (pref && pref[field]) return pref[field];
        const w = new Map();
        list.forEach(p => { const v = p[field]; if (!v) return; const o = w.get(v) || { v, n: 0, c: 0, id: p.id }; o.n += p.n || 0; o.c++; o.id = Math.min(o.id, p.id); w.set(v, o); });
        return [...w.values()].sort((a, b) => b.n - a.n || b.c - a.c || a.id - b.id)[0].v;
    };
    const cur = new Map(prods.map(p => [p.id, { brand: p.brand, model: p.model }]));
    const group = (keyOf) => { const g = new Map(); prods.forEach(p => { const k = keyOf(p); if (!k) return; (g.get(k) || g.set(k, []).get(k)).push(p); }); return g; };
    for (const list of group(p => p.brand && sigAlnum(p.brand)).values()) {
        const v = pick(list, 'brand'); list.forEach(p => { p.brand = v; cur.get(p.id).brand = v; });
    }
    for (const list of group(p => p.model && (sigAlnum(p.brand) + '|' + sigAlnum(p.model))).values()) {
        const v = pick(list, 'model'); list.forEach(p => { p.model = v; cur.get(p.id).model = v; });
    }
    const orig = new Map((await dbAll(`SELECT id, name, brand, model FROM products WHERE COALESCE(is_service, 0) = 0`)).map(p => [p.id, p]));
    let n = 0;
    for (const p of prods) {
        const o = orig.get(p.id); if (!o) continue;
        const name = productDisplayName(p);
        if (o.brand === p.brand && o.model === p.model && o.name === name) continue;
        await dbRun('UPDATE products SET brand = ?, model = ?, name = ? WHERE id = ?', [p.brand, p.model, name, p.id]);
        n++;
    }
    if (n) broadcast('stock:update', {});
    return n;
}

// Écriture déjà en usage pour une marque / un modèle saisi (réception) : « LENOVO » → « Lenovo »
// si c'est l'écriture existante la plus utilisée ; inchangé si la marque/le modèle est nouveau.
async function canonicalBrandModel(brand, model) {
    if (!brand && !model) return { brand, model };
    const rows = await dbAll(`SELECT p.brand, p.model, (SELECT COUNT(*) FROM stock_units u WHERE u.product_id = p.id) AS n
        FROM products p WHERE COALESCE(p.is_service, 0) = 0 AND p.brand IS NOT NULL`);
    const best = (list, f) => { const w = new Map(); list.forEach(r => w.set(r[f], (w.get(r[f]) || 0) + (r.n || 0) + 0.001)); return [...w].sort((a, b) => b[1] - a[1])[0][0]; };
    const kb = sigAlnum(brand);
    const sameB = kb ? rows.filter(r => sigAlnum(r.brand) === kb) : [];
    if (sameB.length) brand = best(sameB, 'brand');
    const km = sigAlnum(model);
    const sameM = km ? sameB.filter(r => r.model && sigAlnum(r.model) === km) : [];
    if (sameM.length) model = best(sameM, 'model');
    return { brand, model };
}

// Passe complète : fusionne tous les groupes identiques (ou seulement celui du produit onlyId),
// puis remet les signatures d'aplomb. Renvoie [{ keep, dup, name }].
let autoMergeRunning = null;
async function autoMergeIdenticalProducts(onlyId) {
    while (autoMergeRunning) await autoMergeRunning.catch(() => {});
    autoMergeRunning = (async () => {
        try { await harmonizeProductNames(onlyId); } catch (e) { console.error('harmonizeProductNames:', e.message); }
        const prods = await dbAll(`SELECT * FROM products WHERE COALESCE(is_service, 0) = 0 ORDER BY id`);
        const groups = new Map();
        for (const p of prods) {
            // Fusion auto seulement si TOUT concorde : config, prix, état (neuf/occasion…) et description.
            const k = [productSignature(p), Math.round(Number(p.sale_price) || 0), sigAlnum(p.condition), sigAlnum(p.description)].join('#');
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k).push(p);
        }
        const merged = [];
        for (const list of groups.values()) {
            if (list.length < 2 || (onlyId && !list.some(p => p.id === +onlyId))) continue;
            for (const d of list.slice(1)) if (await mergeProductInto(list[0].id, d.id)) merged.push({ keep: list[0].id, dup: d.id, name: list[0].name });
        }
        await refreshProductSignatures();
        if (merged.length) broadcast('stock:update', {});
        return merged;
    })();
    try { return await autoMergeRunning; } finally { autoMergeRunning = null; }
}
startupTask(() => autoMergeIdenticalProducts().catch(e => console.error('autoMerge:', e.message)), 5000);

// ============================================================
//  AUTH MIDDLEWARE
// ============================================================
const PASSWORD_MIN = 6;
// Session toujours alignée sur la base : un compte désactivé / supprimé est déconnecté, un changement
// de rôle s'applique tout de suite, et un changement de mot de passe (profil, admin, mot de passe
// oublié) invalide les AUTRES sessions du compte (empreinte du hash stockée dans la session).
const _userCache = new Map();   // id → { row, at }
function invalidateUserCache(id) { if (id == null) _userCache.clear(); else _userCache.delete(Number(id)); }
async function currentUserRow(id) {
    const c = _userCache.get(id);
    if (c && Date.now() - c.at < 30 * 1000) return c.row;
    const row = await dbGet('SELECT id, username, role, extra_roles, full_name, active, password, profile_photo, is_default FROM users WHERE id = ?', [id]);
    _userCache.set(id, { row: row || null, at: Date.now() });
    return row || null;
}
const pwdTag = hash => crypto.createHash('sha256').update(String(hash || '')).digest('hex').slice(0, 16);
app.use(async (req, res, next) => {
    const su = req.session && req.session.user;
    if (!su || !req.path.startsWith('/api/')) return next();
    try {
        const row = await currentUserRow(su.id);
        if (!row || row.active === 0 || (su.pwd && su.pwd !== pwdTag(row.password)))
            return req.session.destroy(() => res.status(401).json({ error: 'Session expirée : reconnectez-vous.' }));
        if (!su.pwd) su.pwd = pwdTag(row.password);
        su.role = row.role; su.roles = rolesOf(row); su.username = row.username; su.full_name = row.full_name;
        // Admin par défaut avec un mot de passe initial / faible connu : seule la lecture et le changement
        // de mot de passe (Mon profil) restent possibles, jusqu'à ce qu'il soit changé.
        if (req.method !== 'GET' && !/^\/api\/(profile|logout|login)\b/.test(req.path) && row.is_default === 1
            && await adminHasDefaultPassword())
            return res.status(403).json({ error: "Changez d'abord le mot de passe du compte admin (Mon profil) : il utilise encore un mot de passe par défaut connu.", code: 'must_change_password' });
        next();
    } catch (e) { next(); }
});

const requireAuth = (req, res, next) => {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'Non autorisé' });
};
const requireAdmin = (req, res, next) => {
    if (req.session && req.session.user && req.session.user.role === 'admin') return next();
    res.status(403).json({ error: 'Accès réservé aux administrateurs' });
};
// Vues « restreintes à ses propres données » : le compte n'a QUE le rôle concerné, sans rôle plus large
// (tient compte des rôles supplémentaires, pas seulement du rôle principal).
const technicianView = u => hasRole(u, 'technicien') && !hasRole(u, 'gestion_stock') && u.role !== 'admin';
const commercialView = u => hasRole(u, 'commercial', 'commercial_ligne') && !hasRole(u, 'caisse', 'gestion_stock') && u.role !== 'admin';
// Autorise l'admin + une liste de rôles.
const requireRole = (...roles) => (req, res, next) => {
    const u = req.session && req.session.user;
    if (u && (u.role === 'admin' || hasRole(u, ...roles))) return next();
    res.status(403).json({ error: 'Accès non autorisé pour votre rôle' });
};

// ============================================================
//  AUTH ROUTES + limitation des tentatives
// ============================================================
// Deux compteurs d'échecs : par IP client (seuil large : toute la boutique sort par la même IP
// publique) et par identifiant (seuil strict : protège un compte contre le devinage).
const loginAttempts = new Map();
const LOGIN_MAX_IP = 30, LOGIN_MAX_USER = 8, LOGIN_WINDOW_MS = 10 * 60 * 1000;
function clientIp(req) {
    // CF-Connecting-IP n'est fiable que si la requête arrive par le tunnel local (cloudflared).
    const sock = (req.socket && req.socket.remoteAddress) || '';
    const local = sock === '127.0.0.1' || sock === '::1' || sock === '::ffff:127.0.0.1';
    return (local && req.get('cf-connecting-ip')) || req.ip || 'unknown';
}
function loginKeys(req) {
    const keys = ['ip:' + clientIp(req)];
    const u = String((req.body && req.body.username) || '').trim().toLowerCase();
    if (u) keys.push('user:' + u);
    return keys;
}
function loginBlocked(key) {
    const rec = loginAttempts.get(key);
    const max = key.startsWith('user:') ? LOGIN_MAX_USER : LOGIN_MAX_IP;
    return rec && rec.count >= max && Date.now() - rec.first < LOGIN_WINDOW_MS;
}
function loginRateLimit(req, res, next) {
    if (loginKeys(req).some(loginBlocked))
        return res.status(429).json({ error: 'Trop de tentatives. Réessayez dans quelques minutes.' });
    next();
}
function registerFailedLogin(req) {
    for (const key of loginKeys(req)) {
        const rec = loginAttempts.get(key);
        if (rec && Date.now() - rec.first < LOGIN_WINDOW_MS) rec.count++;
        else loginAttempts.set(key, { count: 1, first: Date.now() });
    }
}
setInterval(() => {
    const now = Date.now();
    for (const [key, rec] of loginAttempts)
        if (now - rec.first > LOGIN_WINDOW_MS) loginAttempts.delete(key);
}, LOGIN_WINDOW_MS);

// Le compte admin par défaut (is_default) a-t-il encore un mot de passe initial / faible connu ?
// Résultat mis en cache par empreinte (bcrypt est coûteux) ; le mot de passe n'est jamais exposé.
let _defaultPwdCache = { hash: null, value: false };
function isWeakAdminPassword(hash) {
    let initial = process.env.ADMIN_DEFAULT_PASSWORD || null;
    if (!initial) { try { initial = fs.readFileSync(ADMIN_PWD_FILE, 'utf8').trim() || null; } catch (e) {} }
    return [...WEAK_ADMIN_PASSWORDS, initial].filter(Boolean).some(p => bcrypt.compareSync(p, hash));
}
async function adminHasDefaultPassword() {
    const row = await dbGet('SELECT password FROM users WHERE is_default = 1 LIMIT 1');
    if (!row || !row.password) return false;
    if (_defaultPwdCache.hash !== row.password)
        _defaultPwdCache = { hash: row.password, value: isWeakAdminPassword(row.password) };
    return _defaultPwdCache.value;
}

// ============================================================
//  SSE — flux temps réel authentifié
// ============================================================
app.get('/api/events', requireAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const id = sseNextId++;
    sseClients.set(id, { res, userId: req.session.user.id, role: req.session.user.role,
                         roles: Array.isArray(req.session.user.roles) ? req.session.user.roles : [req.session.user.role] });
    sseSend(res, 'ping', {});
    req.on('close', () => sseClients.delete(id));
});

// Questions proposées dans « Mon profil » (sf-layout.js) : le leurre en prend une au hasard stable.
const SECURITY_QUESTIONS = ["Nom de votre premier animal de compagnie ?", "Ville de naissance de votre mère ?",
    "Nom de votre école primaire ?", "Votre plat préféré ?", "Surnom d'enfance ?"];
function decoyQuestion(username) {
    const h = crypto.createHmac('sha256', SESSION_SECRET).update(String(username).trim().toLowerCase()).digest();
    return SECURITY_QUESTIONS[h[0] % SECURITY_QUESTIONS.length];
}
const FORGOT_DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);
const FORGOT_FAIL ="Réponse incorrecte. Si vous n'avez jamais défini de question secrète, contactez l'administrateur.";

// ============================================================
//  CODES D'INSCRIPTION (usage unique, un code = un compte)
//  L'admin génère un code lié à un rôle ; la personne l'utilise
//  une seule fois sur la page de connexion pour créer son compte.
// ============================================================
// Alphabet sans caractères ambigus (pas de O/0/I/1/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function genRegCode() {
    let s = '';
    for (let i = 0; i < 8; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];   // aléa cryptographique
    return s.slice(0, 4) + '-' + s.slice(4);
}
function normalizeCode(c) {
    return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');   // enlève tirets/espaces
}

// ============================================================
//  BONS DE COMMANDE FOURNISSEURS — le responsable commande (désigné par l'admin dans
//  Configuration) saisit ce qu'il a commandé (modèles, quantités, prix de vente, photos de
//  la facture) ; le responsable stock le CONSULTE (ouvrir le détail = « vu »), sans autre action.
//  Aucun lien avec le paiement ni avec le stock (seule la Réception alimente le stock).
// ============================================================
const SO_STATUS = ['en_attente', 'vu', 'annulee'];   // en_attente = pas encore consulté par le stock
const SO_FILE_DIR = path.join(APP_DIR, 'private_uploads', 'commandes');   // HORS de public/ : servi après contrôle d'accès
const SO_FILE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf' };
const soUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => { if (!fs.existsSync(SO_FILE_DIR)) fs.mkdirSync(SO_FILE_DIR, { recursive: true }); cb(null, SO_FILE_DIR); },
        filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + (SO_FILE_TYPES[file.mimetype] || ''))
    }),
    limits: { fileSize: 10 * 1024 * 1024, files: 10 },
    fileFilter: (req, file, cb) => SO_FILE_TYPES[file.mimetype] ? cb(null, true)
        : cb(new Error('Facture : photo (JPG, PNG, WEBP) ou PDF uniquement'))
});

// Responsable du service atelier (désigné en Configuration) : imprime les étiquettes des ordinateurs clients.
function atelierResponsibleId() {
    return dbGet("SELECT value FROM settings WHERE key = 'atelier_responsible_id'")
        .then(r => r && r.value ? parseInt(r.value, 10) : null).catch(() => null);
}
const requireAtelier = async (req, res, next) => {
    const u = req.session && req.session.user;
    if (u && (u.role === 'admin' || (await atelierResponsibleId()) === u.id)) return next();
    res.status(403).json({ error: 'Réservé au responsable du service atelier' });
};
function commandeResponsibleId() {
    return dbGet("SELECT value FROM settings WHERE key = 'commande_responsible_id'")
        .then(r => r && r.value ? parseInt(r.value, 10) : null).catch(() => null);
}
// Saisie des bons : admin + responsable commande désigné.
const requireSoWriter = async (req, res, next) => {
    const u = req.session && req.session.user;
    if (u && (u.role === 'admin' || (await commandeResponsibleId()) === u.id)) return next();
    res.status(403).json({ error: 'Réservé au responsable des commandes' });
};
// Consultation : + responsable stock.
const requireSoReader = async (req, res, next) => {
    const u = req.session && req.session.user;
    if (u && (u.role === 'admin' || hasRole(u, 'gestion_stock') || (await commandeResponsibleId()) === u.id)) return next();
    res.status(403).json({ error: 'Accès non autorisé pour votre rôle' });
};

// Normalise le corps d'un bon ; renvoie { error } ou { order, items }.
async function soParse(body) {
    const items = (Array.isArray(body.items) ? body.items : []).map(l => ({
        product_id: parseInt(l.product_id, 10) || null,
        designation: String(l.designation || '').trim(),
        quantity: Math.max(1, parseInt(l.quantity, 10) || 1),
        unit_price: Math.max(0, Number(l.unit_price) || 0)      // prix de vente prévu
    })).filter(l => l.designation);
    if (!items.length) return { error: 'Au moins un article (désignation) est obligatoire' };
    const supplierId = parseInt(body.supplier_id, 10) || null;
    let supplierName = String(body.supplier_name || '').trim();
    if (supplierId) {
        const s = await dbGet('SELECT name FROM suppliers WHERE id = ?', [supplierId]);
        if (!s) return { error: 'Fournisseur introuvable' };
        supplierName = s.name;
    }
    if (!supplierName) return { error: 'Fournisseur obligatoire' };
    const date = String(body.order_date || '').trim() || getDate();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'Date de commande invalide' };
    const expected = String(body.expected_date || '').trim();
    return { items, order: {
        supplier_id: supplierId, supplier_name: supplierName, order_date: date,
        expected_date: /^\d{4}-\d{2}-\d{2}$/.test(expected) ? expected : null,
        reference: String(body.reference || '').trim() || null,
        total: items.reduce((t, l) => t + l.quantity * l.unit_price, 0),
        note: String(body.note || '').trim() || null
    } };
}
async function soWriteItems(orderId, items) {
    await dbRun('DELETE FROM supplier_order_items WHERE order_id = ?', [orderId]);
    for (const l of items)
        await dbRun(`INSERT INTO supplier_order_items (order_id, product_id, designation, quantity, unit_price) VALUES (?,?,?,?,?)`,
            [orderId, l.product_id, l.designation, l.quantity, l.unit_price]);
}
async function soAttach(orders) {
    if (!orders.length) return orders;
    const ids = orders.map(o => o.id), q = ids.map(() => '?').join(',');
    const items = await dbAll(`SELECT * FROM supplier_order_items WHERE order_id IN (${q}) ORDER BY id`, ids);
    const files = await dbAll(`SELECT id, order_id, original_name, mime, uploaded_by_name, created_at FROM supplier_order_files WHERE order_id IN (${q}) ORDER BY id`, ids);
    const bi = {}, bf = {};
    items.forEach(i => (bi[i.order_id] = bi[i.order_id] || []).push(i));
    files.forEach(f => (bf[f.order_id] = bf[f.order_id] || []).push(f));
    orders.forEach(o => { o.items = bi[o.id] || []; o.files = bf[o.id] || []; });
    return orders;
}
const soNum = n => 'CF-' + String(n).padStart(4, '0');

// Photos / PDF de la facture fournisseur (plusieurs fichiers).
// Erreur multer (type/taille) → message JSON lisible au lieu de la page d'erreur Express.
const soUploadFiles = (req, res, next) => soUpload.array('files', 10)(req, res, err => {
    if (!err) return next();
    res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop lourd (10 Mo max)' : err.message });
});

// ============================================================
//  NOTIFICATIONS
// ============================================================
// Destinataire d'une notification : l'utilisateur lui-même OU l'un de SES rôles (principal + supplémentaires).
function notifTarget(u) {
    const roles = Array.isArray(u.roles) && u.roles.length ? u.roles : [u.role];
    return { sql: `(target_user = ? OR (target_user IS NULL AND target_role IN (${roles.map(() => '?').join(',')})))`, params: [u.id, ...roles] };
}

// ============================================================
//  STOCK DÉPÔT (cartes)
// ============================================================
const DEPOT_STATUSES = ['stock', 'preparation', 'presentoir', 'reserve', 'consignation'];
// Expression SQL « compacte » (minuscules, sans espaces ni ponctuation courante) ≈ sigAlnum côté JS.
const SQL_COMPACT = e => ["' '", "'-'", "'.'", "'_'", "'/'", "'\"'", "''''"].reduce((x, c) => `REPLACE(${x}, ${c}, '')`, `LOWER(${e})`);

// ═══════════════════════════════════════════════════════════════════════════
// INVENTAIRE PHYSIQUE (stock-take par scan) — ADMIN uniquement.
// Portée : produits NON accessoires (ordinateurs, écrans…) physiquement présents
// sur place = stock / préparation / présentoir / réservé / consignation / garantie exceptionnelle.
// On exclut vendu et les autres garanties (physiquement absents du magasin).
// ═══════════════════════════════════════════════════════════════════════════
const INV_SCOPE = ['stock', 'preparation', 'presentoir', 'reserve', 'consignation', 'garantie_exceptionnel'];

// Zone physique d'un statut, pour le contrôle d'emplacement lors du scan en 2 étapes (boutique → dépôt).
// Boutique = présentoir + consignation ; Dépôt = stock, préparation, réservé, garantie exceptionnelle.
const INV_ZONE = {
    presentoir: 'boutique', consignation: 'boutique',
    stock: 'depot', preparation: 'depot', reserve: 'depot', garantie_exceptionnel: 'depot'
};

// Deux inventaires distincts :
//   'pc'        → ordinateurs, écrans… (produits NON accessoires)          — ADMIN uniquement.
//   'composant' → RAM & disques durs suivis à l'unité (accessoires sérialisés) — ADMIN + gestion du stock.
// Chaque route reçoit son « kind » (query ?kind= ou body.kind) ; défaut = 'pc' (rétro-compat).
function invKind(req) {
    const k = (req.query && req.query.kind) || (req.body && req.body.kind);
    return k === 'composant' ? 'composant' : 'pc';
}
// Filtre produit SQL selon le type d'inventaire.
function invFilter(kind) {
    return kind === 'composant' ? 'p.is_accessory = 1 AND p.serialized = 1' : 'p.is_accessory = 0';
}
// Table de brouillon (pause/reprendre) selon le type — séparées pour ne pas se marcher dessus.
function invDraftTable(kind) {
    return kind === 'composant' ? 'inventaire_comp_draft' : 'inventaire_draft';
}
// Contrôle d'accès : les deux inventaires ('pc' ordinateurs et 'composant') sont ouverts à
// l'admin ET au gestionnaire du stock. Les routes sont déjà limitées à ces rôles par
// requireRole('gestion_stock'), donc on renvoie simplement le kind demandé.
function invGuard(req) {
    return invKind(req);
}

// Unités attendues physiquement présentes (avec dernier mouvement = responsable).
async function inventaireExpected(kind = 'pc') {
    const ph = INV_SCOPE.map(() => '?').join(',');
    return dbAll(
        `SELECT u.id AS unit_id, u.serial, u.product_id, u.status, u.location, u.holder_user_id,
                p.name AS product_name, p.brand, p.model, p.category,
                hu.full_name AS holder_full, hu.username AS holder_username,
                (SELECT m.user_name FROM unit_movements m WHERE m.unit_id = u.id ORDER BY m.id DESC LIMIT 1) AS last_by,
                (SELECT m.created_at FROM unit_movements m WHERE m.unit_id = u.id ORDER BY m.id DESC LIMIT 1) AS last_at,
                (SELECT m.to_status FROM unit_movements m WHERE m.unit_id = u.id ORDER BY m.id DESC LIMIT 1) AS last_status
         FROM stock_units u JOIN products p ON p.id = u.product_id
         LEFT JOIN users hu ON hu.id = u.holder_user_id
         WHERE ${invFilter(kind)} AND u.serial IS NOT NULL AND u.serial <> '' AND u.status IN (${ph})
         ORDER BY p.name, u.serial`, INV_SCOPE);
}
// Unités du même périmètre produit connues mais hors zone (vendu, garantie…) — pour classer un scan.
async function inventaireKnownOther(kind = 'pc') {
    const ph = INV_SCOPE.map(() => '?').join(',');
    return dbAll(
        `SELECT u.id AS unit_id, u.serial, u.status, u.location, p.name AS product_name, p.brand, p.model, p.category
         FROM stock_units u JOIN products p ON p.id = u.product_id
         WHERE ${invFilter(kind)} AND u.serial IS NOT NULL AND u.serial <> '' AND u.status NOT IN (${ph})`, INV_SCOPE);
}
const invNorm = s => String(s || '').trim().toUpperCase();

// ── CORBEILLE (page) : unités retirées (« Retirer », soft) + produits supprimés, recherche par n° de série.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ============================================================
//  ADMIN — PRIX D'ACHAT / PROFITS / VALEUR DU STOCK
//  Coût estimé si prix d'achat absent : 60% du prix de vente
//  (marge bénéficiaire supposée de 40%).
// ============================================================
// Coût unitaire : prix d'achat si saisi ; sinon estimation —
// ordinateurs = prix de vente − 80 000 Ar (profit estimé 80 000 Ar/u),
// accessoires = 60 % du prix de vente (marge estimée 40 %).
const ORDI_EST_PROFIT = 80000;
function unitCost(purchase_price, sale_price, is_accessory) {
    const pp = parseFloat(purchase_price) || 0;
    const sp = parseFloat(sale_price) || 0;
    if (pp > 0) return { cost: pp, estimated: false };
    if (is_accessory) return { cost: sp * 0.6, estimated: true };
    return { cost: Math.max(0, sp - ORDI_EST_PROFIT), estimated: true };
}

// ============================================================
//  INSTALLATION / PRÉPARATION
// ============================================================
function resolveTaskNotifs(taskId) {
    db.run(`UPDATE notifications SET resolved = 1 WHERE type IN ('danger','warn') AND message LIKE ?`, [`%#${taskId} %`]);
    db.run(`UPDATE notifications SET resolved = 1 WHERE type IN ('danger','warn') AND message LIKE ?`, [`%#${taskId}\n%`]);
}

// Applique la destination d'UNE unité validée : problème → garantie fournisseur, sinon → stock.
// Idempotent : ignore une unité déjà validée ou introuvable. Retourne 'ok' | 'problem' | null.
async function applyInstallItemValidation(it, taskId, req) {
    if (it.validated_at) return null;
    const u = await dbGet('SELECT * FROM stock_units WHERE id = ?', [it.unit_id]);
    if (!u) return null;
    const now = getDateTime();
    // Réservation atomique de la validation : un double clic / deux gestionnaires ne valident qu'une fois.
    const claim = await dbRun(`UPDATE install_items SET validated_at = ? WHERE id = ? AND validated_at IS NULL`, [now, it.id]);
    if (!claim.changes) return null;
    if (it.result === 'probleme') {
        await dbRun(`UPDATE stock_units SET status = 'garantie_fournisseur', holder_user_id = NULL, note = ?, updated_at = ? WHERE id = ?`,
            [it.problem_note || 'Problème constaté à l\'installation', now, u.id]);
        await recordMovement(u, 'garantie_fournisseur', 'retour_garantie', req, { from: 'preparation', ref_type: 'installation', ref_id: taskId, note: it.problem_note });
        await logGarantie(u, 'entree', 'fournisseur', req, { reason: it.problem_note || 'Problème installation' });
    } else {
        await dbRun(`UPDATE stock_units SET status = 'stock', holder_user_id = NULL, updated_at = ? WHERE id = ?`, [now, u.id]);
        await recordMovement(u, 'stock', 'installation_terminee', req, { from: 'preparation', ref_type: 'installation', ref_id: taskId, note: 'Installation validée' });
    }
    return it.result === 'probleme' ? 'problem' : 'ok';
}

// Clôture la tâche quand toutes ses unités ont été validées (envoyées au stock/garantie).
// Émet alors la notification de fin au technicien. Retourne true si la tâche a été clôturée.
async function closeInstallTaskIfComplete(t, req) {
    const rem = await dbGet(`SELECT COUNT(*) AS n FROM install_items WHERE task_id = ? AND validated_at IS NULL`, [t.id]);
    if (rem.n > 0) return false;
    await dbRun(`UPDATE installation_tasks SET status = 'clos' WHERE id = ?`, [t.id]);
    resolveNotifs(`install:${t.id}:validate`);   // le retour est entièrement validé
    const c = await dbGet(`SELECT SUM(CASE WHEN result='termine' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN result='probleme' THEN 1 ELSE 0 END) AS problem FROM install_items WHERE task_id = ?`, [t.id]);
    const ok = c.ok || 0, problem = c.problem || 0;
    logActivity(req, 'installation_return', 'installation', t.id, { ok, problem });
    pushNotification({ target_user: t.technician_id, type: 'success', title: 'Retour validé',
        message: `Tâche #${t.id} : ${ok} au stock, ${problem} en garantie.`, link: '/installation.html' });
    return true;
}

// Rappels d'installation en retard (vérifie chaque minute).
setInterval(async () => {
    try {
        const settings = await getSettingsAsync();
        const remMin = parseInt(settings.install_reminder_minutes, 10) || 5;
        const now = Date.now();
        const tasks = await dbAll(
            `SELECT * FROM installation_tasks WHERE status = 'en_cours' AND deadline_ms IS NOT NULL AND deadline_ms < ? AND overdue_reason IS NULL`, [now]);
        for (const t of tasks) {
            if (t.last_reminder_at && now - t.last_reminder_at < remMin * 60000) continue;
            await dbRun('UPDATE installation_tasks SET last_reminder_at = ? WHERE id = ?', [now, t.id]);
            resolveNotifs(`install:${t.id}:overdue`);   // remplace l'ancien rappel au lieu d'empiler
            const late = Math.max(1, Math.floor((now - t.deadline_ms) / 60000));
            const ref = `install:${t.id}:overdue`;
            pushNotification({ target_user: t.technician_id, type: 'danger', persistent: true, title: 'Installation en retard',
                message: `Tâche #${t.id} — ${late} minutes de retard. Terminez ou indiquez la raison.`, link: '/installation.html', data: { task_id: t.id }, ref });
            pushNotification({ target_role: 'gestion_stock', type: 'warn', title: 'Installation en retard',
                message: `Tâche #${t.id} (${t.technician_name}) — ${late} minutes de retard.`, link: '/installation.html', data: { task_id: t.id }, ref });
            pushNotification({ target_role: 'admin', type: 'warn', title: 'Installation en retard',
                message: `Tâche #${t.id} (${t.technician_name}) — ${late} minutes de retard.`, link: '/installation.html', data: { task_id: t.id }, ref });
        }
    } catch (e) { /* silencieux */ }
}, 60_000);

// Nettoyage périodique des notifications : borne la taille de la table
// (évite tout ralentissement progressif après une longue utilisation).
function cleanupNotifications() {
    // Les alertes PERSISTANTES non résolues (ex. livraison impayée) ne sont jamais purgées :
    // elles disparaissent seulement quand leur cause est résolue (resolveNotifs).
    // created_at est en heure de Madagascar (UTC+3) : on compare avec « now + 3 h ».
    const keep = `NOT (COALESCE(persistent, 0) = 1 AND COALESCE(resolved, 0) = 0)`;
    db.run(`DELETE FROM notifications WHERE created_at < datetime('now','+3 hours','-7 days') AND ${keep}`);
    db.run(`DELETE FROM notifications WHERE resolved = 1 AND created_at < datetime('now','+3 hours','-1 day')`);
    db.run(`DELETE FROM notifications WHERE ${keep} AND id NOT IN (SELECT id FROM notifications ORDER BY created_at DESC LIMIT 500)`);
    // Garde-fou : une alerte persistante jamais résolue depuis 90 jours n'a plus d'objet.
    db.run(`DELETE FROM notifications WHERE COALESCE(persistent, 0) = 1 AND created_at < datetime('now','+3 hours','-90 days')`);
}
startupTask(cleanupNotifications, 5000);
setInterval(cleanupNotifications, 6 * 60 * 60 * 1000);

// ============================================================
//  POINT DE VENTE / VENTES
// ============================================================
// 'consignation' = unité sortie en boutique (chez un commercial) : la caisse peut la vendre directement.
const SELLABLE = ['stock', 'presentoir', 'reserve', 'consignation'];
// CAISSE : seules les unités déjà SORTIES du dépôt (boutique / présentoir / réservation « à vendre ») sont
// vendables. Une unité encore au dépôt ('stock') doit d'abord passer par la sortie stock (gestion stock).
const POS_SELLABLE = ['presentoir', 'reserve', 'consignation'];
// Kit STARLINK vendu à la caisse : l'ADRESSE du client (lieu d'installation) est obligatoire.
const isStarlinkUnit = u => !!(u && (u.router_id || String(u.category || '').toLowerCase() === 'starlink'));
const starlinkAddressError = (units, client) => units.some(isStarlinkUnit) && !String((client && client.address) || '').trim()
    ? "Vente Starlink : l'adresse du client (lieu d'installation) est obligatoire." : null;
const posNotOut = u => u.status === 'stock'
    ? `${u.product_name ? u.product_name + ' — ' : ''}${u.serial || 'unité'} est encore AU DÉPÔT : faites d'abord la sortie du stock (responsable stock) avant de la vendre à la caisse.`
    : `Unité ${u.serial} non vendable (${u.status})`;
const MM_METHODS = ['mvola', 'orange_money', 'airtel_money'];
// 'virement' = virement bancaire (argent directement sur le compte : hors caisse, réf. facultative).
const PAY_METHODS = ['especes', ...MM_METHODS, 'cheque', 'virement'];

// Normalise l'entrée « paiement » en lignes {method, amount, phone, ref}, en gérant le
// paiement mixte (plusieurs méthodes pour un même total). Accepte deux formes :
//   - { payments: [{method, amount, phone?, ref?}, …] }  → paiement mixte
//   - { method, phone?, ref? }                           → méthode unique (montant = total)
// Règles : plus de référence pour le mobile money (juste le n° émetteur, facultatif) ;
// le n° de chèque reste obligatoire pour un chèque ; la somme des montants doit égaler le total.
// Retourne { error } ou { lines, primary, first }.
function normalizePayments(payment, total) {
    total = Math.round(total || 0);
    // Montant nul (vente à 0 Ar : remise 100 %, articles gratuits) : aucune ligne de paiement.
    if (total <= 0) {
        const m = payment && (payment.method || (Array.isArray(payment.payments) && payment.payments[0] && payment.payments[0].method));
        return { lines: [], primary: PAY_METHODS.includes(m) ? m : 'especes', first: { ref: null, phone: null } };
    }
    let raw;
    if (payment && Array.isArray(payment.payments) && payment.payments.length) raw = payment.payments;
    else if (payment && payment.method) raw = [{ method: payment.method, amount: total, phone: payment.phone, ref: payment.ref }];
    else return { error: 'Mode de paiement requis' };

    const lines = [];
    for (const p of raw) {
        const method = String(p && p.method || '').trim();
        if (!PAY_METHODS.includes(method)) return { error: 'Mode de paiement invalide' };
        let amount = Math.round(parseFloat(p.amount));
        if (raw.length === 1 && (!isFinite(amount) || amount <= 0)) amount = total;  // ligne unique = total
        if (!isFinite(amount) || amount <= 0) return { error: 'Montant de paiement invalide' };
        const phone = (String(p.phone || '').trim()) || null;                        // émetteur MM / bénéficiaire chèque
        // Réf. conservée pour le chèque (n° chèque) ET le mobile money (réf. de transaction déclarée) ; nulle sinon.
        const ref = (method === 'cheque' || method === 'virement' || MM_METHODS.includes(method)) ? ((String(p.ref || '').trim()) || null) : null;
        if (method === 'cheque' && !ref) return { error: 'N° du chèque obligatoire' };
        lines.push({ method, amount, phone, ref });
    }
    const sum = lines.reduce((s, l) => s + l.amount, 0);
    if (Math.abs(sum - total) > 1)
        return { error: `Le total des paiements (${sum.toLocaleString('fr-FR')} Ar) ne correspond pas au montant à payer (${total.toLocaleString('fr-FR')} Ar).` };
    if (sum !== total && lines.length) lines[lines.length - 1].amount += (total - sum);  // absorbe l'arrondi
    return { lines, primary: lines.length === 1 ? lines[0].method : 'mixte', first: lines[0] };
}

// (Ré)enregistre les lignes de paiement d'une vente.
async function recordSalePayments(saleId, lines, now) {
    await dbRun('DELETE FROM sale_payments WHERE sale_id = ?', [saleId]);
    for (const l of lines)
        await dbRun(`INSERT INTO sale_payments (sale_id, method, amount, phone, ref, created_at) VALUES (?,?,?,?,?,?)`,
            [saleId, l.method, l.amount, l.phone, l.ref, now]);
}

// Génère le prochain numéro de série (AAMMJJ + séquence du jour, chiffres uniquement).
async function nextSerial() {
    const prefix = getDate().slice(2).replace(/-/g, '');
    const maxRow = await dbGet(`SELECT MAX(CAST(substr(serial, 7) AS INTEGER)) AS mx FROM stock_units WHERE serial GLOB ?`, [prefix + '[0-9]*']);
    const seq = ((maxRow && maxRow.mx) ? maxRow.mx : 0) + 1;
    return prefix + String(seq).padStart(4, '0');
}

const UPGRADE_FIELDS = ['ram', 'storage', 'storage_type', 'cpu', 'gpu', 'screen_size'];
const UPGRADE_LABELS = { ram: 'RAM', storage: 'Stockage', storage_type: 'Stockage', cpu: 'Processeur', gpu: 'Carte graphique', screen_size: 'Écran' };

// Trouve (ou crée) un produit accessoire pour le composant repris, d'après son intitulé
// (ex. « 500 Go HDD »). Évite d'imposer une liste déroulante : la pièce retirée du PC
// revient au stock sous son propre nom.
async function findOrCreateReprisedProduct(name, category) {
    name = (String(name || '').trim()) || 'Composant repris';
    const byName = await dbGet('SELECT id FROM products WHERE is_accessory = 1 AND LOWER(name) = LOWER(?) LIMIT 1', [name]);
    if (byName) return byName.id;
    const sig = productSignature({ is_accessory: 1, category, model: name });
    const bySig = await dbGet('SELECT id FROM products WHERE signature = ?', [sig]);
    if (bySig) return bySig.id;
    const ins = await dbRun(
        `INSERT INTO products (signature, is_accessory, name, category, subcategory, model, sale_price, created_at)
         VALUES (?, 1, ?, ?, 'Composant', ?, 0, ?)`,
        [sig, name, category, name, getDateTime()]);
    return ins.lastID;
}

// Valide les upgrades de composants demandés à la vente. Chaque upgrade :
//   { pc_unit_id, field, old_value, new_value, new_unit_id (accessoire consommé), keep, old_price }
// « keep » = on récupère l'ancien composant au stock (déduit sa valeur de l'écart).
// Écart = prix du composant neuf − (valeur de reprise si keep). Recalculé côté serveur (sécurité).
// allowDepot : confirmation d'une LIVRAISON (le composant est monté au dépôt avant la sortie de l'ordinateur) ;
// à la caisse, le composant neuf doit être déjà sorti du dépôt (POS_SELLABLE).
async function validateUpgrades(rawUpgrades, cartUnits, allowDepot = false) {
    if (!Array.isArray(rawUpgrades) || !rawUpgrades.length) return { upgrades: [], total: 0 };
    const cartIds = new Set(cartUnits.map(u => u.id));
    const usedComp = new Set();   // un même composant ne peut servir qu'à UN upgrade
    const upgrades = [];
    let total = 0;
    for (const up of rawUpgrades) {
        const field = String(up.field || '').trim();
        if (!UPGRADE_FIELDS.includes(field)) return { error: `Composant non modifiable : ${field}` };
        const pc = cartUnits.find(u => u.id === Number(up.pc_unit_id));
        if (!pc) return { error: 'Ordinateur à upgrader absent du panier' };
        if (pc.is_accessory) return { error: 'Seuls les ordinateurs peuvent être upgradés' };
        const newVal = String(up.new_value || '').trim();
        if (!newVal) return { error: 'Nouvelle valeur du composant requise' };

        // Composant neuf : unité accessoire du stock, consommée (ne doit pas être dans le panier).
        const nu = await dbGet(`SELECT u.*, p.is_accessory FROM stock_units u LEFT JOIN products p ON p.id = u.product_id WHERE u.id = ?`, [Number(up.new_unit_id)]);
        if (!nu) return { error: 'Composant neuf introuvable en stock' };
        if (cartIds.has(nu.id)) return { error: 'Le composant neuf ne peut pas être aussi dans le panier' };
        if (usedComp.has(nu.id)) return { error: `Composant ${nu.serial || ''} choisi pour deux upgrades : prenez une autre unité.` };
        usedComp.add(nu.id);
        if (!(allowDepot ? SELLABLE : POS_SELLABLE).includes(nu.status)) return { error: nu.status === 'stock' ?`Composant neuf ${nu.serial || ''} encore au dépôt : faites d'abord sa sortie du stock.` : `Composant neuf non disponible (${nu.status})` };
        if (!nu.is_accessory) return { error: 'Le composant neuf doit être un accessoire' };
        const newPrice = nu.sale_price || 0;

        // Mode : « ajout » (slot libre : l'ancien composant reste dans l'ordinateur, prix neuf complet) ou
        // « remplacement » (l'ancien est retiré, repris par le magasin à sa valeur → nouvelle réception au dépôt).
        const mode = up.mode === 'ajout' ? 'ajout' : (up.mode === 'remplacement' || up.keep ? 'remplacement' : 'ajout');
        const keep = mode === 'remplacement';
        const oldName = String(up.old_value || '').trim() || 'Composant repris';
        const oldPrice = keep ? Math.max(0, Math.round(parseFloat(up.old_price) || 0)) : 0;
        const ecart = Math.max(0, newPrice - oldPrice);   // recalcul serveur = source de vérité
        total += ecart;
        upgrades.push({ pc_unit_id: pc.id, field, mode, old_value: oldName, new_value: newVal,
            new_unit_id: nu.id, new_price: newPrice, keep, old_price: oldPrice, ecart });
    }
    return { upgrades, total };
}

// Applique les upgrades : consomme les composants neufs, reçoit les anciens au stock, enregistre sale_upgrades.
// pendingStock=true (livraison) : l'ancien composant repris passe par « à réceptionner » (le STOCK valide) au lieu
// d'entrer directement au stock (comportement POS = validation immédiate).
async function applyUpgrades(saleId, upgrades, pcSaleItemByUnit, req, now, pendingStock = false) {
    for (const up of upgrades) {
        // Composant neuf → sort du stock (consommé dans l'ordinateur, pris par le client).
        const nu = await dbGet('SELECT * FROM stock_units WHERE id = ?', [up.new_unit_id]);
        if (nu) {
            await dbRun(`UPDATE stock_units SET status = 'vendu', holder_user_id = NULL, updated_at = ? WHERE id = ?`, [now, up.new_unit_id]);
            await recordMovement(nu, 'vendu', 'upgrade_consomme', req, { from: nu.status, ref_type: 'sale', ref_id: saleId, note: `Monté (upgrade ${up.field})` });
        }
        // Composant ancien récupéré → NOUVELLE réception au stock sous son propre nom, à sa valeur.
        let oldUnitId = null;
        if (up.keep) {
            // Nom de fiche explicite : « RAM 4 Go » plutôt que « 4 Go ».
            const label = UPGRADE_LABELS[up.field] || 'Composant';
            const repName = up.old_value.toLowerCase().includes(label.toLowerCase()) ? up.old_value : `${label} ${up.old_value}`;
            const prodId = await findOrCreateReprisedProduct(repName, label);
            const serial = await nextSerial();
            const st = pendingStock ? 'retour_attente' : 'stock';
            const ins = await dbRun(
                `INSERT INTO stock_units (serial, product_id, status, location, sale_price, note, created_at, updated_at)
                 VALUES (?,?,?, 'depot', ?, ?, ?, ?)`,
                [serial, prodId, st, up.old_price, pendingStock ? 'Composant repris (upgrade) — à réceptionner au dépôt' : null, now, now]);
            oldUnitId = ins.lastID;
            const ou = await dbGet('SELECT * FROM stock_units WHERE id = ?', [oldUnitId]);
            await recordMovement(ou, st, 'upgrade_repris', req, { from: null, ref_type: 'sale', ref_id: saleId, note: `Composant repris : ${up.old_value} (${Math.round(up.old_price)} Ar)` });
            if (pendingStock) {
                // Trace pour la file « Retours à réceptionner » du stock (destination = stock).
                await dbRun(
                    `INSERT INTO sale_returns (sale_id, unit_id, serial, type, destination, refund_amount, reason, user_id, user_name, created_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?)`,
                    [saleId, oldUnitId, serial, 'upgrade_repris', 'stock', 0, `Composant repris (upgrade) : ${up.old_value}`,
                     req.session.user.id, req.session.user.full_name || req.session.user.username, now]);
            }
        }
        const siId = pcSaleItemByUnit.get(up.pc_unit_id) || null;
        await dbRun(
            `INSERT INTO sale_upgrades (sale_id, sale_item_id, pc_unit_id, field, mode, old_value, new_value, new_unit_id, old_unit_id, new_price, old_price, ecart, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [saleId, siId, up.pc_unit_id, up.field, up.mode || (up.keep ? 'remplacement' : 'ajout'), up.old_value, up.new_value, up.new_unit_id, oldUnitId, up.new_price, up.old_price, up.ecart, now]);
    }
}

async function getSaleFull(id) {
    const s = await dbGet('SELECT * FROM sales WHERE id = ?', [id]);
    if (!s) return null;
    const items = await dbAll(`SELECT si.*, u.manufacturer_sn, u.router_id, p.category, p.brand, p.model, p.condition, p.cpu, p.ram, p.storage, p.storage_type,
                                      p.screen_size, p.gpu, p.touchscreen, p.webcam, p.wifi, p.bluetooth, p.numpad, p.is_accessory
                               FROM sale_items si LEFT JOIN stock_units u ON u.id = si.unit_id
                               LEFT JOIN products p ON p.id = si.product_id WHERE si.sale_id = ?`, [id]);
    const payments = await dbAll('SELECT method, amount, phone, ref FROM sale_payments WHERE sale_id = ? ORDER BY id', [id]);
    // Reste d'un service atelier payé plus tard : affiché avec les paiements (facture complète).
    const balance_payments = await dbAll('SELECT method, amount, phone, ref, sale_date, created_at, cashier_name FROM sale_balance_payments WHERE sale_id = ? ORDER BY id', [id]);
    const upgrades = await dbAll('SELECT field, mode, old_value, new_value, ecart, pc_unit_id, sale_item_id FROM sale_upgrades WHERE sale_id = ? ORDER BY id', [id]);
    // Si la vente vient d'une avance (layaway), on rattache l'acompte déjà versé (affichage facture).
    const lay = await dbGet('SELECT id, layaway_number, deposit FROM layaways WHERE sale_id = ?', [id]);
    const layaway = lay ? { number: lay.layaway_number, deposit: lay.deposit,
        payments: await dbAll('SELECT method, amount, sale_date FROM layaway_payments WHERE layaway_id = ? ORDER BY id', [lay.id]) } : null;
    // Livraison liée (permet à la caisse de confirmer/annuler depuis la page ventes).
    const dv = await dbGet('SELECT id, delivery_number, status, payment_status, total, acompte, acompte_method, livreur_name, delivery_fee FROM deliveries WHERE sale_id = ?', [id]);
    const delivery = dv ? { id: dv.id, number: dv.delivery_number, status: dv.status, payment_status: dv.payment_status, total: dv.total, acompte: dv.acompte || 0, acompte_method: dv.acompte_method, livreur: dv.livreur_name || null, fee: dv.delivery_fee || 0,
        // Historique de l'acompte validé par la caisse (date d'encaissement, mode, caissier).
        acompte_payments: await dbAll('SELECT method, amount, sale_date, cashier_name FROM delivery_payments WHERE delivery_id = ? ORDER BY id', [dv.id]) } : null;
    const exit_check = await dbGet('SELECT checked_at, checked_by_name, status, note FROM exit_checks WHERE sale_id = ? ORDER BY id DESC LIMIT 1', [id]);
    // Vente d'ÉCHANGE : facture d'origine + articles rendus lors de CET échange (même horodatage),
    // pour que la facture affiche le vrai prix et la mention « échange » au lieu d'un total à 0 Ar.
    let exchange = null;
    if (s.exchange_of) {
        const o = await dbGet('SELECT id, sale_number, sale_date, created_at FROM sales WHERE id = ?', [s.exchange_of]);
        const back = await dbAll(`SELECT r.serial, COALESCE(si.product_name, '') AS product_name, COALESCE(si.unit_price, 0) AS unit_price
                                  FROM sale_returns r LEFT JOIN sale_items si ON si.sale_id = r.sale_id AND si.unit_id = r.unit_id
                                  WHERE r.sale_id = ? AND r.type = 'echange' AND r.created_at = ?`, [s.exchange_of, s.created_at]);
        if (o) exchange = { number: o.sale_number, date: o.sale_date || String(o.created_at || '').slice(0, 10), ref: invoiceRef(o),
                            returned: back, returned_total: back.reduce((t, b) => t + (b.unit_price || 0), 0) };
    }
    return { ...s, ref: invoiceRef(s), exit_check, exchange, items, payments: payments.concat(balance_payments.map(({ method, amount, phone, ref }) => ({ method, amount, phone, ref }))),
             initial_paid: payments.reduce((x, p) => x + (p.amount || 0), 0), balance_payments, upgrades, layaway, delivery };
}

// ============================================================
//  CONTRÔLE DE SORTIE (agent de sécurité à la porte)
// ============================================================
// Retrouve la vente d'une facture : Réf. AAAAMMJJ-NNNN (code-barres), n° du jour seul, ou n° de série d'un article.
async function exitFindSale(raw) {
    const q = String(raw || '').trim().toUpperCase().replace(/^\*|\*$/g, '');
    if (!q) return { error: 'Saisissez ou scannez la référence de la facture' };
    if (/^A[VL]\d/.test(q)) return { error: "C'est une facture d'AVANCE : demandez la facture de vente (ou du livreur)." };
    // Réf. avec tiret (code-barres) ou 12 chiffres « 20AAMMJJNNNN » ; sinon on tente le n° de série (10 chiffres).
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{1,6})$/.exec(q) || /^(20\d{2})(\d{2})(\d{2})(\d{4})$/.exec(q);
    if (m) {
        const s = await dbGet('SELECT * FROM sales WHERE sale_date = ? AND sale_number = ?', [`${m[1]}-${m[2]}-${m[3]}`, parseInt(m[4], 10)]);
        if (s) return { sale: s };
    }
    if (/^\d{1,4}$/.test(q)) {
        const s = await dbGet('SELECT * FROM sales WHERE sale_date = ? AND sale_number = ?', [getDate(), parseInt(q, 10)]);
        if (s) return { sale: s };
    }
    // N° de série (étiquette du produit) → dernière vente contenant cet article.
    const si = await dbGet(`SELECT si.sale_id FROM sale_items si LEFT JOIN stock_units u ON u.id = si.unit_id
        WHERE UPPER(si.serial) = ? OR UPPER(u.serial) = ? OR UPPER(u.manufacturer_sn) = ? OR UPPER(u.router_id) = ? ORDER BY si.id DESC LIMIT 1`, [q, q, q, q]);
    if (si) return { sale: await dbGet('SELECT * FROM sales WHERE id = ?', [si.sale_id]) };
    return { error: `Facture introuvable : ${q}` };
}
// État de paiement / autorisation de sortie d'une vente.
async function exitState(s) {
    const d = await dbGet('SELECT * FROM deliveries WHERE sale_id = ?', [s.id]);
    const fr = v => Math.round(v || 0).toLocaleString('fr-FR').replace(/\s/g, ' ') + ' Ar';
    if (['annulee', 'returned', 'exchanged'].includes(s.status) || (d && ['annulee', 'retournee'].includes(d.status)))
        return { d, state: 'invalid', block: true, label: 'NE PAS LAISSER SORTIR', detail: s.status === 'exchanged' ? 'Vente échangée (une nouvelle facture remplace celle-ci).' : 'Vente annulée ou retournée.' };
    if (d && s.status !== 'completed') {
        if (d.status === 'facturee') return { d, state: 'not_released', block: true, label: 'NE PAS LAISSER SORTIR', detail: 'La sortie du stock n\'est pas encore validée par le responsable stock (articles non scannés).' };
        if (d.payment_status === 'paye') return { d, state: 'paid', block: false, label: 'PAYÉ — LIVRAISON', detail: `Livraison #${d.delivery_number}${d.livreur_name ? ' — livreur ' + d.livreur_name : ''}` };
        const due = Math.max(0, (s.total || 0) - Math.min(s.total || 0, d.acompte || 0));
        return { d, state: 'cod', block: false, due, label: 'À LA LIVRAISON', detail: `${fr(due)} à encaisser par le livreur${d.livreur_name ? ' (' + d.livreur_name + ')' : ''}${d.acompte > 0 ? ' — avance ' + fr(d.acompte) + ' déjà versée' : ''}.` };
    }
    if ((s.balance_due || 0) > 0)
        return { d, state: 'balance', block: true, due: s.balance_due, label: 'RESTE À PAYER', detail: `${fr(s.balance_due)} restent à payer : envoyer le client à la caisse.` };
    return { d, state: 'paid', block: false, label: 'PAYÉ', detail: d ? `Livraison #${d.delivery_number} livrée et payée.` : 'Facture entièrement payée.' };
}

// Remet en stock toutes les unités rattachées à une vente (quel que soit leur statut).
async function restoreSaleUnits(saleId, req, note) {
    const now = getDateTime();
    const items = await dbAll('SELECT unit_id, returned FROM sale_items WHERE sale_id = ? AND unit_id IS NOT NULL', [saleId]);
    let n = 0;
    for (const it of items) {
        if (it.returned) continue;   // déjà retourné dans cette vente : rien à restaurer.
        // L'unité a-t-elle été RE-VENDUE dans une AUTRE vente encore active ? Alors on n'y touche pas
        // (sinon on la remettrait en stock alors qu'elle est légitimement vendue ailleurs → « en stock mais vendue »).
        const other = await dbGet(
            `SELECT si.id FROM sale_items si JOIN sales s ON s.id = si.sale_id
             WHERE si.unit_id = ? AND si.sale_id != ? AND si.returned = 0
               AND s.status IN ('completed', 'en_livraison', 'exchanged')`, [it.unit_id, saleId]);
        if (other) continue;
        const u = await dbGet('SELECT * FROM stock_units WHERE id = ?', [it.unit_id]);
        if (!u || u.status === 'stock') continue;
        await dbRun(`UPDATE stock_units SET status = 'stock', location = 'depot', holder_user_id = NULL, updated_at = ? WHERE id = ?`, [now, u.id]);
        await recordMovement(u, 'stock', 'admin_correction', req, { from: u.status, ref_type: 'sale', ref_id: saleId, note: note || 'Correction admin' });
        n++;
    }
    return n;
}

// Admin : corriger une vente (mode de paiement, référence, client) — erreur de saisie.
// Journée de caisse CLÔTURÉE : modifier/supprimer/créer une vente de ce jour change le CA sans
// toucher à la clôture. Refus par défaut (409, code « closed_day ») ; l'admin peut confirmer
// explicitement (?force_closed_day=1, demandé par SF.api) et l'opération est alors journalisée.
async function closedDayBlock(req, date) {
    if (!date) return null;
    const c = await dbGet('SELECT id FROM cash_closures WHERE sale_date = ?', [date]);
    if (!c) return null;
    if (req.query.force_closed_day === '1' || (req.body && req.body.force_closed_day === true)) return { forced: true };
    return { error: `La caisse du ${date.split('-').reverse().join('/')} est déjà clôturée : cette opération modifiera le chiffre d'affaires de ce jour sans changer la clôture.`, code: 'closed_day', date };
}
async function salePaymentsSnapshot(saleId) {
    return dbAll('SELECT method, amount, phone, ref FROM sale_payments WHERE sale_id = ? ORDER BY id', [saleId]);
}

// ============================================================
//  CONSIGNATIONS — sorties de présentation/test remises à un commercial
//  (l'unité reste comptée dans le stock détenu jusqu'au paiement).
// ============================================================
function consignItemsSql(alias) {
    return `(SELECT COUNT(*) FROM consignment_items i WHERE i.consignment_id = ${alias}.id) AS item_count,
            (SELECT SUM(i.unit_price) FROM consignment_items i WHERE i.consignment_id = ${alias}.id) AS total,
            (SELECT GROUP_CONCAT(i.product_name, ' · ') FROM consignment_items i WHERE i.consignment_id = ${alias}.id) AS items_summary`;
}
// Rattache à chaque consignation son détail d'articles (produit + config + is_accessory),
// pour affichage en cartes séparées par modèle côté client (une seule requête, pas de N+1).
// onlyRemaining=true : ne renvoie que les unités encore en présentation (status='consignation') —
// utilisé côté caisse pour ne plus montrer les articles déjà encaissés lors d'un encaissement partiel.
async function attachConsignmentItems(rows, onlyRemaining = false) {
    if (!rows.length) return rows;
    const ph = rows.map(() => '?').join(',');
    const items = await dbAll(
        `SELECT i.*, p.brand, p.model, p.category, p.subcategory, p.is_accessory, p.condition, p.image,
                p.cpu, p.ram, p.storage, p.storage_type, p.screen_size, p.gpu,
                u.manufacturer_sn, u.warranty_end, u.status AS unit_status
         FROM consignment_items i
         LEFT JOIN products p ON p.id = i.product_id
         ${onlyRemaining ? 'JOIN' : 'LEFT JOIN'} stock_units u ON u.id = i.unit_id${onlyRemaining ? " AND u.status = 'consignation'" : ''}
         WHERE i.consignment_id IN (${ph})`, rows.map(r => r.id));
    const byConsign = {};
    // Serial d'affichage : les accessoires (serial NULL en base) montrent leur code de modèle
    // partagé (ex. A000501) au lieu d'un « — » vide dans les historiques.
    items.forEach(it => { it.serial = displaySerial(it); });
    items.forEach(it => { (byConsign[it.consignment_id] = byConsign[it.consignment_id] || []).push(it); });
    rows.forEach(r => { r.items = byConsign[r.id] || []; });
    return rows;
}

// ============================================================
//  ÉCHANGES DE SORTIES (livraison / boutique) + STOCK DÉFECTUEUX
// ============================================================
// Disposition de l'ANCIENNE unité après un échange (ou marquage défectueux) : garantie (PC),
// défectueux (accessoire) ou retour au stock réel. Renvoie une courte étiquette pour le message.
async function disposeOldUnit(unit, disposition, reason, req, refType, refId) {
    const now = getDateTime();
    if (disposition === 'garantie') {
        await dbRun(`UPDATE stock_units SET status = 'garantie_fournisseur', holder_user_id = NULL, note = ?, updated_at = ? WHERE id = ?`, [reason, now, unit.id]);
        await recordMovement(unit, 'garantie_fournisseur', 'echange_garantie', req, { from: unit.status, ref_type: refType, ref_id: refId, note: reason });
        await logGarantie(unit, 'entree', 'fournisseur', req, { reason });
        return 'envoyée en garantie';
    }
    if (disposition === 'defectueux') {
        await dbRun(`UPDATE stock_units SET status = 'defectueux', holder_user_id = NULL, note = ?, updated_at = ? WHERE id = ?`, [reason, now, unit.id]);
        await recordMovement(unit, 'defectueux', 'defectueux', req, { from: unit.status, ref_type: refType, ref_id: refId, note: reason });
        return 'placée en stock défectueux';
    }
    await dbRun(`UPDATE stock_units SET status = 'stock', location = 'depot', holder_user_id = NULL, note = NULL, updated_at = ? WHERE id = ?`, [now, unit.id]);
    await recordMovement(unit, 'stock', 'echange_retour_stock', req, { from: unit.status, ref_type: refType, ref_id: refId, note: reason });
    return 'remise en stock';
}

// Stock : marquer une unité EN STOCK comme défectueuse (sort du stock réel, sans retour ni réparation).
// ADMIN : corriger la configuration d'UNE unité (ex. reçue en 8/256 mais vérifiée en 8/500). L'unité quitte sa
// fiche : elle rejoint la fiche existante identique (même config, même état, même prix) ou une nouvelle fiche
// créée à partir de l'ancienne (image, description, emplacement repris). dry_run = aperçu de la destination.
const RECONF_FIELDS = ['category', 'subcategory', 'brand', 'model', 'cpu', 'ram', 'storage', 'storage_type', 'gpu', 'screen_size'];
const RECONF_FLAGS = ['touchscreen', 'webcam', 'wifi', 'bluetooth', 'numpad'];

// ============================================================
//  BATTERIES — ordinateurs compatibles, trouvés automatiquement sur internet
//  (moteur DuckDuckGo version HTML : titres + extraits des résultats). On relève
//  les gammes d'ordinateurs citées (ProBook 640 645 G1, Latitude E7240…) pour la
//  marque de la batterie ; le résultat reste corrigeable à la main (stock / admin).
// ============================================================
const BAT_FAMILIES = {
    HP: ['ProBook', 'EliteBook', 'Pavilion', 'Compaq', 'Presario', 'Envy', 'Spectre', 'ZBook', 'Stream', 'Omen', 'Victus', 'Chromebook', 'Mini'],
    DELL: ['Latitude', 'Inspiron', 'Vostro', 'Precision', 'XPS', 'Alienware', 'Studio'],
    LENOVO: ['ThinkPad', 'IdeaPad', 'Yoga', 'Legion', 'ThinkBook', 'Flex', 'Essential', 'V14', 'V15'],
    ASUS: ['VivoBook', 'ZenBook', 'ROG', 'TUF', 'ExpertBook', 'EeePC'],
    ACER: ['Aspire', 'TravelMate', 'Extensa', 'Nitro', 'Predator', 'Swift', 'Spin'],
    TOSHIBA: ['Satellite', 'Tecra', 'Portege', 'Dynabook'],
    SONY: ['VAIO'],
    FUJITSU: ['LifeBook'],
    SAMSUNG: ['Notebook'],
    MSI: ['Modern', 'Prestige', 'Katana', 'Thin']
};
const BAT_BRANDS = Object.keys(BAT_FAMILIES);
function batDecode(s) {
    return String(s || '').replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/\s+/g, ' ');
}
// Jeton « modèle d'ordinateur » : contient un chiffre (640, E7240, T450s, 15-ab000, K56) ou génération G1…
function batIsModelToken(t, refTokens) {
    if (!t || t.length > 14) return false;
    if (!/\d/.test(t)) return false;
    if (/^(19|20)\d\d$/.test(t)) return false;                        // années
    if (/(wh|mah|v|w|cell|cells|pcs|%)$/i.test(t) && /^\d/.test(t)) return false; // 48Wh, 4400mAh, 10.8V, 6cell
    if (/[.,]/.test(t)) return false;
    if (/xl$/i.test(t) || /^(hstnn|a\d{2}-|c\d{2}n|l\d{2}[a-z]\d|\d{6}-\d{3})/i.test(t)) return false; // références de batteries
    const lt = t.toLowerCase();
    if ([...refTokens].some(r => r === lt || (lt.length >= 3 && (r.startsWith(lt) || lt.startsWith(r))))) return false;
    if (/\d[a-z]+\d/i.test(t.replace(/-.*/, '')) && !/^\d{2}-/.test(t)) return false;   // réf. pièce : F62G0, 039DY5, C21N1818
    if ((t.match(/[a-z]/gi) || []).length >= 4 && !t.includes('-')) return false;          // RPJC3, HSTNN…
    if (/^[a-z]{2}\d{2}$/i.test(t)) return false;                                         // CA06, CA09, MU06…
    return true;
}
function batExtractModels(text, brand, ref) {
    const B = String(brand || '').toUpperCase();
    const brands = BAT_BRANDS.includes(B) ? [B] : BAT_BRANDS;
    const refTokens = new Set(String(ref || '').toLowerCase().split(/[\s/()]+/).filter(Boolean));
    const fams = [];
    brands.forEach(b => BAT_FAMILIES[b].forEach(f => fams.push([b, f])));
    const found = new Map();   // clé normalisée → { label, n }
    const add = (label) => {
        const k = label.toLowerCase();
        const cur = found.get(k); if (cur) cur.n++; else found.set(k, { label, n: 1 });
    };
    for (const [b, fam] of fams) {
        const re = new RegExp(`\\b${fam.replace(/[-]/g, '\\-')}\\b`, 'gi');
        let m;
        while ((m = re.exec(text))) {
            // Jetons qui suivent la gamme : « 640 645 650 655 G0 G1 », « E7240/E7250 », « 15-ab000, 15-ac100 »
            const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 160);
            const parts = rest.split(/([\s,/&;]+)/);
            const toks = [];
            for (const p of parts) {
                if (!p || /^[\s,/&;]+$/.test(p)) continue;
                const w = p.replace(/[()[\]:"]+/g, '');
                if (/^(and|et|series|serie|séries|notebook|laptop|pc)$/i.test(w)) { if (toks.length) continue; else continue; }
                if (batIsModelToken(w, refTokens)) { toks.push(w.toUpperCase() === w ? w : w); if (toks.length >= 10) break; }
                else break;
            }
            if (!toks.length) continue;
            const uniq = [...new Set(toks)]; toks.length = 0; toks.push(...uniq);
            const label = `${b === 'HP' ? 'HP' : b.charAt(0) + b.slice(1).toLowerCase()} ${fam} ${toks.join(' ')}`;
            add(label);
        }
    }
    // Marque suivie directement de modèles : « Asus K56 X550 », « Dell N5010 N4010 », « Samsung R580 »
    for (const b of brands) {
        const re = new RegExp(`\\b${b}\\b`, 'gi');
        let m;
        while ((m = re.exec(text))) {
            const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 120);
            const parts = rest.split(/([\s,/&;]+)/);
            const toks = [];
            for (const p of parts) {
                if (!p || /^[\s,/&;]+$/.test(p)) continue;
                const w = p.replace(/[()[\]:"]+/g, '');
                if (/^(and|et)$/i.test(w)) continue;
                if (fams.some(([, f]) => f.toLowerCase() === w.toLowerCase())) { toks.length = 0; break; }  // gamme : déjà traitée
                if (/^[A-Z]{1,3}\d{2,4}[A-Z0-9-]{0,6}$/i.test(w) && batIsModelToken(w, refTokens)) { toks.push(w); if (toks.length >= 8) break; }
                else break;
            }
            if (toks.length) add(`${b === 'HP' ? 'HP' : b.charAt(0) + b.slice(1).toLowerCase()} ${toks.join(' ')}`);
        }
    }
    // Garder les plus citées ; supprimer celles entièrement contenues dans une autre.
    let list = [...found.values()].sort((a, b) => b.n - a.n || b.label.length - a.label.length);
    const tokset = l => new Set(l.toLowerCase().split(' '));
    list = list.filter((x, i) => !list.some((y, j) => j !== i && y.label.length > x.label.length && [...tokset(x.label)].every(t => tokset(y.label).has(t))));
    return list.slice(0, 15).map(x => x.label);
}
async function batSearchWeb(query) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000);
    try {
        const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
            headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', 'Accept-Language': 'fr,en;q=0.8' },
            signal: ctrl.signal
        });
        if (!r.ok) throw new Error('Recherche internet indisponible (HTTP ' + r.status + ')');
        const html = await r.text();
        const bits = [];
        const re = /class="result__(?:a|snippet)"[^>]*>([\s\S]*?)<\/a>/g;
        let m; while ((m = re.exec(html))) bits.push(batDecode(m[1]));
        if (!bits.length) throw new Error('Aucun résultat exploitable (moteur de recherche indisponible)');
        return bits.join(' \n ');
    } finally { clearTimeout(t); }
}
async function batLookup(p) {
    const ref = String(p.model || p.name || '').trim();
    const text = await batSearchWeb(`${p.brand || ''} ${ref} laptop battery compatible`.trim());
    return batExtractModels(text, p.brand, ref);
}

// ---- Catalogue batteries INFINITY (projet « Catalogue Batteries », http://192.168.88.10:3030) ----
// Source principale des compatibilités : on lit le tableau de données de la page (getDefaultData) et on
// le rapproche des fiches BATTERIE (références saisies avec confusions O/0, I/1, S/5 → jetons canoniques).
// Les batteries absentes du catalogue passent par la recherche internet (ci-dessus).
const BATCAT_BRAND = { AC: 'ACER', AS: 'ASUS', DE: 'DELL', FU: 'FUJITSU', HP: 'HP', LE: 'LENOVO', SA: 'SAMSUNG', TO: 'TOSHIBA', SO: 'SONY', PA: 'PANASONIC', MS: 'MICROSOFT', NE: 'NEC' };
const batCanon = t => String(t || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').replace(/S/g, '5').replace(/Z/g, '2');
const batToks = s => String(s || '').toUpperCase().split(/[\s\/()\-,.;]+/).filter(Boolean);
const BATCAT_STOP = new Set(['BATTERIE', 'SIMPLE', 'SERIES', 'ACER', 'ASUS', 'DELL', 'HP', 'LENOVO', 'TOSHIBA', 'SAMSUNG', 'SONY', 'FUJITSU', 'AS', 'AC', 'DE', 'LE', 'TO', 'SA']);
// Jetons de référence (« A32 », « A41 », « HSTNN » : préfixes génériques, non discriminants).
function batKeyToks(s) { return [...new Set(batToks(s).filter(t => !BATCAT_STOP.has(t) && /\d/.test(t) && t.length >= 3 && !/^[ABC]\d{2}$/.test(t)).map(batCanon))]; }
function batCatScore(p, c) {
    const pb = String(p.brand || '').toUpperCase().replace(/^BATTERIE\s+/, '').replace(/\s+\S*\d\S*$/, '');
    const cb = (BATCAT_BRAND[c.ref.slice(0, 2)] || c.brand || '').toUpperCase();
    const same = pb === cb || pb.startsWith(cb) || cb.startsWith(pb);
    const pt = batKeyToks([p.model, p.name].join(' ')), ct = batKeyToks(c.ref.replace(/^[A-Z]{2}\s+/, ''));
    // L'ancien code brut (ex. « AS K56 » ↔ « AS K56 ») compte aussi.
    // Somme des jetons concordants (égalité canonique, ou préfixe pour les longues références).
    let best = 0;
    for (const b of ct) {
        let t = 0;
        for (const a of pt) {
            if (a === b) t = Math.max(t, a.length >= 5 ? 3 : 2);
            else if (a.length >= 6 && b.length >= 6 && (a.startsWith(b) || b.startsWith(a))) t = Math.max(t, 1.2);
        }
        best += t;
    }
    if (!best) return 0;
    // Les ordinateurs du catalogue doivent être de la marque de la batterie (catalogue parfois mal classé).
    const m0 = String((c.models || [])[0] || '').toUpperCase();
    if (pb && !m0.startsWith(pb) && !(pb === 'HP' && /^(HP|COMPAQ)/.test(m0))) return 0;
    return same ? best + 1 : (best >= 3 ? best - 0.5 : 0);
}
// Ordinateurs : compléter les entrées abrégées (« 836 G5 » → « HP EliteBook 836 G5 »).
function batExpandModels(c) {
    const ms = (c.models || []).map(m => String(m).trim()).filter(Boolean);
    if (!ms.length) return [];
    const first = ms[0].split(/\s+/);
    const k = first.findIndex(w => /\d/.test(w));
    const prefix = k > 0 ? first.slice(0, k).join(' ') : '';
    const brand = String(c.brand || '').toLowerCase();
    return ms.map((m, i) => {
        if (i === 0 || !prefix) return m;
        const low = m.toLowerCase();
        if (brand && low.startsWith(brand)) return m;
        if (prefix && low.startsWith(prefix.toLowerCase())) return m;
        if (/^[a-z]+\s/i.test(m) && !/\d/.test(m.split(/\s+/)[0])) return (c.brand ? c.brand + ' ' : '') + m;   // « Aspire E5 » → « Acer Aspire E5 »
        return prefix + ' ' + m;
    });
}
function batCatMatch(products, catalog) {
    const out = [];
    for (const p of products) {
        let best = null, bs = 0;
        for (const c of catalog) { const s = batCatScore(p, c); if (s > bs) { bs = s; best = c; } }
        if (best) out.push({ p, c: best, s: bs, models: batExpandModels(best) });
    }
    return out;
}
const BatCatalog = { rows: [], loadedAt: 0, error: null, url: process.env.BATTERY_CATALOG_URL || 'http://192.168.88.10:3030/' };
// Littéral JS (clés sans guillemets) → JSON, en respectant le contenu des chaînes.
function batJsToJson(src) {
    let out = '', i = 0, inStr = null;
    while (i < src.length) {
        const ch = src[i];
        if (inStr) { out += ch; if (ch === '\\') { out += src[i + 1] || ''; i += 2; continue; } if (ch === inStr) inStr = null; i++; continue; }
        if (ch === '"') { inStr = ch; out += ch; i++; continue; }
        if (ch === "'") {   // chaîne entre apostrophes → guillemets
            let j = i + 1, str = '';
            while (j < src.length && src[j] !== "'") { if (src[j] === '\\') { str += src[j + 1]; j += 2; continue; } str += src[j++]; }
            out += JSON.stringify(str); i = j + 1; continue;
        }
        const k = /^[A-Za-z_$][\w$]*(?=\s*:)/.exec(src.slice(i, i + 40));
        if (k && /[{,\s]$/.test(out.trimEnd().slice(-1) || '{')) { out += JSON.stringify(k[0]); i += k[0].length; continue; }
        out += ch; i++;
    }
    return out.replace(/,\s*([}\]])/g, '$1');
}
async function batteryCatalogLoad() {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10000);
    try {
        const r = await fetch(BatCatalog.url, { signal: ctrl.signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const html = await r.text();
        const i = html.indexOf('function getDefaultData()');
        if (i < 0) throw new Error('données du catalogue introuvables');
        const start = html.indexOf('[', i), end = html.indexOf('];', start);
        const rows = JSON.parse(batJsToJson(html.slice(start, end + 1)))
            .filter(x => x && x.ref && Array.isArray(x.models) && x.models.length);
        if (!rows.length) throw new Error('catalogue vide');
        BatCatalog.rows = rows; BatCatalog.loadedAt = Date.now(); BatCatalog.error = null;
    } catch (e) { BatCatalog.error = e.message; console.error('Catalogue batteries :', e.message); }
    finally { clearTimeout(t); }
}
const BAT_WHERE = `UPPER(TRIM(p.category)) LIKE 'BATTERIE%'`;
const batKey = p => `${String(p.brand || '').trim().toUpperCase()}|${String(p.model || p.name || '').trim().toUpperCase()}`;
const batSleep = ms => new Promise(r => setTimeout(r, ms));
// Recherche + enregistrement pour une batterie. Une fiche corrigée à la main n'est plus écrasée (sauf force).
async function batteryLookupAndSave(productId, force = false) {
    const p = await dbGet(`SELECT id, name, brand, model FROM products p WHERE id = ? AND ${BAT_WHERE}`, [productId]);
    if (!p) return null;
    const cur = await dbGet(`SELECT * FROM battery_compat WHERE product_id = ?`, [p.id]);
    if (cur && (cur.source === 'manuel' || cur.source === 'catalogue') && !force) return cur;
    const now = getDateTime();
    try {
        const models = await batLookup(p);
        await dbRun(`INSERT INTO battery_compat (product_id, query_key, models, source, status, error, searched_at, edited_by)
                     VALUES (?, ?, ?, 'auto', ?, NULL, ?, NULL)
                     ON CONFLICT(product_id) DO UPDATE SET query_key = excluded.query_key, models = excluded.models, source = 'auto',
                        status = excluded.status, error = NULL, searched_at = excluded.searched_at, edited_by = NULL`,
            [p.id, batKey(p), JSON.stringify(models), models.length ? 'ok' : 'vide', now]);
        broadcast('battery:update', { id: p.id });
        return { models };
    } catch (e) {
        await dbRun(`INSERT INTO battery_compat (product_id, query_key, models, source, status, error, searched_at)
                     VALUES (?, ?, '[]', 'auto', 'erreur', ?, ?)
                     ON CONFLICT(product_id) DO UPDATE SET status = CASE WHEN battery_compat.models IS NOT NULL AND battery_compat.models != '[]' THEN battery_compat.status ELSE 'erreur' END,
                        error = excluded.error, searched_at = excluded.searched_at`,
            [p.id, batKey(p), e.message, now]);
        e.blocked = true;
        throw e;
    }
}
// File d'attente polie : une recherche toutes les 3 min ; pause d'1 h si le moteur limite les requêtes
// (page de vérification) — on ne la contourne pas, on attend.
const BatQueue = {
    pending: new Set(), running: false, pauseUntil: 0,
    add(id) { this.pending.add(id); if (!this.running) this.run(); },
    async run() {
        this.running = true;
        try {
            while (this.pending.size) {
                const wait = this.pauseUntil - Date.now();
                if (wait > 0) await batSleep(wait);
                const id = this.pending.values().next().value;
                this.pending.delete(id);
                try { await batteryLookupAndSave(id); }
                catch (e) { this.pending.add(id); this.pauseUntil = Date.now() + 60 * 60 * 1000; continue; }
                await batSleep(180 * 1000);
            }
        } finally { this.running = false; }
    }
};
// Batteries à (re)chercher : jamais cherchées, fiche modifiée depuis (recherche auto), ou échec de plus de 6 h.
// 1) catalogue Infinity (prioritaire, sauf liste corrigée à la main) ; 2) sinon recherche internet.
async function batterySweep() {
    try {
        if (!BatCatalog.rows.length || Date.now() - BatCatalog.loadedAt > 6 * 3600 * 1000) await batteryCatalogLoad();
        const rows = await dbAll(`SELECT p.id, p.brand, p.model, p.name, bc.query_key, bc.source, bc.status, bc.searched_at, bc.models
                                  FROM products p LEFT JOIN battery_compat bc ON bc.product_id = p.id WHERE ${BAT_WHERE}`);
        const found = new Map(batCatMatch(rows.filter(r => r.source !== 'manuel'), BatCatalog.rows).map(x => [x.p.id, x]));
        const now = getDateTime(); let changed = 0;
        for (const r of rows) {
            const f = found.get(r.id);
            if (!f) continue;
            const js = JSON.stringify(f.models);
            if (r.source === 'catalogue' && r.models === js && r.query_key === batKey(r)) continue;
            await dbRun(`INSERT INTO battery_compat (product_id, query_key, models, source, status, error, searched_at, edited_by)
                         VALUES (?, ?, ?, 'catalogue', 'ok', NULL, ?, ?)
                         ON CONFLICT(product_id) DO UPDATE SET query_key = excluded.query_key, models = excluded.models, source = 'catalogue',
                            status = 'ok', error = NULL, searched_at = excluded.searched_at, edited_by = excluded.edited_by`,
                [r.id, batKey(r), js, now, f.c.ref]);
            BatQueue.pending.delete(r.id); changed++;
        }
        if (changed) broadcast('battery:update', {});
        if (!BAT_AUTO) return;
        const old = Date.now() - 6 * 3600 * 1000;
        rows.filter(r => !found.has(r.id) && r.source !== 'manuel' && (!r.query_key || r.source === 'catalogue' || r.query_key !== batKey(r)
                || (r.status === 'erreur' && (!r.searched_at || Date.parse(r.searched_at.replace(' ', 'T') + '+03:00') < old))))
            .forEach(r => BatQueue.add(r.id));
    } catch (e) { console.error('batterySweep', e.message); }
}
// Recherche internet automatique : seulement sur le serveur de production (Linux). Les copies locales
// (Windows) partagent la même connexion ; elles n'interrogent internet que via le bouton « Rechercher ».
// Le catalogue Infinity (réseau local) est lu partout.
const BAT_AUTO = process.platform === 'linux' && process.env.BATTERY_LOOKUP !== 'off';
setTimeout(batterySweep, 20 * 1000); setInterval(batterySweep, 6 * 3600 * 1000);

// Date de prochain paiement promise : obligatoire, entre aujourd'hui et la date limite. Renvoie un message d'erreur ou null.
function checkNextPaymentDate(d, today, dueDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return 'Date du prochain paiement obligatoire';
    if (d < today) return 'La date du prochain paiement ne peut pas être passée';
    if (dueDate && d > dueDate) return `La date du prochain paiement dépasse la date limite (${dueDate.split('-').reverse().join('/')})`;
    return null;
}
async function getLayawayFull(id) {
    const l = await dbGet('SELECT * FROM layaways WHERE id = ?', [id]);
    if (!l) return null;
    const items = await dbAll(`SELECT i.*, p.brand, p.model, p.cpu, p.ram, p.storage, p.storage_type, p.screen_size, p.gpu, p.is_accessory FROM layaway_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.layaway_id = ?`, [id]);
    const payments = await dbAll('SELECT method, amount, phone, ref, sale_date, created_at, next_date, cashier_name FROM layaway_payments WHERE layaway_id = ? ORDER BY id', [id]);
    return { ...l, items, payments };
}

// Avances en retard : date de paiement promise ou date limite dépassée → notification (une seule par avance
// tant qu'elle n'est pas résolue par un versement, le solde ou l'annulation).
async function layawayLateCheck() {
    const today = getDate();
    const rows = await dbAll(`SELECT * FROM layaways WHERE status = 'active'
        AND ((next_payment_date IS NOT NULL AND next_payment_date < ?) OR (due_date IS NOT NULL AND due_date < ?))`, [today, today]);
    for (const l of rows) {
        const ref = `layaway_late:${l.id}`;
        const open = await dbGet(`SELECT 1 FROM notifications WHERE ref = ? AND resolved = 0 LIMIT 1`, [ref]);
        if (open) continue;
        const pastDue = l.due_date && l.due_date < today;
        const fr = d => d ? d.split('-').reverse().join('/') : '—';
        const msg = `${l.client_name || 'Client'}${l.client_phone ? ' (' + l.client_phone + ')' : ''} — reste ${Math.round(l.total - l.deposit)} Ar. `
            + (pastDue ? `Date limite dépassée (${fr(l.due_date)}).` : `Paiement promis le ${fr(l.next_payment_date)} non reçu.`);
        for (const role of ['caisse', 'admin'])
            pushNotification({ target_role: role, type: pastDue ? 'danger' : 'warn', title: `Avance #${l.layaway_number} en retard`,
                message: msg, link: '/engagements.html#avances', ref, persistent: true, data: { layaway_id: l.id } });
    }
    const dels = await dbAll(`SELECT * FROM deliveries WHERE ${DELIVERY_AVANCE_OPEN}
        AND ((avance_next_date IS NOT NULL AND avance_next_date < ?) OR (avance_due_date IS NOT NULL AND avance_due_date < ?))`, [today, today]);
    for (const d of dels) {
        const ref = `delivery_avance_late:${d.id}`;
        if (await dbGet(`SELECT 1 FROM notifications WHERE ref = ? AND resolved = 0 LIMIT 1`, [ref])) continue;
        const pastDue = d.avance_due_date && d.avance_due_date < today;
        const fr = x => x ? x.split('-').reverse().join('/') : '—';
        const msg = `${d.client_name || 'Client'}${d.client_phone ? ' (' + d.client_phone + ')' : ''} — reste ${Math.round((d.total || 0) - (d.acompte || 0))} Ar. `
            + (pastDue ? `Date limite dépassée (${fr(d.avance_due_date)}).` : `Paiement promis le ${fr(d.avance_next_date)} non reçu.`);
        for (const role of ['caisse', 'admin'])
            pushNotification({ target_role: role, type: pastDue ? 'danger' : 'warn', title: `Livraison #${d.delivery_number} : avance en retard`,
                message: msg, link: '/engagements.html#avances', ref, persistent: true, data: { delivery_id: d.id } });
    }
}
startupTask(() => layawayLateCheck().catch(e => console.error('layawayLateCheck:', e.message)), 5200);
setInterval(() => layawayLateCheck().catch(() => {}), 60 * 60 * 1000);

// ============================================================
//  TRÉSORERIE
// ============================================================
// Avances encaissées (ventes avec avance + livraisons avec avance) : une seule source pour la trésorerie.
const ADVANCES_SQL = `(SELECT method, amount, sale_date FROM layaway_payments UNION ALL SELECT method, amount, sale_date FROM delivery_payments
                        UNION ALL SELECT method, amount, sale_date FROM sale_balance_payments)`;
// Ventes dont l'argent a été reçu : vendues, échangées (remplacées par une nouvelle vente) ou retournées
// (le remboursement est compté à part, le jour où il sort de la caisse).
const PAID_SALE_STATUSES = `('completed','exchanged','returned')`;
// Tout l'argent reçu, daté du jour où il est reçu : paiements de vente + avances caisse + avances livraison
// + reste des services atelier.
const RECEIPTS_SQL = `(SELECT sp.method AS method, sp.amount AS amount, s.sale_date AS sale_date FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id WHERE s.status IN ${PAID_SALE_STATUSES}
                       UNION ALL SELECT method, amount, sale_date FROM ${ADVANCES_SQL})`;
// CHIFFRE D'AFFAIRES = argent réellement encaissé sur la période − remboursements (base encaissement).
// from / to : AAAA-MM-JJ inclus, ou null (sans borne).
async function caBetween(from, to) {
    const w = [], p = [];
    if (from) { w.push('sale_date >= ?'); p.push(from); }
    if (to)   { w.push('sale_date <= ?'); p.push(to); }
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const inn = (await dbGet(`SELECT COALESCE(SUM(amount),0) AS v FROM ${RECEIPTS_SQL} ${where}`, p)).v || 0;
    const out = (await dbGet(`SELECT COALESCE(SUM(-amount),0) AS v FROM cash_movements ${where ? where + ' AND' : 'WHERE'} kind = 'remboursement'`, p)).v || 0;
    return inn - out;
}
// CA encaissé ventilé par mode de paiement (espèces, MVola, Orange Money, Airtel Money, chèque, virement) :
// même base que caBetween (reçu − remboursements de ce mode), pour le récap de la page Ventes.
async function caByMethod(from, to) {
    const w = [], p = [];
    if (from) { w.push('sale_date >= ?'); p.push(from); }
    if (to)   { w.push('sale_date <= ?'); p.push(to); }
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const out = {};
    (await dbAll(`SELECT method, COALESCE(SUM(amount),0) AS v FROM ${RECEIPTS_SQL} ${where} GROUP BY method`, p)).forEach(r => { out[r.method || 'especes'] = (out[r.method || 'especes'] || 0) + r.v; });
    (await dbAll(`SELECT COALESCE(method,'especes') AS method, COALESCE(SUM(-amount),0) AS v FROM cash_movements ${where ? where + ' AND' : 'WHERE'} kind = 'remboursement' GROUP BY 1`, p)).forEach(r => { out[r.method] = (out[r.method] || 0) - r.v; });
    return out;
}
// Série du CA encaissé par jour (ou par mois si monthly) + nombre de ventes, pour les graphiques.
async function caSeries(from, monthly) {
    const g = monthly ? 'substr(sale_date,1,7)' : 'sale_date';
    const w = from ? 'WHERE sale_date >= ?' : '', p = from ? [from] : [];
    const inn = await dbAll(`SELECT ${g} AS d, SUM(amount) AS v FROM ${RECEIPTS_SQL} ${w} GROUP BY ${g}`, p);
    const out = await dbAll(`SELECT ${g} AS d, SUM(-amount) AS v FROM cash_movements ${w ? w + ' AND' : 'WHERE'} kind = 'remboursement' GROUP BY ${g}`, p);
    const cnt = await dbAll(`SELECT ${g} AS d, COUNT(*) AS n FROM sales WHERE status = 'completed' ${from ? 'AND sale_date >= ?' : ''} GROUP BY ${g}`, p);
    const m = new Map();
    const at = d => m.get(d) || (m.set(d, { d, ca: 0, n: 0 }), m.get(d));
    inn.forEach(r => at(r.d).ca += r.v || 0);
    out.forEach(r => at(r.d).ca -= r.v || 0);
    cnt.forEach(r => at(r.d).n = r.n || 0);
    return [...m.values()].sort((a, b) => a.d.localeCompare(b.d));
}

// Soldes (toutes dates) mobile money par opérateur et chèque : encaissé (paiements de vente, y compris
// paiements MIXTES, + avances + reste atelier) − remboursements faits par ce moyen − retraits de l'admin.
// Source UNIQUE pour la trésorerie, le tableau de bord et la page Mobile Money.
async function walletBalances() {
    const out = {};
    for (const op of [...MM_METHODS, 'cheque']) {
        const inS = (await dbGet(`SELECT SUM(sp.amount) AS v FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id WHERE s.status IN ${PAID_SALE_STATUSES} AND sp.method = ?`, [op]))?.v || 0;
        const inA = (await dbGet(`SELECT SUM(amount) AS v FROM ${ADVANCES_SQL} WHERE method = ?`, [op]))?.v || 0;
        const refunds = (await dbGet(`SELECT SUM(-amount) AS v FROM cash_movements WHERE kind = 'remboursement' AND method = ?`, [op]))?.v || 0;
        const withdrawn = (await dbGet(`SELECT SUM(amount) AS v FROM admin_finance WHERE operator = ?`, [op]))?.v || 0;
        const inflow = inS + inA;
        out[op] = { inflow, outflow: withdrawn + refunds, refunds, withdrawn, balance: inflow - refunds - withdrawn };
    }
    return out;
}

async function treasurySummary(date) {
    // Ventilation par méthode depuis sale_payments (gère le paiement mixte : une vente
    // peut cumuler espèces + mobile money, chaque part étant comptée dans son bon poste).
    const salesCount = (await dbGet(`SELECT COUNT(*) AS n FROM sales WHERE sale_date = ? AND status = 'completed'`, [date]))?.n || 0;
    const parts = await dbAll(
        `SELECT sp.method AS method, SUM(sp.amount) AS amt
         FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
         WHERE s.sale_date = ? AND s.status IN ${PAID_SALE_STATUSES} GROUP BY sp.method`, [date]);
    // Avances (acomptes) encaissées ce jour : comptées comme entrée de caisse du jour, par méthode.
    const lparts = await dbAll(
        `SELECT method, SUM(amount) AS amt FROM ${ADVANCES_SQL} WHERE sale_date = ? GROUP BY method`, [date]);
    let cash = 0, mm = 0, cheque = 0, virement = 0;
    // Ventilation du mobile money du JOUR par opérateur (mvola / orange_money / airtel_money).
    const mmByMethod = { mvola: 0, orange_money: 0, airtel_money: 0 };
    [...parts, ...lparts].forEach(s => {
        if (s.method === 'especes') cash += s.amt;
        else if (s.method === 'cheque') cheque += s.amt;
        else if (s.method === 'virement') virement += s.amt;
        else if (MM_METHODS.includes(s.method)) { mm += s.amt; mmByMethod[s.method] += s.amt; }
    });
    const mv = await dbAll(`SELECT kind, amount, method FROM cash_movements WHERE sale_date = ?`, [date]);
    let fond = 0, depenses = 0, refunds = 0, cashRefunds = 0, cashFond = 0, cashDepenses = 0;
    const isCash = m => !m.method || m.method === 'especes';
    mv.forEach(m => {
        if (m.kind === 'fond') { fond += m.amount; if (isCash(m)) cashFond += m.amount; }
        else if (m.kind === 'depense') { depenses += -m.amount; if (isCash(m)) cashDepenses += -m.amount; }
        else if (m.kind === 'remboursement') { refunds += -m.amount; if (isCash(m)) cashRefunds += -m.amount; }
    });
    const ca = cash + mm + cheque + virement - refunds;   // CA du jour = encaissé − remboursements (comme caBetween)
    // Tiroir = mouvements en ESPÈCES uniquement (un fond, une dépense ou un remboursement par mobile money /
    // chèque / virement ne passe pas par le tiroir).
    const expectedCash = cashFond + cash - cashDepenses - cashRefunds;
    const closure = await dbGet('SELECT * FROM cash_closures WHERE sale_date = ?', [date]);
    // Contrôles du jour : situations qui faussent l'encaisse (même argent compté deux fois, paiement ≠ total…).
    const anomalies = [];
    (await dbAll(`SELECT s.id, s.sale_number, s.total, s.client_name, MIN(r.created_at) AS at
                  FROM sale_returns r JOIN sales s ON s.id = r.sale_id
                  WHERE substr(r.created_at, 1, 10) = ? AND r.type = 'retour_stock' AND s.status = 'returned'
                  GROUP BY s.id HAVING (SELECT COALESCE(SUM(refund_amount), 0) FROM sale_returns WHERE sale_id = s.id) < s.total - 1`, [date]))
        .forEach(r => anomalies.push({ kind: 'retour_sans_remboursement', sale_id: r.id, amount: r.total,
            message: `Vente n° ${r.sale_number} (${r.client_name || 'client'}) retournée SANS remboursement : ses ${Math.round(r.total).toLocaleString('fr-FR')} Ar restent comptés. Si le client a été refacturé, l'argent est compté deux fois.` }));
    (await dbAll(`SELECT s.id, s.sale_number, s.total, s.client_name,
                    (SELECT COALESCE(SUM(amount), 0) FROM sale_payments WHERE sale_id = s.id) AS paid,
                    (SELECT COALESCE(SUM(amount), 0) FROM sale_balance_payments WHERE sale_id = s.id) AS bal, s.balance_due
                  FROM sales s WHERE s.sale_date = ? AND s.status = 'completed' AND s.exchange_of IS NULL
                    AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.sale_id = s.id) AND NOT EXISTS (SELECT 1 FROM layaways l WHERE l.sale_id = s.id)`, [date]))
        .filter(r => Math.abs(r.total - r.paid - r.bal - (r.balance_due || 0)) > 1)
        .forEach(r => anomalies.push({ kind: 'paiement_different', sale_id: r.id, amount: r.total - r.paid - r.bal,
            message: `Vente n° ${r.sale_number} (${r.client_name || 'client'}) : total ${Math.round(r.total).toLocaleString('fr-FR')} Ar mais ${Math.round(r.paid + r.bal).toLocaleString('fr-FR')} Ar enregistrés.` }));
    const pending = await dbAll(
        `SELECT id, delivery_number, livreur_name, client_name, total FROM deliveries
         WHERE status = 'en_livraison' AND payment_status = 'a_livraison' AND (deferred_date IS NULL OR deferred_date <= ?)`, [date]);
    // Soldes Mobile Money / chèque (toutes dates) — même calcul que le tableau de bord admin.
    const wb = await walletBalances();
    const mmBalanceByOp = { mvola: wb.mvola.balance, orange_money: wb.orange_money.balance, airtel_money: wb.airtel_money.balance };
    return { date, sales_count: salesCount, ca, cash_sales: cash, mm_sales: mm, cheque_sales: cheque, virement_sales: virement,
             fond_total: fond, expenses_total: depenses, refunds_total: refunds, expected_cash: expectedCash,
             cash_fond: cashFond, cash_expenses: cashDepenses, cash_refunds: cashRefunds, anomalies,
             mm_balance: MM_METHODS.reduce((t, op) => t + wb[op].balance, 0), cheque_balance: wb.cheque.balance,
             mm_by_method: mmByMethod, mm_balance_by_op: mmBalanceByOp,
             closed: !!closure, closure, pending_deliveries: pending };
}

// Garde commune : la caisse ne peut modifier/supprimer que la journée EN COURS et NON clôturée.
// Retourne null si autorisé, sinon { code, error }. L'administrateur n'a aucune limite.
async function treasuryEditGuard(req, date) {
    if (req.session.user.role === 'admin') return null;
    if (date !== getDate()) return { code: 403, error: 'Journée passée : seul un administrateur peut modifier un mouvement antérieur.' };
    const closed = await dbGet('SELECT id FROM cash_closures WHERE sale_date = ?', [getDate()]);
    if (closed) return { code: 403, error: 'Caisse clôturée : seul un administrateur peut modifier.' };
    return null;
}

// ============================================================
//  GARANTIE (client / fournisseur / exceptionnelle)
// ============================================================
const GARANTIE_DEPOT = ['garantie_fournisseur', 'garantie_exceptionnel'];

function garantieType(status) {
    if (status === 'garantie_exceptionnel') return 'exceptionnel';
    return 'fournisseur';   // garantie_fournisseur | retour_fournisseur
}

// Rappel quotidien : unités en garantie fournisseur non encore renvoyées.
setInterval(async () => {
    try {
        const today = getDate();
        const last = await dbGet(`SELECT value FROM settings WHERE key = 'garantie_reminder_date'`);
        if (last && last.value === today) return;
        const pending = await dbGet(`SELECT COUNT(*) AS n FROM stock_units WHERE status = 'garantie_fournisseur'`);
        if (pending.n > 0) {
            db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('garantie_reminder_date', ?)`, [today]);
            pushNotification({ target_role: 'gestion_stock', type: 'warn', title: 'Garanties à renvoyer',
                message: `${pending.n} unité(s) en garantie fournisseur à renvoyer.`, link: '/garantie.html' });
            pushNotification({ target_role: 'admin', type: 'warn', title: 'Garanties à renvoyer',
                message: `${pending.n} unité(s) en garantie fournisseur non encore renvoyées.`, link: '/garantie.html' });
        }
    } catch (e) { /* silencieux */ }
}, 60 * 60 * 1000);

// ============================================================
//  LIVRAISONS (commande en ligne)
// ============================================================
async function getDeliveryFull(id) {
    const d = await dbGet('SELECT * FROM deliveries WHERE id = ?', [id]);
    if (!d) return null;
    const items = await dbAll(`SELECT di.*, p.brand, p.model, p.category, p.condition, p.cpu, p.ram, p.storage, p.storage_type, p.screen_size, p.gpu, p.touchscreen, p.numpad, p.is_accessory, p.is_service, p.emplacement
                               FROM delivery_items di LEFT JOIN products p ON p.id = di.product_id WHERE di.delivery_id = ?`, [id]);
    // Unités physiques réellement sorties (après release) : utile pour l'échange d'une pièce précise
    // tant que la livraison est « en_livraison » (sortie, non encore livrée).
    let released_units = [];
    if (d.sale_id) {
        released_units = await dbAll(
            `SELECT si.unit_id, si.serial, si.product_id, si.product_name, p.is_accessory, su.status AS unit_status,
                    (SELECT er.status FROM exchange_requests er WHERE er.old_unit_id = si.unit_id AND er.status = 'pending' LIMIT 1) AS exchange_pending
             FROM sale_items si LEFT JOIN products p ON p.id = si.product_id LEFT JOIN stock_units su ON su.id = si.unit_id
             WHERE si.sale_id = ? AND si.unit_id IS NOT NULL AND si.returned = 0 AND (si.is_service = 0 OR si.is_service IS NULL)`, [d.sale_id]);
    }
    return { ...d, items, released_units };
}

// Accès au détail d'une livraison (client, adresse, téléphone) : rôles de la chaîne livraison ; un
// commercial en ligne « pur » ne voit que SES commandes.
const DELIVERY_ROLES = ['commercial_ligne', 'coordinateur', 'caisse', 'gestion_stock'];
const ownsDeliveryOrBroader = (u, d) => !(hasRole(u, 'commercial_ligne') && !hasRole(u, 'coordinateur', 'caisse', 'gestion_stock') && u.role !== 'admin') || d.commercial_id === u.id;

// ============================================================
//  LIVRAISON : ÉTIQUETTE 60×40 mm + RÉSUMÉ COPIABLE
// ============================================================

// Montant en Ariary, séparateurs = espaces simples (copiable tel quel dans Messenger).
function arNum(n) {
    return String(Math.round(parseFloat(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
function htmlEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// 'AAAA-MM-JJ' → 'JJ/MM/AAAA'
function dateFR(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || '');
}
async function getDeliveryLabelData(id) {
    const d = await dbGet('SELECT * FROM deliveries WHERE id = ?', [id]);
    if (!d) return { notFound: true };
    const items = await dbAll(
        `SELECT di.product_name, di.quantity, di.unit_price, di.serial, di.color, di.upgrade_note,
                p.is_accessory, p.category, p.cpu, p.ram, p.storage, p.storage_type, p.screen_size
         FROM delivery_items di LEFT JOIN products p ON p.id = di.product_id
         WHERE di.delivery_id = ? ORDER BY di.id`, [d.id]);
    return { d, items, total: parseFloat(d.total || 0) + parseFloat(d.delivery_fee || 0) };
}

// ============================================================
//  DEMANDES CLIENTS (réseaux sociaux) — commercial en ligne → responsable commande
// ============================================================
// Le commercial en ligne note chaque produit demandé par un client ; le responsable commande voit
// les besoins (analyse par mots-clés, produits les plus demandés). Quand une réception (ou le stock
// déjà présent) correspond à la demande, le commercial est notifié : produit disponible.
const RQ_STOP = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'un', 'une', 'et', 'en', 'au', 'aux', 'pour', 'avec', 'a', 'sur', 'par',
    'ou', 'svp', 'merci', 'client', 'cliente', 'cherche', 'recherche', 'veut', 'voudrait', 'besoin', 'prix', 'modele', 'model', 'bon', 'etat',
    'qui', 'que', 'est', 'son', 'sa', 'ses', 'mon', 'ma', 'mes', 'dispo', 'disponible', 'encore', 'type', 'genre', 'comme', 'tres', 'plus', 'max', 'mini']);
// Mots trop génériques pour identifier un produit (comptent dans l'analyse, pas dans la correspondance).
const RQ_WEAK = new Set(['pc', 'ordinateur', 'ordi', 'portable', 'portables', 'laptop', 'bureau', 'desktop', 'machine', 'ram', 'memoire', 'stockage',
    'disque', 'dur', 'ecran', 'pouce', 'pouces', 'generation', 'gen', 'core', 'intel', 'amd', 'processeur', 'proc', 'cpu', 'neuf', 'occasion',
    'noir', 'blanc', 'gris', 'silver', 'go', 'gb', 'to', 'tb', 'giga', 'hdd', 'ssd', 'sata', 'nvme', 'avec', 'sans', 'accessoire']);
function rqNorm(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/(\d+)\s*(go|gb|giga|g)\b/g, '$1go').replace(/(\d+)\s*(to|tb)\b/g, '$1to')
        .replace(/(\d+)\s*(eme|e|th|gen|generation)\b/g, '$1gen');
}
function rqTokens(s) {
    return rqNorm(s).split(/[^a-z0-9]+/).filter(t => t && !RQ_STOP.has(t));
}
// Mots identifiants d'une demande (hors génériques et générations) ; à défaut, tous les mots.
function rqStrong(tokens) {
    const st = tokens.filter(t => !RQ_WEAK.has(t) && !/^\d+gen$/.test(t));
    return st.length ? st : tokens;
}
// Vocabulaire d'une fiche produit (noms, config, description) + mots accolés (« elitebook840 »).
function rqProductSet(p) {
    const toks = rqTokens([p.name, p.brand, p.model, p.category, p.subcategory, p.cpu, p.ram, p.storage, p.storage_type,
        p.screen_size, p.gpu, p.description].filter(Boolean).join(' '));
    const set = new Set(toks);
    for (let i = 0; i + 1 < toks.length; i++) set.add(toks[i] + toks[i + 1]);
    return set;
}
// Références de modèle (X390, G3010, 840, M1…) : lettres + chiffres ou nombre long, hors capacités,
// générations et gammes de processeur (8go, 256go, 8gen, i5, r7).
function rqKeys(tokens) {
    return tokens.filter(t => ((/[a-z]/.test(t) && /\d/.test(t)) || /^\d{3,}$/.test(t))
        && !/^\d+(go|to|gen|ghz|mhz|hz|w|mah|mp)$/.test(t) && !/^[ir][3579]$/.test(t));
}
// Correspondance : toutes les références de modèle de la demande, et tous les mots identifiants
// si elle en a 1 ou 2, sinon au moins 75 %.
function rqMatches(reqText, prodSet) {
    const strong = [...new Set(rqStrong(rqTokens(reqText)))];
    if (!strong.length) return false;
    if (rqKeys(strong).some(k => !prodSet.has(k))) return false;
    const hit = strong.filter(t => prodSet.has(t)).length;
    return strong.length <= 2 ? hit === strong.length : hit / strong.length >= 0.75;
}
const RQ_STATUSES = ['en_attente', 'disponible', 'commandee', 'abandonnee'];
const rqCanSeeAll = async u => u.role === 'admin' || (await commandeResponsibleId()) === u.id;
const requireRqAccess = async (req, res, next) => {
    const u = req.session && req.session.user;
    if (u && (u.role === 'admin' || hasRole(u, 'commercial_ligne') || (await commandeResponsibleId()) === u.id)) return next();
    res.status(403).json({ error: 'Accès non autorisé pour votre rôle' });
};

// Produits encore disponibles (dépôt, présentoir, boutique) correspondant à une demande.
async function rqFindInStock(text) {
    const prods = await dbAll(`SELECT p.* FROM products p WHERE COALESCE(p.is_service, 0) = 0
        AND EXISTS (SELECT 1 FROM stock_units u WHERE u.product_id = p.id AND u.status IN ('stock','presentoir','consignation'))`);
    return prods.find(p => rqMatches(text, rqProductSet(p))) || null;
}
async function rqMarkAvailable(r, prod, source) {
    const now = getDateTime();
    const ch = await dbRun(`UPDATE client_requests SET status = 'disponible', matched_product_id = ?, matched_product_name = ?, matched_at = ?, matched_source = ?, updated_at = ?
                            WHERE id = ? AND status = 'en_attente'`, [prod.id, prod.name, now, source, now, r.id]);
    if (!ch.changes) return false;
    pushNotification({ target_user: r.commercial_id, type: 'success', title: 'Produit disponible',
        message: `${r.client_name ? r.client_name + ' · ' : ''}« ${r.product_text} » → ${prod.name}${source === 'reception' ? ' (nouvelle réception)' : ' (en stock)'}`,
        link: '/demandes-clients.html', ref: `client_request:${r.id}`, data: { request_id: r.id, product_id: prod.id } });
    return true;
}
// Après une réception : chaque demande en attente qui correspond à un produit reçu devient « disponible ».
async function rqMatchReception(productIds) {
    try {
        if (!productIds.length) return;
        const prods = await dbAll(`SELECT * FROM products WHERE id IN (${productIds.map(() => '?').join(',')}) AND COALESCE(is_service, 0) = 0`, productIds);
        const sets = prods.map(p => ({ p, set: rqProductSet(p) }));
        const pending = await dbAll(`SELECT * FROM client_requests WHERE status = 'en_attente'`);
        let n = 0;
        for (const r of pending) {
            const m = sets.find(x => rqMatches(r.product_text, x.set));
            if (m && await rqMarkAvailable(r, m.p, 'reception')) n++;
        }
        if (n) broadcast('client-request:update', {});
    } catch (e) { console.error('rqMatchReception:', e.message); }
}

// ============================================================
//  SERVICE ATELIER : étiquettes des ordinateurs clients — responsable désigné
// ============================================================
// Référence de facture identique à celle imprimée : AAAAMMJJ-NNNN.
function invoiceRef(s) {
    const d = String(s.sale_date || String(s.created_at || '').slice(0, 10)).replace(/-/g, '');
    return (d ? d + '-' : '') + String(s.sale_number || 0).padStart(4, '0');
}
// Données à jour de la vente (client corrigé…) ; à défaut (vente supprimée), la copie gardée sur l'étiquette.
const ATELIER_SELECT = `SELECT l.id, l.sale_id, l.services, l.status, l.created_at, l.created_by_name, l.printed_at, l.printed_by_name, l.print_count,
        COALESCE(s.sale_number, l.sale_number) AS sale_number, COALESCE(s.sale_date, l.sale_date) AS sale_date,
        COALESCE(s.created_at, l.sale_created_at) AS sale_created_at,
        COALESCE(s.client_name, l.client_name) AS client_name, COALESCE(s.client_phone, l.client_phone) AS client_phone,
        COALESCE(s.client_pc, l.client_pc) AS client_pc, COALESCE(s.client_pc_ram, l.client_pc_ram) AS client_pc_ram,
        COALESCE(s.client_pc_storage, l.client_pc_storage) AS client_pc_storage, COALESCE(s.client_pc_charger, l.client_pc_charger) AS client_pc_charger,
        COALESCE(s.client_pc_note, l.client_pc_note) AS client_pc_note, COALESCE(s.cashier_name, l.cashier_name) AS cashier_name,
        COALESCE(s.commercial_name, l.commercial_name) AS commercial_name, COALESCE(s.balance_due, 0) AS balance_due,
        -- Prix du service atelier (affiché sur l'étiquette, payé ou non) ; à défaut, total de la facture.
        COALESCE((SELECT SUM(si.unit_price) FROM sale_items si JOIN products p ON p.id = si.product_id
                  WHERE si.sale_id = l.sale_id AND si.is_service = 1 AND p.service_atelier = 1), s.total, 0) AS service_price,
        -- Articles achetés dans la MÊME vente (disque, RAM, accessoires…) : à installer / remettre avec le PC.
        (SELECT GROUP_CONCAT(COALESCE(si.product_name, 'Article') || char(31) || CAST(COALESCE(si.unit_price, 0) AS INTEGER) || char(31) || COALESCE(si.is_gift, 0), char(30))
           FROM sale_items si WHERE si.sale_id = l.sale_id AND COALESCE(si.is_service, 0) = 0 AND COALESCE(si.returned, 0) = 0) AS parts_raw
    FROM atelier_labels l LEFT JOIN sales s ON s.id = l.sale_id`;
const withRef = rows => rows.map(r => {
    const parts = String(r.parts_raw || '').split('\u001e').filter(Boolean).map(x => { const [name, price, gift] = x.split('\u001f'); return { name, price: +price || 0, gift: gift === '1' }; })
        // Articles identiques regroupés : « 2× SSD 512 Go 180 000 Ar » (prix unitaire).
        .reduce((acc, x) => { const o = acc.find(y => y.name === x.name && y.price === x.price && y.gift === x.gift); o ? o.qty++ : acc.push({ ...x, qty: 1 }); return acc; }, []);
    const { parts_raw, ...rest } = r;
    return { ...rest, parts, invoice_ref: invoiceRef(r) };
});

// Livraison avec avance → document au format d'une avance (facture d'avance, cf. SFInvoice.avance).
async function getDeliveryAvanceDoc(id) {
    const d = await getDeliveryFull(id);
    if (!d) return null;
    const items = [];
    for (const it of d.items) for (let k = 0; k < it.quantity; k++) items.push({ ...it, quantity: 1 });
    const payments = await dbAll('SELECT method, amount, phone, ref, sale_date, created_at, next_date, cashier_name FROM delivery_payments WHERE delivery_id = ? ORDER BY id', [id]);
    return { id: d.id, layaway_number: d.delivery_number, doc_label: 'N° livraison', code_prefix: 'AL', subtitle: `Livraison #${d.delivery_number}`,
             total: d.total || 0, deposit: d.acompte || 0, status: d.status, created_at: payments.length ? payments[0].created_at : d.created_at,
             due_date: d.avance_due_date, next_payment_date: d.avance_next_date, client_name: d.client_name, client_phone: d.client_phone,
             client_address: d.client_address, commercial_name: d.commercial_name, items, payments };
}
const DELIVERY_AVANCE_OPEN = `acompte_paid = 1 AND status IN ('facturee','en_livraison')`;

// Alertes « livraison impayée / montant élevé » : UNE par livraison et par destinataire (ref), résolues
// quand la livraison est confirmée ou annulée — au lieu d'une nouvelle alerte toutes les 10 minutes.
function resolveDeliveryLateNotifs(id) {
    ['late-coord', 'late-caisse', 'late-stock', 'high-amount'].forEach(k => resolveNotifs(`delivery:${id}:${k}`));
}
const openNotif = ref => dbGet(`SELECT 1 FROM notifications WHERE ref = ? AND resolved = 0 LIMIT 1`, [ref]);

// Vérifs livraison : impayées en retard + montants élevés (toutes les 10 min).
setInterval(async () => {
    try {
        const settings = await getSettingsAsync();
        const alertH = parseInt(settings.delivery_alert_hours, 10) || 3;
        const alertAmt = parseFloat(settings.delivery_alert_amount) || 50000;
        const now = Date.now();
        const rows = await dbAll(`SELECT * FROM deliveries WHERE status = 'en_livraison' AND payment_status = 'a_livraison' AND released_at IS NOT NULL`);
        for (const d of rows) {
            const hours = (now - d.released_at) / 3600000;
            if (hours >= alertH) {
                // Coordinateur : une alerte par livraison (jusqu'au versement) → page Coordination > Versements.
                const cref = `delivery:${d.id}:late-coord`;
                if (!(await dbGet(`SELECT 1 FROM notifications WHERE ref = ? AND resolved = 0 LIMIT 1`, [cref])))
                    pushNotification({ target_role: 'coordinateur', type: 'warn', persistent: true, ref: cref, title: 'Versement livreur en retard',
                        message: `Livraison #${d.delivery_number} (${d.livreur_name || 'livreur'}) — ${Math.floor(hours)} h depuis la sortie, ${Math.round(Math.max(0, d.total + (d.delivery_fee || 0) - (d.acompte || 0))).toLocaleString('fr-FR')} Ar non versés.`,
                        link: '/coordination.html#versements', data: { delivery_id: d.id } });
                const kref = `delivery:${d.id}:late-caisse`, sref = `delivery:${d.id}:late-stock`;
                if (!(await openNotif(kref)))
                    pushNotification({ target_role: 'caisse', type: 'warn', title: 'Livraison impayée en cours', persistent: true, ref: kref,
                        message: `Livraison #${d.delivery_number} (${d.livreur_name}) — plus de ${Math.floor(hours)} h sans paiement.`, link: '/deliveries.html', data: { delivery_id: d.id } });
                if (!(await openNotif(sref)))
                    pushNotification({ target_role: 'gestion_stock', type: 'warn', title: 'Livraison impayée en cours', ref: sref,
                        message: `Livraison #${d.delivery_number} (${d.livreur_name}) — plus de ${Math.floor(hours)} h.`, link: '/deliveries.html', data: { delivery_id: d.id } });
            }
            const href = `delivery:${d.id}:high-amount`;
            if (d.total >= alertAmt && hours >= 24 && !(await openNotif(href))) {
                pushNotification({ target_role: 'admin', type: 'danger', title: 'Montant élevé chez le livreur', persistent: true, ref: href,
                    message: `Livraison #${d.delivery_number} (${d.livreur_name}) — ${Math.round(d.total)} Ar depuis +24 h. Appelez le livreur.`, link: '/deliveries.html', data: { delivery_id: d.id } });
            }
        }
    } catch (e) { /* silencieux */ }
}, 10 * 60 * 1000);

// Détection des livraisons bloquées à une étape > 10 min → alerte l'admin.
setInterval(async () => {
    try {
        const now = Date.now(), STUCK = 10 * 60 * 1000;
        const stage = {
            nouvelle:  { who: 'coordinateur',              act: 'assignation',        link: '/coordination.html' },
            acceptee:  { who: 'caisse',                    act: 'facturation',        link: '/deliveries.html' },
            facturee:  { who: 'gestionnaire du stock',     act: 'sortie du stock',    link: '/deliveries.html' }
        };
        const rows = await dbAll(`SELECT * FROM deliveries WHERE status IN ('nouvelle','acceptee','facturee') AND stuck_notified = 0 AND status_at IS NOT NULL`);
        for (const d of rows) {
            if (now - d.status_at < STUCK) continue;
            const s = stage[d.status]; if (!s) continue;
            const mins = Math.floor((now - d.status_at) / 60000);
            const who = s.who;
            await dbRun(`UPDATE deliveries SET stuck_notified = 1 WHERE id = ?`, [d.id]);
            pushNotification({ target_role: 'admin', type: 'danger', title: 'Livraison bloquée',
                message: `Livraison #${d.delivery_number} en attente de ${s.act} (${who}) depuis ${mins} min.`,
                link: '/supervision.html', ref: `stuck:delivery:${d.id}` });
        }
    } catch (e) { /* silencieux */ }
}, 2 * 60 * 1000);

// Livraisons EN RETARD de plus de 3 jours sur la date prévue et JAMAIS sorties du stock : PLUS
// d'annulation automatique (21/10) — l'admin est notifié (une fois par livraison, notification
// persistante) et DÉCIDE dans la page « Annulations » : reporter à une nouvelle date ou annuler (motif).
// La notification se résout d'elle-même dès que la livraison n'est plus en retard (sortie, reportée,
// annulée…). overdue_notified = horodatage de la notification envoyée.
const OVERDUE_DAYS = 3;
async function notifyOverdueDeliveries() {
    const cutoff = addDays(getDate(), -OVERDUE_DAYS);   // prévue avant (aujourd'hui − 3 j) = en retard de > 3 jours
    const overdueWhere = `status IN ('nouvelle','assignee','acceptee','facturee') AND released_at IS NULL
           AND COALESCE(planned_date, delivery_date, substr(created_at,1,10)) < ?`;
    const rows = await dbAll(`SELECT * FROM deliveries WHERE ${overdueWhere} AND overdue_notified IS NULL`, [cutoff]);
    for (const d of rows) {
        let paid = 0;
        if (d.sale_id) paid = (await dbGet('SELECT SUM(amount) AS v FROM sale_payments WHERE sale_id = ?', [d.sale_id]))?.v || 0;
        if (d.acompte_paid) paid += (await dbGet('SELECT SUM(amount) AS v FROM delivery_payments WHERE delivery_id = ?', [d.id]))?.v || 0;
        const plan = d.planned_date || d.delivery_date || String(d.created_at || '').slice(0, 10);
        pushNotification({ target_role: 'admin', type: 'warn', persistent: true, ref: `delivery:${d.id}:overdue`,
            title: `Livraison #${d.delivery_number} en retard — à décider`,
            message: `${d.client_name || 'Client'} · prévue le ${plan}, jamais sortie du stock${paid > 0 ? ` · ${Math.round(paid).toLocaleString('fr-FR')} Ar déjà payés` : ''}. Reporter ou annuler ?`,
            link: '/annulations.html#retard', data: { delivery_id: d.id } });
        await dbRun('UPDATE deliveries SET overdue_notified = ? WHERE id = ?', [Date.now(), d.id]);
    }
    // Plus en retard (sortie, reportée, annulée, livrée…) → notification résolue, compteur remis à zéro.
    const healed = await dbAll(`SELECT id FROM deliveries WHERE overdue_notified IS NOT NULL AND NOT (${overdueWhere})`, [cutoff]);
    for (const d of healed) {
        resolveNotifs(`delivery:${d.id}:overdue`);
        await dbRun('UPDATE deliveries SET overdue_notified = NULL WHERE id = ?', [d.id]);
    }
}
startupTask(() => {
    ensureColumn('deliveries', 'overdue_notified', 'overdue_notified INTEGER');   // notif « en retard » envoyée (ms)
    ensureColumn('deliveries', 'cancel_category', 'cancel_category TEXT');        // catégorie de motif corrigée par l'admin
    ensureColumn('deliveries', 'cancelled_by', 'cancelled_by TEXT');              // qui a annulé (nom)
    ensureColumn('deliveries', 'cancelled_by_role', 'cancelled_by_role TEXT');
    ensureColumn('deliveries', 'source_page', 'source_page TEXT');                // page réseau social d'origine (commande en ligne)
    setTimeout(() => { notifyOverdueDeliveries().catch(() => {}); }, 25 * 1000);          // peu après le démarrage
    setInterval(() => { notifyOverdueDeliveries().catch(() => {}); }, 60 * 60 * 1000);     // puis toutes les heures
}, 4710);

// Rappel toutes les ~30 min à la caisse pour les consignations reçues non encaissées.
setInterval(async () => {
    try {
        const now = Date.now(), WAIT = 30 * 60 * 1000;
        const rows = await dbAll(`SELECT * FROM consignments WHERE status = 'received'`);
        for (const c of rows) {
            const base = c.last_reminder_at || (c.received_at ? Date.parse(String(c.received_at).replace(' ', 'T') + '+03:00') : now);
            if (now - base < WAIT) continue;
            await dbRun(`UPDATE consignments SET last_reminder_at = ? WHERE id = ?`, [now, c.id]);
            resolveNotifs(`consignment:${c.id}`);   // remplace le rappel précédent au lieu de l'empiler
            const t = await dbGet('SELECT SUM(unit_price) v, COUNT(*) n FROM consignment_items WHERE consignment_id = ?', [c.id]);
            pushNotification({ target_role: 'caisse', type: 'warn', persistent: true, ref: `consignment:${c.id}`,
                title: 'Rappel — encaissement en attente',
                message: `${c.commercial_name} détient encore ${t.n} article(s) (${Math.round(t.v || 0).toLocaleString('fr-FR')} Ar) non encaissés.`,
                link: '/encaissement.html' });
        }
    } catch (e) { /* silencieux */ }
}, 5 * 60 * 1000);

// ── Tableau de bord des rôles : graphique d'activité personnel (une ou deux séries par jour/mois) ──
// rows = [{ d, ca, n }] : « ca » = série A (montant ou quantité), « n » = série B (nombre).
// Chiffre d'affaires (montants de ventes agrégés, même du jour) : réservé à l'admin et à la caisse.
// Les autres rôles voient leur activité en NOMBRES (ventes, commandes, articles), jamais en montants.
const canSeeCA = u => !!u && (u.role === 'admin' || hasRole(u, 'caisse'));
// Accès COMPLET aux chiffres (page Profits, marges, CA des jours passés / du mois / global) : réservé aux
// admins listés dans settings.full_ca_users (ids, JSON). Sans réglage : le compte « jom » seul.
// Les autres admins ne voient que le CA du jour (+ moyenne / journalier du graphique du tableau de bord).
async function fullCAIds() {
    const s = await getSettingsAsync().catch(() => ({}));
    try { const a = JSON.parse(s.full_ca_users || 'null'); if (Array.isArray(a)) return a.map(Number).filter(Boolean); } catch (e) {}
    const j = await dbGet(`SELECT id FROM users WHERE LOWER(username) = 'jom'`).catch(() => null);
    return j ? [j.id] : [];
}
async function hasFullCA(u) { return !!u && u.role === 'admin' && (await fullCAIds()).includes(Number(u.id)); }
// Admin SANS accès complet : CA limité au jour même.
async function caTodayOnly(u) { return !!u && u.role === 'admin' && !hasRole(u, 'caisse') && !(await hasFullCA(u)); }

// ============================================================
//  FALLBACK + DÉMARRAGE
// ============================================================
// Redirige la racine vers la page de connexion.
app.get('/', (req, res) => res.redirect('/login.html'));

// ============================================================
//  ROUTES PAR DOMAINE (routes/*.js)
//  Chaque module reçoit l'application et les helpers partagés ci-dessous. Enregistrés ICI,
//  après toutes les déclarations et avant le gestionnaire 404 / d'erreurs.
// ============================================================
const SHARED = {
    notifyOverdueDeliveries, OVERDUE_DAYS,
    applyAutoImage, AutoImgQueue, autoImageQuery,
    accCode, addDays, adminHasDefaultPassword, applyInstallItemValidation, applyUpgrades, arNum, ATELIER_SELECT,
    atelierResponsibleId, attachConsignmentItems, autoMergeIdenticalProducts, BAT_AUTO, BAT_WHERE, BatCatalog,
    batKey, BatQueue, batteryLookupAndSave, batterySweep, bcrypt, boutiqueResponsibleIdAsync, broadcast, caBetween, caByMethod,
    canonicalBrandModel, canSeeCA, caTodayOnly, fullCAIds, hasFullCA, caSeries, checkNextPaymentDate, clientError, closedDayBlock,
    closeInstallTaskIfComplete, commandeResponsibleId, commercialView, consignItemsSql, DATE_RE, dateFR, daysUntil,
    db, dbAll, dbGet, dbRun, decoyQuestion, DELIVERY_AVANCE_OPEN, DELIVERY_ROLES, displaySerial, exitFindSale,
    exitState, FORGOT_DUMMY_HASH, FORGOT_FAIL, fs, GARANTIE_DEPOT, garantieResponsibleId, garantieType, genRegCode,
    getDate, getDateTime, getDeliveryAvanceDoc, getDeliveryFull, getDeliveryLabelData, getLayawayFull, getSaleFull,
    getSettings, getSettingsAsync, hasRole, htmlEsc, INV_SCOPE, INV_ZONE, invalidateUserCache, invDraftTable,
    inventaireExpected, inventaireKnownOther, invFilter, invGuard, invNorm, invoiceRef, logActivity, logGarantie,
    loginAttempts, loginRateLimit, MM_METHODS, nextSaleNumber, normalizeCode, normalizePayments, normalizeRole,
    normEmplacement, notifTarget, ORDI_EST_PROFIT, ownsDeliveryOrBroader, parseAccCode, parseExtraRoles,
    PASSWORD_MIN, path, PAY_METHODS, POS_SELLABLE, posNotOut, productDisplayName, productSignature, pushNotification,
    pwdTag, RECONF_FIELDS, RECONF_FLAGS, recordMovement, recordSalePayments, registerFailedLogin, requireAdmin,
    requireAtelier, requireAuth, requireGarantieResponsible, requireGarantieViewer, requireRole, requireRqAccess,
    requireSoReader, requireSoWriter, resolveDeliveryLateNotifs, resolveDepotUnits, resolveNotifs, restoreSaleUnits,
    ROLE_HOME, ROLE_KEYS, ROLES, rolesOf, RQ_STATUSES, RQ_WEAK, rqCanSeeAll, rqFindInStock, rqKeys, rqMarkAvailable,
    rqMatchReception, rqStrong, rqTokens, runDailyBackup, safeUploadPath, salePaymentsSnapshot, SELLABLE, sigAlnum,
    SO_FILE_DIR, SO_STATUS, soAttach, soNum, soParse, soUploadFiles, soWriteItems, SQL_COMPACT, starlinkAddressError,
    storage, stripCost, syncUnitPrices, technicianView, treasuryEditGuard, treasurySummary, txError, UNIT_STATUS,
    unitCost, unlinkUpload, upload, validateUpgrades, walletBalances, withRef, withTx
};
require('./routes/comptes')(app, SHARED);
require('./routes/config')(app, SHARED);
require('./routes/commandes')(app, SHARED);
require('./routes/stock')(app, SHARED);
require('./routes/ventes')(app, SHARED);
require('./routes/atelier')(app, SHARED);
require('./routes/engagements')(app, SHARED);
require('./routes/livraisons')(app, SHARED);
require('./routes/tresorerie')(app, SHARED);

app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Route introuvable' });
    res.status(404).sendFile(path.join(APP_DIR, 'public', 'login.html'));
});

// Gestionnaire d'erreurs global : jamais de page Express avec trace de pile. Erreurs d'upload (type de
// fichier, taille) → 400 lisible ; JSON mal formé → 400 ; le reste → 500 journalisé côté serveur.
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    let status = err.status || err.statusCode || 500, message = err.message || 'Erreur serveur';
    if (err instanceof multer.MulterError) { status = 400; message = err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop lourd' : message; }
    else if (/^Type de fichier non autorisé/.test(message)) status = 400;
    else if (err.type === 'entity.parse.failed') { status = 400; message = 'Requête invalide (JSON mal formé)'; }
    else if (err.type === 'entity.too.large') { status = 413; message = 'Requête trop volumineuse'; }
    if (status >= 500) { console.error('Erreur non gérée :', req.method, req.originalUrl, err); message = 'Erreur serveur'; }
    if (req.path.startsWith('/api/')) return res.status(status).json({ error: message });
    res.status(status).type('text/plain').send(message);
});

// Une promesse rejetée sans catch (tâche de fond, notification…) est journalisée au lieu de passer inaperçue.
process.on('unhandledRejection', e => console.error('Promesse rejetée non gérée :', e && e.message ? e.message : e));

Promise.race([runStartupTasks(), new Promise(r => setTimeout(() => { console.warn('⚠️  Migrations de démarrage > 60 s : démarrage quand même.'); r(); }, 60000))])
.then(() => app.listen(PORT, () => {
    console.log(`\n🚀 STOCKFLOW démarré → http://localhost:${PORT}`);
    console.log(`   Données : ${APP_DIR}`);
    adminHasDefaultPassword().then(def => {
        if (def) console.warn('⚠️  Le compte admin par défaut utilise encore son mot de passe initial : changez-le (Mon profil).');
    }).catch(() => {});
}));

// Exporté pour les modules de phases suivantes (stock, ventes, livraison…).
module.exports = { app, db, dbRun, dbGet, dbAll, broadcast, pushNotification, logActivity,
                   recordMovement, getDate, getDateTime, addDays, daysUntil, getSettings, getSettingsAsync,
                   requireAuth, requireAdmin, requireRole, ROLES, UNIT_STATUS, upload };
