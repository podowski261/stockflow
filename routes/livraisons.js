// ============================================================
//  STOCKFLOW — Livraisons, coordination, encaissement des livraisons
//  Routes /api déplacées depuis server.js (code inchangé). Les helpers, la base et les
//  middlewares partagés arrivent par S (voir « Routes par domaine » en fin de server.js).
// ============================================================
module.exports = function register(app, S) {
    const { accCode, addDays, applyUpgrades, arNum, attachConsignmentItems, broadcast, checkNextPaymentDate,
        clientError, commercialView, consignItemsSql, dateFR, dbAll, dbGet, dbRun, DELIVERY_AVANCE_OPEN,
        DELIVERY_ROLES, getDate, getDateTime, getDeliveryAvanceDoc, getDeliveryFull, getDeliveryLabelData,
        getSaleFull, getSettingsAsync, hasRole, htmlEsc, logActivity, MM_METHODS, nextSaleNumber, normalizePayments,
        ownsDeliveryOrBroader, parseAccCode, PAY_METHODS, pushNotification, recordMovement, recordSalePayments,
        requireAdmin, requireAuth, requireRole, resolveDeliveryLateNotifs, resolveNotifs, restoreSaleUnits, txError,
        validateUpgrades, withTx } = S;
    const { notifyOverdueDeliveries, OVERDUE_DAYS } = S;
    // Pages réseaux sociaux (canal d'une commande en ligne) : liste gérée par l'admin (Paramètres).
    const DEFAULT_SOCIAL_PAGES = ['Infinity PC Store', 'Infinity Store I', 'Infinity Store II', 'Infinity Store III', 'Infinity Store IV', 'Infini-Tech'];
    const socialPages = async () => {
        const s = await getSettingsAsync().catch(() => ({}));
        try { const a = JSON.parse(s.social_pages || 'null'); if (Array.isArray(a)) return a.map(x => String(x || '').trim()).filter(Boolean); } catch (e) {}
        return DEFAULT_SOCIAL_PAGES.slice();
    };
    // Acompte déclaré par le commercial à la création de la commande (client déjà payé, ex. MVola) :
    // l'argent est reçu CE jour-là → il compte dans le CA du jour de la commande, pas du jour de la facture.
    const acompteDay = d => { const c = String(d.created_at || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(c) && c < getDate() ? c : getDate(); };
    const whoCancels = req => { const u = req.session.user || {}; return [u.full_name || u.username || null, u.role || null]; };

// Page caisse : encaissements en attente (boutique + livraison).
app.get('/api/encaissement/pending', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const boutique = await attachConsignmentItems(await dbAll(
            `SELECT c.*, ${consignItemsSql('c')} FROM consignments c WHERE c.status = 'received' ORDER BY c.received_at`, []), true);
        const today = getDate();
        const livraison = await dbAll(
            `SELECT d.id, d.delivery_number, d.client_name, d.client_phone, d.client_address, d.delivery_time,
                    d.livreur_name, d.commercial_name, d.total, d.acompte, d.acompte_paid, d.status, d.payment_status, d.sale_id,
                    d.status_at, d.released_at, d.deferred_date, d.defer_reason, d.created_at,
                (SELECT GROUP_CONCAT(di.quantity || '× ' || di.product_name, ' · ') FROM delivery_items di WHERE di.delivery_id = d.id) AS items_summary
             FROM deliveries d
             WHERE d.status = 'en_livraison' AND d.payment_status = 'a_livraison'
             ORDER BY (d.deferred_date = ?) ASC, d.released_at ASC, d.created_at ASC`, [today]);
        res.json({ boutique, livraison, now: Date.now(), today });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/social-pages', requireAuth, async (req, res) => {
    try { res.json({ pages: await socialPages() }); } catch (e) { res.status(500).json({ error: e.message }); }
});
// Commercial en ligne : créer une livraison.
app.post('/api/deliveries', requireAuth, requireRole('commercial_ligne'), async (req, res) => {
    try {
        const { client, delivery_fee, note, lines } = req.body;
        { const cErr = clientError(client && client.name, client && client.phone); if (cErr) return res.status(400).json({ error: cErr }); }
        if (!client.address || !String(client.address).trim()) return res.status(400).json({ error: 'Lieu de livraison requis' });
        if (!Array.isArray(lines) || !lines.length) return res.status(400).json({ error: 'Panier vide' });
        // Canal obligatoire : la page réseau social qui a reçu la commande (liste de l'admin).
        const source_page = String(req.body.source_page || '').trim();
        if (!source_page) return res.status(400).json({ error: 'Canal de la commande obligatoire (page réseau social)' });
        if (!(await socialPages()).includes(source_page)) return res.status(400).json({ error: `Page « ${source_page} » inconnue : liste à jour dans Paramètres` });
        const payment_declared = req.body.payment_declared === 'paye' ? 'paye' : 'a_livraison';
        const now = getDateTime(), today = getDate();
        // Date de livraison prévue : défaut aujourd'hui, modifiable (future autorisée, passé refusé).
        let planned_date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.planned_date || '') ? req.body.planned_date : today;
        if (planned_date < today) planned_date = today;
        // Prix : celui de la fiche par défaut. Un prix négocié par le commercial reste possible, mais il
        // doit être un montant valide (≥ 0) ; il est tracé (prix fiche conservé) et l'admin est prévenu
        // dès qu'une ligne est vendue SOUS le prix de la fiche.
        let total = 0;
        const below = [];
        for (const l of lines) {
            const p = await dbGet('SELECT id, name, sale_price FROM products WHERE id = ?', [l.product_id]);
            if (!p) return res.status(400).json({ error: 'Produit introuvable dans le panier' });
            const catalog = Math.round(Number(p.sale_price) || 0);
            let price = catalog;
            if (l.unit_price != null && l.unit_price !== '') {
                price = Math.round(Number(l.unit_price));
                if (!isFinite(price) || price < 0) return res.status(400).json({ error: `Prix invalide pour « ${p.name} »` });
            }
            l._name = p.name; l._catalog = catalog; l._price = price;
            l._qty = Math.max(1, parseInt(l.quantity, 10) || 1);
            if (price < catalog) below.push(`${p.name} : ${price.toLocaleString('fr-FR')} Ar (fiche ${catalog.toLocaleString('fr-FR')} Ar)`);
            total += l._price * l._qty;
        }
        const fee = Math.max(0, parseFloat(delivery_fee) || 0);
        // Acompte déjà versé (facultatif) : montant borné à [0, total], mode obligatoire si > 0.
        let acompte = Math.max(0, parseFloat(req.body.acompte) || 0);
        if (acompte > total) acompte = total;
        let acompte_method = null;
        if (acompte > 0) {
            acompte_method = req.body.acompte_method;
            if (!PAY_METHODS.includes(acompte_method)) return res.status(400).json({ error: 'Mode de paiement de l\'acompte invalide' });
        }
        // Pour une commande « déjà payée », la méthode (espèces / mobile money) et les détails éventuels
        // sont déclarés juste après la création via /declared-payment (modale dédiée côté commercial).
        // N° du jour + insertion dans la même transaction : deux commandes simultanées n'ont plus le même n°.
        const { deliveryId, number } = await withTx(async () => {
            const nrow = await dbGet(`SELECT MAX(delivery_number) AS mx FROM deliveries WHERE delivery_date = ?`, [today]);
            const number = (nrow && nrow.mx ? nrow.mx : 0) + 1;
            const d = await dbRun(
                `INSERT INTO deliveries (delivery_number, delivery_date, planned_date, client_name, client_phone, client_address, delivery_time, delivery_fee, commercial_id, commercial_name, status, total, note, payment_declared, acompte, acompte_method, source_page, status_at, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?, 'nouvelle', ?, ?, ?, ?, ?, ?, ?, ?)`,
                [number, today, planned_date, client.name, client.phone || null, client.address, client.time || null, fee,
                 req.session.user.id, req.session.user.full_name || req.session.user.username, total, note || null, payment_declared, acompte, acompte_method, source_page, Date.now(), now]);
            for (const l of lines)
                await dbRun(`INSERT INTO delivery_items (delivery_id, product_id, product_name, quantity, unit_price, catalog_price, color, upgrade_note) VALUES (?,?,?,?,?,?,?,?)`,
                    [d.lastID, l.product_id, l._name, l._qty, l._price, l._catalog, (l.color || '').trim() || null, (l.upgrade_note || '').trim() || null]);
            return { deliveryId: d.lastID, number };
        });
        logActivity(req, 'delivery_create', 'delivery', deliveryId, { number, total, below_catalog: below.length ? below : undefined });
        if (below.length)
            pushNotification({ target_role: 'admin', type: 'warn', title: `Livraison #${number} : prix sous la fiche`,
                message: `${req.session.user.full_name || req.session.user.username} — ${below.join(' ; ')}`, link: '/deliveries.html',
                data: { delivery_id: deliveryId }, ref: `delivery:${deliveryId}:below_price` });
        const rqId = parseInt(req.body.client_request_id, 10);
        if (rqId) {
            const ch = await dbRun(`UPDATE client_requests SET status = 'commandee', delivery_id = ?, updated_at = ? WHERE id = ? AND (commercial_id = ? OR ? = 'admin')`,
                [deliveryId, now, rqId, req.session.user.id, req.session.user.role]);
            if (ch.changes) { resolveNotifs(`client_request:${rqId}`); broadcast('client-request:update', { id: rqId }); }
        }
        pushNotification({ target_role: 'coordinateur', type: 'info', title: 'Nouvelle livraison à assigner',
            message: `Livraison #${number} — ${client.name} · ${Math.round(total)} Ar`, link: '/coordination.html',
            data: { delivery_id: deliveryId }, ref: `delivery:${deliveryId}:assign` });
        broadcast('delivery:update', { id: deliveryId });
        res.json({ success: true, delivery_id: deliveryId, number });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Commercial en ligne : déclarer la méthode d'un paiement « déjà reçu » (espèces ou mobile money),
// juste après la création. Purement déclaratif — la caisse le confirme à la facturation avant toute
// entrée en caisse. Mobile money : n° de l'expéditeur obligatoire, référence facultative.
app.post('/api/deliveries/:id/declared-payment', requireAuth, requireRole('commercial_ligne'), async (req, res) => {
    try {
        const d = await dbGet('SELECT id, commercial_id, payment_declared, status FROM deliveries WHERE id = ?', [req.params.id]);
        if (!d) return res.status(404).json({ error: 'Commande introuvable' });
        if (d.commercial_id !== req.session.user.id) return res.status(403).json({ error: 'Commande d\'un autre commercial' });
        if (d.payment_declared !== 'paye') return res.status(400).json({ error: 'Commande non déclarée comme déjà payée' });
        const method = String(req.body.paid_method || '').trim();
        if (method !== 'especes' && method !== 'virement' && !MM_METHODS.includes(method)) return res.status(400).json({ error: 'Méthode de paiement invalide (espèces, mobile money ou virement)' });
        let phone = null, ref = null;
        if (method === 'virement') ref = String(req.body.paid_ref || '').trim() || null;   // réf. du virement (facultative)
        if (MM_METHODS.includes(method)) {
            phone = String(req.body.paid_phone || '').trim();
            if (!phone) return res.status(400).json({ error: 'Numéro de l\'expéditeur obligatoire pour un paiement mobile money' });
            ref = String(req.body.paid_ref || '').trim() || null;
        }
        await dbRun(`UPDATE deliveries SET paid_method = ?, paid_phone = ?, paid_ref = ? WHERE id = ?`, [method, phone, ref, d.id]);
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/deliveries', requireAuth, requireRole('commercial_ligne', 'coordinateur', 'caisse', 'gestion_stock'), async (req, res) => {
    try {
        const me = req.session.user;
        let w = '1=1', p = [];
        // Rôles larges d'abord (voient plus) ; commercial_ligne en dernier (scopé à ses propres commandes)
        // afin qu'un compte cumulant p.ex. coordinateur + commercial_ligne garde la vue la plus large.
        // NB : cet endpoint alimente l'onglet « En cours » (l'historique a sa propre route). L'admin est
        // donc scopé aux livraisons ACTIVES — sinon les 638 livraisons (dont l'historique livrée/retournée)
        // saturaient le LIMIT et masquaient les vieilles commandes encore « à sortir » (facturée non sortie).
        if (me.role === 'admin')             { w = "status NOT IN ('livree','retournee')"; }
        else if (hasRole(me, 'coordinateur')){ w = "status NOT IN ('livree','retournee')"; }
        else if (hasRole(me, 'caisse'))      { w = "status IN ('acceptee','facturee','en_livraison','annulee')"; }
        // Le gestionnaire ne voit une annulation QUE si des unités sont réellement sorties (released_at)
        // et doivent revenir au stock. Une commande annulée avant sortie = rien à réceptionner.
        else if (hasRole(me, 'gestion_stock')){ w = "(status IN ('facturee','en_livraison') OR (status = 'annulee' AND released_at IS NOT NULL))"; }
        else if (hasRole(me, 'commercial_ligne')) { w = 'commercial_id = ?'; p = [me.id]; }
        // ?day=AAAA-MM-JJ : ajoute les livraisons LIVRÉES prévues ce jour-là (carte « Livraisons du jour »).
        // Le commercial en ligne voit déjà toutes ses commandes, livrées comprises.
        const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : null;
        if (day && !(w === 'commercial_id = ?')) { w = `(${w}) OR (status = 'livree' AND COALESCE(planned_date, delivery_date) = ?)`; p.push(day); }
        if (req.query.status) { w = `(${w}) AND status = ?`; p.push(req.query.status); }
        const rows = await dbAll(
            `SELECT d.*,
                (SELECT GROUP_CONCAT(di.quantity || '× ' || di.product_name, ' · ')
                 FROM delivery_items di WHERE di.delivery_id = d.id) AS items_summary,
                (SELECT GROUP_CONCAT(di.product_name || ' : ' || di.upgrade_note, ' · ')
                 FROM delivery_items di WHERE di.delivery_id = d.id AND di.upgrade_note IS NOT NULL) AS upgrade_notes,
                (SELECT GROUP_CONCAT(di.serial, ' ') FROM delivery_items di WHERE di.delivery_id = d.id AND di.serial IS NOT NULL) AS serials_concat,
                (SELECT GROUP_CONCAT(di.product_name || ' → ' || pp.emplacement, ' · ')
                 FROM delivery_items di LEFT JOIN products pp ON pp.id = di.product_id
                 WHERE di.delivery_id = d.id AND pp.emplacement IS NOT NULL AND pp.emplacement <> '') AS emplacement_concat,
                (SELECT GROUP_CONCAT(TRIM(COALESCE(pp.brand,'') || ' ' || COALESCE(pp.model,'') || ' ' || COALESCE(pp.cpu,'') || ' ' || COALESCE(pp.ram,'') || ' ' || COALESCE(pp.storage,'')), ' · ')
                 FROM delivery_items di LEFT JOIN products pp ON pp.id = di.product_id WHERE di.delivery_id = d.id) AS config_concat
             FROM deliveries d WHERE ${w} ORDER BY d.priority DESC, d.created_at DESC LIMIT 1000`, p);
        // Responsable stock : quantité restante au dépôt par produit (sortie à valider / en livraison),
        // pour anticiper le réassort. Reste = unités au dépôt − celles déjà promises à des livraisons
        // facturées pas encore sorties (la commande affichée comprise).
        if (me.role === 'admin' || hasRole(me, 'gestion_stock')) {
            const active = rows.filter(d => d.status === 'facturee' || d.status === 'en_livraison');
            if (active.length) {
                const items = await dbAll(
                    `SELECT di.delivery_id, di.product_id, MAX(di.product_name) AS product_name, p.is_accessory
                     FROM delivery_items di JOIN products p ON p.id = di.product_id
                     WHERE di.delivery_id IN (${active.map(() => '?').join(',')}) AND (p.is_service = 0 OR p.is_service IS NULL)
                     GROUP BY di.delivery_id, di.product_id`, active.map(d => d.id));
                const pids = [...new Set(items.map(i => i.product_id))];
                const stock = new Map();
                if (pids.length) {
                    const ph = pids.map(() => '?').join(',');
                    const counts = await dbAll(
                        `SELECT p.id,
                            (SELECT COUNT(*) FROM stock_units su WHERE su.product_id = p.id AND su.status = 'stock') AS depot,
                            (SELECT COUNT(*) FROM stock_units su WHERE su.product_id = p.id AND su.status IN ('presentoir','consignation')) AS ailleurs,
                            (SELECT COUNT(*) FROM sale_items si JOIN deliveries dd ON dd.sale_id = si.sale_id
                             WHERE si.product_id = p.id AND si.unit_id IS NULL AND dd.status = 'facturee') AS pending
                         FROM products p WHERE p.id IN (${ph})`, pids);
                    counts.forEach(c => stock.set(c.id, c));
                }
                const settings = await getSettingsAsync();
                const threshold = Math.max(0, parseInt(settings.low_stock_threshold, 10) || 2);
                const byDelivery = new Map();
                items.forEach(i => {
                    const c = stock.get(i.product_id) || { depot: 0, ailleurs: 0, pending: 0 };
                    if (!byDelivery.has(i.delivery_id)) byDelivery.set(i.delivery_id, []);
                    byDelivery.get(i.delivery_id).push({ product_id: i.product_id, name: i.product_name, is_accessory: i.is_accessory ? 1 : 0,
                        depot: c.depot, ailleurs: c.ailleurs, pending: c.pending, remaining: Math.max(0, c.depot - c.pending) });
                });
                active.forEach(d => { d.stock_left = byDelivery.get(d.id) || []; });
                return res.json({ now: Date.now(), deliveries: rows, low_stock_threshold: threshold });
            }
        }
        res.json({ now: Date.now(), deliveries: rows });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Historique des livraisons — scopé par rôle + filtres (défini avant /:id).
app.get('/api/deliveries/history', requireAuth, requireRole('commercial_ligne', 'coordinateur', 'caisse', 'gestion_stock'), async (req, res) => {
    try {
        const me = req.session.user;
        const w = [], p = [];
        // Un commercial en ligne « pur » ne voit que ses commandes ; un rôle plus large voit tout.
        if (hasRole(me, 'commercial_ligne') && !hasRole(me, 'coordinateur', 'caisse', 'gestion_stock') && me.role !== 'admin') { w.push('d.commercial_id = ?'); p.push(me.id); }
        const { from, to, livreur_name, commercial_id, status, q } = req.query;
        if (from)          { w.push('date(d.created_at) >= date(?)'); p.push(from); }
        if (to)            { w.push('date(d.created_at) <= date(?)'); p.push(to); }
        if (livreur_name)  { w.push('d.livreur_name = ?'); p.push(livreur_name); }
        if (commercial_id) { w.push('d.commercial_id = ?'); p.push(commercial_id); }
        if (status)        { w.push('d.status = ?'); p.push(status); }
        if (q) {
            // Recherche LIBRE : client (nom/tél/adresse), n° de livraison, livreur, créateur (commercial),
            // et sur les articles (nom produit, config CPU/RAM/stockage/marque/modèle, n° de série local OU constructeur).
            w.push(`(d.client_name LIKE ? OR d.client_phone LIKE ? OR d.client_address LIKE ? OR CAST(d.delivery_number AS TEXT) LIKE ?
                     OR d.livreur_name LIKE ? OR d.commercial_name LIKE ?
                     OR EXISTS (SELECT 1 FROM delivery_items di LEFT JOIN stock_units u ON u.serial = di.serial LEFT JOIN products pp ON pp.id = di.product_id
                                WHERE di.delivery_id = d.id AND (di.product_name LIKE ? OR di.serial LIKE ? OR u.manufacturer_sn LIKE ?
                                     OR pp.brand LIKE ? OR pp.model LIKE ? OR pp.cpu LIKE ? OR pp.ram LIKE ? OR pp.storage LIKE ?)))`);
            const l = `%${q}%`; p.push(l, l, l, l, l, l, l, l, l, l, l, l, l, l);
        }
        const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
        const rows = await dbAll(
            `SELECT d.*,
                (SELECT GROUP_CONCAT(di.quantity || '× ' || di.product_name, ' · ') FROM delivery_items di WHERE di.delivery_id = d.id) AS items_summary
             FROM deliveries d ${where} ORDER BY d.created_at DESC LIMIT 500`, p);
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.get('/api/deliveries/:id', requireAuth, requireRole(...DELIVERY_ROLES), async (req, res) => {
    try {
        const d = await getDeliveryFull(req.params.id);
        if (!d) return res.status(404).json({ error: 'Livraison introuvable' });
        if (!ownsDeliveryOrBroader(req.session.user, d)) return res.status(403).json({ error: "Commande d'un autre commercial" });
        res.json(d);
    }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// Coordinateur : assigner un livreur (simple nom, aucun compte utilisateur requis).
// L'assignation envoie directement la commande à la caisse (plus d'étape « prise en charge »).
app.post('/api/deliveries/:id/assign', requireAuth, requireRole('coordinateur'), async (req, res) => {
    try {
        const liv_name = String(req.body.livreur_name || '').trim();
        const priority = req.body.priority;
        if (!liv_name) return res.status(400).json({ error: 'Nom du livreur requis' });

        const d = await dbGet('SELECT * FROM deliveries WHERE id = ?', [req.params.id]);
        if (!d || !['nouvelle', 'assignee', 'acceptee'].includes(d.status)) return res.status(400).json({ error: 'Livraison non assignable' });
        const claim = await dbRun(`UPDATE deliveries SET livreur_name = ?, coordinator_id = ?, coordinator_name = ?, priority = ?, status = 'acceptee', status_at = ?, stuck_notified = 0
             WHERE id = ? AND status IN ('nouvelle','assignee','acceptee')`,
            [liv_name, req.session.user.id, req.session.user.full_name || req.session.user.username, priority ? 1 : 0, Date.now(), d.id]);
        if (!claim.changes) return res.status(409).json({ error: 'Livraison déjà facturée/traitée (rafraîchissez).' });
        resolveNotifs(`delivery:${d.id}:assign`);   // assignée : le coordinateur n'a plus rien à faire
        // Notification directe à la caisse
        pushNotification({ target_role: 'caisse', type: 'info', title: 'Livraison à facturer',
            message: `Livraison #${d.delivery_number} assignée à ${liv_name}.`, link: '/deliveries.html',
            data: { delivery_id: d.id }, ref: `delivery:${d.id}:invoice` });
        broadcast('delivery:update', { id: d.id });
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Étiquette 60×40 mm remise au livreur après assignation : elle est collée sur le colis
// et accompagne la commande jusqu'à la caisse.
app.get('/api/deliveries/:id/label', requireAuth, requireRole('coordinateur', 'caisse', 'commercial_ligne', 'gestion_stock'), async (req, res) => {
    try {
        const { d, items, total, notFound } = await getDeliveryLabelData(req.params.id);
        if (notFound) return res.status(404).send('Livraison introuvable');
        if (!d.livreur_name) return res.status(400).send('Livreur non assigné');

        const cc = await dbGet('SELECT name FROM company_config WHERE id = 1');
        const company = ((cc && cc.name) || '').trim();
        const dateStr = dateFR(d.planned_date || d.delivery_date) + (d.delivery_time ? ' · ' + d.delivery_time : '');
        // Statut de paiement réel une fois facturé (payment_status), sinon la déclaration du
        // commercial à la création (payment_declared) — c'est ce que le livreur doit savoir.
        const payState = d.payment_status || d.payment_declared || 'a_livraison';
        const isCOD = payState !== 'paye';

        // Étiquette 60×40 mm qui S'ADAPTE au contenu : les coordonnées du client (nom, téléphone, adresse
        // complète) ne sont JAMAIS coupées. Au rendu, un script réduit d'abord la taille du texte, puis
        // résume les derniers articles (« + N autre(s) »), et réduit encore si nécessaire.
        const itemsHtml = items.map(it => {
            const serials = it.serial ? it.serial.split(',').map(x => x.trim()).filter(Boolean) : [];
            const snRow = serials.length ? `<div class="itc">SN : ${htmlEsc(serials.join(', '))}</div>` : '';
            const colorTxt = it.color ? ` (${htmlEsc(it.color)})` : '';
            const upgTxt = it.upgrade_note ? `<div class="itc b">⚙ Upgrade : ${htmlEsc(it.upgrade_note)}</div>` : '';
            return `<div class="it"><div class="itn">${it.quantity}× ${htmlEsc(it.product_name || '')}${colorTxt} — ${arNum(it.unit_price)} Ar</div>${snRow}${upgTxt}</div>`;
        }).join('');
        const due = isCOD ? Math.max(0, total - (parseFloat(d.acompte) || 0)) : 0;

        const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><title>Étiquette livraison #${d.delivery_number}</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  @page{size:60mm 40mm;margin:0;}
  html,body{width:60mm;height:40mm;}
  body{font-family:Arial,Helvetica,sans-serif;color:#000;background:#fff;--k:1;}
  .lbl{width:60mm;height:40mm;padding:1.2mm 1.5mm;display:flex;flex-direction:column;overflow:hidden;line-height:1.15;}
  .top{display:flex;justify-content:space-between;align-items:baseline;gap:1mm;border-bottom:.3mm solid #000;padding-bottom:.4mm;}
  .co{font-size:calc(8.5px*var(--k));font-weight:700;text-transform:uppercase;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-width:0;}
  .num{font-size:calc(12px*var(--k));font-weight:800;white-space:nowrap;}
  .dt{font-size:calc(7.5px*var(--k));text-align:right;margin-top:.2mm;}
  .cli{font-size:calc(10px*var(--k));font-weight:800;margin-top:.3mm;overflow-wrap:anywhere;}
  .tel{font-size:calc(10px*var(--k));font-weight:800;}
  .adr{font-size:calc(8px*var(--k));margin-top:.2mm;overflow-wrap:anywhere;white-space:pre-line;}
  .items{font-size:calc(7.2px*var(--k));margin-top:.4mm;border-top:.2mm dotted #000;padding-top:.3mm;flex:1 1 auto;min-height:0;overflow:hidden;}
  .it{margin-bottom:.3mm;}
  .itn{font-weight:700;overflow-wrap:anywhere;}
  .itc{color:#222;overflow-wrap:anywhere;} .b{font-weight:700;}
  .bot{display:flex;justify-content:space-between;align-items:flex-end;gap:1mm;border-top:.3mm solid #000;padding-top:.4mm;margin-top:.3mm;flex-shrink:0;}
  .liv{font-size:calc(6.2px*var(--k));text-transform:uppercase;}
  .livn{font-size:calc(8.5px*var(--k));font-weight:800;overflow-wrap:anywhere;}
  .tot{text-align:right;white-space:nowrap;}
  .totl{font-size:calc(6.2px*var(--k));}
  .totv{font-size:calc(9px*var(--k));font-weight:800;}
  .cod{background:#000;color:#fff;text-align:center;font-size:calc(7.2px*var(--k));font-weight:800;padding:.4mm;margin-top:.3mm;letter-spacing:.2px;flex-shrink:0;}
  .head,.cliw{flex-shrink:0;}
</style></head>
<body>
  <div class="lbl" id="lbl">
    <div class="head">
      <div class="top">
        <div class="co">${htmlEsc(company || 'Bon de livraison')}</div>
        <div class="num">#${d.delivery_number}</div>
      </div>
      <div class="dt">${htmlEsc(dateStr)}</div>
    </div>
    <div class="cliw">
      <div class="cli">${htmlEsc(d.client_name || '')}${d.client_phone ? ` · <span class="tel">${htmlEsc(d.client_phone)}</span>` : ''}</div>
      ${d.client_address ? `<div class="adr">📍 ${htmlEsc(d.client_address)}</div>` : ''}
    </div>
    <div class="items" id="items">
      ${itemsHtml}
      <div class="it itc b" id="more" style="display:none;"></div>
      ${parseFloat(d.delivery_fee) ? `<div class="it itc b">Frais de livraison : ${arNum(d.delivery_fee)} Ar</div>` : ''}
    </div>
    <div class="bot">
      <div style="min-width:0;">
        <div class="liv">Livreur</div>
        <div class="livn">${htmlEsc(d.livreur_name)}</div>
      </div>
      <div class="tot">
        <div class="totl">TOTAL${!isCOD ? ' (payé)' : ''}</div>
        <div class="totv">${arNum(total)} Ar</div>
      </div>
    </div>
    ${isCOD ? `<div class="cod">⚠ À ENCAISSER : ${arNum(due)} Ar</div>` : ''}
  </div>
  <script>
  (function () {
    var lbl = document.getElementById('lbl'), box = document.getElementById('items'), more = document.getElementById('more');
    var its = [].slice.call(box.querySelectorAll('.it')).filter(function (e) { return e.querySelector('.itn'); });
    var setK = function (k) { document.body.style.setProperty('--k', k); };
    var over = function () { return lbl.scrollHeight > lbl.clientHeight + 1 || box.scrollHeight > box.clientHeight + 1; };
    var k = 1;
    while (over() && k > 0.8) { k = Math.round((k - 0.05) * 100) / 100; setK(k); }
    var hidden = 0;
    while (over() && its.length - hidden > 1) {
      hidden++; its[its.length - hidden].style.display = 'none';
      more.style.display = ''; more.textContent = '+ ' + hidden + ' autre(s) article(s)';
    }
    while (over() && k > 0.55) { k = Math.round((k - 0.05) * 100) / 100; setK(k); }
    window.onload = function () { window.print(); };
  })();
  <\/script>
</body></html>`;
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (e) { res.status(500).send('Erreur étiquette : ' + e.message); }
});
// Résumé texte de la commande : le commercial le copie et l'envoie au client (Messenger).
app.get('/api/deliveries/:id/summary', requireAuth, requireRole(...DELIVERY_ROLES), async (req, res) => {
    try {
        const { d, items, total, notFound } = await getDeliveryLabelData(req.params.id);
        if (notFound) return res.status(404).json({ error: 'Livraison introuvable' });
        if (!ownsDeliveryOrBroader(req.session.user, d)) return res.status(403).json({ error: "Commande d'un autre commercial" });

        const L = [];
        L.push(`Commande #${d.delivery_number} — ${dateFR(d.delivery_date)}`);
        L.push('');
        L.push(`Nom : ${d.client_name}`);
        L.push(`Contact : ${d.client_phone || '—'}`);
        L.push('');
        items.forEach(it => {
            const q = parseInt(it.quantity, 10) || 1;
            L.push(`${it.product_name} ${q} ${q > 1 ? 'pièces' : 'pièce'} = ${arNum(q * it.unit_price)} Ar`);
        });
        L.push('');
        L.push(`Frais de livraison : ${arNum(d.delivery_fee)} Ar`);
        L.push(`Total : ${arNum(total)} Ar`);
        L.push('');
        L.push(`Lieu de livraison : ${d.client_address}`);
        L.push(`Date de livraison : ${dateFR(d.planned_date || d.delivery_date)}${d.delivery_time ? ' à ' + d.delivery_time : ''}`);
        res.json({ summary: L.join('\n') });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Caisse : facturer (choisir les séries, définir le paiement).
app.post('/api/deliveries/:id/invoice', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const { payment } = req.body;
        // « avance » : le client verse une partie maintenant (encaissée ce jour), le reste à la livraison.
        const withAvance = req.body.payment_status === 'avance';
        const payment_status = withAvance ? 'a_livraison' : req.body.payment_status;
        if (!['paye', 'a_livraison'].includes(payment_status)) return res.status(400).json({ error: 'Statut de paiement invalide' });
        const d = await getDeliveryFull(req.params.id);
        if (!d || d.status !== 'acceptee') return res.status(400).json({ error: 'Livraison non facturable' });
        // Acompte déclaré par le commercial : la caisse confirme qu'il est reçu (« Avance ») ou le refuse
        // explicitement (acompte_refused) — un acompte non validé n'est plus jamais déduit.
        const declaredAcompte = !d.acompte_paid && (d.acompte || 0) > 0;
        if (declaredAcompte && payment_status === 'a_livraison' && !withAvance && !req.body.acompte_refused)
            return res.status(400).json({ error: `Acompte déclaré (${Math.round(d.acompte).toLocaleString('fr-FR')} Ar) : confirmez qu'il est reçu (« Acompte reçu ») ou indiquez qu'il ne l'est pas.` });
        let avance = null;
        if (withAvance) {
            const tot = d.items.reduce((x, it) => x + (it.unit_price || 0) * it.quantity, 0);
            const amt = Array.isArray(payment && payment.payments) ? payment.payments.reduce((x, p) => x + Math.round(parseFloat(p.amount) || 0), 0) : 0;
            if (amt <= 0) return res.status(400).json({ error: 'Montant de l\'avance requis' });
            if (amt >= tot) return res.status(400).json({ error: 'L\'avance doit être inférieure au total (sinon « Déjà payé »)' });
            const ap = normalizePayments(payment, amt);
            if (ap.error) return res.status(400).json({ error: ap.error });
            const settings = await getSettingsAsync();
            const dueDate = addDays(getDate(), Math.max(1, parseInt(settings.layaway_max_days, 10) || 30));
            const nextDate = String(req.body.next_payment_date || '').trim();
            const nd = checkNextPaymentDate(nextDate, getDate(), dueDate);
            if (nd) return res.status(400).json({ error: nd });
            avance = { lines: ap.lines, amount: amt, primary: ap.primary, dueDate, nextDate };
        }

        const now = getDateTime(), today = getDate();
        const total = d.items.reduce((s, it) => s + (it.unit_price || 0) * it.quantity, 0);
        // Paiement (mixte possible) si payé maintenant ; sinon « à la livraison » (méthode définie au /complete).
        let payLines = null, payPrimary = null, payFirst = { ref: null, phone: null };
        if (payment_status === 'paye') {
            const pay = normalizePayments(payment, total);
            if (pay.error) return res.status(400).json({ error: pay.error });
            payLines = pay.lines; payPrimary = pay.primary; payFirst = pay.first;
        }

        // Écriture ATOMIQUE et sérialisée : contrôle du stock, transition « facturée », vente, lignes,
        // paiements et avance — deux factures simultanées ne peuvent plus se réserver la même pièce.
        const saleId = await withTx(async () => {
        // Réserve d'abord la transition (empêche une double-facturation concurrente) ; annulée si le stock manque.
        const claim = await dbRun(`UPDATE deliveries SET status = 'facturee', status_at = ?, stuck_notified = 0 WHERE id = ? AND status = 'acceptee'`, [Date.now(), d.id]);
        if (!claim.changes) throw txError(409, 'Livraison déjà facturée ou non facturable (rafraîchissez).');
        // Vérifie qu'il y a assez de stock, SANS choisir de série précise :
        // ce sera le gestionnaire du stock qui scannera les vraies unités à la sortie.
        // Disponibilité = dépôt (stock/présentoir) + boutique − réservations déjà FACTURÉES non encore
        // sorties (lignes placeholder unit_id NULL) : évite que deux commandes se réservent la même pièce.
        for (const it of d.items) {
            if (it.is_service) continue;   // service (illimité, sans stock) : rien à réserver
            const avail = await dbGet(`SELECT COUNT(*) AS n FROM stock_units WHERE product_id = ? AND status IN ('stock','presentoir','consignation')`, [it.product_id]);
            const reserved = await dbGet(
                `SELECT COUNT(*) AS n FROM sale_items si JOIN deliveries dd ON dd.sale_id = si.sale_id
                 WHERE si.product_id = ? AND si.unit_id IS NULL AND (si.is_service = 0 OR si.is_service IS NULL) AND dd.status = 'facturee' AND dd.id <> ?`, [it.product_id, d.id]);
            const free = (avail.n || 0) - (reserved.n || 0);
            if (free < it.quantity)
                throw txError(400, `Stock insuffisant pour « ${it.product_name} » (${free}/${it.quantity} disponibles après réservations de livraison en cours).`);
        }

        // Vente (canal livraison, non comptée tant que non livrée).
        const saleNumber = await nextSaleNumber(today);
        const sale = await dbRun(
            `INSERT INTO sales (sale_number, sale_date, client_name, client_phone, client_address, commercial_id, commercial_name, cashier_id, cashier_name, total, payment_method, payment_ref, payment_phone, channel, status, note, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'livraison', 'en_livraison', ?, ?)`,
            [saleNumber, today, d.client_name, d.client_phone, d.client_address, d.commercial_id, d.commercial_name,
             req.session.user.id, req.session.user.full_name || req.session.user.username, total,
             payPrimary, payFirst.ref, payFirst.phone, `Livraison #${d.delivery_number}`, now]);
        const saleId = sale.lastID;
        if (payLines) await recordSalePayments(saleId, payLines, now);
        // Lignes de vente : produits physiques → placeholders SANS n° de série (une par unité
        // commandée ; le gestionnaire renseignera les séries réelles à la sortie/release).
        // Services (is_service) → ligne définitive sans unité ni décompte de stock : jamais de série.
        for (const it of d.items) {
            for (let k = 0; k < it.quantity; k++) {
                if (it.is_service) {
                    await dbRun(`INSERT INTO sale_items (sale_id, unit_id, serial, product_id, product_name, unit_price, is_service) VALUES (?, NULL, NULL, ?, ?, ?, 1)`,
                        [saleId, it.product_id, it.product_name, it.unit_price || 0]);
                } else {
                    await dbRun(`INSERT INTO sale_items (sale_id, unit_id, serial, product_id, product_name, unit_price, color) VALUES (?, NULL, NULL, ?, ?, ?, ?)`,
                        [saleId, it.product_id, it.product_name, it.unit_price || 0, it.color || null]);
                }
            }
        }
        // Statut déjà passé à 'facturee' (claim atomique) — on renseigne le reste.
        await dbRun(`UPDATE deliveries SET payment_status = ?, sale_id = ?, total = ? WHERE id = ?`, [payment_status, saleId, total, d.id]);
        // Acompte déclaré non reçu (ou tout payé maintenant) : il disparaît, le client paie tout.
        if (declaredAcompte && !avance) await dbRun(`UPDATE deliveries SET acompte = 0, acompte_method = NULL WHERE id = ?`, [d.id]);
        if (avance) {
            // Part de l'avance = acompte déjà déclaré par le commercial → datée du jour de la commande ;
            // le surplus éventuel (versé à la caisse aujourd'hui) reste daté d'aujourd'hui.
            let declared = (!d.acompte_paid && d.payment_declared === 'a_livraison') ? Math.max(0, Math.round(d.acompte || 0)) : 0;
            const ins = (l, amount, day) => dbRun(`INSERT INTO delivery_payments (delivery_id, method, amount, phone, ref, sale_date, created_at, next_date, cashier_name) VALUES (?,?,?,?,?,?,?,?,?)`,
                [d.id, l.method, amount, l.phone, l.ref, day, now, avance.nextDate, req.session.user.full_name || req.session.user.username]);
            for (const l of avance.lines) {
                const early = Math.min(declared, l.amount); declared -= early;
                if (early > 0) await ins(l, early, acompteDay(d));
                if (l.amount - early > 0) await ins(l, l.amount - early, today);
            }
            await dbRun(`UPDATE deliveries SET acompte = ?, acompte_method = ?, acompte_paid = 1, avance_due_date = ?, avance_next_date = ? WHERE id = ?`,
                [avance.amount, avance.primary, avance.dueDate, avance.nextDate, d.id]);
        }
        return saleId;
        });
        if (avance) logActivity(req, 'delivery_avance', 'delivery', d.id, { number: d.delivery_number, amount: avance.amount, next_payment_date: avance.nextDate });
        else if (declaredAcompte) logActivity(req, 'delivery_acompte_refuse', 'delivery', d.id, { number: d.delivery_number, declared: d.acompte, payment_status });
        resolveNotifs(`delivery:${d.id}:invoice`);   // facturée : la caisse a fait sa part
        pushNotification({ target_role: 'gestion_stock', type: 'info', title: 'Sortie à valider (livraison)',
            message: `Livraison #${d.delivery_number} facturée — validez la sortie du stock.`, link: '/deliveries.html',
            data: { delivery_id: d.id }, ref: `delivery:${d.id}:release` });
        broadcast('delivery:update', { id: d.id }); broadcast('stock:update', {});
        res.json({ success: true, sale_id: saleId, sale: await getSaleFull(saleId), avance_doc: avance ? await getDeliveryAvanceDoc(d.id) : null });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Livraisons avec avance en cours (page Engagements > Avances).
app.get('/api/delivery-avances', requireAuth, requireRole('caisse', 'gestion_stock', 'commercial', 'commercial_ligne'), async (req, res) => {
    try {
        const me = req.session.user, w = [DELIVERY_AVANCE_OPEN], p = [];
        if (commercialView(me)) { w.push('commercial_id = ?'); p.push(me.id); }
        res.json(await dbAll(`SELECT d.id, d.delivery_number, d.client_name, d.client_phone, d.commercial_name, d.livreur_name, d.status, d.total, d.acompte,
                d.avance_due_date, d.avance_next_date, d.planned_date,
                (SELECT GROUP_CONCAT(di.quantity || '× ' || di.product_name, ' · ') FROM delivery_items di WHERE di.delivery_id = d.id) AS items_summary
             FROM deliveries d WHERE ${w.join(' AND ')} ORDER BY COALESCE(d.avance_next_date, d.avance_due_date)`, p));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.get('/api/deliveries/:id/avance-doc', requireAuth, requireRole('caisse', 'gestion_stock', 'commercial', 'commercial_ligne'), async (req, res) => {
    try {
        const doc = await getDeliveryAvanceDoc(req.params.id);
        if (!doc || !doc.payments.length) return res.status(404).json({ error: 'Aucune avance sur cette livraison' });
        res.json(doc);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// Versement supplémentaire sur une livraison avec avance (avant la livraison).
app.post('/api/deliveries/:id/avance-pay', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const d = await dbGet(`SELECT * FROM deliveries WHERE id = ? AND ${DELIVERY_AVANCE_OPEN}`, [req.params.id]);
        if (!d) return res.status(400).json({ error: 'Livraison avec avance non disponible' });
        const balance = Math.max(0, (d.total || 0) - (d.acompte || 0));
        const amount = Array.isArray(req.body.payment && req.body.payment.payments)
            ? req.body.payment.payments.reduce((x, p) => x + Math.round(parseFloat(p.amount) || 0), 0) : 0;
        if (amount <= 0) return res.status(400).json({ error: 'Montant requis' });
        if (amount >= balance) return res.status(400).json({ error: 'Ce versement règle tout le reste : encaissez-le à la livraison.' });
        const dp = normalizePayments(req.body.payment, amount);
        if (dp.error) return res.status(400).json({ error: dp.error });
        const now = getDateTime(), today = getDate();
        const nextDate = String(req.body.next_payment_date || '').trim();
        const nd = checkNextPaymentDate(nextDate, today, d.avance_due_date);
        if (nd) return res.status(400).json({ error: nd });
        await withTx(async () => {
            for (const l of dp.lines)
                await dbRun(`INSERT INTO delivery_payments (delivery_id, method, amount, phone, ref, sale_date, created_at, next_date, cashier_name) VALUES (?,?,?,?,?,?,?,?,?)`,
                    [d.id, l.method, l.amount, l.phone, l.ref, today, now, nextDate, req.session.user.full_name || req.session.user.username]);
            await dbRun('UPDATE deliveries SET acompte = acompte + ?, avance_next_date = ? WHERE id = ?', [amount, nextDate, d.id]);
        });
        resolveNotifs(`delivery_avance_late:${d.id}`);
        logActivity(req, 'delivery_avance_pay', 'delivery', d.id, { number: d.delivery_number, amount, next_payment_date: nextDate });
        broadcast('delivery:update', { id: d.id }); broadcast('layaway:update', {});
        res.json({ success: true, doc: await getDeliveryAvanceDoc(d.id) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Gestionnaire : valider la sortie du stock EN SCANNANT les vraies unités.
// Le gestionnaire fournit les n° de série (locaux ou constructeur) des pièces qui sortent
// physiquement ; on les rattache aux lignes de vente (placeholders) créées à la facturation.
app.post('/api/deliveries/:id/release', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const d = await dbGet('SELECT * FROM deliveries WHERE id = ?', [req.params.id]);
        if (!d || d.status !== 'facturee') return res.status(400).json({ error: 'Livraison non prête à sortir' });
        const serials = Array.isArray(req.body.serials) ? req.body.serials.map(s => String(s || '').trim()).filter(Boolean) : [];
        // N° de série UNIQUES (ordinateurs ET accessoires étiquetés à l'unité) : un même n° ne sort qu'une fois.
        { const seen = new Set(); for (const sr of serials) { if (parseAccCode(sr)) continue; const k = sr.toUpperCase();
            if (seen.has(k)) return res.status(400).json({ error: `N° de série « ${sr} » scanné deux fois : chaque article a son propre n°.` }); seen.add(k); } }
        const now = getDateTime();

        // Sélection des unités ET écriture dans la MÊME transaction (exclusive) : deux sorties simultanées
        // (ex. le même accessoire générique « A000… » sur deux livraisons) ne peuvent plus retenir la même unité.
        await withTx(async () => {
            // Lignes de vente à remplir (placeholders sans unité) — hors services (sans stock, jamais de série).
            const slots = await dbAll(`SELECT id, product_id FROM sale_items WHERE sale_id = ? AND unit_id IS NULL AND (is_service = 0 OR is_service IS NULL)`, [d.sale_id]);
            // Commande 100 % services : rien ne sort physiquement du stock, aucune série à scanner.
            if (slots.length && !serials.length) throw txError(400, 'Scannez les numéros de série des articles à sortir');
            if (serials.length !== slots.length)
                throw txError(400, `${serials.length} série(s) scannée(s) pour ${slots.length} article(s) attendu(s).`);

            const assigned = [];   // { slotId, unit }
            const usedUnitIds = new Set();
            for (const serial of serials) {
                // Accepte une unité du dépôt (stock/présentoir) OU de la boutique (consignation) :
                // tout produit vendable est livrable ; la caisse/le stock sait d'où il sort.
                let u;
                const accId = parseAccCode(serial);
                const used = [...usedUnitIds];
                const notIn = used.length ? ` AND id NOT IN (${used.map(() => '?').join(',')})` : '';
                if (accId) {
                    // Accessoire générique (serial NULL) : chaque scan du code de modèle sort UNE unité
                    // différente. Les anciens accessoires étiquetés se scannent par leur propre n° de série.
                    u = await dbGet(
                        `SELECT * FROM stock_units WHERE product_id = ? AND serial IS NULL AND status IN ('stock','presentoir','consignation')${notIn}
                         ORDER BY CASE status WHEN 'stock' THEN 0 WHEN 'presentoir' THEN 1 ELSE 2 END, id LIMIT 1`,
                        [accId, ...used]);
                    if (!u) throw txError(400, `Accessoire « ${serial} » : plus d'unité générique disponible (scannez l'étiquette individuelle).`);
                    // L'unité générique n'a pas de serial propre → on lui donne le code de modèle partagé
                    // pour qu'il apparaisse dans la vente, la livraison et l'historique (au lieu d'un blanc).
                    u.serial = accCode(u.product_id);
                } else {
                    // Vrais n° de série (accessoires étiquetés inclus) : on exclut les unités déjà retenues
                    // pour ce scan afin de pouvoir en sortir DEUX identiques à la suite.
                    u = await dbGet(
                        `SELECT * FROM stock_units WHERE (serial = ? OR manufacturer_sn = ?) AND status IN ('stock','presentoir','consignation')${notIn}
                         ORDER BY CASE status WHEN 'stock' THEN 0 WHEN 'presentoir' THEN 1 ELSE 2 END, id LIMIT 1`,
                        [serial, serial, ...used]);
                    if (!u) throw txError(400, `N° de série « ${serial} » introuvable ou déjà sorti (vendu / livraison).`);
                }
                // Un slot libre du même produit ?
                const slot = slots.find(s => s.product_id === u.product_id && !assigned.some(a => a.slotId === s.id));
                if (!slot) throw txError(400, `« ${serial} » ne correspond à aucun produit de cette commande (ou déjà complété).`);
                assigned.push({ slotId: slot.id, unit: u });
                usedUnitIds.add(u.id);
            }

            // Réserve la transition de façon ATOMIQUE (évite une double-sortie concurrente).
            const claim = await dbRun(`UPDATE deliveries SET status = 'en_livraison', released_at = ?, status_at = ?, stuck_notified = 0 WHERE id = ? AND status = 'facturee'`, [Date.now(), Date.now(), d.id]);
            if (!claim.changes) throw txError(409, 'Sortie déjà validée (rafraîchissez).');

            for (const { slotId, unit } of assigned) {
                const up = await dbRun(`UPDATE stock_units SET status = 'livraison', holder_user_id = NULL, updated_at = ? WHERE id = ? AND status = ?`, [now, unit.id, unit.status]);
                if (up.changes !== 1) throw txError(409, `« ${unit.serial} » vient d'être sorti par ailleurs — rescannez.`);
                await dbRun(`UPDATE sale_items SET unit_id = ?, serial = ? WHERE id = ?`, [unit.id, unit.serial, slotId]);
                await dbRun(`UPDATE delivery_items SET serial = COALESCE(serial || ', ', '') || ? WHERE delivery_id = ? AND product_id = ? AND (serial IS NULL OR serial NOT LIKE '%' || ? || '%')`,
                    [unit.serial, d.id, unit.product_id, unit.serial]);
                const src = unit.status === 'consignation' ? 'boutique' : 'dépôt';
                await recordMovement(unit, 'livraison', 'livraison_sortie', req, { from: unit.status, ref_type: 'delivery', ref_id: d.id, note: `Livraison #${d.delivery_number} — livreur ${d.livreur_name || '—'} · sorti du ${src}` });
            }
        });
        resolveNotifs(`delivery:${d.id}:release`);   // sortie validée : le gestionnaire a fait sa part
        pushNotification({ target_role: 'securite', type: 'info', title: 'Livraison à contrôler', message: `Livraison #${d.delivery_number} sortie du stock — livreur ${d.livreur_name || '—'} : contrôlez la sortie à la porte.`, link: '/controle-sortie.html', data: { delivery_id: d.id } });
        pushNotification({ target_role: 'caisse', type: 'info', title: 'Livraison en cours', message: `Livraison #${d.delivery_number} sortie du stock — à confirmer une fois livrée.`, link: '/deliveries.html', data: { delivery_id: d.id }, ref: `delivery:${d.id}:complete` });
        broadcast('delivery:update', { id: d.id }); broadcast('stock:update', {});
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Caisse : livraison terminée (payée & confirmée).
app.post('/api/deliveries/:id/complete', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const d = await dbGet('SELECT * FROM deliveries WHERE id = ?', [req.params.id]);
        if (!d || d.status !== 'en_livraison') return res.status(400).json({ error: 'Livraison non en cours' });
        const now = getDateTime();
        // 1) Valide upgrades + paiement AVANT toute écriture (méthode unique ou mixte).
        //    Un acompte déjà versé réduit le RESTE ; l'écart des upgrades s'AJOUTE à encaisser.
        let pay = null, acompte = 0;
        // Upgrades réalisés par la caisse à la livraison (le PC est connu depuis la sortie du stock).
        const pcUnits = await dbAll(
            `SELECT u.id, p.is_accessory FROM sale_items si JOIN stock_units u ON u.id = si.unit_id
             LEFT JOIN products p ON p.id = u.product_id WHERE si.sale_id = ? AND si.unit_id IS NOT NULL`, [d.sale_id]);
        const upg = await validateUpgrades(req.body.upgrades, pcUnits, true);
        if (upg.error) return res.status(400).json({ error: upg.error });

        // Livraison PARTIELLE : le client ne prend pas tous les articles. Les unités NON prises
        // reviennent au stock (réception validée par le gestionnaire) ; on n'encaisse que le gardé.
        const allItems = await dbAll('SELECT id, unit_id, serial, product_name, unit_price FROM sale_items WHERE sale_id = ? AND unit_id IS NOT NULL AND returned = 0', [d.sale_id]);
        const returnedIds = new Set((Array.isArray(req.body.returned_unit_ids) ? req.body.returned_unit_ids : []).map(Number).filter(Boolean));
        const returnedItems = allItems.filter(it => returnedIds.has(it.unit_id));
        const keptItems = allItems.filter(it => !returnedIds.has(it.unit_id));
        const hasReturns = returnedItems.length > 0;
        if (hasReturns && !keptItems.length) return res.status(400).json({ error: 'Aucun article gardé — utilisez plutôt l\'annulation de la livraison.' });
        if (hasReturns && d.payment_status === 'paye') return res.status(400).json({ error: 'Commande déjà payée : confirmez la livraison complète, puis traitez le retour depuis la page Ventes.' });
        // Les services (sans unité) sont toujours facturés, même en livraison partielle.
        const svcRow = await dbGet('SELECT COALESCE(SUM(unit_price), 0) AS t FROM sale_items WHERE sale_id = ? AND is_service = 1', [d.sale_id]);
        const servicesTotal = (svcRow && svcRow.t) || 0;
        const keptTotal = keptItems.reduce((s, it) => s + (it.unit_price || 0), 0) + servicesTotal;

        const saleRow = await dbGet('SELECT total FROM sales WHERE id = ?', [d.sale_id]);
        const saleTotal = (saleRow && saleRow.total) || d.total || 0;
        const effectiveTotal = hasReturns ? keptTotal : saleTotal;   // on n'encaisse que les articles gardés (+ services)
        acompte = Math.min(Math.max(0, d.acompte || 0), effectiveTotal);
        // À encaisser : reste (si à la livraison) + écart des upgrades (dû dans tous les cas).
        const base = d.payment_status === 'a_livraison' ? Math.max(0, effectiveTotal - acompte) : 0;
        const toCollect = base + (upg.total || 0);
        if (toCollect > 0) {
            pay = normalizePayments(req.body.payment, toCollect);
            if (pay.error) return res.status(400).json({ error: pay.error });
        }
        // 2) Tout le reste en UNE transaction : transition « livrée », paiements, unités, upgrades et
        //    re-datation de la vente — tout ou rien (plus de livraison « livrée » sans vente soldée).
        await withTx(async () => {
        const claim = await dbRun(`UPDATE deliveries SET status = 'livree', status_at = ? WHERE id = ? AND status = 'en_livraison'`, [Date.now(), d.id]);
        if (!claim.changes) throw txError(409, 'Livraison déjà confirmée (rafraîchissez).');
        // 3) Applique : paiement (acompte + reste + écart), upgrades, sortie des unités, vente soldée.
        if (pay || (d.payment_status === 'a_livraison' && acompte > 0)) {
            let lines;
            if (d.payment_status === 'a_livraison') {
                // Pas encore payée → on enregistre tout (acompte + reste + écart des upgrades).
                lines = [];
                // Avance encaissée par la caisse (delivery_payments, déjà en trésorerie) : non recomptée ici.
                if (acompte > 0 && !d.acompte_paid) {
                    await dbRun(`INSERT INTO delivery_payments (delivery_id, method, amount, phone, ref, sale_date, created_at, next_date, cashier_name) VALUES (?,?,?,?,?,?,?,?,?)`,
                        [d.id, d.acompte_method || 'especes', acompte, null, null, acompteDay(d), now, null, req.session.user.full_name || req.session.user.username]);
                    await dbRun('UPDATE deliveries SET acompte_paid = 1 WHERE id = ?', [d.id]);
                }
                if (pay) lines.push(...pay.lines);
                if (lines.length) {
                    const primary = pay ? pay.primary : (d.acompte_method || 'especes');
                    const first = pay ? pay.first : { ref: null, phone: null };
                    await dbRun(`UPDATE sales SET payment_method = ?, payment_ref = ?, payment_phone = ? WHERE id = ?`, [primary, first.ref, first.phone, d.sale_id]);
                }
            } else {
                // Déjà payée (marchandises) → on AJOUTE seulement l'écart des upgrades aux paiements existants.
                const existing = await dbAll('SELECT method, amount, phone, ref FROM sale_payments WHERE sale_id = ?', [d.sale_id]);
                lines = existing.concat(pay ? pay.lines : []);
            }
            if (lines.length) await recordSalePayments(d.sale_id, lines, now);
        }
        const items = await dbAll('SELECT id, unit_id FROM sale_items WHERE sale_id = ? AND unit_id IS NOT NULL', [d.sale_id]);
        for (const it of items) {
            const u = await dbGet('SELECT * FROM stock_units WHERE id = ?', [it.unit_id]);
            if (!u) continue;
            if (returnedIds.has(it.unit_id)) {
                // Article NON pris par le client → retour au stock (à réceptionner par le gestionnaire).
                await dbRun(`UPDATE stock_units SET status = 'retour_attente', holder_user_id = NULL, note = ?, updated_at = ? WHERE id = ?`, ['Non pris à la livraison', now, u.id]);
                await dbRun('UPDATE sale_items SET returned = 1 WHERE id = ?', [it.id]);
                await dbRun(`INSERT INTO sale_returns (sale_id, unit_id, serial, type, destination, refund_amount, reason, user_id, user_name, created_at)
                             VALUES (?,?,?, 'retour_stock', 'stock', 0, ?, ?, ?, ?)`,
                    [d.sale_id, u.id, u.serial, `Non pris (livraison #${d.delivery_number})`, req.session.user.id, req.session.user.full_name || req.session.user.username, now]);
                await recordMovement(u, 'retour_attente', 'retour_livraison', req, { from: 'livraison', ref_type: 'delivery', ref_id: d.id, note: `Non pris à la livraison #${d.delivery_number}` });
            } else {
                // Unité déjà repassée « vendue » (pièce de remplacement d'un échange) : rien à refaire.
                const up = await dbRun(`UPDATE stock_units SET status = 'vendu', holder_user_id = NULL, updated_at = ? WHERE id = ? AND status = 'livraison'`, [now, u.id]);
                if (up.changes) await recordMovement(u, 'vendu', 'livraison_livree', req, { from: 'livraison', ref_type: 'delivery', ref_id: d.id, note: `Livrée #${d.delivery_number}` });
            }
        }
        // Livraison partielle : la vente ne retient que les articles gardés + notif retour au stock.
        if (hasReturns) {
            await dbRun('UPDATE sales SET total = ? WHERE id = ?', [keptTotal, d.sale_id]);
            const excess = Math.max(0, Math.round(d.acompte || 0) - keptTotal);   // acompte > gardé → à rembourser
            if (excess > 0) pushNotification({ target_role: 'caisse', type: 'warn', persistent: true, ref: `delivery:${d.id}:refund`,
                title: 'Remboursement à effectuer', message: `Livraison #${d.delivery_number} partielle — avance excédentaire de ${excess.toLocaleString('fr-FR')} Ar à rembourser au client.`, link: '/deliveries.html' });
            pushNotification({ target_role: 'gestion_stock', type: 'warn', persistent: true, ref: `return:sale:${d.sale_id}`,
                title: 'Retour livraison à réceptionner', message: `Livraison #${d.delivery_number} : ${returnedItems.length} article(s) non pris — à réceptionner au stock.`, link: '/stock.html' });
        }
        // Upgrades réalisés à la livraison : composant neuf consommé, ancien repris → à réceptionner par le stock.
        if (upg.upgrades && upg.upgrades.length) {
            const siRows = await dbAll('SELECT id, unit_id FROM sale_items WHERE sale_id = ? AND unit_id IS NOT NULL', [d.sale_id]);
            const pcSaleItemByUnit = new Map(siRows.map(r => [r.unit_id, r.id]));
            await applyUpgrades(d.sale_id, upg.upgrades, pcSaleItemByUnit, req, now, true);
            await dbRun('UPDATE sales SET total = total + ? WHERE id = ?', [upg.total, d.sale_id]);
            if (upg.upgrades.some(u => u.keep))
                pushNotification({ target_role: 'gestion_stock', type: 'warn', persistent: true, ref: `return:sale:${d.sale_id}:upgrade`,
                    title: 'Composant repris à réceptionner',
                    message: `Livraison #${d.delivery_number} — ${upg.upgrades.filter(u => u.keep).map(u => u.old_value).join(', ')} retiré(s) d'un ordinateur (upgrade) : à valider au dépôt.`, link: '/retour.html' });
        }
        // La vente est RÉALISÉE le jour de la confirmation/livraison : on la (re)date de ce jour
        // (avec un n° du jour) pour qu'elle compte dans le CA du jour de confirmation — pas du jour
        // de facturation. Tant qu'elle n'est pas confirmée, elle « roule » et reste visible chaque jour.
        const cDay = getDate();
        const cNumber = await nextSaleNumber(cDay);
        await dbRun(`UPDATE sales SET status = 'completed', sale_date = ?, sale_number = ?, created_at = ? WHERE id = ?`,
            [cDay, cNumber, now, d.sale_id]);
        });
        // Statut livraison déjà passé à 'livree' (claim atomique ci-dessus).
        resolveNotifs(`delivery:${d.id}:complete`);   // livrée & payée : plus rien en attente
        resolveDeliveryLateNotifs(d.id);
        resolveNotifs(`delivery_avance_late:${d.id}`);
        logActivity(req, 'delivery_complete', 'delivery', d.id, { number: d.delivery_number });
        // Livrée sans passage au contrôle de sortie : l'admin est prévenu (la sécurité la voit encore dans « À contrôler »).
        const exitOk = await dbGet(`SELECT 1 FROM exit_checks WHERE sale_id = ? AND status = 'ok' LIMIT 1`, [d.sale_id]);
        if (!exitOk) pushNotification({ target_role: 'admin', type: 'warn', title: 'Livraison sans contrôle de sortie',
            message: `Livraison #${d.delivery_number} (${d.client_name || '—'}, livreur ${d.livreur_name || '—'}) confirmée livrée sans contrôle à la porte.`,
            link: '/deliveries.html', data: { delivery_id: d.id } });
        pushNotification({ target_user: d.commercial_id, type: 'success', title: 'Livraison livrée', message: `Votre livraison #${d.delivery_number} est livrée et payée.`, link: '/online.html' });
        broadcast('delivery:update', { id: d.id }); broadcast('sale:new', { sale_id: d.sale_id });
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Caisse : annuler une livraison (retour attendu).
app.post('/api/deliveries/:id/cancel', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason || !reason.trim()) return res.status(400).json({ error: 'Motif obligatoire' });
        const d = await dbGet('SELECT * FROM deliveries WHERE id = ?', [req.params.id]);
        if (!d || !['en_livraison', 'facturee'].includes(d.status)) return res.status(400).json({ error: 'Annulation impossible' });
        const wasReleased = !!d.released_at;   // des unités sont-elles réellement sorties du stock ?
        // Remboursement éventuel (paiement déjà encaissé, jamais compté en trésorerie tant que non livrée).
        const paid = (d.sale_id ? ((await dbGet('SELECT SUM(amount) AS v FROM sale_payments WHERE sale_id = ?', [d.sale_id]))?.v || 0) : 0)
            + (d.acompte_paid ? ((await dbGet('SELECT SUM(amount) AS v FROM delivery_payments WHERE delivery_id = ?', [d.id]))?.v || 0) : 0);
        await withTx(async () => {
            const claim = await dbRun(`UPDATE deliveries SET status = 'annulee', cancel_reason = ?, status_at = ?, stuck_notified = 0, cancelled_by = ?, cancelled_by_role = ? WHERE id = ? AND status IN ('en_livraison','facturee')`, [reason.trim(), Date.now(), ...whoCancels(req), d.id]);
            if (!claim.changes) throw txError(409, 'Livraison déjà traitée (rafraîchissez).');
            if (wasReleased) {
                // Des unités sont sorties → la vente reste (en_livraison), on efface juste le paiement si payé,
                // et le gestionnaire doit RÉCEPTIONNER le retour physique au stock.
                if (d.payment_status === 'paye' && d.sale_id) {
                    await dbRun('DELETE FROM sale_payments WHERE sale_id = ?', [d.sale_id]);
                    await dbRun(`UPDATE sales SET payment_method = NULL, payment_ref = NULL, payment_phone = NULL WHERE id = ?`, [d.sale_id]);
                }
            } else if (d.sale_id) {
                // Rien n'est sorti du stock (facturée non sortie) → la vente n'est que des placeholders :
                // on la supprime (ne doit pas apparaître en « vente ») et AUCUN retour à réceptionner.
                await dbRun('DELETE FROM sale_items WHERE sale_id = ?', [d.sale_id]);
                await dbRun('DELETE FROM sale_payments WHERE sale_id = ?', [d.sale_id]);
                await dbRun('DELETE FROM sales WHERE id = ?', [d.sale_id]);
                await dbRun('UPDATE deliveries SET sale_id = NULL WHERE id = ?', [d.id]);
            }
        });
        resolveNotifs(`delivery_avance_late:${d.id}`);
        if (wasReleased)
            pushNotification({ target_role: 'gestion_stock', type: 'warn', title: 'Livraison annulée', message: `Livraison #${d.delivery_number} annulée — réception du retour à valider.`, link: '/deliveries.html', data: { delivery_id: d.id }, ref: `delivery:${d.id}:return` });
        if (paid > 0) pushNotification({ target_role: 'caisse', type: 'warn', persistent: true, ref: `delivery:${d.id}:refund`,
            title: 'Remboursement à effectuer', message: `Livraison #${d.delivery_number} annulée — ${Math.round(paid).toLocaleString('fr-FR')} Ar déjà payés à rembourser au client.`, link: '/deliveries.html' });
        resolveNotifs(`delivery:${d.id}:complete`);   // annulée : plus de « à confirmer » côté caisse
        resolveDeliveryLateNotifs(d.id);
        broadcast('delivery:update', { id: d.id }); broadcast('stock:update', {});
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Annulation AVANT sortie du stock (commande pas encore livrée) — par le commercial (sa commande),
// le coordinateur ou la caisse. Motif obligatoire. Rien n'a quitté le stock → aucun retour à réceptionner.
app.post('/api/deliveries/:id/cancel-order', requireAuth, requireRole('commercial_ligne', 'coordinateur', 'caisse'), async (req, res) => {
    try {
        const reason = String(req.body.reason || '').trim();
        if (!reason) return res.status(400).json({ error: 'Motif obligatoire' });
        const me = req.session.user;
        const d = await dbGet('SELECT * FROM deliveries WHERE id = ?', [req.params.id]);
        if (!d) return res.status(404).json({ error: 'Commande introuvable' });
        if (hasRole(me, 'commercial_ligne') && !hasRole(me, 'coordinateur', 'caisse', 'gestion_stock') && me.role !== 'admin' && d.commercial_id !== me.id)
            return res.status(403).json({ error: 'Cette commande ne vous appartient pas' });
        // Uniquement tant que rien n'est sorti du stock (avant 'en_livraison').
        if (!['nouvelle', 'assignee', 'acceptee', 'facturee'].includes(d.status))
            return res.status(400).json({ error: 'Commande déjà sortie du stock — annulation impossible ici (voir la caisse).' });
        const paid = d.sale_id ? ((await dbGet('SELECT SUM(amount) AS v FROM sale_payments WHERE sale_id = ?', [d.sale_id]))?.v || 0)
            + (d.acompte_paid ? ((await dbGet('SELECT SUM(amount) AS v FROM delivery_payments WHERE delivery_id = ?', [d.id]))?.v || 0) : 0) : 0;
        await withTx(async () => {
            const claim = await dbRun(`UPDATE deliveries SET status = 'annulee', cancel_reason = ?, status_at = ?, stuck_notified = 0, cancelled_by = ?, cancelled_by_role = ?
                 WHERE id = ? AND status IN ('nouvelle','assignee','acceptee','facturee') AND released_at IS NULL`, [reason, Date.now(), ...whoCancels(req), d.id]);
            if (!claim.changes) throw txError(409, 'Commande déjà traitée ou sortie du stock (rafraîchissez).');
            // Vente de facturation éventuelle : uniquement des placeholders (aucune unité sortie) → supprimée.
            if (d.sale_id) {
                await dbRun('DELETE FROM sale_items WHERE sale_id = ?', [d.sale_id]);
                await dbRun('DELETE FROM sale_payments WHERE sale_id = ?', [d.sale_id]);
                await dbRun('DELETE FROM sales WHERE id = ?', [d.sale_id]);
                await dbRun('UPDATE deliveries SET sale_id = NULL WHERE id = ?', [d.id]);
            }
        });
        if (d.sale_id) {
            resolveNotifs(`delivery_avance_late:${d.id}`);
            if (paid > 0) pushNotification({ target_role: 'caisse', type: 'warn', persistent: true, ref: `delivery:${d.id}:refund`,
                title: 'Remboursement à effectuer', message: `Commande #${d.delivery_number} annulée — ${Math.round(paid).toLocaleString('fr-FR')} Ar déjà payés à rembourser au client.`, link: '/deliveries.html' });
        }
        // Rien n'a quitté le stock → aucun retour à valider. On résout juste les tâches en attente.
        resolveNotifs(`delivery:${d.id}:assign`);
        resolveNotifs(`delivery:${d.id}:invoice`);
        resolveNotifs(`delivery:${d.id}:release`);
        pushNotification({ target_role: 'coordinateur', type: 'warn', title: 'Commande annulée', message: `Commande #${d.delivery_number} annulée par ${me.full_name || me.username}.`, link: '/coordination.html' });
        pushNotification({ target_role: 'caisse', type: 'warn', title: 'Commande annulée', message: `Commande #${d.delivery_number} annulée avant sortie du stock — motif : ${reason}.`, link: '/deliveries.html' });
        logActivity(req, 'delivery_cancel_order', 'delivery', d.id, { number: d.delivery_number, reason });
        resolveNotifs(`delivery:${d.id}:overdue`);
        broadcast('delivery:update', { id: d.id }); broadcast('stock:update', {});
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Gestionnaire : confirmer le retour au stock (après annulation).
app.post('/api/deliveries/:id/return-confirm', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const d = await dbGet('SELECT * FROM deliveries WHERE id = ?', [req.params.id]);
        if (!d || d.status !== 'annulee') return res.status(400).json({ error: 'Aucun retour à valider' });
        // Rien à réceptionner si aucune unité n'est réellement sortie du stock (annulée avant sortie).
        if (!d.released_at) return res.status(400).json({ error: 'Aucun retour physique : cette commande n\'est jamais sortie du stock.' });
        const now = getDateTime();
        const skipped = [];
        await withTx(async () => {
            // Réserve la transition de façon ATOMIQUE (évite un double retour au stock).
            const claim = await dbRun(`UPDATE deliveries SET status = 'retournee' WHERE id = ? AND status = 'annulee'`, [d.id]);
            if (!claim.changes) throw txError(409, 'Retour déjà validé (rafraîchissez).');
            const items = await dbAll('SELECT unit_id FROM sale_items WHERE sale_id = ?', [d.sale_id]);
            for (const it of items) {
                const u = await dbGet('SELECT * FROM stock_units WHERE id = ?', [it.unit_id]);
                if (!u) continue;
                // GARDE-FOU : ne remettre au stock QUE les unités encore physiquement sorties pour CETTE
                // livraison (statut 'livraison'). Une unité déjà repassée ailleurs entre-temps (revendue sur
                // une autre vente, retournée par une autre voie) NE DOIT PAS être remise en stock : sinon on
                // écrase une vente valide et l'ordinateur redevient vendable alors qu'il est déjà payé (fuite).
                if (u.status !== 'livraison') { skipped.push(u.serial || String(u.id)); continue; }
                await dbRun(`UPDATE stock_units SET status = 'stock', holder_user_id = NULL, updated_at = ? WHERE id = ? AND status = 'livraison'`, [now, u.id]);
                await recordMovement(u, 'stock', 'livraison_retour', req, { from: u.status, ref_type: 'delivery', ref_id: d.id, note: 'Retour livraison annulée' });
            }
            if (d.sale_id) await dbRun(`UPDATE sales SET status = 'annulee' WHERE id = ?`, [d.sale_id]);
        });
        if (skipped.length) pushNotification({ target_role: 'gestion_stock', type: 'warn', persistent: true, ref: `delivery:${d.id}:return-skip`,
            title: 'Retour livraison — unités déjà traitées', message: `Livraison #${d.delivery_number} : ${skipped.length} unité(s) NON remise(s) au stock car déjà revendues/retournées ailleurs (${skipped.join(', ')}). À vérifier manuellement.`, link: '/deliveries.html' });
        resolveNotifs(`delivery:${d.id}:refund`);   // le remboursement éventuel est traité côté caisse
        resolveNotifs(`delivery:${d.id}:return`);   // retour validé : le gestionnaire a fait sa part
        pushNotification({ target_role: 'caisse', type: 'info', title: 'Retour livraison validé', message: `Livraison #${d.delivery_number} : retour au stock validé.`, link: '/deliveries.html' });
        broadcast('delivery:update', { id: d.id }); broadcast('stock:update', {});
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Caisse : ANNULATION PARTIELLE d'une livraison pas encore sortie du stock (assignée / facturée) —
// ex. 10 souris commandées, le client n'en veut plus que 6 : on retire 4 pièces (quantité par ligne),
// sans annuler toute la commande. Totaux livraison + vente recalculés ; argent déjà encaissé en trop
// (payée, ou avance supérieure au nouveau total) remboursé et tracé en caisse. Une livraison déjà sortie
// se règle à la confirmation (articles « non pris » décochés).
app.post('/api/deliveries/:id/cancel-items', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const reason = String((req.body && req.body.reason) || '').trim();
        if (!reason) return res.status(400).json({ error: 'Motif obligatoire' });
        const lines = (Array.isArray(req.body.lines) ? req.body.lines : [])
            .map(l => ({ id: parseInt(l.item_id, 10), qty: parseInt(l.qty, 10) || 0 })).filter(l => l.id && l.qty > 0);
        if (!lines.length) return res.status(400).json({ error: 'Indiquez la quantité à annuler sur au moins un article' });
        const d = await dbGet('SELECT * FROM deliveries WHERE id = ?', [req.params.id]);
        if (!d) return res.status(404).json({ error: 'Livraison introuvable' });
        if (!['nouvelle', 'assignee', 'acceptee', 'facturee'].includes(d.status))
            return res.status(400).json({ error: d.status === 'en_livraison'
                ? 'Livraison déjà sortie du stock : à la confirmation « Livrée & payée », décochez les articles non pris (retour au stock).'
                : 'Livraison terminée ou annulée : utilisez « Retour » sur la vente.' });
        const items = await dbAll('SELECT * FROM delivery_items WHERE delivery_id = ?', [d.id]);
        let removed = 0, removedQty = 0;
        for (const l of lines) {
            const it = items.find(i => i.id === l.id);
            if (!it) return res.status(400).json({ error: 'Article introuvable dans cette livraison' });
            if (l.qty > it.quantity) return res.status(400).json({ error: `« ${it.product_name} » : ${it.quantity} pièce(s) seulement` });
            removed += l.qty * (it.unit_price || 0); removedQty += l.qty;
        }
        const totalQty = items.reduce((t, i) => t + (i.quantity || 0), 0);
        if (removedQty >= totalQty) return res.status(400).json({ error: 'Tous les articles seraient retirés : utilisez « Annuler la livraison ».' });
        const now = getDateTime(), today = getDate();
        const oldTotal = parseFloat(d.total) || items.reduce((t, i) => t + i.quantity * (i.unit_price || 0), 0);
        const newTotal = Math.max(0, Math.round(oldTotal - removed));
        let refund = 0;
        if (d.sale_id && d.payment_status === 'paye') refund = Math.round(removed);
        else if ((d.acompte || 0) > newTotal) refund = Math.round(d.acompte - newTotal);
        const summary = [];
        await withTx(async () => {
            for (const l of lines) {
                const it = items.find(i => i.id === l.id);
                if (l.qty === it.quantity) await dbRun('DELETE FROM delivery_items WHERE id = ?', [it.id]);
                else await dbRun('UPDATE delivery_items SET quantity = quantity - ? WHERE id = ?', [l.qty, it.id]);
                if (d.sale_id) {
                    const del = await dbRun(`DELETE FROM sale_items WHERE id IN (SELECT id FROM sale_items WHERE sale_id = ? AND product_id = ? AND unit_id IS NULL AND returned = 0 ORDER BY id DESC LIMIT ?)`,
                        [d.sale_id, it.product_id, l.qty]);
                    if (del.changes !== l.qty) throw txError(409, `« ${it.product_name} » : pièces déjà affectées — rafraîchissez.`);
                }
                summary.push(`${l.qty}× ${it.product_name}`);
            }
            await dbRun('UPDATE deliveries SET total = ? WHERE id = ?', [newTotal, d.id]);
            if (d.sale_id) await dbRun('UPDATE sales SET total = ? WHERE id = ?', [newTotal, d.sale_id]);
            if (refund > 0) {
                if ((d.acompte || 0) > newTotal && d.payment_status !== 'paye') await dbRun('UPDATE deliveries SET acompte = ? WHERE id = ?', [newTotal, d.id]);
                await dbRun(`INSERT INTO cash_movements (sale_date, kind, amount, method, reason, ref_id, user_id, user_name, created_at)
                             VALUES (?, 'remboursement', ?, 'especes', ?, ?, ?, ?, ?)`,
                    [today, -refund, `Annulation partielle livraison #${d.delivery_number} (${summary.join(', ')})`, d.sale_id || null,
                     req.session.user.id, req.session.user.full_name || req.session.user.username, now]);
            }
            await dbRun('UPDATE deliveries SET note = ? WHERE id = ?',
                [((d.note ? d.note + '\n' : '') + `Annulation partielle (${today}) : ${summary.join(', ')} — ${reason}`), d.id]);
        });
        logActivity(req, 'delivery_cancel_partial', 'delivery', d.id, { number: d.delivery_number, removed: summary, amount: removed, refund, reason });
        if (d.status === 'facturee') pushNotification({ target_role: 'gestion_stock', type: 'warn', title: `Livraison #${d.delivery_number} modifiée`,
            message: `Annulation partielle avant sortie : ${summary.join(', ')} retiré(s). Ne sortez que le reste.`, link: '/deliveries.html', data: { delivery_id: d.id } });
        if (d.commercial_id) pushNotification({ target_user: d.commercial_id, type: 'info', title: `Livraison #${d.delivery_number} : annulation partielle`,
            message: `${summary.join(', ')} retiré(s) — ${reason}`, link: '/online.html' });
        broadcast('delivery:update', { id: d.id }); broadcast('stock:update', {});
        res.json({ success: true, removed: summary, amount: Math.round(removed), refund, total: newTotal });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Caisse : reporter une livraison impayée à une date future (permet la clôture du jour).
// La date choisie est stockée dans deferred_date : tant qu'elle est postérieure au jour de
// clôture, la livraison ne bloque plus la caisse ; le jour venu, elle réapparaît comme à traiter.
app.post('/api/deliveries/:id/defer', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const { reason, date } = req.body;
        if (!reason || !reason.trim()) return res.status(400).json({ error: 'Motif obligatoire' });
        const today = getDate();
        const target = String(date || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(target)) return res.status(400).json({ error: 'Date de report invalide' });
        if (target <= today) return res.status(400).json({ error: 'La date de report doit être postérieure à aujourd’hui.' });
        const d = await dbGet('SELECT id, delivery_number, deferred_date FROM deliveries WHERE id = ?', [req.params.id]);
        if (!d) return res.status(404).json({ error: 'Commande introuvable' });
        await dbRun(`UPDATE deliveries SET deferred_date = ?, defer_reason = ? WHERE id = ?`, [target, reason.trim(), d.id]);
        // Un report sort la livraison du blocage de clôture : tracé + admin prévenu.
        logActivity(req, 'delivery_defer', 'delivery', d.id, { number: d.delivery_number, from: d.deferred_date || null, to: target, reason: reason.trim() });
        const who = req.session.user.full_name || req.session.user.username;
        pushNotification({ target_role: 'admin', type: 'warn', title: `Livraison #${d.delivery_number} reportée`,
            message: `${who} : report au ${target}${d.deferred_date ? ` (était ${d.deferred_date})` : ''} — ${reason.trim()}`,
            link: '/deliveries.html', data: { delivery_id: d.id } });
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ============================================================
//  ANNULATIONS DE LIVRAISON (admin) : rapport + analyse des motifs + retards à décider
// ============================================================
// Classement des motifs (texte libre, malgache / français) en causes. Ordre = priorité (le premier
// qui correspond gagne). L'admin peut corriger la catégorie d'une annulation (cancel_category).
const CANCEL_CATS = [
    ['delai',       /annulation automatique|delai de livraison depasse/],
    ['doublon',     /indroa|\bin ?-?2\b|\bin2\b|double|doublon|(mi|ni)tovy|miveri/],
    ['boutique',    /boutiq|boutik|recuperation|hanantona|anatona|andalo|nadalo|magasin/],
    ['deja_servi',  /efa (vita|nahazo|nividy|nividian|noetiny|nivoaka|regle|nandoa|lasa)|vitan i|deja (fait|livre|achete|regle)|deja fait/],
    ['paiement',    /vola|tsy ampy|paiement|payement|payer|\bpaye\b|argent|budget|\bcher\b/],
    ['stock',       /tsi?s(y|i)? ?entana|\blany\b|stock insuffisant|rupture|tsisy ilay ref|sortie.{0,15}stock|defaut|numero de serie|en panne|tsy misy/],
    ['erreur',      /diso|nifandiso|erreur|adino|ovaina ilay (numero|lieu|adiresy|adresse)|faute|soratra/],
    ['desistement', /tsy atao|annule par le client|tsy mandray|tsy nandray|tsy mety amin|tsy hividy|najanona|tsy maka|tsy mila|tsy te|injoignable|tsy azo antsoina|renonce/],
    ['modification',/soloina|solo|ovaina|novaina|echange|change|upgrade|transparent|telecomande|\batao (?!rahampitso|demain|samedi|asabotsy|talata|lundi|alatsinainy|alarobia|alakamisy|zoma|alahady)/],
    ['report',      /demain|rahampitso|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|asabotsy|talata|alatsinainy|alarobia|alakamisy|zoma|alahady|report|relanc|mbola tsy|semaine/],
    ['logistique',  /lera|fianar|any (antsirabe|toamasina|mahajanga|fianar)|reseau|absent|lavitra|livreur|moto|orana/],
];
const CANCEL_CAT_KEYS = [...CANCEL_CATS.map(c => c[0]), 'autre'];
const normTxt = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[’']/g, "'");
const cancelCategory = reason => { const t = normTxt(reason).trim(); if (t.replace(/[^a-z0-9]/g, '').length < 3) return 'autre';
    const hit = CANCEL_CATS.find(([, re]) => re.test(t)); return hit ? hit[0] : 'autre'; };

app.get('/api/admin/annulations', requireAuth, requireAdmin, async (req, res) => {
    try {
        const rows = await dbAll(`SELECT d.id, d.delivery_number, d.client_name, d.client_phone, d.client_address, d.commercial_name, d.livreur_name,
                d.total, d.delivery_fee, d.created_at, d.planned_date, d.delivery_date, d.released_at, d.status_at, d.cancel_reason,
                d.cancel_category, d.cancelled_by, d.cancelled_by_role, d.payment_status,
                (SELECT GROUP_CONCAT(di.quantity || '× ' || di.product_name, ' · ') FROM delivery_items di WHERE di.delivery_id = d.id) AS items_summary,
                (SELECT l.user_name FROM activity_log l WHERE l.entity = 'delivery' AND l.entity_id = CAST(d.id AS TEXT) AND l.action = 'delivery_cancel_order' ORDER BY l.id DESC LIMIT 1) AS log_by
            FROM deliveries d WHERE d.status = 'annulee' ORDER BY d.id DESC`);
        rows.forEach(d => {
            const ms = Number(d.status_at);
            d.cancelled_at = ms > 1e12 ? new Date(ms + 3 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : String(d.created_at || '').slice(0, 16);
            d.auto_category = cancelCategory(d.cancel_reason);
            d.category = CANCEL_CAT_KEYS.includes(d.cancel_category) ? d.cancel_category : d.auto_category;
            d.stage = d.released_at ? 'apres_sortie' : 'avant_sortie';
            d.amount = Math.round((d.total || 0) + (d.delivery_fee || 0));
            d.by = d.cancelled_by || d.log_by || (d.auto_category === 'delai' ? 'Système (auto)' : null);
            delete d.log_by;
        });
        // Base du taux d'annulation : toutes les livraisons créées, par jour (le front choisit la période).
        const created = await dbAll(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM deliveries GROUP BY 1`);
        // Retards à décider : prévues il y a plus de 3 jours, jamais sorties du stock.
        const cutoff = addDays(getDate(), -OVERDUE_DAYS);
        const overdue = await dbAll(`SELECT d.id, d.delivery_number, d.client_name, d.client_phone, d.client_address, d.commercial_name, d.livreur_name,
                d.total, d.delivery_fee, d.status, d.created_at, COALESCE(d.planned_date, d.delivery_date, substr(d.created_at,1,10)) AS plan_date,
                d.payment_status, d.acompte, d.deferred_date, d.defer_reason,
                (SELECT GROUP_CONCAT(di.quantity || '× ' || di.product_name, ' · ') FROM delivery_items di WHERE di.delivery_id = d.id) AS items_summary,
                (SELECT COALESCE(SUM(sp.amount), 0) FROM sale_payments sp WHERE sp.sale_id = d.sale_id) AS paid
            FROM deliveries d WHERE d.status IN ('nouvelle','assignee','acceptee','facturee') AND d.released_at IS NULL
              AND COALESCE(d.planned_date, d.delivery_date, substr(d.created_at,1,10)) < ? ORDER BY plan_date`, [cutoff]);
        res.json({ rows, created, overdue, overdue_days: OVERDUE_DAYS, today: getDate() });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// Admin : analyse des commandes en ligne par page réseau social (canal). Le front agrège par période.
app.get('/api/admin/reseaux-sociaux', requireAuth, requireAdmin, async (req, res) => {
    try {
        // Période demandée par le front (période affichée + période précédente) : seules ces commandes transitent.
        const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : '0000-00-00';
        const rows = await dbAll(`SELECT d.id, d.delivery_number, d.source_page, d.status, d.payment_status, d.client_name, d.client_phone,
                d.client_address, d.commercial_id, d.commercial_name, d.livreur_name, d.total, d.delivery_fee, d.created_at, d.planned_date, d.status_at
            FROM deliveries d WHERE d.created_at >= ? ORDER BY d.id DESC`, [from]);
        const items = await dbAll(`SELECT di.delivery_id, di.product_id, di.product_name, di.quantity, di.unit_price,
                p.is_accessory, p.category, p.brand, p.is_service
            FROM delivery_items di JOIN deliveries d ON d.id = di.delivery_id LEFT JOIN products p ON p.id = di.product_id
            WHERE d.created_at >= ?`, [from]);
        const byD = new Map();
        items.forEach(i => { (byD.get(i.delivery_id) || byD.set(i.delivery_id, []).get(i.delivery_id)).push(i); });
        rows.forEach(d => {
            d.items = (byD.get(d.id) || []).map(i => ({ pid: i.product_id, name: i.product_name, qty: i.quantity || 0, price: i.unit_price || 0,
                kind: i.is_service ? 'service' : (i.is_accessory ? 'accessoire' : 'ordinateur'), category: i.category || null, brand: i.brand || null }));
            d.day = String(d.created_at || '').slice(0, 10);
            d.hour = parseInt(String(d.created_at || '').slice(11, 13), 10);
            if (!isFinite(d.hour)) d.hour = null;
        });
        res.json({ rows, from, pages: await socialPages(), today: getDate() });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// Admin : corriger la cause d'une annulation (analyse plus juste).
app.post('/api/deliveries/:id/cancel-category', requireAuth, requireAdmin, async (req, res) => {
    try {
        const cat = String(req.body.category || '');
        if (cat && !CANCEL_CAT_KEYS.includes(cat)) return res.status(400).json({ error: 'Catégorie inconnue' });
        const r = await dbRun(`UPDATE deliveries SET cancel_category = ? WHERE id = ? AND status = 'annulee'`, [cat || null, req.params.id]);
        if (!r.changes) return res.status(404).json({ error: 'Livraison annulée introuvable' });
        logActivity(req, 'delivery_cancel_category', 'delivery', req.params.id, { category: cat || null });
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// Admin : décision sur une livraison en retard → nouvelle date prévue (la commande reste active).
app.post('/api/deliveries/:id/reschedule', requireAuth, requireAdmin, async (req, res) => {
    try {
        const date = String(req.body.date || '').trim(), note = String(req.body.note || '').trim().slice(0, 300);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date invalide' });
        if (date < getDate()) return res.status(400).json({ error: 'La nouvelle date ne peut pas être passée.' });
        const d = await dbGet('SELECT * FROM deliveries WHERE id = ?', [req.params.id]);
        if (!d) return res.status(404).json({ error: 'Livraison introuvable' });
        if (!['nouvelle', 'assignee', 'acceptee', 'facturee'].includes(d.status) || d.released_at)
            return res.status(400).json({ error: 'Livraison déjà sortie du stock ou clôturée.' });
        const old = d.planned_date || d.delivery_date || null;
        await dbRun('UPDATE deliveries SET planned_date = ?, overdue_notified = NULL WHERE id = ?', [date, d.id]);
        resolveNotifs(`delivery:${d.id}:overdue`);
        logActivity(req, 'delivery_reschedule', 'delivery', d.id, { number: d.delivery_number, from: old, to: date, note: note || null });
        const msg = `Livraison #${d.delivery_number} (${d.client_name || 'client'}) reportée par l'admin au ${date}${note ? ' — ' + note : ''}.`;
        pushNotification({ target_role: 'coordinateur', type: 'info', title: 'Livraison reportée', message: msg, link: '/coordination.html' });
        if (d.commercial_id) pushNotification({ target_user: d.commercial_id, type: 'info', title: 'Livraison reportée', message: msg, link: '/deliveries.html' });
        broadcast('delivery:update', { id: d.id });
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Admin : supprimer une commande de livraison → les articles reviennent au stock immédiatement.
app.delete('/api/deliveries/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const d = await dbGet('SELECT * FROM deliveries WHERE id = ?', [req.params.id]);
        if (!d) return res.status(404).json({ error: 'Commande introuvable' });
        const restored = await withTx(async () => {
            let restored = 0;
            if (d.sale_id) {
                restored = await restoreSaleUnits(d.sale_id, req, `Commande #${d.delivery_number} supprimée (admin)`);
                await dbRun('DELETE FROM sale_items WHERE sale_id = ?', [d.sale_id]);
                await dbRun('DELETE FROM sale_payments WHERE sale_id = ?', [d.sale_id]);
                await dbRun('DELETE FROM sales WHERE id = ?', [d.sale_id]);
            }
            // Les avances (delivery_payments) sont CONSERVÉES : cet argent a réellement été encaissé ce
            // jour-là et reste compté dans la trésorerie de sa date (un remboursement se saisit à part).
            await dbRun('DELETE FROM delivery_items WHERE delivery_id = ?', [d.id]);
            await dbRun('DELETE FROM deliveries WHERE id = ?', [d.id]);
            await dbRun(`DELETE FROM notifications WHERE ref LIKE 'delivery:' || ? || ':%'`, [d.id]);
            return restored;
        });
        logActivity(req, 'delivery_delete', 'delivery', d.id, { number: d.delivery_number, restored });
        broadcast('delivery:update', { id: d.id }); broadcast('stock:update', {});
        res.json({ success: true, restored });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Livreurs (pour le coordinateur, la caisse, le gestionnaire, l'admin).
// Noms de livreurs déjà utilisés — simples suggestions pour l'assignation (aucun compte requis).
app.get('/api/livreurs', requireAuth, requireRole('coordinateur', 'caisse', 'gestion_stock'), async (req, res) => {
    try { const rows = await dbAll(`SELECT livreur_name AS name, COUNT(*) AS n FROM deliveries
                                    WHERE livreur_name IS NOT NULL AND TRIM(livreur_name) <> ''
                                    GROUP BY livreur_name ORDER BY n DESC, livreur_name LIMIT 50`);
          res.json(rows.map(r => ({ name: r.name, count: r.n }))); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// Suivi des versements des livreurs (coordinateur / admin / caisse), en temps réel :
// livraisons sorties pas encore réglées à la caisse (argent chez le livreur, durée depuis la sortie,
// retard selon delivery_alert_hours / delivery_alert_amount) + livraisons réglées le jour choisi.
// Résumé des livraisons d'une journée (coordinateur) : toutes les livraisons SORTIES ce jour-là ou
// RÉGLÉES ce jour-là, avec l'état du paiement (payée / non payée), le livreur, et par livreur le nombre
// de livraisons terminées (réglées à la caisse), en route, l'encaissé et le reste — classement du jour.
app.get('/api/coordination/day-summary', requireAuth, requireRole('coordinateur'), async (req, res) => {
    try {
        const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : getDate();
        const dayStart = Date.parse(day + 'T00:00:00+03:00'), dayEnd = dayStart + 86400000;   // journée à Madagascar
        const rows = await dbAll(`SELECT d.id, d.delivery_number, d.client_name, d.client_phone, d.client_address, d.livreur_name,
                d.total, d.delivery_fee, d.acompte, d.payment_status, d.released_at, d.status, d.status_at, d.deferred_date,
                (SELECT GROUP_CONCAT(di.quantity || '× ' || di.product_name, ' · ') FROM delivery_items di WHERE di.delivery_id = d.id) AS items_summary
            FROM deliveries d
            WHERE (d.released_at >= ? AND d.released_at < ?)
               OR (d.status = 'livree' AND CAST(d.status_at AS INTEGER) >= ? AND CAST(d.status_at AS INTEGER) < ?)
            ORDER BY COALESCE(d.released_at, CAST(d.status_at AS INTEGER))`, [dayStart, dayEnd, dayStart, dayEnd]);
        const liv = new Map();
        rows.forEach(d => {
            d.amount = Math.round((d.total || 0) + (d.delivery_fee || 0));
            const rest = Math.max(0, Math.round(d.amount - (d.acompte || 0)));
            // payee : réglée à la caisse (livrée) ou déjà payée avant le départ ; non_payee : argent encore à verser.
            d.state = d.status === 'livree' ? 'payee'
                : d.status === 'en_livraison' ? (d.payment_status === 'paye' ? 'payee' : 'non_payee')
                : d.status === 'retournee' ? 'retournee' : d.status === 'annulee' ? 'annulee' : 'non_payee';
            d.due = d.state === 'non_payee' ? rest : 0;
            d.done = d.status === 'livree';
            const k = d.livreur_name || 'Non assigné';
            const o = liv.get(k) || { name: k, total: 0, done: 0, en_route: 0, paid: 0, unpaid: 0, cancelled: 0 };
            o.total++;
            if (d.done) o.done++; else if (d.status === 'en_livraison') o.en_route++; else o.cancelled++;
            if (d.state === 'payee') o.paid += d.amount; else o.unpaid += d.due;
            liv.set(k, o);
        });
        const livreurs = [...liv.values()].sort((a, b) => b.done - a.done || b.paid - a.paid || a.name.localeCompare(b.name));
        res.json({ day, rows, livreurs, top: livreurs.find(l => l.done > 0 && l.name !== 'Non assigné') || null });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/coordination/payments', requireAuth, requireRole('coordinateur', 'caisse'), async (req, res) => {
    try {
        const settings = await getSettingsAsync();
        const alertH = parseInt(settings.delivery_alert_hours, 10) || 3;
        const alertAmt = parseFloat(settings.delivery_alert_amount) || 50000;
        const day = /^\d{4}-\d{2}-\d{2}$/.test(req.query.day || '') ? req.query.day : getDate();
        const dayStart = Date.parse(day + 'T00:00:00+03:00'), dayEnd = dayStart + 86400000;   // journée à Madagascar
        const cols = `d.id, d.delivery_number, d.client_name, d.client_phone, d.client_address, d.livreur_name, d.commercial_name,
            d.total, d.delivery_fee, d.acompte, d.acompte_paid, d.payment_status, d.released_at, d.status, d.status_at, d.deferred_date, d.defer_reason,
            d.planned_date, d.delivery_date, d.delivery_time, d.priority,
            (SELECT GROUP_CONCAT(di.quantity || '× ' || di.product_name, ' · ') FROM delivery_items di WHERE di.delivery_id = d.id) AS items_summary`;
        const out = await dbAll(`SELECT ${cols} FROM deliveries d WHERE d.status = 'en_livraison' ORDER BY d.released_at`);
        const settled = await dbAll(`SELECT ${cols}, s.payment_method,
                (SELECT GROUP_CONCAT(sp.method, ',') FROM sale_payments sp WHERE sp.sale_id = d.sale_id) AS methods
            FROM deliveries d LEFT JOIN sales s ON s.id = d.sale_id
            WHERE d.status = 'livree' AND ((CAST(d.status_at AS INTEGER) >= ? AND CAST(d.status_at AS INTEGER) < ?)
                OR (d.status_at IS NULL AND s.sale_date = ?))
            ORDER BY CAST(d.status_at AS INTEGER) DESC`, [dayStart, dayEnd, day]);
        const now = Date.now();
        const due = d => d.payment_status === 'paye' ? 0 : Math.max(0, Math.round((d.total || 0) + (d.delivery_fee || 0) - (d.acompte || 0)));
        out.forEach(d => {
            d.due = due(d);
            d.hours = d.released_at ? (now - d.released_at) / 3600000 : null;
            d.level = !d.due ? 'paid' : (d.deferred_date && d.deferred_date > getDate()) ? 'deferred'
                : (d.hours != null && d.total >= alertAmt && d.hours >= 24) ? 'critical'
                : (d.hours != null && d.hours >= alertH) ? 'late' : 'ok';
        });
        settled.forEach(d => {
            d.amount = Math.round((d.total || 0) + (d.delivery_fee || 0));
            d.duration_h = d.released_at && d.status_at ? (Number(d.status_at) - d.released_at) / 3600000 : null;
        });
        res.json({ now, day, alert_hours: alertH, alert_amount: alertAmt, out, settled });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
};
