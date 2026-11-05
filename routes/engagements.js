// ============================================================
//  STOCKFLOW — Engagements clients : réservations, sorties boutique (consignations), avances, échanges
//  Routes /api déplacées depuis server.js (code inchangé). Les helpers, la base et les
//  middlewares partagés arrivent par S (voir « Routes par domaine » en fin de server.js).
// ============================================================
module.exports = function register(app, S) {
    const { accCode, addDays, attachConsignmentItems, boutiqueResponsibleIdAsync, broadcast, checkNextPaymentDate,
        clientError, commercialView, consignItemsSql, dbAll, dbGet, dbRun, displaySerial, getDate, getDateTime,
        getLayawayFull, getSaleFull, getSettingsAsync, hasRole, logActivity, nextSaleNumber, normalizePayments,
        parseAccCode, POS_SELLABLE, posNotOut, pushNotification, recordMovement, recordSalePayments, requireAuth,
        requireRole, resolveDepotUnits, resolveNotifs, starlinkAddressError, txError, withTx } = S;

// ============================================================
//  RÉSERVATIONS « À VENDRE » (sortie de stock pour un commercial)
// ============================================================
app.post('/api/reservations', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const { commercial_id, lines, unit_ids, note } = req.body;
        if (!commercial_id) return res.status(400).json({ error: 'Commercial requis' });
        const com = await dbGet('SELECT * FROM users WHERE id = ? AND role IN (\'commercial\',\'commercial_ligne\')', [commercial_id]);
        if (!com) return res.status(400).json({ error: 'Commercial introuvable' });
        const resolved = await resolveDepotUnits(unit_ids, lines);
        if (resolved.error) return res.status(400).json({ error: resolved.error });
        const units = resolved.units;
        const now = getDateTime();
        const rid = await withTx(async () => {
            const r = await dbRun(`INSERT INTO reservations (commercial_id, commercial_name, created_by_id, created_by_name, status, note, created_at) VALUES (?,?,?,?, 'active', ?, ?)`,
                [com.id, com.full_name || com.username, req.session.user.id, req.session.user.full_name || req.session.user.username, note || null, now]);
            for (const u of units) {
                const up = await dbRun(`UPDATE stock_units SET status = 'reserve', holder_user_id = ?, updated_at = ? WHERE id = ? AND status = 'stock'`, [com.id, now, u.id]);
                if (up.changes !== 1) throw txError(409, `Unité ${u.serial || u.id} sortie entre-temps par ailleurs — rechargez.`);
                await dbRun(`INSERT INTO reservation_items (reservation_id, unit_id, serial, product_id, product_name, unit_price) VALUES (?,?,?,?,?,?)`,
                    [r.lastID, u.id, u.serial, u.product_id, u.product_name, u.sale_price || 0]);
                await recordMovement(u, 'reserve', 'reservation', req, { from: 'stock', ref_type: 'reservation', ref_id: r.lastID, note: `Réservé à vendre — ${com.full_name || com.username}` });
            }
            return r.lastID;
        });
        logActivity(req, 'reservation', 'reservation', rid, { units: units.length, commercial: com.full_name });
        // Réservation « à vendre » : le commercial présente / teste chez le client puis la caisse
        // vend au POS (scan du n° de série). Suivi et retour dépôt dans « Suivi boutique » (stock).
        pushNotification({ target_user: com.id, type: 'info', ref: `reservation:${rid}`,
            title: 'Articles réservés à votre nom', message: `${units.length} article(s) à présenter / vendre (à rendre au dépôt si non vendus).`, link: '/consignations.html' });
        broadcast('reservation:update', {}); broadcast('stock:update', {});
        res.json({ success: true, reservation_id: rid });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/reservations', requireAuth, requireRole('caisse', 'gestion_stock', 'commercial', 'commercial_ligne'), async (req, res) => {
    try {
        const me = req.session.user;
        const w = [], p = [];
        if (commercialView(me)) { w.push('r.commercial_id = ?'); p.push(me.id); }
        if (req.query.status) { w.push('r.status = ?'); p.push(req.query.status); }
        const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
        const rows = await dbAll(
            `SELECT r.*,
                (SELECT COUNT(*) FROM reservation_items i WHERE i.reservation_id = r.id) AS item_count,
                (SELECT SUM(i.unit_price) FROM reservation_items i WHERE i.reservation_id = r.id) AS total,
                (SELECT GROUP_CONCAT(i.product_name, ' · ') FROM reservation_items i WHERE i.reservation_id = r.id) AS items_summary
             FROM reservations r ${where} ORDER BY CASE r.status WHEN 'active' THEN 0 ELSE 1 END, r.created_at DESC LIMIT 300`, p);
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Unités réservées (statut 'reserve') encore actives, en cartes détaillées — utilisé par
// « Ma boutique » pour montrer au commercial ses articles réservés (physiquement au dépôt).
// Défini AVANT /:id pour ne pas être capté par le paramètre.
app.get('/api/reservations/units', requireAuth, requireRole('caisse', 'gestion_stock', 'commercial', 'commercial_ligne'), async (req, res) => {
    try {
        const me = req.session.user;
        const w = ["r.status = 'active'", "u.status = 'reserve'"], p = [];
        // Vue commercial pure : seulement ses propres réservations.
        if (hasRole(me, 'commercial', 'commercial_ligne') && !hasRole(me, 'caisse', 'gestion_stock') && me.role !== 'admin') {
            w.push('r.commercial_id = ?'); p.push(me.id);
        }
        const rows = await dbAll(
            `SELECT i.unit_id, i.product_id, i.unit_price, i.product_name, r.id AS reservation_id, r.commercial_id, r.commercial_name, r.created_at,
                    u.serial, u.manufacturer_sn, u.warranty_end, u.status AS unit_status,
                    p.brand, p.model, p.category, p.subcategory, p.is_accessory, p.condition, p.image,
                    p.cpu, p.ram, p.storage, p.storage_type, p.screen_size, p.gpu
             FROM reservation_items i
             JOIN reservations r ON r.id = i.reservation_id
             JOIN stock_units u ON u.id = i.unit_id
             LEFT JOIN products p ON p.id = i.product_id
             WHERE ${w.join(' AND ')}
             ORDER BY r.created_at DESC`, p);
        rows.forEach(it => { it.serial = displaySerial(it); });
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Suivi boutique (stock) : réservations « à vendre » avec le détail par unité (statut courant),
// même forme que les consignations pour un affichage unifié. Défini AVANT /:id.
app.get('/api/reservations/tracking', requireAuth, requireRole('gestion_stock', 'admin'), async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT r.*, (SELECT role FROM users WHERE id = r.commercial_id) AS commercial_role
             FROM reservations r ORDER BY r.created_at DESC LIMIT 300`, []);
        if (!rows.length) return res.json([]);
        const ph = rows.map(() => '?').join(',');
        const items = await dbAll(
            `SELECT i.*, p.brand, p.model, p.category, p.subcategory, p.is_accessory, p.condition, p.image,
                    p.cpu, p.ram, p.storage, p.storage_type, p.screen_size, p.gpu,
                    u.manufacturer_sn, u.warranty_end, u.status AS unit_status
             FROM reservation_items i
             LEFT JOIN products p ON p.id = i.product_id
             LEFT JOIN stock_units u ON u.id = i.unit_id
             WHERE i.reservation_id IN (${ph})`, rows.map(r => r.id));
        items.forEach(it => { it.serial = displaySerial(it); });
        const byResa = {};
        items.forEach(it => { (byResa[it.reservation_id] = byResa[it.reservation_id] || []).push(it); });
        rows.forEach(r => { r.items = byResa[r.id] || []; });
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/reservations/:id', requireAuth, requireRole('caisse', 'gestion_stock', 'commercial', 'commercial_ligne'), async (req, res) => {
    try {
        const r = await dbGet('SELECT * FROM reservations WHERE id = ?', [req.params.id]);
        if (!r) return res.status(404).json({ error: 'Réservation introuvable' });
        if (commercialView(req.session.user) && r.commercial_id !== req.session.user.id) return res.status(403).json({ error: 'Réservation d\'un autre commercial' });
        const items = await dbAll(`SELECT i.*, p.brand, p.model, p.cpu, p.ram, p.storage FROM reservation_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.reservation_id = ?`, [req.params.id]);
        res.json({ ...r, items });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Caisse : encaisser la réservation → facture (vente).
app.post('/api/reservations/:id/sell', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const { client, payment } = req.body;
        { const cErr = clientError(client && client.name, client && client.phone); if (cErr) return res.status(400).json({ error: cErr }); }
        const r = await dbGet(`SELECT * FROM reservations WHERE id = ? AND status = 'active'`, [req.params.id]);
        if (!r) return res.status(400).json({ error: 'Réservation non disponible' });
        const items = await dbAll('SELECT * FROM reservation_items WHERE reservation_id = ?', [r.id]);
        const units = [];
        for (const it of items) { const u = await dbGet(`SELECT * FROM stock_units WHERE id = ? AND status = 'reserve'`, [it.unit_id]); if (u) units.push({ ...u, product_name: it.product_name, unit_price: it.unit_price }); }
        if (!units.length) return res.status(400).json({ error: 'Aucune unité réservée valide' });
        const now = getDateTime(), today = getDate();
        const total = units.reduce((s, u) => s + (u.unit_price || 0), 0);
        const pay = normalizePayments(payment, total); if (pay.error) return res.status(400).json({ error: pay.error });
        // Écriture ATOMIQUE : vente, paiements, lignes, unités (revérifiées), réservation soldée.
        const { saleId, saleNumber } = await withTx(async () => {
            const claim = await dbRun(`UPDATE reservations SET status = 'vendu' WHERE id = ? AND status = 'active'`, [r.id]);
            if (!claim.changes) throw txError(409, 'Réservation déjà encaissée ou annulée (rafraîchissez).');
            const saleNumber = await nextSaleNumber(today);
            const sale = await dbRun(
                `INSERT INTO sales (sale_number, sale_date, client_name, client_phone, client_address, commercial_id, commercial_name, cashier_id, cashier_name, total, payment_method, payment_ref, payment_phone, channel, status, note, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'boutique', 'completed', ?, ?)`,
                [saleNumber, today, client && client.name || null, client && client.phone || null, client && client.address || null,
                 r.commercial_id, r.commercial_name, req.session.user.id, req.session.user.full_name || req.session.user.username,
                 total, pay.primary, pay.first.ref, pay.first.phone, `Réservation #${r.id}`, now]);
            const saleId = sale.lastID;
            await recordSalePayments(saleId, pay.lines, now);
            for (const u of units) {
                const up = await dbRun(`UPDATE stock_units SET status = 'vendu', holder_user_id = NULL, updated_at = ? WHERE id = ? AND status = 'reserve'`, [now, u.id]);
                if (up.changes !== 1) throw txError(409, `Unité ${u.serial} vendue ou déplacée entre-temps — rechargez.`);
                await dbRun(`INSERT INTO sale_items (sale_id, unit_id, serial, product_id, product_name, unit_price) VALUES (?,?,?,?,?,?)`, [saleId, u.id, u.serial, u.product_id, u.product_name, u.unit_price || 0]);
                await recordMovement(u, 'vendu', 'vente', req, { from: 'reserve', ref_type: 'sale', ref_id: saleId, note: `Vente #${saleNumber} (réservation)` });
            }
            await dbRun(`UPDATE reservations SET sale_id = ? WHERE id = ?`, [saleId, r.id]);
            return { saleId, saleNumber };
        });
        resolveNotifs(`reservation:${r.id}`);
        logActivity(req, 'reservation_sell', 'reservation', r.id, { sale: saleId });
        pushNotification({ target_role: 'gestion_stock', type: 'success', title: 'Réservation vendue', message: `Réservation #${r.id} encaissée (vente #${saleNumber}).`, link: '/sales.html' });
        broadcast('reservation:update', {}); broadcast('sale:new', { sale_id: saleId }); broadcast('stock:update', {});
        res.json({ success: true, sale: await getSaleFull(saleId) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Annuler une réservation → retour au stock.
app.post('/api/reservations/:id/cancel', requireAuth, requireRole('caisse', 'gestion_stock'), async (req, res) => {
    try {
        const r = await dbGet(`SELECT * FROM reservations WHERE id = ? AND status = 'active'`, [req.params.id]);
        if (!r) return res.status(400).json({ error: 'Réservation non disponible' });
        const now = getDateTime();
        await withTx(async () => {
            const claim = await dbRun(`UPDATE reservations SET status = 'annule' WHERE id = ? AND status = 'active'`, [r.id]);
            if (!claim.changes) throw txError(409, 'Réservation déjà traitée (rafraîchissez).');
            const items = await dbAll('SELECT * FROM reservation_items WHERE reservation_id = ?', [r.id]);
            for (const it of items) {
                const u = await dbGet(`SELECT * FROM stock_units WHERE id = ? AND status = 'reserve'`, [it.unit_id]);
                if (!u) continue;
                await dbRun(`UPDATE stock_units SET status = 'stock', holder_user_id = NULL, updated_at = ? WHERE id = ? AND status = 'reserve'`, [now, u.id]);
                await recordMovement(u, 'stock', 'reservation_annulee', req, { from: 'reserve', ref_type: 'reservation', ref_id: r.id, note: (req.body && req.body.reason) || 'Réservation annulée' });
            }
        });
        resolveNotifs(`reservation:${r.id}`);
        broadcast('reservation:update', {}); broadcast('stock:update', {});
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Stock : retour au dépôt d'UNE unité réservée (depuis « Suivi boutique »). Solde la réservation
// dès qu'aucune de ses unités n'est plus réservée (soldée 'vendu' si des unités ont été vendues,
// sinon 'annule').
app.post('/api/reservations/unit/:unitId/return', requireAuth, requireRole('gestion_stock', 'admin'), async (req, res) => {
    try {
        const it = await dbGet('SELECT * FROM reservation_items WHERE unit_id = ?', [req.params.unitId]);
        if (!it) return res.status(404).json({ error: 'Unité non réservée' });
        const u = await dbGet(`SELECT * FROM stock_units WHERE id = ? AND status = 'reserve'`, [it.unit_id]);
        if (!u) return res.status(400).json({ error: 'Unité déjà vendue ou retournée' });
        const now = getDateTime();
        let closedResa = false;
        await withTx(async () => {
        const up = await dbRun(`UPDATE stock_units SET status = 'stock', holder_user_id = NULL, updated_at = ? WHERE id = ? AND status = 'reserve'`, [now, u.id]);
        if (up.changes !== 1) throw txError(409, 'Unité déjà vendue ou retournée');
        await recordMovement(u, 'stock', 'reservation_annulee', req, { from: 'reserve', ref_type: 'reservation', ref_id: it.reservation_id, note: 'Retour dépôt (réservation) — Suivi boutique' });
        const left = await dbGet(`SELECT COUNT(*) AS n FROM reservation_items i JOIN stock_units su ON su.id = i.unit_id WHERE i.reservation_id = ? AND su.status = 'reserve'`, [it.reservation_id]);
        if ((left.n || 0) === 0) {
            const sold = await dbGet(`SELECT COUNT(*) AS n FROM reservation_items i JOIN stock_units su ON su.id = i.unit_id WHERE i.reservation_id = ? AND su.status = 'vendu'`, [it.reservation_id]);
            await dbRun(`UPDATE reservations SET status = ? WHERE id = ? AND status = 'active'`, [(sold.n || 0) > 0 ? 'vendu' : 'annule', it.reservation_id]);
            closedResa = true;
        }
        });
        if (closedResa) resolveNotifs(`reservation:${it.reservation_id}`);
        broadcast('reservation:update', {}); broadcast('stock:update', {});
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Stock crée une consignation (sortie présentation) pour un commercial.
app.post('/api/consignments', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const { commercial_id, lines, unit_ids, note } = req.body;
        if (!commercial_id) return res.status(400).json({ error: 'Commercial requis' });
        const com = await dbGet(`SELECT * FROM users WHERE id = ? AND role IN ('commercial','commercial_ligne') AND active = 1`, [commercial_id]);
        if (!com) return res.status(400).json({ error: 'Commercial introuvable' });
        // Règle boutique : seul le commercial responsable de la boutique (Configuration → Paramètres)
        // peut recevoir une sortie boutique. Les autres commerciaux boutique doivent passer par
        // « Réservé à vendre ». Les commerciaux EN LIGNE ne sont pas concernés (canal séparé).
        if (com.role === 'commercial') {
            const respId = await boutiqueResponsibleIdAsync();
            if (!respId) return res.status(400).json({ error: 'Aucun responsable de la boutique n\'est configuré (Configuration → Paramètres). Utilisez « Réservé à vendre » pour ce commercial.' });
            if (com.id !== respId) return res.status(403).json({ error: 'Seul le commercial responsable de la boutique peut recevoir une sortie boutique. Pour ce commercial, utilisez « Réservé à vendre » (unités à son nom, à rendre si non vendues).' });
        }
        const resolved = await resolveDepotUnits(unit_ids, lines);
        if (resolved.error) return res.status(400).json({ error: resolved.error });
        const units = resolved.units;
        const now = getDateTime();
        // Sortie boutique : sortie IMMÉDIATE (statut 'boutique', pas d'étape « à réceptionner »).
        // Les unités sont dès maintenant chez le commercial responsable, vendables à la caisse.
        const cid = await withTx(async () => {
            const c = await dbRun(`INSERT INTO consignments (commercial_id, commercial_name, created_by_id, created_by_name, status, received_at, note, created_at) VALUES (?,?,?,?, 'boutique', ?, ?, ?)`,
                [com.id, com.full_name || com.username, req.session.user.id, req.session.user.full_name || req.session.user.username, now, note || null, now]);
            for (const u of units) {
                const up = await dbRun(`UPDATE stock_units SET status = 'consignation', holder_user_id = ?, updated_at = ? WHERE id = ? AND status = 'stock'`, [com.id, now, u.id]);
                if (up.changes !== 1) throw txError(409, `Unité ${u.serial || u.id} sortie entre-temps par ailleurs — rechargez.`);
                await dbRun(`INSERT INTO consignment_items (consignment_id, unit_id, serial, product_id, product_name, unit_price) VALUES (?,?,?,?,?,?)`,
                    [c.lastID, u.id, u.serial, u.product_id, u.product_name, u.sale_price || 0]);
                await recordMovement(u, 'consignation', 'sortie_boutique', req, { from: 'stock', ref_type: 'consignment', ref_id: c.lastID, note: `Sortie boutique — ${com.full_name || com.username}` });
            }
            return c.lastID;
        });
        logActivity(req, 'sortie_boutique', 'consignment', cid, { units: units.length, commercial: com.full_name });
        pushNotification({ target_user: com.id, type: 'info', ref: `consignment:${cid}`,
            title: 'Produits sortis en boutique', message: `${units.length} article(s) à votre nom, vendables en boutique.`, link: '/consignations.html' });
        broadcast('consignment:update', {}); broadcast('stock:update', {});
        res.json({ success: true, consignment_id: cid });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Liste (role-scoped : commercial voit les siennes, caisse voit les reçues, stock/admin tout).
app.get('/api/consignments', requireAuth, requireRole('caisse', 'gestion_stock', 'commercial'), async (req, res) => {
    try {
        const me = req.session.user;
        const w = [], p = [];
        // Commercial : sa boutique = seulement les sorties boutique en cours (statut 'boutique').
        // Avec ?all=1 : historique de réception = toutes ses sorties (tous statuts, toutes les unités).
        // Vue « mon espace commercial » = a le rôle commercial et n'a pas de rôle plus large (caisse/stock/admin).
        const commercialView = hasRole(me, 'commercial') && !hasRole(me, 'caisse', 'gestion_stock') && me.role !== 'admin';
        const wantAll = commercialView && (req.query.all === '1' || req.query.history === '1');
        if (commercialView) {
            w.push('c.commercial_id = ?'); p.push(me.id);
            if (!wantAll) w.push("c.status = 'boutique'");
        }
        if (req.query.status) { w.push('c.status = ?'); p.push(req.query.status); }
        const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
        // IMPORTANT : le statut d'une consignation reste 'boutique' même après la vente de ses unités
        // (il ne repasse pas 'sold'). Avec 1000+ consignations, un simple LIMIT masquait des sorties
        // ANCIENNES dont l'unité est ENCORE en boutique → introuvables dans le Suivi boutique et donc
        // impossibles à retourner. On calcule les unités encore en boutique (active_units) et on trie
        // ces consignations ACTIVES en premier : elles ne sont jamais coupées par la limite.
        const rows = await dbAll(
            `SELECT c.*, (SELECT role FROM users WHERE id = c.commercial_id) AS commercial_role, ${consignItemsSql('c')},
                (SELECT COUNT(*) FROM consignment_items ci JOIN stock_units su ON su.id = ci.unit_id
                 WHERE ci.consignment_id = c.id AND su.status = 'consignation') AS active_units
             FROM consignments c ${where}
             ORDER BY (active_units > 0) DESC,
                      CASE c.status WHEN 'sent' THEN 0 WHEN 'received' THEN 1 WHEN 'boutique' THEN 1 WHEN 'cancelled' THEN 2 ELSE 3 END,
                      c.created_at DESC LIMIT 1000`, p);
        // Vue commercial « boutique » : ne montre que les unités encore en boutique (les vendues disparaissent).
        // Vue historique (?all=1) : montre toutes les unités de chaque sortie.
        res.json(await attachConsignmentItems(rows, commercialView && !wantAll));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Consignations annulées à réceptionner (bannière stock) — AVANT /:id.
app.get('/api/consignments/pending-return', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const rows = await dbAll(`SELECT c.*, ${consignItemsSql('c')} FROM consignments c WHERE c.status = 'cancelled' ORDER BY c.created_at`, []);
        res.json(await attachConsignmentItems(rows));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/consignments/:id', requireAuth, requireRole('caisse', 'gestion_stock', 'commercial', 'commercial_ligne'), async (req, res) => {
    try {
        const c = await dbGet('SELECT * FROM consignments WHERE id = ?', [req.params.id]);
        if (!c) return res.status(404).json({ error: 'Consignation introuvable' });
        if (commercialView(req.session.user) && c.commercial_id !== req.session.user.id) return res.status(403).json({ error: "Sortie d'un autre commercial" });
        const items = await dbAll(`SELECT i.*, p.brand, p.model, p.category, p.condition, p.cpu, p.ram, p.storage, p.storage_type, p.screen_size, p.gpu, p.is_accessory
                                   FROM consignment_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.consignment_id = ?`, [req.params.id]);
        res.json({ ...c, items });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Commercial confirme la réception (sent → received) → devient encaissement en attente.
app.post('/api/consignments/:id/receive', requireAuth, requireRole('commercial'), async (req, res) => {
    try {
        const me = req.session.user;
        const c = await dbGet(`SELECT * FROM consignments WHERE id = ? AND status = 'sent'`, [req.params.id]);
        if (!c) return res.status(400).json({ error: 'Consignation non disponible' });
        if (me.role !== 'admin' && c.commercial_id !== me.id) return res.status(403).json({ error: 'Cette consignation ne vous est pas destinée' });
        await dbRun(`UPDATE consignments SET status = 'received', received_at = ? WHERE id = ?`, [getDateTime(), c.id]);
        resolveNotifs(`consignment:${c.id}`);
        const tot = await dbGet('SELECT SUM(unit_price) t, COUNT(*) n FROM consignment_items WHERE consignment_id = ?', [c.id]);
        pushNotification({ target_role: 'caisse', type: 'info', persistent: true, ref: `consignment:${c.id}`,
            title: 'Encaissement en attente (boutique)', message: `${c.commercial_name} détient ${tot.n} article(s) — ${Math.round(tot.t || 0).toLocaleString('fr-FR')} Ar à encaisser.`, link: '/encaissement.html' });
        broadcast('consignment:update', {});
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Caisse encaisse une consignation reçue (received → sold), ou une partie seulement
// (choix multiple côté client via unit_ids) — le reste demeure « received » à encaisser plus tard.
app.post('/api/consignments/:id/sell', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const { client, payment, unit_ids } = req.body;
        const c = await dbGet(`SELECT * FROM consignments WHERE id = ? AND status = 'received'`, [req.params.id]);
        if (!c) return res.status(400).json({ error: 'Consignation non disponible' });
        let items = await dbAll('SELECT * FROM consignment_items WHERE consignment_id = ?', [c.id]);
        if (Array.isArray(unit_ids) && unit_ids.length) {
            const wanted = new Set(unit_ids.map(Number));
            items = items.filter(it => wanted.has(it.unit_id));
        }
        const units = [];
        for (const it of items) { const u = await dbGet(`SELECT * FROM stock_units WHERE id = ? AND status = 'consignation'`, [it.unit_id]); if (u) units.push({ ...u, product_name: it.product_name, unit_price: it.unit_price }); }
        if (!units.length) return res.status(400).json({ error: 'Aucune unité valide sélectionnée' });
        { const cErr = clientError(client && client.name, client && client.phone); if (cErr) return res.status(400).json({ error: cErr }); }
        const now = getDateTime(), today = getDate();
        const total = units.reduce((s, u) => s + (u.unit_price || 0), 0);
        const pay = normalizePayments(payment, total); if (pay.error) return res.status(400).json({ error: pay.error });
        // Écriture ATOMIQUE : vente, paiements, lignes et unités (revérifiées) — tout ou rien.
        const { saleId, saleNumber, remaining } = await withTx(async () => {
            const saleNumber = await nextSaleNumber(today);
            const sale = await dbRun(
                `INSERT INTO sales (sale_number, sale_date, client_name, client_phone, client_address, commercial_id, commercial_name, cashier_id, cashier_name, total, payment_method, payment_ref, payment_phone, channel, status, note, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'boutique', 'completed', ?, ?)`,
                [saleNumber, today, client && client.name || null, client && client.phone || null, client && client.address || null,
                 c.commercial_id, c.commercial_name, req.session.user.id, req.session.user.full_name || req.session.user.username,
                 total, pay.primary, pay.first.ref, pay.first.phone, `Consignation #${c.id}`, now]);
            const saleId = sale.lastID;
            await recordSalePayments(saleId, pay.lines, now);
            for (const u of units) {
                const up = await dbRun(`UPDATE stock_units SET status = 'vendu', holder_user_id = NULL, updated_at = ? WHERE id = ? AND status = 'consignation'`, [now, u.id]);
                if (up.changes !== 1) throw txError(409, `Unité ${u.serial} vendue ou déplacée entre-temps — rechargez.`);
                await dbRun(`INSERT INTO sale_items (sale_id, unit_id, serial, product_id, product_name, unit_price) VALUES (?,?,?,?,?,?)`, [saleId, u.id, u.serial, u.product_id, u.product_name, u.unit_price || 0]);
                await recordMovement(u, 'vendu', 'vente', req, { from: 'consignation', ref_type: 'sale', ref_id: saleId, note: `Vente #${saleNumber} (consignation)` });
            }
            // Solde uniquement si plus aucune unité de la consignation n'est encore en présentation
            // (sinon elle reste « received » : le reste attend un encaissement ultérieur).
            const remaining = await dbGet(
                `SELECT COUNT(*) n FROM consignment_items i JOIN stock_units u ON u.id = i.unit_id
                 WHERE i.consignment_id = ? AND u.status = 'consignation'`, [c.id]);
            if (!remaining.n) await dbRun(`UPDATE consignments SET status = 'sold', sale_id = ?, resolved_at = ? WHERE id = ?`, [saleId, now, c.id]);
            return { saleId, saleNumber, remaining };
        });
        if (!remaining.n) {
            resolveNotifs(`consignment:${c.id}`);
        } else {
            pushNotification({ target_role: 'caisse', type: 'info', persistent: true, ref: `consignment:${c.id}`,
                title: 'Encaissement partiel', message: `${c.commercial_name} : encore ${remaining.n} article(s) à encaisser sur la présentation #${c.id}.`, link: '/encaissement.html' });
        }
        logActivity(req, 'consignment_sell', 'consignment', c.id, { sale: saleId, partial: !!remaining.n, sold: units.length });
        pushNotification({ target_role: 'gestion_stock', type: 'success', title: 'Présentation vendue', message: `Consignation #${c.id} — vente #${saleNumber} (${units.length} article(s)).`, link: '/sales.html' });
        broadcast('consignment:update', {}); broadcast('sale:new', { sale_id: saleId }); broadcast('stock:update', {});
        res.json({ success: true, sale: await getSaleFull(saleId) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Caisse déclare l'annulation (non vendu) → à retourner au stock (received → cancelled).
app.post('/api/consignments/:id/cancel', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const reason = (req.body && req.body.reason || '').trim();
        const c = await dbGet(`SELECT * FROM consignments WHERE id = ? AND status = 'received'`, [req.params.id]);
        if (!c) return res.status(400).json({ error: 'Consignation non disponible' });
        await dbRun(`UPDATE consignments SET status = 'cancelled', cancel_reason = ? WHERE id = ?`, [reason || null, c.id]);
        resolveNotifs(`consignment:${c.id}`);
        pushNotification({ target_role: 'gestion_stock', type: 'warn', persistent: true, ref: `consignment:return:${c.id}`,
            title: 'Retour présentation à réceptionner', message: `Consignation #${c.id} (${c.commercial_name}) annulée — à réceptionner au stock.`, link: '/stock.html' });
        broadcast('consignment:update', {});
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Stock valide le retour physique (cancelled → returned) → unités de nouveau en stock.
app.post('/api/consignments/:id/return-received', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const c = await dbGet(`SELECT * FROM consignments WHERE id = ? AND status = 'cancelled'`, [req.params.id]);
        if (!c) return res.status(400).json({ error: 'Consignation non disponible' });
        const now = getDateTime();
        const items = await dbAll('SELECT * FROM consignment_items WHERE consignment_id = ?', [c.id]);
        await withTx(async () => {
            const claim = await dbRun(`UPDATE consignments SET status = 'returned', resolved_at = ? WHERE id = ? AND status = 'cancelled'`, [now, c.id]);
            if (!claim.changes) throw txError(409, 'Retour déjà validé (rafraîchissez).');
            for (const it of items) {
                const u = await dbGet(`SELECT * FROM stock_units WHERE id = ? AND status = 'consignation'`, [it.unit_id]);
                if (!u) continue;
                await dbRun(`UPDATE stock_units SET status = 'stock', holder_user_id = NULL, updated_at = ? WHERE id = ? AND status = 'consignation'`, [now, u.id]);
                await recordMovement(u, 'stock', 'consignation_retour', req, { from: 'consignation', ref_type: 'consignment', ref_id: c.id, note: 'Retour présentation réceptionné' });
            }
        });
        resolveNotifs(`consignment:return:${c.id}`);
        logActivity(req, 'consignment_return', 'consignment', c.id, { units: items.length });
        broadcast('consignment:update', {}); broadcast('stock:update', {});
        res.json({ success: true, count: items.length });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Stock / admin : renvoyer DIRECTEMENT au dépôt une unité tenue en boutique (consignation).
// Utile pour réconcilier une sortie boutique quand l'unité est physiquement revenue au dépôt
// sans passer par la file de retour (ou que le commercial ne la détient plus). L'unité redevient
// 'stock' (disponible) et la consignation d'origine est clôturée si plus rien n'y reste en boutique.
app.post('/api/consignments/unit/:unitId/return-to-stock', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const uid = parseInt(req.params.unitId, 10);
        const u = await dbGet(`SELECT * FROM stock_units WHERE id = ? AND status = 'consignation'`, [uid]);
        if (!u) return res.status(400).json({ error: 'Unité introuvable ou déjà revenue (plus en boutique).' });
        const reason = (req.body && req.body.reason || '').trim() || 'Retour boutique au dépôt (réconciliation stock)';
        const now = getDateTime();
        // Consignation d'origine (pour tracer le mouvement + clôturer si vide).
        const c = await dbGet(`SELECT c.id FROM consignment_items ci JOIN consignments c ON c.id = ci.consignment_id WHERE ci.unit_id = ? ORDER BY c.id DESC LIMIT 1`, [uid]);
        await withTx(async () => {
            const up = await dbRun(`UPDATE stock_units SET status = 'stock', location = 'depot', holder_user_id = NULL, note = NULL, updated_at = ? WHERE id = ? AND status = 'consignation'`, [now, uid]);
            if (up.changes !== 1) throw txError(409, 'Unité déjà revenue ou vendue entre-temps.');
            await recordMovement(u, 'stock', 'consignation_retour', req, { from: 'consignation', ref_type: 'consignment', ref_id: c ? c.id : null, note: reason });
            if (c) {
                const rem = await dbGet(`SELECT COUNT(*) n FROM consignment_items ci JOIN stock_units su ON su.id = ci.unit_id WHERE ci.consignment_id = ? AND su.status = 'consignation'`, [c.id]);
                if (rem && rem.n === 0) await dbRun(`UPDATE consignments SET status = 'returned', resolved_at = ? WHERE id = ? AND status IN ('sent','received','boutique','cancelled')`, [now, c.id]);
            }
        });
        logActivity(req, 'consignment_return_to_stock', 'stock_unit', uid, { serial: u.serial, reason });
        broadcast('consignment:update', {}); broadcast('stock:update', {});
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Commercial : demander l'échange d'une unité DÉJÀ sortie (livraison en cours, ou boutique) contre
// une autre du MÊME modèle (n° de série différent). Motif obligatoire + disposition de l'ancienne.
app.post('/api/exchanges', requireAuth, requireRole('commercial_ligne', 'commercial'), async (req, res) => {
    try {
        const me = req.session.user;
        const kind = req.body.kind === 'consignation' ? 'consignation' : 'delivery';
        let refId = parseInt(req.body.ref_id, 10) || null;
        const oldUnitId = parseInt(req.body.old_unit_id, 10);
        const reason = String(req.body.reason || '').trim();
        let disposition = String(req.body.disposition || 'stock').trim();
        if (!reason) return res.status(400).json({ error: 'Motif de l\'échange obligatoire' });
        if (!oldUnitId) return res.status(400).json({ error: 'Unité à échanger manquante' });
        const u = await dbGet(`SELECT su.*, p.name AS product_name, p.is_accessory FROM stock_units su LEFT JOIN products p ON p.id = su.product_id WHERE su.id = ?`, [oldUnitId]);
        if (!u) return res.status(404).json({ error: 'Unité introuvable' });
        // Disposition cohérente avec le type (PC → garantie | stock ; accessoire → défectueux | stock).
        const allowed = u.is_accessory ? ['defectueux', 'stock'] : ['garantie', 'stock'];
        if (!allowed.includes(disposition)) disposition = 'stock';
        const dup = await dbGet(`SELECT id FROM exchange_requests WHERE old_unit_id = ? AND status = 'pending'`, [oldUnitId]);
        if (dup) return res.status(400).json({ error: 'Une demande d\'échange est déjà en attente pour cette unité.' });

        let refLabel = '';
        if (kind === 'delivery') {
            const d = await dbGet(`SELECT * FROM deliveries WHERE id = ?`, [refId]);
            if (!d) return res.status(404).json({ error: 'Livraison introuvable' });
            if (me.role !== 'admin' && d.commercial_id !== me.id) return res.status(403).json({ error: 'Cette livraison n\'est pas la vôtre.' });
            // En cours (pièce chez le livreur) ou déjà livrée (problème constaté chez le client).
            if (!['en_livraison', 'livree'].includes(d.status)) return res.status(400).json({ error: 'Échange possible une fois la livraison sortie du stock (en cours ou livrée).' });
            if (u.status !== (d.status === 'livree' ? 'vendu' : 'livraison')) return res.status(400).json({ error: `Cette unité n'est plus ${d.status === 'livree' ? 'chez le client' : 'en livraison'} (${u.status}).` });
            const si = await dbGet(`SELECT id FROM sale_items WHERE sale_id = ? AND unit_id = ? AND returned = 0`, [d.sale_id, oldUnitId]);
            if (!si) return res.status(400).json({ error: 'Unité absente de cette livraison.' });
            refLabel = `Livraison #${d.delivery_number}${d.status === 'livree' ? ' (livrée)' : ''}`;
        } else {
            if (u.status !== 'consignation') return res.status(400).json({ error: 'Cette unité n\'est pas en boutique.' });
            let c = refId ? await dbGet(`SELECT c.* FROM consignment_items ci JOIN consignments c ON c.id = ci.consignment_id WHERE ci.unit_id = ? AND c.id = ? LIMIT 1`, [oldUnitId, refId]) : null;
            if (!c) c = await dbGet(`SELECT c.* FROM consignment_items ci JOIN consignments c ON c.id = ci.consignment_id WHERE ci.unit_id = ? ORDER BY c.id DESC LIMIT 1`, [oldUnitId]);
            if (!c) return res.status(404).json({ error: 'Sortie boutique introuvable pour cette unité.' });
            if (me.role !== 'admin' && c.commercial_id !== me.id) return res.status(403).json({ error: 'Cette sortie boutique n\'est pas la vôtre.' });
            refId = c.id; refLabel = 'Boutique';
        }

        const now = getDateTime();
        const ins = await dbRun(
            `INSERT INTO exchange_requests (kind, ref_id, ref_label, old_unit_id, serial, product_id, product_name, is_accessory, reason, disposition, status, requested_by_id, requested_by_name, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?, ?)`,
            [kind, refId, refLabel, oldUnitId, displaySerial(u), u.product_id, u.product_name, u.is_accessory ? 1 : 0, reason, disposition, me.id, me.full_name || me.username, now]);
        pushNotification({ target_role: 'gestion_stock', type: 'warn', persistent: true, title: 'Demande d\'échange',
            message: `${me.full_name || me.username} demande l'échange de ${displaySerial(u)} (${refLabel}) — motif : ${reason}.`,
            link: '/echanges.html', ref: `exchange:${ins.lastID}` });
        logActivity(req, 'exchange_request', 'stock_unit', oldUnitId, { serial: displaySerial(u), kind, disposition, reason });
        broadcast('exchange:update', {});
        res.json({ success: true, id: ins.lastID });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Commercial : annuler SA demande encore en attente.
app.post('/api/exchanges/:id/cancel', requireAuth, requireRole('commercial_ligne', 'commercial'), async (req, res) => {
    try {
        const me = req.session.user;
        const r = await dbGet(`SELECT * FROM exchange_requests WHERE id = ?`, [req.params.id]);
        if (!r || r.status !== 'pending') return res.status(400).json({ error: 'Demande introuvable ou déjà traitée.' });
        if (me.role !== 'admin' && r.requested_by_id !== me.id) return res.status(403).json({ error: 'Ce n\'est pas votre demande.' });
        await dbRun(`UPDATE exchange_requests SET status = 'cancelled', resolved_at = ? WHERE id = ?`, [getDateTime(), r.id]);
        resolveNotifs(`exchange:${r.id}`);
        broadcast('exchange:update', {});
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Stock : lister les demandes d'échange (en attente par défaut).
app.get('/api/exchanges', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const status = req.query.status;
        const w = status ? 'WHERE status = ?' : '';
        const rows = await dbAll(`SELECT * FROM exchange_requests ${w} ORDER BY (status = 'pending') DESC, created_at DESC LIMIT 500`, status ? [status] : []);
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Stock : valider une demande en scannant/choisissant la NOUVELLE unité (même modèle, en stock).
app.post('/api/exchanges/:id/validate', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const r = await dbGet(`SELECT * FROM exchange_requests WHERE id = ?`, [req.params.id]);
        if (!r || r.status !== 'pending') return res.status(400).json({ error: 'Demande introuvable ou déjà traitée.' });
        const now = getDateTime();
        // SORTIE PHYSIQUE : la pièce de remplacement est scannée (n° de série obligatoire) au moment où le
        // stock la remet au commercial responsable.
        const scan = String(req.body.new_serial || '').trim();
        if (!scan) return res.status(400).json({ error: 'Scannez le n° de série de la pièce de remplacement (sortie du stock).' });
        let nu;
        const accId = parseAccCode(scan);
        if (accId) nu = await dbGet(`SELECT * FROM stock_units WHERE product_id = ? AND serial IS NULL AND status = 'stock' ORDER BY id LIMIT 1`, [r.product_id]);
        else nu = await dbGet(`SELECT * FROM stock_units WHERE (serial = ? OR manufacturer_sn = ?) AND product_id = ? AND status = 'stock' ORDER BY id LIMIT 1`, [scan, scan, r.product_id]);
        if (!nu) {
            const other = accId ? null : await dbGet(`SELECT su.status, p.name FROM stock_units su LEFT JOIN products p ON p.id = su.product_id WHERE su.serial = ? OR su.manufacturer_sn = ? LIMIT 1`, [scan, scan]);
            return res.status(400).json({ error: other ? `« ${scan} » n'est pas utilisable : ${other.name || 'autre modèle'} (${other.status}). Il faut une pièce du MÊME modèle, en stock au dépôt.` : `« ${scan} » introuvable en stock pour ce modèle.` });
        }
        if (nu.id === r.old_unit_id) return res.status(400).json({ error: 'La nouvelle unité doit être différente de l\'ancienne.' });
        const newSerial = nu.serial || accCode(nu.product_id);
        const oldUnit = await dbGet(`SELECT su.*, p.is_accessory FROM stock_units su LEFT JOIN products p ON p.id = su.product_id WHERE su.id = ?`, [r.old_unit_id]);
        if (!oldUnit) return res.status(400).json({ error: 'Ancienne unité introuvable.' });
        // Devenir de l'ancienne pièce, appliqué à sa RÉCEPTION au dépôt (file « Retours à réceptionner »).
        const dest = r.disposition === 'garantie' ? 'garantie_fournisseur' : r.disposition === 'defectueux' ? 'defectueux' : 'stock';
        const dispoLabel = { garantie_fournisseur: 'ira en garantie', defectueux: 'ira en stock défectueux', stock: 'retournera en stock' }[dest];
        const me = req.session.user, meName = me.full_name || me.username;
        let d = null, commercialId = null, saleId = null;

        await withTx(async () => {
            if (r.kind === 'delivery') {
                d = await dbGet(`SELECT * FROM deliveries WHERE id = ?`, [r.ref_id]);
                if (!d || !['en_livraison', 'livree'].includes(d.status)) throw txError(400, 'Livraison ni en cours ni livrée — échange impossible.');
                const expected = d.status === 'livree' ? 'vendu' : 'livraison';
                if (oldUnit.status !== expected) throw txError(400, 'Ancienne unité déjà changée ou revenue.');
                commercialId = d.commercial_id; saleId = d.sale_id;
                await dbRun(`UPDATE sale_items SET unit_id = ?, serial = ? WHERE sale_id = ? AND unit_id = ?`, [nu.id, newSerial, d.sale_id, r.old_unit_id]);
                const up = await dbRun(`UPDATE stock_units SET status = ?, holder_user_id = NULL, updated_at = ? WHERE id = ? AND status = 'stock'`, [expected, now, nu.id]);
                if (up.changes !== 1) throw txError(409, `${newSerial} vient d'être sorti par ailleurs — scannez une autre pièce.`);
                if (r.serial) await dbRun(`UPDATE delivery_items SET serial = REPLACE(serial, ?, ?) WHERE delivery_id = ? AND product_id = ? AND serial LIKE '%' || ? || '%'`, [r.serial, newSerial, d.id, r.product_id, r.serial]);
                await recordMovement(nu, expected, 'echange_sortie', req, { from: 'stock', ref_type: 'delivery', ref_id: d.id, note: `Échange — remplace ${r.serial} (livraison #${d.delivery_number}) · remis à ${r.requested_by_name || 'commercial'}` });
            } else {
                if (oldUnit.status !== 'consignation') throw txError(400, 'Ancienne unité déjà changée (plus en boutique).');
                const c = await dbGet(`SELECT * FROM consignments WHERE id = ?`, [r.ref_id]);
                commercialId = c ? c.commercial_id : r.requested_by_id;
                await dbRun(`UPDATE consignment_items SET unit_id = ?, serial = ? WHERE consignment_id = ? AND unit_id = ?`, [nu.id, newSerial, r.ref_id, r.old_unit_id]);
                const up = await dbRun(`UPDATE stock_units SET status = 'consignation', holder_user_id = ?, updated_at = ? WHERE id = ? AND status = 'stock'`, [commercialId, now, nu.id]);
                if (up.changes !== 1) throw txError(409, `${newSerial} vient d'être sorti par ailleurs — scannez une autre pièce.`);
                await recordMovement(nu, 'consignation', 'echange_sortie', req, { from: 'stock', ref_type: 'consignment', ref_id: r.ref_id, note: `Échange — remplace ${r.serial} (boutique)` });
            }
            // Ancienne pièce : encore chez le client / le livreur / le commercial → « à réceptionner ».
            await dbRun(`UPDATE stock_units SET status = 'retour_attente', holder_user_id = NULL, note = ?, updated_at = ? WHERE id = ?`, [`Échange — ${r.reason}`, now, oldUnit.id]);
            await dbRun(`INSERT INTO sale_returns (sale_id, unit_id, serial, type, destination, refund_amount, reason, user_id, user_name, created_at)
                         VALUES (?,?,?,?,?,?,?,?,?,?)`, [saleId, oldUnit.id, r.serial, 'echange', dest, 0, r.reason, me.id, meName, now]);
            await recordMovement(oldUnit, 'retour_attente', 'echange_retour', req, { from: oldUnit.status, ref_type: r.kind === 'delivery' ? 'delivery' : 'consignment', ref_id: r.ref_id, note: `Remplacée par ${newSerial} — à rapporter au dépôt (${r.reason})` });
            const v = await dbRun(`UPDATE exchange_requests SET status = 'validated', new_unit_id = ?, new_serial = ?, validated_by_id = ?, validated_by_name = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`,
                [nu.id, newSerial, me.id, meName, now, r.id]);
            if (v.changes !== 1) throw txError(409, 'Demande déjà traitée.');
        });
        resolveNotifs(`exchange:${r.id}`);
        pushNotification({ target_user: commercialId || r.requested_by_id, type: 'success', persistent: true, title: 'Échange validé — pièce à récupérer',
            message: `Récupérez ${newSerial} au dépôt (remplace ${r.serial}${r.ref_label ? ', ' + r.ref_label : ''}) et rapportez l'ancienne pièce ${r.serial} au stock.`,
            link: r.kind === 'delivery' ? '/deliveries.html' : '/consignations.html', ref: `exchange:${r.id}:done` });
        pushNotification({ target_role: 'gestion_stock', type: 'info', persistent: true, title: 'Ancienne pièce à réceptionner (échange)',
            message: `${r.serial} (${r.ref_label || ''}) doit revenir au dépôt — elle ${dispoLabel} à sa réception.`, link: '/retour.html', ref: `return:exchange:${r.id}` });
        logActivity(req, 'exchange_validate', 'stock_unit', r.old_unit_id, { old: r.serial, new: newSerial, disposition: r.disposition });
        broadcast('exchange:update', {}); broadcast('stock:update', {}); broadcast(r.kind === 'delivery' ? 'delivery:update' : 'consignment:update', {});
        res.json({ success: true, new_serial: newSerial, disposition: dispoLabel });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Stock : refuser une demande d'échange (l'unité reste en l'état — en livraison / boutique).
app.post('/api/exchanges/:id/reject', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const r = await dbGet(`SELECT * FROM exchange_requests WHERE id = ?`, [req.params.id]);
        if (!r || r.status !== 'pending') return res.status(400).json({ error: 'Demande introuvable ou déjà traitée.' });
        const reason = String(req.body.reason || '').trim() || null;
        await dbRun(`UPDATE exchange_requests SET status = 'rejected', reject_reason = ?, validated_by_id = ?, validated_by_name = ?, resolved_at = ? WHERE id = ?`,
            [reason, req.session.user.id, req.session.user.full_name || req.session.user.username, getDateTime(), r.id]);
        resolveNotifs(`exchange:${r.id}`);
        pushNotification({ target_user: r.requested_by_id, type: 'warn', title: 'Échange refusé',
            message: `Demande d'échange de ${r.serial} refusée${reason ? ' — ' + reason : ''}.`, link: r.kind === 'delivery' ? '/deliveries.html' : '/consignations.html' });
        broadcast('exchange:update', {});
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Commercial : renvoyer AU DÉPÔT une ou plusieurs unités qu'il détient en boutique (consignation).
// Les unités passent « à réceptionner » ; le STOCK valide la réception (→ stock) via la file existante.
app.post('/api/consignments/return-units', requireAuth, requireRole('commercial'), async (req, res) => {
    try {
        const me = req.session.user;
        const unit_ids = Array.isArray(req.body.unit_ids) ? req.body.unit_ids.map(Number).filter(Boolean) : [];
        if (!unit_ids.length) return res.status(400).json({ error: 'Aucune unité sélectionnée' });
        const reason = (req.body.reason || '').trim() || 'Retour boutique au dépôt';
        const now = getDateTime();
        let count = 0;
        await withTx(async () => {
        for (const uid of unit_ids) {
            const u = await dbGet(`SELECT * FROM stock_units WHERE id = ? AND status = 'consignation'`, [uid]);
            if (!u) continue;
            // L'unité doit appartenir à une consignation de CE commercial.
            const owner = await dbGet(
                `SELECT c.commercial_id FROM consignment_items ci JOIN consignments c ON c.id = ci.consignment_id
                 WHERE ci.unit_id = ? ORDER BY c.id DESC LIMIT 1`, [uid]);
            if (me.role !== 'admin' && (!owner || owner.commercial_id !== me.id)) continue;
            await dbRun(`UPDATE stock_units SET status = 'retour_attente', holder_user_id = NULL, note = ?, updated_at = ? WHERE id = ?`, [reason, now, uid]);
            await dbRun(`INSERT INTO sale_returns (sale_id, unit_id, serial, type, destination, refund_amount, reason, user_id, user_name, created_at)
                         VALUES (NULL, ?, ?, 'retour_boutique', 'stock', 0, ?, ?, ?, ?)`,
                [uid, u.serial, reason, me.id, me.full_name || me.username, now]);
            await recordMovement(u, 'retour_attente', 'retour_boutique', req, { from: 'consignation', ref_type: 'consignment', ref_id: null, note: `Retour boutique au dépôt — ${me.full_name || me.username}` });
            count++;
        }
        });
        if (!count) return res.status(400).json({ error: 'Aucune unité éligible (doit être en boutique à votre nom)' });
        pushNotification({ target_role: 'gestion_stock', type: 'warn', title: 'Retour boutique à réceptionner',
            message: `${me.full_name || me.username} renvoie ${count} article(s) de la boutique au dépôt — à réceptionner.`, link: '/stock.html', ref: `return:boutique:${me.id}` });
        logActivity(req, 'consignment_return_units', 'consignment', null, { units: count });
        broadcast('consignment:update', {}); broadcast('stock:update', {});
        res.json({ success: true, count });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Gestion stock : reprendre AU DÉPÔT des unités sorties (consignation) — retour direct, sans
// passer par la file « à réceptionner » (le gestionnaire les a physiquement en main).
// Utilisé notamment pour les prises « commercial en ligne » non vendues.
app.post('/api/consignments/return-to-depot', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const unit_ids = Array.isArray(req.body.unit_ids) ? req.body.unit_ids.map(Number).filter(Boolean) : [];
        if (!unit_ids.length) return res.status(400).json({ error: 'Aucune unité sélectionnée' });
        const now = getDateTime();
        let count = 0;
        await withTx(async () => {
            for (const uid of unit_ids) {
                const u = await dbGet(`SELECT * FROM stock_units WHERE id = ? AND status = 'consignation'`, [uid]);
                if (!u) continue;
                await dbRun(`UPDATE stock_units SET status = 'stock', location = 'depot', holder_user_id = NULL, updated_at = ? WHERE id = ? AND status = 'consignation'`, [now, uid]);
                await recordMovement(u, 'stock', 'consignation_retour', req, { from: 'consignation', ref_type: 'consignment', ref_id: null, note: 'Retour au dépôt (repris par le stock)' });
                count++;
            }
        });
        if (!count) return res.status(400).json({ error: 'Aucune unité éligible (doit être « en boutique / sortie »)' });
        logActivity(req, 'consignment_return_depot', 'consignment', null, { units: count });
        broadcast('consignment:update', {}); broadcast('stock:update', {});
        res.json({ success: true, count });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ============================================================
//  VENTES AVEC AVANCE (acompte / layaway)
// ============================================================
// Le client verse une avance ; les unités passent en statut 'acompte' (non vendables) jusqu'au
// règlement du solde (→ vente) ou à l'annulation (→ retour stock, avance conservée, non remboursée).

// Crée une vente avec avance : réserve les unités + enregistre le 1er versement.
app.post('/api/layaways', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const { client, commercial_id, deposit, note } = req.body;
        // Unités physiques (réservées) + services (sans unité, ex. installation) ; un identifiant non
        // numérique (ancienne ligne « svc-… » du panier) n'est jamais une unité.
        const unit_ids = (Array.isArray(req.body.unit_ids) ? req.body.unit_ids : []).map(Number).filter(n => Number.isInteger(n) && n > 0);
        const serviceIds = (Array.isArray(req.body.services) ? req.body.services : []).map(Number).filter(Boolean);
        if (!unit_ids.length && !serviceIds.length) return res.status(400).json({ error: 'Aucun article' });
        if (new Set(unit_ids).size !== unit_ids.length) return res.status(400).json({ error: 'Une même unité figure deux fois dans le panier' });
        // Client : nom ET numéro obligatoires (comme toute vente caisse).
        const layName = String((client && client.name) || '').trim();
        const layPhone = String((client && client.phone) || '').trim();
        { const cErr = clientError(layName, layPhone); if (cErr) return res.status(400).json({ error: cErr }); }
        const units = unit_ids.length ? await dbAll(
            `SELECT u.*, p.name AS product_name, p.category FROM stock_units u LEFT JOIN products p ON p.id = u.product_id WHERE u.id IN (${unit_ids.map(() => '?').join(',')})`, unit_ids) : [];
        if (units.length !== unit_ids.length) return res.status(400).json({ error: 'Certaines unités sont introuvables' });
        { const aErr = starlinkAddressError(units, client); if (aErr) return res.status(400).json({ error: aErr }); }
        const notSellable = units.find(u => !POS_SELLABLE.includes(u.status));
        if (notSellable) return res.status(400).json({ error: posNotOut(notSellable) });
        const services = [];
        for (const sid of serviceIds) {
            const sp = await dbGet(`SELECT id, name, sale_price FROM products WHERE id = ? AND is_service = 1`, [sid]);
            if (!sp) return res.status(400).json({ error: 'Service introuvable' });
            services.push(sp);
        }
        const subtotal = units.reduce((s, u) => s + (u.sale_price || 0), 0) + services.reduce((s, sp) => s + (sp.sale_price || 0), 0);
        // Remise globale du panier (même règle qu'une vente caisse), conservée jusqu'au solde.
        const disc = req.body.discount || {};
        const discType = disc.type === 'percent' || disc.type === 'value' ? disc.type : null;
        const discValue = Math.max(0, parseFloat(disc.value) || 0);
        let discountAmount = 0;
        if (discType === 'percent') discountAmount = Math.round(subtotal * Math.min(discValue, 100) / 100);
        else if (discType === 'value') discountAmount = Math.min(discValue, subtotal);
        const total = Math.max(0, subtotal - discountAmount);
        // Montant de l'avance = somme des lignes de paiement fournies.
        const depAmount = Array.isArray(deposit && deposit.payments)
            ? deposit.payments.reduce((s, p) => s + Math.round(parseFloat(p.amount) || 0), 0)
            : Math.round(parseFloat(deposit && deposit.amount) || 0);
        if (depAmount <= 0) return res.status(400).json({ error: 'Avance requise (montant > 0)' });
        if (depAmount >= total) return res.status(400).json({ error: 'L\'avance doit être inférieure au total (sinon vente normale)' });
        const dp = normalizePayments(deposit, depAmount);
        if (dp.error) return res.status(400).json({ error: dp.error });
        const now = getDateTime(), today = getDate();
        // Échéancier : date limite = aujourd'hui + délai paramétré ; date du prochain paiement promise par le client.
        const settings = await getSettingsAsync();
        const dueDate = addDays(today, Math.max(1, parseInt(settings.layaway_max_days, 10) || 30));
        const nextDate = String(req.body.next_payment_date || '').trim();
        const nd = checkNextPaymentDate(nextDate, today, dueDate);
        if (nd) return res.status(400).json({ error: nd });
        // Écriture ATOMIQUE : client, avance (n° du jour), unités mises de côté (revérifiées), versements.
        const { layId, number } = await withTx(async () => {
        let clientId = null;
        {
            const c = await dbRun(`INSERT INTO clients (name, phone, address, created_at) VALUES (?, ?, ?, ?)`,
                [layName, layPhone, (client && client.address) || null, now]);
            clientId = c.lastID;
        }
        let commercialName = null;
        if (commercial_id) { const cu = await dbGet('SELECT full_name, username FROM users WHERE id = ?', [commercial_id]); if (cu) commercialName = cu.full_name || cu.username; }
        const nrow = await dbGet(`SELECT MAX(layaway_number) AS mx FROM layaways WHERE date(created_at) = date(?)`, [now]);
        const number = (nrow && nrow.mx ? nrow.mx : 0) + 1;

        const lay = await dbRun(
            `INSERT INTO layaways (layaway_number, client_id, client_name, client_phone, client_address, commercial_id, commercial_name, cashier_id, cashier_name, total, deposit, status, note, created_at, due_date, next_payment_date, discount_type, discount_value, discount_amount)
             VALUES (?,?,?,?,?,?,?,?,?,?,?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
            [number, clientId, layName, layPhone, client && client.address || null,
             commercial_id || null, commercialName, req.session.user.id, req.session.user.full_name || req.session.user.username,
             total, depAmount, note || null, now, dueDate, nextDate, discountAmount > 0 ? discType : null, discountAmount > 0 ? discValue : 0, discountAmount]);
        const layId = lay.lastID;
        for (const u of units) {
            await dbRun(`INSERT INTO layaway_items (layaway_id, unit_id, serial, product_id, product_name, unit_price, prev_status, prev_holder) VALUES (?,?,?,?,?,?,?,?)`,
                [layId, u.id, u.serial, u.product_id, u.product_name, u.sale_price || 0, u.status, u.holder_user_id || null]);
            const up = await dbRun(`UPDATE stock_units SET status = 'acompte', holder_user_id = NULL, updated_at = ? WHERE id = ? AND status = ?`, [now, u.id, u.status]);
            if (up.changes !== 1) throw txError(409, `Unité ${u.serial} vendue ou déplacée entre-temps — rechargez le panier`);
            await recordMovement(u, 'acompte', 'acompte_reserve', req, { from: u.status, ref_type: 'layaway', ref_id: layId, note: `Avance #${number}` });
        }
        for (const sp of services)
            await dbRun(`INSERT INTO layaway_items (layaway_id, unit_id, serial, product_id, product_name, unit_price, is_service) VALUES (?, NULL, NULL, ?, ?, ?, 1)`,
                [layId, sp.id, sp.name, sp.sale_price || 0]);
        for (const l of dp.lines)
            await dbRun(`INSERT INTO layaway_payments (layaway_id, method, amount, phone, ref, sale_date, created_at, next_date, cashier_name) VALUES (?,?,?,?,?,?,?,?,?)`,
                [layId, l.method, l.amount, l.phone, l.ref, today, now, nextDate, req.session.user.full_name || req.session.user.username]);
        return { layId, number };
        });
        logActivity(req, 'layaway_create', 'layaway', layId, { number, total, deposit: depAmount, due_date: dueDate, next_payment_date: nextDate });
        pushNotification({ target_role: 'gestion_stock', type: 'info', title: 'Vente avec avance',
            message: `Avance #${number} — ${units.length} article(s) réservé(s)${services.length ? ' + ' + services.length + ' service(s)' : ''} · ${Math.round(depAmount)} / ${Math.round(total)} Ar`, link: '/layaways.html' });
        broadcast('layaway:update', {}); broadcast('stock:update', {});
        res.json({ success: true, layaway_id: layId, number, layaway: await getLayawayFull(layId) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/layaways', requireAuth, requireRole('caisse', 'gestion_stock', 'commercial', 'commercial_ligne'), async (req, res) => {
    try {
        const me = req.session.user;
        const w = [], p = [];
        if (commercialView(me)) { w.push('l.commercial_id = ?'); p.push(me.id); }
        if (req.query.status) { w.push('l.status = ?'); p.push(req.query.status); }
        if (req.query.from) { w.push('date(l.created_at) >= ?'); p.push(req.query.from); }
        if (req.query.to) { w.push('date(l.created_at) <= ?'); p.push(req.query.to); }
        const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
        const rows = await dbAll(
            `SELECT l.*,
                (SELECT COUNT(*) FROM layaway_items i WHERE i.layaway_id = l.id) AS item_count,
                (SELECT GROUP_CONCAT(i.product_name, ' · ') FROM layaway_items i WHERE i.layaway_id = l.id) AS items_summary
             FROM layaways l ${where} ORDER BY CASE l.status WHEN 'active' THEN 0 ELSE 1 END, l.created_at DESC LIMIT 300`, p);
        if (req.query.items && rows.length) {
            const its = await dbAll(`SELECT layaway_id, unit_id, serial, product_id, product_name, unit_price, is_service FROM layaway_items
                WHERE layaway_id IN (${rows.map(() => '?').join(',')}) ORDER BY id`, rows.map(r => r.id));
            rows.forEach(r => { r.items = its.filter(i => i.layaway_id === r.id); });
        }
        const today = getDate();
        rows.forEach(r => { r.expired = r.status === 'active' && !!r.due_date && r.due_date < today; });
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/layaways/:id', requireAuth, requireRole('caisse', 'gestion_stock', 'commercial', 'commercial_ligne'), async (req, res) => {
    try {
        const l = await dbGet('SELECT * FROM layaways WHERE id = ?', [req.params.id]);
        if (!l) return res.status(404).json({ error: 'Avance introuvable' });
        const items = await dbAll(`SELECT i.*, p.brand, p.model, p.cpu, p.ram, p.storage, p.storage_type, p.is_accessory FROM layaway_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.layaway_id = ?`, [req.params.id]);
        const payments = await dbAll('SELECT method, amount, phone, ref, sale_date, created_at FROM layaway_payments WHERE layaway_id = ? ORDER BY id', [req.params.id]);
        res.json({ ...l, items, payments });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Versement d'avance supplémentaire (le solde reste dû).
app.post('/api/layaways/:id/pay', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const l = await dbGet(`SELECT * FROM layaways WHERE id = ? AND status = 'active'`, [req.params.id]);
        if (!l) return res.status(400).json({ error: 'Avance non disponible' });
        const balance = Math.max(0, l.total - l.deposit);
        const amount = Array.isArray(req.body.payment && req.body.payment.payments)
            ? req.body.payment.payments.reduce((s, p) => s + Math.round(parseFloat(p.amount) || 0), 0)
            : Math.round(parseFloat(req.body.payment && req.body.payment.amount) || 0);
        if (amount <= 0) return res.status(400).json({ error: 'Montant requis' });
        if (amount > balance) return res.status(400).json({ error: `Le versement dépasse le solde (${Math.round(balance)} Ar)` });
        if (amount >= balance) return res.status(400).json({ error: 'Ce versement règle tout le solde : utilisez « Solder » (la facture finale sera émise).' });
        const dp = normalizePayments(req.body.payment, amount);
        if (dp.error) return res.status(400).json({ error: dp.error });
        const now = getDateTime(), today = getDate();
        const nextDate = String(req.body.next_payment_date || '').trim();
        const nd = checkNextPaymentDate(nextDate, today, l.due_date);
        if (nd) return res.status(400).json({ error: nd });
        await withTx(async () => {
            for (const line of dp.lines)
                await dbRun(`INSERT INTO layaway_payments (layaway_id, method, amount, phone, ref, sale_date, created_at, next_date, cashier_name) VALUES (?,?,?,?,?,?,?,?,?)`,
                    [l.id, line.method, line.amount, line.phone, line.ref, today, now, nextDate, req.session.user.full_name || req.session.user.username]);
            await dbRun('UPDATE layaways SET deposit = deposit + ?, next_payment_date = ? WHERE id = ?', [amount, nextDate, l.id]);
        });
        resolveNotifs(`layaway_late:${l.id}`);
        logActivity(req, 'layaway_pay', 'layaway', l.id, { amount, next_payment_date: nextDate });
        broadcast('layaway:update', {});
        res.json({ success: true, layaway: await getLayawayFull(l.id) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Règlement du solde → crée la vente (l'avance est déjà comptée en trésorerie à sa date).
app.post('/api/layaways/:id/complete', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const l = await dbGet(`SELECT * FROM layaways WHERE id = ? AND status = 'active'`, [req.params.id]);
        if (!l) return res.status(400).json({ error: 'Avance non disponible' });
        const allItems = await dbAll('SELECT * FROM layaway_items WHERE layaway_id = ?', [l.id]);
        const items = allItems.filter(it => it.unit_id);               // unités réservées
        const svcItems = allItems.filter(it => !it.unit_id);           // services (sans unité)
        const units = [];
        for (const it of items) { const u = await dbGet(`SELECT * FROM stock_units WHERE id = ? AND status = 'acompte'`, [it.unit_id]); if (u) units.push({ ...u, product_name: it.product_name, unit_price: it.unit_price }); }
        if (units.length !== items.length) return res.status(400).json({ error: 'Certaines unités réservées ne sont plus disponibles' });
        const balance = Math.max(0, l.total - l.deposit);
        // Le solde peut être réglé en mixte ; sa somme doit égaler le solde restant.
        const pay = normalizePayments(req.body.payment, balance);
        if (pay.error) return res.status(400).json({ error: pay.error });

        const now = getDateTime(), today = getDate();
        // Écriture ATOMIQUE : vente finale, solde, unités (revérifiées), avance soldée — tout ou rien.
        const { saleId, saleNumber } = await withTx(async () => {
        const claim = await dbRun(`UPDATE layaways SET status = 'vendu', resolved_at = ? WHERE id = ? AND status = 'active'`, [now, l.id]);
        if (!claim.changes) throw txError(409, 'Avance déjà soldée ou annulée (rafraîchissez).');
        const saleNumber = await nextSaleNumber(today);
        const sale = await dbRun(
            `INSERT INTO sales (sale_number, sale_date, client_id, client_name, client_phone, client_address, commercial_id, commercial_name, cashier_id, cashier_name, total, discount_type, discount_value, discount_amount, payment_method, payment_ref, payment_phone, channel, status, note, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'boutique', 'completed', ?, ?)`,
            [saleNumber, today, l.client_id, l.client_name, l.client_phone, l.client_address, l.commercial_id, l.commercial_name,
             req.session.user.id, req.session.user.full_name || req.session.user.username, l.total,
             l.discount_type || null, l.discount_value || 0, l.discount_amount || 0,
             pay.primary, pay.first.ref, pay.first.phone, `Vente sur avance #${l.layaway_number} (acompte ${Math.round(l.deposit)} Ar)`, now]);
        const saleId = sale.lastID;
        if (l.client_lat != null) await dbRun('UPDATE sales SET client_lat = ?, client_lng = ? WHERE id = ?', [l.client_lat, l.client_lng, saleId]);   // position GPS de l'avance
        // Seul le SOLDE est enregistré en sale_payments (l'avance est déjà comptée via layaway_payments).
        if (balance > 0) await recordSalePayments(saleId, pay.lines, now);
        for (const u of units) {
            await dbRun(`INSERT INTO sale_items (sale_id, unit_id, serial, product_id, product_name, unit_price) VALUES (?,?,?,?,?,?)`, [saleId, u.id, u.serial, u.product_id, u.product_name, u.unit_price || 0]);
            const up = await dbRun(`UPDATE stock_units SET status = 'vendu', holder_user_id = NULL, updated_at = ? WHERE id = ? AND status = 'acompte'`, [now, u.id]);
            if (up.changes !== 1) throw txError(409, `Unité ${u.serial} n'est plus réservée (avance) — rechargez.`);
            await recordMovement(u, 'vendu', 'vente', req, { from: 'acompte', ref_type: 'sale', ref_id: saleId, note: `Vente #${saleNumber} (avance #${l.layaway_number})` });
        }
        for (const it of svcItems)
            await dbRun(`INSERT INTO sale_items (sale_id, unit_id, serial, product_id, product_name, unit_price, is_service) VALUES (?, NULL, NULL, ?, ?, ?, 1)`,
                [saleId, it.product_id, it.product_name, it.unit_price || 0]);
        await dbRun(`UPDATE layaways SET sale_id = ? WHERE id = ?`, [saleId, l.id]);
        return { saleId, saleNumber };
        });
        resolveNotifs(`layaway_late:${l.id}`);
        logActivity(req, 'layaway_complete', 'layaway', l.id, { sale: saleId, balance });
        pushNotification({ target_role: 'gestion_stock', type: 'success', title: 'Avance soldée', message: `Avance #${l.layaway_number} soldée (vente #${saleNumber}).`, link: '/sales.html' });
        broadcast('layaway:update', {}); broadcast('sale:new', { sale_id: saleId }); broadcast('stock:update', {});
        res.json({ success: true, sale: await getSaleFull(saleId) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Annulation : les unités reviennent au stock ; l'avance est CONSERVÉE (non remboursée).
app.post('/api/layaways/:id/cancel', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const reason = (req.body && req.body.reason || '').trim();
        const l = await dbGet(`SELECT * FROM layaways WHERE id = ? AND status = 'active'`, [req.params.id]);
        if (!l) return res.status(400).json({ error: 'Avance non disponible' });
        const today = getDate();
        const expired = !!l.due_date && l.due_date < today;
        if (!expired && req.session.user.role !== 'admin')
            return res.status(400).json({ error: `Réservation encore valide jusqu'au ${String(l.due_date || '').split('-').reverse().join('/')} : les articles restent réservés au client. Retour en vente possible à l'expiration (ou par l'admin).` });
        const now = getDateTime();
        const back = [];
        await withTx(async () => {
            const items = await dbAll('SELECT * FROM layaway_items WHERE layaway_id = ? AND unit_id IS NOT NULL', [l.id]);
            for (const it of items) {
                const u = await dbGet(`SELECT * FROM stock_units WHERE id = ? AND status = 'acompte'`, [it.unit_id]);
                if (!u) continue;
                // Statut d'avant la mise de côté (colonne, sinon parcours de l'unité) ; boutique sans détenteur → présentoir.
                let prev = it.prev_status, holder = it.prev_holder || null;
                if (!prev) {
                    const mv = await dbGet(`SELECT from_status FROM unit_movements WHERE unit_id = ? AND action = 'acompte_reserve' AND ref_id = ? ORDER BY id DESC LIMIT 1`, [u.id, String(l.id)]);
                    prev = mv && mv.from_status;
                }
                if (!['stock', 'presentoir', 'reserve', 'consignation'].includes(prev)) prev = 'presentoir';
                if (['consignation', 'reserve'].includes(prev) && !holder) prev = 'presentoir';
                if (prev !== 'consignation' && prev !== 'reserve') holder = null;
                await dbRun(`UPDATE stock_units SET status = ?, holder_user_id = ?, updated_at = ? WHERE id = ?`, [prev, holder, now, u.id]);
                await recordMovement(u, prev, 'acompte_annule', req, { from: 'acompte', ref_type: 'layaway', ref_id: l.id,
                    note: `Avance #${l.layaway_number} ${expired ? 'expirée' : 'annulée'} — remise en vente` });
                back.push(`${it.product_name || ''} (${u.serial || ''})`);
            }
            await dbRun(`UPDATE layaways SET status = 'annule', note = ?, resolved_at = ? WHERE id = ?`,
                [((l.note ? l.note + ' · ' : '') + (expired ? 'Expirée' : 'Annulée') + ' : ' + (reason || 'sans motif') + ` (avance ${Math.round(l.deposit)} Ar conservée)`), now, l.id]);
        });
        resolveNotifs(`layaway_late:${l.id}`);
        logActivity(req, 'layaway_cancel', 'layaway', l.id, { deposit_kept: l.deposit, expired, units: back.length });
        if (back.length) pushNotification({ target_role: 'gestion_stock', type: 'info', title: 'Avance terminée — articles remis en vente',
            message: `Avance #${l.layaway_number} (${l.client_name || 'client'}) ${expired ? 'expirée' : 'annulée'} : ${back.join(', ')}`, link: '/sales.html' });
        broadcast('layaway:update', {}); broadcast('stock:update', {});
        res.json({ success: true, deposit_kept: l.deposit, units: back.length });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ============================================================
//  SUIVI (parcours d'une unité par numéro de série)
// ============================================================
app.get('/api/suivi/search', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        if (!q) return res.json([]);
        const like = `%${q}%`;
        const rows = await dbAll(
            `SELECT u.id, u.serial, u.status, u.warranty_end, p.name AS product_name, p.brand, p.model, s.name AS supplier_name
             FROM stock_units u LEFT JOIN products p ON p.id = u.product_id LEFT JOIN suppliers s ON s.id = u.supplier_id
             WHERE u.serial LIKE ? OR p.name LIKE ? OR p.model LIKE ? OR p.brand LIKE ?
             ORDER BY u.serial LIMIT 50`, [q + '%', like, like, like]);
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/suivi/unit/:id', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const u = await dbGet(
            `SELECT u.*, p.name AS product_name, p.brand, p.model, p.category, p.condition, p.cpu, p.ram, p.storage, p.storage_type, s.name AS supplier_name
             FROM stock_units u LEFT JOIN products p ON p.id = u.product_id LEFT JOIN suppliers s ON s.id = u.supplier_id
             WHERE u.id = ?`, [req.params.id]);
        if (!u) return res.status(404).json({ error: 'Unité introuvable' });
        const movements = await dbAll(`SELECT * FROM unit_movements WHERE unit_id = ? ORDER BY created_at, id`, [req.params.id]);
        const garantie = await dbAll(`SELECT * FROM garantie_actions WHERE unit_id = ? ORDER BY created_at`, [req.params.id]);
        const sale = await dbGet(`SELECT s.id, s.sale_number, s.sale_date, s.total, s.client_name, s.channel FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE si.unit_id = ? ORDER BY s.id DESC LIMIT 1`, [req.params.id]);
        res.json({ ...u, movements, garantie, sale });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
};
