// ============================================================
//  STOCKFLOW — Caisse et ventes : POS, ventes, retours, proformas, contrôle de sortie, rapports de ventes
//  Routes /api déplacées depuis server.js (code inchangé). Les helpers, la base et les
//  middlewares partagés arrivent par S (voir « Routes par domaine » en fin de server.js).
// ============================================================
module.exports = function register(app, S) {
    const { applyUpgrades, atelierResponsibleId, broadcast, caBetween, caByMethod, canSeeCA, caTodayOnly, hasFullCA, clientError, closedDayBlock,
        daysUntil, dbAll, dbGet, dbRun, displaySerial, exitFindSale, exitState, getDate, getDateTime, getSaleFull,
        getSettingsAsync, hasRole, invoiceRef, logActivity, logGarantie, nextSaleNumber, normalizePayments,
        PAY_METHODS, POS_SELLABLE, posNotOut, pushNotification, recordMovement, recordSalePayments, requireAdmin,
        requireAuth, requireRole, resolveNotifs, restoreSaleUnits, salePaymentsSnapshot, SELLABLE,
        starlinkAddressError, txError, unitCost, validateUpgrades, withTx } = S;

// Profits réalisés sur les ventes (admin) — style TECHFLOW.
app.get('/api/profits', requireAuth, requireAdmin, async (req, res) => {
    try {
        if (!(await hasFullCA(req.session.user))) return res.status(403).json({ error: 'Profits réservés au compte autorisé (Configuration › Accès aux chiffres).' });
        const { from, to } = req.query;
        const w = ["s.status != 'returned'"], p = [];
        if (from) { w.push('date(s.sale_date) >= date(?)'); p.push(from); }
        if (to)   { w.push('date(s.sale_date) <= date(?)'); p.push(to); }
        const rows = await dbAll(
            `SELECT s.id, s.sale_number, s.sale_date, s.created_at, s.client_name, s.channel, s.commercial_name,
                    si.unit_price, si.returned, si.product_name AS si_name, si.serial,
                    p.purchase_price, p.name AS product_name, p.category, p.brand, p.is_accessory
             FROM sales s
             JOIN sale_items si ON si.sale_id = s.id
             LEFT JOIN products p ON p.id = si.product_id
             WHERE ${w.join(' AND ')}
             ORDER BY s.created_at DESC`, p);
        const salesMap = new Map();
        let tRevenue = 0, tCost = 0, tProfit = 0, estimatedItems = 0;
        for (const r of rows) {
            if (r.returned) continue;
            const price = parseFloat(r.unit_price) || 0;
            const c = unitCost(r.purchase_price, price, r.is_accessory);
            const profit = price - c.cost;
            tRevenue += price; tCost += c.cost; tProfit += profit;
            if (c.estimated) estimatedItems++;
            let s = salesMap.get(r.id);
            if (!s) {
                s = { id: r.id, sale_number: r.sale_number, sale_date: r.sale_date, created_at: r.created_at,
                      client_name: r.client_name, channel: r.channel, commercial_name: r.commercial_name,
                      revenue: 0, cost: 0, profit: 0, has_estimate: false, items: [] };
                salesMap.set(r.id, s);
            }
            s.revenue += price; s.cost += c.cost; s.profit += profit;
            if (c.estimated) s.has_estimate = true;
            s.items.push({ name: r.product_name || r.si_name, serial: r.serial, price, cost: c.cost, profit, estimated: c.estimated });
        }
        res.json({
            totals: { revenue: tRevenue, cost: tCost, profit: tProfit,
                      margin: tRevenue ? tProfit / tRevenue : 0, estimated_items: estimatedItems,
                      sales_count: salesMap.size },
            sales: Array.from(salesMap.values())
        });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Liste des commerciaux (vendeurs) pour la caisse.
app.get('/api/commercials', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const rows = await dbAll(`SELECT id, full_name, username FROM users WHERE role IN ('commercial','commercial_ligne') AND active = 1 ORDER BY full_name`);
        res.json(rows.map(u => ({ id: u.id, name: u.full_name || u.username })));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Brouillons de panier (POS) ──────────────────────────────────────────────
// Liste des brouillons du caissier courant (les plus récents d'abord).
app.get('/api/pos/drafts', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT id, label, item_count, total, created_at FROM pos_drafts WHERE cashier_id = ? ORDER BY id DESC`,
            [req.session.user.id]);
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Détail d'un brouillon (données du panier), avec le statut actuel de chaque unité.
app.get('/api/pos/drafts/:id', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const d = await dbGet(`SELECT * FROM pos_drafts WHERE id = ? AND cashier_id = ?`, [req.params.id, req.session.user.id]);
        if (!d) return res.status(404).json({ error: 'Brouillon introuvable' });
        let data = {};
        try { data = JSON.parse(d.data || '{}'); } catch (_) { data = {}; }
        const items = Array.isArray(data.items) ? data.items : [];
        const ids = items.map(it => it.id).filter(Boolean);
        let statusById = {};
        if (ids.length) {
            const units = await dbAll(
                `SELECT id, status FROM stock_units WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
            units.forEach(u => { statusById[u.id] = u.status; });
        }
        // Marque chaque ligne : disponible si l'unité existe encore et reste vendable.
        const enriched = items.map(it => ({
            ...it,
            current_status: statusById[it.id] || null,
            available: it.id ? POS_SELLABLE.includes(statusById[it.id]) : false
        }));
        res.json({ id: d.id, label: d.label, discount: data.discount || { type: 'value', value: 0 }, upgrades: Array.isArray(data.upgrades) ? data.upgrades : [], items: enriched });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Enregistre un brouillon de panier.
app.post('/api/pos/drafts', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const { label, items, discount, upgrades } = req.body || {};
        if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Panier vide' });
        const data = JSON.stringify({ items, discount: discount || { type: 'value', value: 0 }, upgrades: Array.isArray(upgrades) ? upgrades : [] });
        const total = items.reduce((s, it) => s + (it.gift ? 0 : Number(it.price) || 0), 0);
        const name = req.session.user.full_name || req.session.user.username || '';
        const r = await dbRun(
            `INSERT INTO pos_drafts (cashier_id, cashier_name, label, item_count, total, data, created_at)
             VALUES (?,?,?,?,?,?,?)`,
            [req.session.user.id, name, (label || '').trim() || null, items.length, total, data, getDateTime()]);
        res.json({ success: true, id: r.lastID });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Supprime un brouillon (après reprise ou abandon).
app.delete('/api/pos/drafts/:id', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        await dbRun(`DELETE FROM pos_drafts WHERE id = ? AND cashier_id = ?`, [req.params.id, req.session.user.id]);
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Factures proforma (devis) ──────────────────────────────────────────────
// Créer/historiser une proforma. Référence séquentielle par année : PRO-AAAA-NNNN.
app.post('/api/proformas', requireAuth, requireRole('caisse', 'admin'), async (req, res) => {
    try {
        const b = req.body || {};
        const dest = b.dest || {};
        if (!dest.name || !String(dest.name).trim()) return res.status(400).json({ error: 'Nom du destinataire requis' });
        { const cErr = clientError(dest.name, dest.contact); if (cErr) return res.status(400).json({ error: cErr }); }
        const lines = (Array.isArray(b.lines) ? b.lines : []).filter(l => l && l.designation).map(l => ({
            designation: String(l.designation || ''), detail: String(l.detail || ''), pitch: String(l.pitch || ''),
            qty: Math.max(1, parseInt(l.qty, 10) || 1), unit: String(l.unit || 'pièce'), pu: Math.max(0, parseFloat(l.pu) || 0)
        }));
        if (!lines.length) return res.status(400).json({ error: 'Aucune ligne' });
        const total = lines.reduce((s, l) => s + Math.round(l.qty * l.pu), 0);
        const year = getDate().slice(0, 4);   // année à Madagascar (pas celle du fuseau du serveur)
        const now = getDateTime();
        // Numéro + insertion dans la même transaction : deux proformas simultanées n'ont pas la même référence.
        const { r, ref } = await withTx(async () => {
        const last = await dbGet(`SELECT ref FROM proformas WHERE ref LIKE ? ORDER BY id DESC LIMIT 1`, [`PRO-${year}-%`]);
        const seq = last && last.ref ? (parseInt(String(last.ref).split('-').pop(), 10) || 0) + 1 : 1;
        const ref = `PRO-${year}-${String(seq).padStart(4, '0')}`;
        const r = await dbRun(
            `INSERT INTO proformas (ref, dest_name, dest_contact, dest_address, dest_nif, dest_stat, dest_email, objet, lines, total, created_by_id, created_by_name, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [ref, String(dest.name).trim(), String(dest.contact).trim(), (dest.address || '').trim() || null,
             (dest.nif || '').trim() || null, (dest.stat || '').trim() || null, (dest.email || '').trim() || null,
             (b.objet || '').trim() || null, JSON.stringify(lines), total,
             req.session.user.id, req.session.user.full_name || req.session.user.username, now]);
        return { r, ref };
        });
        logActivity(req, 'proforma_create', 'proforma', r.lastID, { ref, total });
        res.json({ success: true, id: r.lastID, ref, created_at: now });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Liste (historique) des proformas — filtres date + recherche.
app.get('/api/proformas', requireAuth, requireRole('caisse', 'admin'), async (req, res) => {
    try {
        const { from, to, search } = req.query;
        const w = [], p = [];
        if (from)   { w.push('date(created_at) >= date(?)'); p.push(from); }
        if (to)     { w.push('date(created_at) <= date(?)'); p.push(to); }
        if (search) { w.push('(ref LIKE ? OR dest_name LIKE ? OR dest_contact LIKE ?)'); const l = `%${search}%`; p.push(l, l, l); }
        const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
        const rows = await dbAll(
            `SELECT id, ref, dest_name, dest_contact, total, created_by_name, created_at
             FROM proformas ${where} ORDER BY id DESC LIMIT 300`, p);
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Détail d'une proforma (pour revoir / réimprimer).
app.get('/api/proformas/:id', requireAuth, requireRole('caisse', 'admin'), async (req, res) => {
    try {
        const r = await dbGet('SELECT * FROM proformas WHERE id = ?', [req.params.id]);
        if (!r) return res.status(404).json({ error: 'Proforma introuvable' });
        let lines = [];
        try { lines = JSON.parse(r.lines || '[]'); } catch (e) {}
        res.json({ ...r, lines });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/sales', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const { client, commercial_id, payment, note, channel } = req.body;
        const unit_ids = Array.isArray(req.body.unit_ids) ? req.body.unit_ids : [];
        const serviceIds = Array.isArray(req.body.services) ? req.body.services.map(Number).filter(Boolean) : [];
        if (!unit_ids.length && !serviceIds.length) return res.status(400).json({ error: 'Panier vide' });

        // Unités vendables.
        let units = [];
        if (unit_ids.length) {
            const ph = unit_ids.map(() => '?').join(',');
            units = await dbAll(
                `SELECT u.*, p.name AS product_name, p.is_accessory, p.category FROM stock_units u LEFT JOIN products p ON p.id = u.product_id
                 WHERE u.id IN (${ph})`, unit_ids);
            if (units.length !== unit_ids.length) return res.status(400).json({ error: 'Certaines unités sont introuvables' });
        }
        // Services (illimité, sans stock) : chaque occurrence = son prix encaissé.
        const services = [];
        for (const sid of serviceIds) {
            const sp = await dbGet(`SELECT id, name, sale_price, service_atelier FROM products WHERE id = ? AND is_service = 1`, [sid]);
            if (!sp) return res.status(400).json({ error: 'Service introuvable' });
            services.push(sp);
        }
        const notSellable = units.find(u => !POS_SELLABLE.includes(u.status));
        if (notSellable) return res.status(400).json({ error: posNotOut(notSellable) });

        // Service atelier sur l'ordinateur du CLIENT : référence, RAM, stockage et chargeur obligatoires.
        // Exception : le service porte sur un ordinateur vendu dans cette même vente (case cochée à la caisse).
        const atelierServices = services.filter(sp => sp.service_atelier);
        const cpc = req.body.client_pc || {};
        const onSoldPc = !!cpc.on_sold_pc && units.some(u => !u.is_accessory);
        let clientPc = null;
        if (atelierServices.length && !onSoldPc) {
            const t = v => String(v == null ? '' : v).trim().slice(0, 200);
            clientPc = { pc: t(cpc.pc), ram: t(cpc.ram), storage: t(cpc.storage), charger: ['avec', 'sans'].includes(cpc.charger) ? cpc.charger : '', note: t(cpc.note) || null };
            if (!clientPc.pc || !clientPc.ram || !clientPc.storage || !clientPc.charger)
                return res.status(400).json({ error: "Ordinateur du client : référence, RAM, stockage et chargeur (avec / sans) obligatoires" });
        }

        // Cadeaux : unités offertes (prix 0, décomptées du stock). Réservé aux accessoires.
        const giftSet = new Set((Array.isArray(req.body.gifts) ? req.body.gifts : []).map(Number));
        const giftBadPc = units.find(u => giftSet.has(u.id) && !u.is_accessory);
        if (giftBadPc) return res.status(400).json({ error: 'Seuls les accessoires peuvent être offerts (cadeau).' });
        const priceOf = u => giftSet.has(u.id) ? 0 : (u.sale_price || 0);
        const servicesSubtotal = services.reduce((s, sp) => s + (sp.sale_price || 0), 0);
        const subtotal = units.reduce((s, u) => s + priceOf(u), 0) + servicesSubtotal;
        // Remise globale : pourcentage ou valeur fixe (bornée au sous-total).
        const disc = req.body.discount || {};
        const discType = disc.type === 'percent' || disc.type === 'value' ? disc.type : null;
        const discValue = Math.max(0, parseFloat(disc.value) || 0);
        let discountAmount = 0;
        if (discType === 'percent') discountAmount = Math.round(subtotal * Math.min(discValue, 100) / 100);
        else if (discType === 'value') discountAmount = Math.min(discValue, subtotal);

        // Pack cadeau : forfait FIXE ajouté dès qu'au moins un accessoire est offert (peu importe leur valeur).
        const settings = await getSettingsAsync();
        const giftPackAmount = Math.max(0, Math.round(parseFloat(settings.gift_pack_amount) || 0));
        const giftPack = giftSet.size > 0 ? giftPackAmount : 0;

        // Upgrades de composants (Stockage/RAM/…) : le client paie l'écart, composant neuf du stock, ancien repris.
        const upg = await validateUpgrades(req.body.upgrades, units);
        if (upg.error) return res.status(400).json({ error: upg.error });

        const total = Math.max(0, subtotal - discountAmount) + giftPack + upg.total;
        const now = getDateTime(), today = getDate();

        // Paiement (méthode unique ou mixte) — validé une fois le total connu.
        // Paiement PARTIEL : seulement si la vente comporte un service atelier ; le reste (≤ prix des services
        // atelier) sera payé à la récupération de l'ordinateur (page Encaissements > Atelier).
        let paidNow = total, balanceDue = 0;
        if (req.body.partial_amount != null && req.body.partial_amount !== '') {
            const atelierTotal = services.filter(sp => sp.service_atelier).reduce((x, sp) => x + (sp.sale_price || 0), 0);
            if (!atelierTotal) return res.status(400).json({ error: 'Paiement partiel réservé aux ventes avec un service atelier' });
            paidNow = Math.round(parseFloat(req.body.partial_amount) || 0);
            if (paidNow <= 0) return res.status(400).json({ error: 'Montant payé requis (supérieur à 0)' });
            if (paidNow >= total) { paidNow = total; }
            balanceDue = total - paidNow;
            if (balanceDue > atelierTotal)
                return res.status(400).json({ error: `Le reste à payer (${Math.round(balanceDue)} Ar) ne peut pas dépasser le prix du service atelier (${Math.round(atelierTotal)} Ar) : le matériel se paie en entier.` });
        }
        const pay = normalizePayments(payment, paidNow);
        if (pay.error) return res.status(400).json({ error: pay.error });

        // Client : nom ET numéro OBLIGATOIRES sur toute vente caisse.
        const clientName = String((client && client.name) || '').trim();
        const clientPhone = String((client && client.phone) || '').trim();
        const cErr = clientError(clientName, clientPhone) || starlinkAddressError(units, client);
        if (cErr) return res.status(400).json({ error: cErr });
        // Écriture ATOMIQUE (client, vente, paiements, lignes, unités, mouvements, upgrades, étiquette,
        // réservations) : tout ou rien. Chaque unité est revérifiée dans la transaction (vendue entre-temps
        // par une autre caisse → 409, rien n'est écrit).
        let saleId, saleNumber, commercialName = null;
        const soldPresentoir = [];
        await withTx(async () => {
            let clientId = null;
            {
                const c = await dbRun(`INSERT INTO clients (name, phone, address, created_at) VALUES (?, ?, ?, ?)`,
                    [clientName, clientPhone, (client && client.address) || null, now]);
                clientId = c.lastID;
            }
            // Commercial (vendeur).
            if (commercial_id) { const cu = await dbGet('SELECT full_name, username FROM users WHERE id = ?', [commercial_id]); if (cu) commercialName = cu.full_name || cu.username; }

            // Numéro de vente du jour.
            saleNumber = await nextSaleNumber(today);

            const sale = await dbRun(
                `INSERT INTO sales (sale_number, sale_date, client_id, client_name, client_phone, client_address, client_nif, client_stat, client_rcs, commercial_id, commercial_name, cashier_id, cashier_name, total, discount_type, discount_value, discount_amount, gift_pack, payment_method, payment_ref, payment_phone, channel, note, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                [saleNumber, today, clientId, clientName, clientPhone, client && client.address || null,
                 client && client.nif || null, client && client.stat || null, client && client.rcs || null,
                 commercial_id || null, commercialName, req.session.user.id, req.session.user.full_name || req.session.user.username,
                 total, discType, discValue, discountAmount, giftPack, pay.primary, pay.first.ref || null, pay.first.phone || null, channel || 'boutique', note || null, now]);
            saleId = sale.lastID;
            await recordSalePayments(saleId, pay.lines, now);
            if (balanceDue > 0) await dbRun('UPDATE sales SET balance_due = ? WHERE id = ?', [balanceDue, saleId]);

            const pcSaleItemByUnit = new Map();   // unit_id → sale_item.id (pour rattacher les upgrades)
            for (const u of units) {
                const gift = giftSet.has(u.id);
                const si = await dbRun(`INSERT INTO sale_items (sale_id, unit_id, serial, product_id, product_name, unit_price, is_gift) VALUES (?,?,?,?,?,?,?)`,
                    [saleId, u.id, displaySerial(u), u.product_id, u.product_name, gift ? 0 : (u.sale_price || 0), gift ? 1 : 0]);
                pcSaleItemByUnit.set(u.id, si.lastID);
                const upd = await dbRun(`UPDATE stock_units SET status = 'vendu', holder_user_id = NULL, updated_at = ? WHERE id = ? AND status = ?`, [now, u.id, u.status]);
                if (upd.changes !== 1) throw txError(409, `Unité ${u.serial} déjà vendue ou déplacée entre-temps — rechargez le panier`);
                await recordMovement(u, 'vendu', 'vente', req, { from: u.status, ref_type: 'sale', ref_id: saleId, note: `Vente #${saleNumber}` });
                if (u.status === 'presentoir') soldPresentoir.push(u);
            }
            // (Ancienne réaffectation « accessoire fongible » retirée : la caisse ne vend plus d'unité encore
            //  au dépôt — POS_SELLABLE exclut 'stock' —, ce cas ne pouvait donc plus se produire.)
            // Services (illimité) : une ligne de vente par occurrence, sans unité ni décompte de stock.
            for (const sp of services) {
                await dbRun(`INSERT INTO sale_items (sale_id, unit_id, serial, product_id, product_name, unit_price, is_service) VALUES (?, NULL, NULL, ?, ?, ?, 1)`,
                    [saleId, sp.id, sp.name, sp.sale_price || 0]);
            }
            // Upgrades : consomme les composants neufs, reçoit les anciens au stock, journalise.
            if (upg.upgrades.length) {
                await applyUpgrades(saleId, upg.upgrades, pcSaleItemByUnit, req, now, true);
                const kept = upg.upgrades.filter(u => u.keep);
                if (kept.length)
                    pushNotification({ target_role: 'gestion_stock', type: 'warn', persistent: true, title: 'Composant repris à réceptionner',
                        message: `Vente #${saleNumber} — ${kept.map(u => u.old_value).join(', ')} retiré(s) d'un ordinateur (upgrade) : à valider au dépôt.`,
                        link: '/retour.html', ref: `return:sale:${saleId}` });
            }

            // Ordinateur du client (service atelier) : fiche sur la vente (facture) + étiquette à imprimer.
            if (clientPc) {
                await dbRun(`UPDATE sales SET client_pc = ?, client_pc_ram = ?, client_pc_storage = ?, client_pc_charger = ?, client_pc_note = ? WHERE id = ?`,
                    [clientPc.pc, clientPc.ram, clientPc.storage, clientPc.charger, clientPc.note, saleId]);
                const lb = await dbRun(`INSERT INTO atelier_labels (sale_id, services, status, created_at, created_by_name,
                        sale_number, sale_date, sale_created_at, client_name, client_phone, client_pc, client_pc_ram, client_pc_storage,
                        client_pc_charger, client_pc_note, cashier_name, commercial_name)
                     VALUES (?, ?, 'a_imprimer', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [saleId, atelierServices.map(sp => sp.name).join(' + '), now, req.session.user.full_name || req.session.user.username,
                     saleNumber, today, now, clientName, clientPhone, clientPc.pc, clientPc.ram, clientPc.storage, clientPc.charger, clientPc.note,
                     req.session.user.full_name || req.session.user.username, commercialName]);
                const atelierRid = await atelierResponsibleId();
                pushNotification({ ...(atelierRid ? { target_user: atelierRid } : { target_role: 'admin' }), type: 'info', title: `Étiquette à imprimer — facture ${saleNumber}`,
                    message: `${clientName} · ${clientPc.pc} (${atelierServices.map(sp => sp.name).join(', ')})`,
                    link: '/service-atelier.html', ref: `atelier_label:${lb.lastID}`, data: { label_id: lb.lastID, sale_id: saleId } });
                broadcast('atelier:update', { label_id: lb.lastID });
            }

            // Unité issue d'une RÉSERVATION (« à vendre ») vendue au comptoir : on solde la réservation
            // dès qu'aucune de ses unités n'est plus réservée (la vente POS est la clôture normale, à la
            // place de l'ancien « encaisser la réservation »). Suivi dans « Suivi boutique ».
            let reservationClosed = false;
            for (const u of units) {
                if (u.status !== 'reserve') continue;
                const ri = await dbGet('SELECT reservation_id FROM reservation_items WHERE unit_id = ?', [u.id]);
                if (!ri) continue;
                const left = await dbGet(
                    `SELECT COUNT(*) AS n FROM reservation_items i JOIN stock_units su ON su.id = i.unit_id
                     WHERE i.reservation_id = ? AND su.status = 'reserve'`, [ri.reservation_id]);
                if ((left.n || 0) === 0) {
                    await dbRun(`UPDATE reservations SET status = 'vendu', sale_id = ? WHERE id = ? AND status = 'active'`, [saleId, ri.reservation_id]);
                    resolveNotifs(`reservation:${ri.reservation_id}`);
                    reservationClosed = true;
                }
            }
            if (reservationClosed) broadcast('reservation:update', {});
        });

        // Notifications gestionnaire : vente + présentoir vendu + stock faible.
        pushNotification({ target_role: 'gestion_stock', type: 'success', title: `Vente #${saleNumber}`,
            message: `${units.length + services.length} ligne(s) · ${Math.round(total)} Ar`, link: '/sales.html', data: { sale_id: saleId } });
        for (const u of soldPresentoir)
            pushNotification({ target_role: 'gestion_stock', type: 'warn', title: 'Présentoir vendu',
                message: `${u.product_name} (${u.serial}) vendu depuis le présentoir — à remplacer.`, link: '/stock.html', data: { product_id: u.product_id } });
        // Dernière(s) pièce(s).
        const prodIds = [...new Set(units.map(u => u.product_id))];
        for (const pid of prodIds) {
            const left = await dbGet(`SELECT COUNT(*) AS n FROM stock_units WHERE product_id = ? AND status = 'stock'`, [pid]);
            if (left.n <= 1) {
                const p = await dbGet('SELECT name FROM products WHERE id = ?', [pid]);
                pushNotification({ target_role: 'gestion_stock', type: 'warn', title: 'Stock faible',
                    message: `${p ? p.name : 'Produit'} : ${left.n} pièce(s) disponible(s).`, link: '/stock.html', data: { product_id: pid } });
            }
        }

        logActivity(req, 'sale', 'sale', saleId, { number: saleNumber, total, method: pay.primary });
        broadcast('sale:new', { sale_id: saleId, number: saleNumber });
        broadcast('stock:update', {});
        const full = await getSaleFull(saleId);
        res.json({ success: true, sale: full });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Vente MANUELLE rétroactive (admin) : régularise une vente non enregistrée à sa date réelle.
// Les unités quittent le stock immédiatement ; la vente est comptée dans la caisse de la date choisie.
app.post('/api/sales/manual', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const { sale_date, client, commercial_id, unit_ids, payment, note } = req.body;
        if (!Array.isArray(unit_ids) || !unit_ids.length) return res.status(400).json({ error: 'Aucun article' });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(sale_date || '')) return res.status(400).json({ error: 'Date invalide' });
        if (sale_date > getDate()) return res.status(400).json({ error: 'La date ne peut pas être dans le futur' });
        { const cErr = clientError(client && client.name, client && client.phone); if (cErr) return res.status(400).json({ error: cErr }); }
        const closed = await closedDayBlock(req, sale_date);
        if (closed && closed.error) return res.status(409).json(closed);

        const ph = unit_ids.map(() => '?').join(',');
        const units = await dbAll(
            `SELECT u.*, p.name AS product_name FROM stock_units u LEFT JOIN products p ON p.id = u.product_id WHERE u.id IN (${ph})`, unit_ids);
        if (units.length !== unit_ids.length) return res.status(400).json({ error: 'Certaines unités sont introuvables' });
        const notSellable = units.find(u => !SELLABLE.includes(u.status));
        if (notSellable) return res.status(400).json({ error: `Unité ${notSellable.serial} non vendable (${notSellable.status})` });

        const total = units.reduce((s, u) => s + (u.sale_price || 0), 0);
        const pay = normalizePayments(payment && payment.method ? payment : { method: 'especes' }, total);
        if (pay.error) return res.status(400).json({ error: pay.error });
        // created_at = date choisie + heure courante → apparaît dans l'historique de cette date.
        const createdAt = `${sale_date} ${getDateTime().slice(11)}`;

        const { saleId, saleNumber } = await withTx(async () => {
        let clientId = null;
        if (client && (client.name || client.phone)) {
            const c = await dbRun(`INSERT INTO clients (name, phone, address, created_at) VALUES (?, ?, ?, ?)`,
                [client.name || null, client.phone || null, client.address || null, createdAt]);
            clientId = c.lastID;
        }
        let commercialName = null;
        if (commercial_id) { const cu = await dbGet('SELECT full_name, username FROM users WHERE id = ?', [commercial_id]); if (cu) commercialName = cu.full_name || cu.username; }

        const saleNumber = await nextSaleNumber(sale_date);

        const sale = await dbRun(
            `INSERT INTO sales (sale_number, sale_date, client_id, client_name, client_phone, client_address, commercial_id, commercial_name, cashier_id, cashier_name, total, payment_method, payment_ref, payment_phone, channel, status, note, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'boutique', 'completed', ?, ?)`,
            [saleNumber, sale_date, clientId, client && client.name || null, client && client.phone || null, client && client.address || null,
             commercial_id || null, commercialName, req.session.user.id, req.session.user.full_name || req.session.user.username,
             total, pay.primary, pay.first.ref || null, pay.first.phone || null, ('Régularisation — ' + (note || 'vente non enregistrée')), createdAt]);
        const saleId = sale.lastID;
        await recordSalePayments(saleId, pay.lines, createdAt);

        for (const u of units) {
            await dbRun(`INSERT INTO sale_items (sale_id, unit_id, serial, product_id, product_name, unit_price) VALUES (?,?,?,?,?,?)`,
                [saleId, u.id, u.serial, u.product_id, u.product_name, u.sale_price || 0]);
            const upd = await dbRun(`UPDATE stock_units SET status = 'vendu', holder_user_id = NULL, updated_at = ? WHERE id = ? AND status = ?`, [createdAt, u.id, u.status]);
            if (upd.changes !== 1) throw txError(409, `Unité ${u.serial} vendue ou déplacée entre-temps — rechargez.`);
            await recordMovement(u, 'vendu', 'vente', req, { from: u.status, ref_type: 'sale', ref_id: saleId, note: `Régularisation vente #${saleNumber} (${sale_date})` });
        }
        return { saleId, saleNumber };
        });

        logActivity(req, 'sale_manual', 'sale', saleId, { number: saleNumber, total, sale_date, closed_day: !!(closed && closed.forced) });
        broadcast('sale:new', { sale_id: saleId, number: saleNumber });
        broadcast('stock:update', {});
        res.json({ success: true, sale: await getSaleFull(saleId) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.get('/api/exit-check/lookup', requireAuth, requireRole('securite'), async (req, res) => {
    try {
        const f = await exitFindSale(req.query.q);
        if (f.error) return res.status(404).json({ error: f.error });
        const s = f.sale;
        const st = await exitState(s);
        const items = await dbAll(`SELECT si.id, si.serial, si.product_name, si.is_service, si.returned, u.manufacturer_sn, u.router_id, u.serial AS unit_serial,
                p.brand, p.model, p.cpu, p.ram, p.storage, p.is_accessory
            FROM sale_items si LEFT JOIN stock_units u ON u.id = si.unit_id LEFT JOIN products p ON p.id = si.product_id
            WHERE si.sale_id = ? ORDER BY si.id`, [s.id]);
        const previous = await dbAll('SELECT checked_at, checked_by_name, status, items_checked, items_total, note FROM exit_checks WHERE sale_id = ? ORDER BY id DESC', [s.id]);
        const { d } = st;
        res.json({
            sale: { id: s.id, ref: invoiceRef(s), sale_number: s.sale_number, created_at: s.created_at, status: s.status, channel: s.channel,
                    client_name: s.client_name, client_phone: s.client_phone, cashier_name: s.cashier_name, commercial_name: s.commercial_name,
                    total: s.total, client_pc: s.client_pc },
            delivery: d ? { id: d.id, number: d.delivery_number, livreur: d.livreur_name, status: d.status, address: d.client_address } : null,
            state: st.state, block: st.block, label: st.label, detail: st.detail, due: st.due || 0,
            items: items.filter(it => !it.is_service).map(it => ({ id: it.id, name: [it.brand, it.model].filter(Boolean).join(' ') || it.product_name,
                spec: [it.cpu, it.ram, it.storage].filter(Boolean).join(' · '), serial: it.serial || it.unit_serial, sn: it.manufacturer_sn, router: it.router_id || null, returned: !!it.returned })),
            services: items.filter(it => it.is_service).map(it => it.product_name),
            previous
        });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// Enregistre la sortie (ou une anomalie signalée) : heure, agent, articles vérifiés.
app.post('/api/exit-check', requireAuth, requireRole('securite'), async (req, res) => {
    try {
        const s = await dbGet('SELECT * FROM sales WHERE id = ?', [parseInt(req.body.sale_id, 10)]);
        if (!s) return res.status(404).json({ error: 'Vente introuvable' });
        const st = await exitState(s);
        const anomaly = !!req.body.anomaly;
        const note = String(req.body.note || '').trim().slice(0, 500);
        const total = Math.max(0, parseInt(req.body.items_total, 10) || 0);
        const checked = Math.min(total, Math.max(0, parseInt(req.body.items_checked, 10) || 0));
        if (!anomaly && st.block) return res.status(400).json({ error: `${st.label} : ${st.detail}` });
        if (!anomaly && checked < total && !note) return res.status(400).json({ error: 'Tous les articles ne sont pas cochés : indiquez un motif ou signalez une anomalie.' });
        if (anomaly && !note) return res.status(400).json({ error: "Décrivez l'anomalie" });
        const me = req.session.user, now = getDateTime(), ref = invoiceRef(s);
        const status = anomaly ? 'anomalie' : 'ok';
        const r = await dbRun(`INSERT INTO exit_checks (sale_id, sale_ref, delivery_id, kind, payment_state, amount_due, items_total, items_checked, status, note, checked_by_id, checked_by_name, checked_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [s.id, ref, st.d ? st.d.id : null, st.d ? 'livraison' : 'client', st.state, st.due || 0, total, checked, status, note || null, me.id, me.full_name || me.username, now]);
        logActivity(req, 'exit_check', 'sale', s.id, { ref, status, state: st.state, items: `${checked}/${total}`, note });
        if (anomaly || checked < total)
            pushNotification({ target_role: 'admin', type: anomaly ? 'danger' : 'warn', title: anomaly ? `Anomalie à la sortie — facture ${ref}` : `Sortie incomplète — facture ${ref}`,
                message: `${me.full_name || me.username} : ${note || ''} (${checked}/${total} article(s) vérifié(s), ${st.label})`, link: '/controle-sortie.html', data: { sale_id: s.id } });
        broadcast('exit:update', { sale_id: s.id });
        res.json({ success: true, id: r.lastID, checked_at: now, status });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// À contrôler : ventes du jour + livraisons sorties du stock (en cours), avec au moins un article physique,
// sans sortie validée. L'agent choisit dans la liste au lieu de saisir la référence.
app.get('/api/exit-check/pending', requireAuth, requireRole('securite'), async (req, res) => {
    try {
        const today = getDate();
        const rows = await dbAll(`SELECT s.*, d.id AS d_id, d.status AS d_status, d.released_at AS d_released_at
            FROM sales s LEFT JOIN deliveries d ON d.sale_id = s.id
            WHERE s.status NOT IN ('annulee','returned','exchanged') AND COALESCE(s.note,'') NOT LIKE 'Régularisation%'
              AND EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id = s.id AND COALESCE(si.is_service,0) = 0 AND COALESCE(si.returned,0) = 0)
              AND (
                   -- Livraison sortie aujourd'hui, MÊME si la caisse l'a déjà confirmée « livrée » (souvent quelques
                   -- secondes après la sortie) ; livraison facturée mais pas encore sortie du stock : affichée
                   -- « NE PAS LAISSER SORTIR » pour que l'agent arrête le livreur qui part sans scan du stock.
                   (((d.id IS NULL AND s.sale_date = ?) OR (d.status IN ('en_livraison','livree') AND d.released_at >= ?)
                     OR (d.status = 'facturee' AND d.released_at IS NULL))
                     AND NOT EXISTS (SELECT 1 FROM exit_checks e WHERE e.sale_id = s.id AND e.status = 'ok'))
                   -- Pièce de REMPLACEMENT (échange livraison validé aujourd'hui) : nouvelle sortie à contrôler,
                   -- même si la livraison avait déjà été contrôlée avant l'échange.
                OR (d.id IS NOT NULL AND EXISTS (SELECT 1 FROM exchange_requests er WHERE er.kind = 'delivery' AND er.ref_id = d.id
                        AND er.status = 'validated' AND substr(er.resolved_at, 1, 10) = ?
                        AND NOT EXISTS (SELECT 1 FROM exit_checks e WHERE e.sale_id = s.id AND e.status = 'ok' AND e.checked_at >= er.resolved_at)))
              )
            ORDER BY COALESCE(d.released_at, 0) DESC, s.created_at DESC LIMIT 200`, [today, Date.parse(`${today}T00:00:00+03:00`), today]);
        const out = [];
        for (const s of rows) {
            const st = await exitState(s);
            const its = await dbAll(`SELECT COALESCE(NULLIF(TRIM(COALESCE(p.brand,'') || ' ' || COALESCE(p.model,'')), ''), si.product_name) AS name
                FROM sale_items si LEFT JOIN products p ON p.id = si.product_id
                WHERE si.sale_id = ? AND COALESCE(si.is_service,0) = 0 AND COALESCE(si.returned,0) = 0 ORDER BY si.id`, [s.id]);
            const anomaly = await dbGet(`SELECT 1 FROM exit_checks WHERE sale_id = ? AND status = 'anomalie' LIMIT 1`, [s.id]);
            const exr = st.d ? await dbGet(`SELECT serial, new_serial, requested_by_name FROM exchange_requests WHERE kind = 'delivery' AND ref_id = ? AND status = 'validated'
                AND substr(resolved_at, 1, 10) = ? ORDER BY id DESC LIMIT 1`, [st.d.id, today]) : null;
            out.push({ id: s.id, ref: invoiceRef(s), sale_number: s.sale_number, created_at: s.created_at, client_name: s.client_name,
                kind: st.d ? 'livraison' : 'client', delivery_number: st.d ? st.d.delivery_number : null, livreur: st.d ? st.d.livreur_name : null,
                released_at: st.d ? st.d.released_at : null, state: st.state, block: st.block, label: st.label, due: st.due || 0,
                items: its.map(i => i.name), anomaly: !!anomaly,
                exchange: exr ? { old: exr.serial, new: exr.new_serial, by: exr.requested_by_name } : null });
        }
        // Plus récent d'abord (heure de sortie du stock pour une livraison, heure de la vente sinon).
        const t = r => r.released_at || Date.parse(String(r.created_at || '').replace(' ', 'T') + '+03:00') || 0;
        res.json(out.sort((a, b) => t(b) - t(a)));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// Historique des contrôles d'une journée.
app.get('/api/exit-check/history', requireAuth, requireRole('securite'), async (req, res) => {
    try {
        const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : getDate();
        res.json(await dbAll(`SELECT e.*, s.client_name, s.total, s.sale_number FROM exit_checks e LEFT JOIN sales s ON s.id = e.sale_id
            WHERE substr(e.checked_at, 1, 10) = ? ORDER BY e.id DESC`, [date]));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Détail d'une vente (client, téléphone…) : uniquement les rôles qui manipulent des ventes / factures
// (plus le technicien ni l'agent de sécurité, qui a son propre écran de contrôle de sortie).
app.get('/api/sales/:id', requireAuth, requireRole('caisse', 'gestion_stock', 'commercial', 'commercial_ligne', 'coordinateur'), async (req, res) => {
    try {
        const full = await getSaleFull(req.params.id);
        if (!full) return res.status(404).json({ error: 'Vente introuvable' });
        res.json(full);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.patch('/api/sales/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const s = await dbGet('SELECT * FROM sales WHERE id = ?', [req.params.id]);
        if (!s) return res.status(404).json({ error: 'Vente introuvable' });
        const b = req.body, set = [], p = [];
        if (b.client_name !== undefined || b.client_phone !== undefined) {
            const cErr = clientError(b.client_name !== undefined ? b.client_name : s.client_name, b.client_phone !== undefined ? b.client_phone : s.client_phone);
            if (cErr) return res.status(400).json({ error: cErr });
        }
        if (b.payment_method !== undefined) {
            if (!PAY_METHODS.includes(b.payment_method)) return res.status(400).json({ error: 'Mode de paiement invalide' });
            set.push('payment_method = ?'); p.push(b.payment_method);
        }
        if (b.payment_ref !== undefined)     { set.push('payment_ref = ?');     p.push((b.payment_ref || '').trim() || null); }
        if (b.payment_phone !== undefined)   { set.push('payment_phone = ?');   p.push((b.payment_phone || '').trim() || null); }
        if (b.client_name !== undefined)     { set.push('client_name = ?');     p.push((b.client_name || '').trim() || null); }
        if (b.client_phone !== undefined)    { set.push('client_phone = ?');    p.push((b.client_phone || '').trim() || null); }
        if (b.client_address !== undefined)  { set.push('client_address = ?');  p.push((b.client_address || '').trim() || null); }
        if (b.client_nif !== undefined)      { set.push('client_nif = ?');      p.push((b.client_nif || '').trim() || null); }
        if (b.client_stat !== undefined)     { set.push('client_stat = ?');     p.push((b.client_stat || '').trim() || null); }
        if (b.client_rcs !== undefined)      { set.push('client_rcs = ?');      p.push((b.client_rcs || '').trim() || null); }
        if (!set.length) return res.json({ success: true, sale: await getSaleFull(s.id) });
        const payChange = b.payment_method !== undefined && b.payment_method !== s.payment_method;
        if (payChange && ((s.balance_due || 0) > 0 || await dbGet('SELECT 1 FROM sale_balance_payments WHERE sale_id = ? LIMIT 1', [s.id])))
            return res.status(400).json({ error: 'Vente payée en plusieurs fois (service atelier) : le mode de paiement ne peut pas être changé ici.' });
        const closed = payChange ? await closedDayBlock(req, s.sale_date) : null;
        if (closed && closed.error) return res.status(409).json(closed);
        const before = { payment_method: s.payment_method, payments: await salePaymentsSnapshot(s.id) };
        p.push(s.id);
        await withTx(async () => {
            await dbRun(`UPDATE sales SET ${set.join(', ')} WHERE id = ?`, p);
            // Correction de la méthode → resynchronise la ventilation (1 seule ligne = total)
            // pour que la trésorerie reste cohérente.
            if (b.payment_method !== undefined) {
                const refv = (b.payment_method === 'cheque' || b.payment_method === 'virement') ? ((b.payment_ref || s.payment_ref || '').trim() || null) : null;
                const phonev = (b.payment_phone !== undefined ? (b.payment_phone || '').trim() : (s.payment_phone || '')) || null;
                await recordSalePayments(s.id, [{ method: b.payment_method, amount: s.total || 0, phone: phonev, ref: refv }], getDateTime());
            }
        });
        const after = { payment_method: b.payment_method !== undefined ? b.payment_method : s.payment_method, payments: await salePaymentsSnapshot(s.id) };
        logActivity(req, 'sale_edit', 'sale', s.id, { number: s.sale_number, sale_date: s.sale_date, fields: Object.keys(b).filter(k => k !== 'force_closed_day'),
            total: s.total, before, after, closed_day: !!(closed && closed.forced) });
        broadcast('sale:new', { sale_id: s.id });
        res.json({ success: true, sale: await getSaleFull(s.id) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Corriger UNIQUEMENT les infos CLIENT d'une vente (nom, contact, adresse, NIF/STAT/RCS) —
// erreur de saisie à réparer avant réimpression. Données non financières → accessible caisse +
// gestion_stock (le total, les articles et le paiement ne sont pas touchés).
app.patch('/api/sales/:id/client', requireAuth, requireRole('caisse', 'gestion_stock'), async (req, res) => {
    try {
        const s = await dbGet('SELECT id, client_name, client_phone FROM sales WHERE id = ?', [req.params.id]);
        if (!s) return res.status(404).json({ error: 'Vente introuvable' });
        const b = req.body, set = [], p = [];
        if (b.client_name !== undefined || b.client_phone !== undefined) {
            const cErr = clientError(b.client_name !== undefined ? b.client_name : s.client_name, b.client_phone !== undefined ? b.client_phone : s.client_phone);
            if (cErr) return res.status(400).json({ error: cErr });
        }
        const FIELDS = ['client_name', 'client_phone', 'client_address', 'client_nif', 'client_stat', 'client_rcs'];
        for (const k of FIELDS)
            if (b[k] !== undefined) { set.push(`${k} = ?`); p.push((b[k] || '').trim() || null); }
        if (!set.length) return res.json({ success: true, sale: await getSaleFull(s.id) });
        p.push(s.id);
        await dbRun(`UPDATE sales SET ${set.join(', ')} WHERE id = ?`, p);
        logActivity(req, 'sale_client_edit', 'sale', s.id, { fields: Object.keys(b) });
        broadcast('sale:new', { sale_id: s.id });
        res.json({ success: true, sale: await getSaleFull(s.id) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// Encaisser le reste (en totalité ou en partie) d'un service atelier ; renvoie la vente (facture complète).
app.post('/api/sales/:id/balance', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const s = await dbGet(`SELECT * FROM sales WHERE id = ? AND status = 'completed'`, [req.params.id]);
        if (!s || !(s.balance_due > 0)) return res.status(400).json({ error: 'Aucun reste à payer sur cette vente' });
        const amount = Array.isArray(req.body.payment && req.body.payment.payments)
            ? req.body.payment.payments.reduce((x, p) => x + Math.round(parseFloat(p.amount) || 0), 0) : 0;
        if (amount <= 0) return res.status(400).json({ error: 'Montant requis' });
        if (amount > Math.round(s.balance_due)) return res.status(400).json({ error: `Le montant dépasse le reste à payer (${Math.round(s.balance_due)} Ar)` });
        const pay = normalizePayments(req.body.payment, amount);
        if (pay.error) return res.status(400).json({ error: pay.error });
        const now = getDateTime(), today = getDate();
        await withTx(async () => {
            for (const l of pay.lines)
                await dbRun(`INSERT INTO sale_balance_payments (sale_id, method, amount, phone, ref, sale_date, created_at, cashier_name) VALUES (?,?,?,?,?,?,?,?)`,
                    [s.id, l.method, l.amount, l.phone, l.ref, today, now, req.session.user.full_name || req.session.user.username]);
            await dbRun('UPDATE sales SET balance_due = MAX(0, balance_due - ?) WHERE id = ?', [amount, s.id]);
        });
        logActivity(req, 'sale_balance_pay', 'sale', s.id, { number: s.sale_number, amount, rest: Math.max(0, s.balance_due - amount) });
        broadcast('sale:new', { sale_id: s.id }); broadcast('atelier:update', {});
        res.json({ success: true, sale: await getSaleFull(s.id) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Admin : supprimer une vente → les articles reviennent au stock immédiatement.
app.delete('/api/sales/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const s = await dbGet('SELECT * FROM sales WHERE id = ?', [req.params.id]);
        if (!s) return res.status(404).json({ error: 'Vente introuvable' });
        const closed = await closedDayBlock(req, s.sale_date);
        if (closed && closed.error) return res.status(409).json(closed);
        const before = { total: s.total, payments: await salePaymentsSnapshot(s.id),
            items: await dbAll('SELECT serial, product_name, unit_price FROM sale_items WHERE sale_id = ? ORDER BY id', [s.id]) };
        const n = await withTx(async () => {
            const n = await restoreSaleUnits(s.id, req, `Vente #${s.sale_number} supprimée (admin)`);
            // Étiquette atelier liée : annulée (plus rien à coller).
            const lbs = await dbAll(`SELECT id FROM atelier_labels WHERE sale_id = ? AND status <> 'annulee'`, [s.id]);
            if (lbs.length) {
                await dbRun(`UPDATE atelier_labels SET status = 'annulee' WHERE sale_id = ?`, [s.id]);
                lbs.forEach(l => resolveNotifs(`atelier_label:${l.id}`));
                broadcast('atelier:update', {});
            }
            // Si la vente vient d'une livraison, on remet la livraison à « à facturer ».
            const del = await dbGet('SELECT id FROM deliveries WHERE sale_id = ?', [s.id]);
            if (del) {
                await dbRun(`UPDATE delivery_items SET serial = NULL WHERE delivery_id = ?`, [del.id]);
                await dbRun(`UPDATE deliveries SET status = 'acceptee', sale_id = NULL, payment_status = NULL, status_at = ? WHERE id = ?`, [Date.now(), del.id]);
            }
            await dbRun('DELETE FROM sale_items WHERE sale_id = ?', [s.id]);
            await dbRun('DELETE FROM sale_payments WHERE sale_id = ?', [s.id]);
            await dbRun('DELETE FROM sale_balance_payments WHERE sale_id = ?', [s.id]);
            await dbRun('DELETE FROM sale_upgrades WHERE sale_id = ?', [s.id]);
            await dbRun('DELETE FROM sales WHERE id = ?', [s.id]);
            return n;
        });
        logActivity(req, 'sale_delete', 'sale', s.id, { number: s.sale_number, sale_date: s.sale_date, restored: n, before, closed_day: !!(closed && closed.forced) });
        broadcast('sale:new', { sale_id: s.id }); broadcast('stock:update', {}); broadcast('delivery:update', {});
        res.json({ success: true, restored: n });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/sales', requireAuth, requireRole('caisse', 'gestion_stock', 'commercial'), async (req, res) => {
    try {
        const { from, to, commercial_id, method, search } = req.query;
        const w = [], p = [];
        // Référence de facture (AAAAMMJJ-NNNN, imprimée en haut de la facture et dans son code-barres) :
        // recherche exacte, sur TOUT l'historique (le filtre de dates est ignoré).
        const refM = /^(\d{4})(\d{2})(\d{2})-(\d{1,6})$/.exec(String(search || '').trim());
        // Filtre de dates : les livraisons NON encore confirmées (statut 'en_livraison', ni annulées)
        // restent visibles quel que soit le jour filtré (« roll forward ») jusqu'à leur confirmation ;
        // une fois confirmées, elles sont datées du jour de confirmation (voir /complete).
        const dateW = [];
        if (refM) {
            w.push(`COALESCE(s.sale_date, substr(s.created_at, 1, 10)) = ? AND s.sale_number = ?`);
            p.push(`${refM[1]}-${refM[2]}-${refM[3]}`, parseInt(refM[4], 10));
        }
        if (from && !refM) dateW.push('date(s.created_at) >= date(?)');
        if (to && !refM) dateW.push('date(s.created_at) <= date(?)');
        if (dateW.length) {
            w.push(`((${dateW.join(' AND ')}) OR s.status = 'en_livraison')`);
            if (from && !refM) p.push(from);
            if (to && !refM)   p.push(to);
        }
        if (commercial_id) { w.push('s.commercial_id = ?'); p.push(commercial_id); }
        if (method)        { w.push('s.payment_method = ?'); p.push(method); }
        if (search && !refM) {
            // Recherche plein-texte LIBRE : n° de vente, client (nom/tél/adresse), vendeur/caisse, note,
            // livreur, et sur les articles (nom produit, config CPU/RAM/stockage/marque/modèle,
            // n° de série local OU constructeur).
            w.push(`(s.client_name LIKE ? OR s.client_phone LIKE ? OR s.client_address LIKE ? OR s.commercial_name LIKE ?
                     OR s.cashier_name LIKE ? OR s.note LIKE ? OR CAST(s.sale_number AS TEXT) LIKE ?
                     OR EXISTS (SELECT 1 FROM deliveries dd WHERE dd.sale_id = s.id AND dd.livreur_name LIKE ?)
                     OR EXISTS (SELECT 1 FROM sale_items si LEFT JOIN stock_units u ON u.id = si.unit_id LEFT JOIN products pp ON pp.id = si.product_id
                                WHERE si.sale_id = s.id AND (si.serial LIKE ? OR si.product_name LIKE ? OR u.manufacturer_sn LIKE ?
                                     OR pp.brand LIKE ? OR pp.model LIKE ? OR pp.cpu LIKE ? OR pp.ram LIKE ? OR pp.storage LIKE ?)))`);
            const l = `%${search}%`; p.push(l, l, l, l, l, l, l, l, l, l, l, l, l, l, l, l);
        }
        const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
        const rows = await dbAll(
            `SELECT s.*, (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id) AS item_count,
                (SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = s.id AND si.returned = 0) AS item_count_net,
                (SELECT COALESCE(SUM(refund_amount),0) FROM sale_returns sr WHERE sr.sale_id = s.id) AS refunded,
                (SELECT GROUP_CONCAT(si.product_name, ', ') FROM sale_items si WHERE si.sale_id = s.id) AS items_summary,
                (SELECT dd.status FROM deliveries dd WHERE dd.sale_id = s.id) AS delivery_status,
                (SELECT dd.livreur_name FROM deliveries dd WHERE dd.sale_id = s.id) AS livreur_name,
                -- Argent déjà reçu AVANT cette vente (acompte d'avance ou de livraison) : montant + jour(s).
                (SELECT COALESCE(SUM(amount), 0) FROM sale_payments WHERE sale_id = s.id) AS paid_sum,
                -- Échanges : articles repris de CETTE vente + vente d'origine d'une vente d'échange.
                (SELECT COUNT(*) FROM sale_returns sr WHERE sr.sale_id = s.id AND sr.type = 'echange') AS exch_n,
                (SELECT o.sale_number FROM sales o WHERE o.id = s.exchange_of) AS exch_of_num,
                (SELECT o.sale_date FROM sales o WHERE o.id = s.exchange_of) AS exch_of_date,
                (SELECT GROUP_CONCAT(method || ':' || CAST(amount AS INTEGER), '|') FROM sale_payments WHERE sale_id = s.id) AS pays,
                (SELECT l.deposit FROM layaways l WHERE l.sale_id = s.id) AS prior_lay,
                (SELECT GROUP_CONCAT(DISTINCT lp.sale_date) FROM layaway_payments lp JOIN layaways l ON l.id = lp.layaway_id WHERE l.sale_id = s.id) AS prior_lay_days,
                (SELECT SUM(dp.amount) FROM delivery_payments dp JOIN deliveries d ON d.id = dp.delivery_id WHERE d.sale_id = s.id) AS prior_dv,
                (SELECT GROUP_CONCAT(DISTINCT dp.sale_date) FROM delivery_payments dp JOIN deliveries d ON d.id = dp.delivery_id WHERE d.sale_id = s.id) AS prior_dv_days
             FROM sales s ${where} ORDER BY s.created_at DESC LIMIT 500`, p);
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Retour / remboursement — INITIÉ PAR LA CAISSE (côté argent). L'article part
// en « retour à réceptionner » : c'est le gestionnaire du stock qui validera
// la réception physique avant réintégration au stock ou en garantie.
app.post('/api/sales/:id/return', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        // Identification par sale_item.id (les services n'ont pas d'unité) ; compat : unit_ids accepté.
        const { item_ids, unit_ids, type, reason } = req.body;
        if (!reason || !reason.trim()) return res.status(400).json({ error: 'Motif obligatoire' });
        // « refacture » : vente annulée et refaite sur une NOUVELLE facture propre (sans mention d'échange) —
        // le montant payé est sorti (remboursement comptable) puis ré-encaissé par la nouvelle vente : CA net juste.
        if (!['remboursement', 'retour_stock', 'garantie', 'refacture'].includes(type)) return res.status(400).json({ error: 'Type invalide' });
        const sale = await dbGet('SELECT * FROM sales WHERE id = ?', [req.params.id]);
        if (!sale) return res.status(404).json({ error: 'Vente introuvable' });
        // Seule une vente SOLDÉE se retourne : une livraison non confirmée se règle depuis la livraison.
        if (sale.status !== 'completed')
            return res.status(400).json({ error: sale.status === 'en_livraison'
                ? 'Livraison pas encore confirmée : décochez les articles non pris à la confirmation, ou annulez la livraison.'
                : 'Vente non soldée (annulée, retournée ou échangée) : retour impossible.' });
        // Mode du remboursement : choisi par la caisse, sinon celui du paiement de la vente (espèces si mixte).
        // Seul un remboursement en ESPÈCES sort du tiroir (encaisse attendue).
        const refundMethod = PAY_METHODS.includes(req.body.refund_method) ? req.body.refund_method
            : (PAY_METHODS.includes(sale.payment_method) ? sale.payment_method : 'especes');
        const now = getDateTime(), me = req.session.user, meName = me.full_name || me.username;
        let refundTotal = 0, count = 0, physicalCount = 0;
        // Remise de la vente répartie sur les articles (ex. écran 200 000 vendu 180 000 après remise → 180 000
        // remboursés) ; article offert → 0. Plafond : argent reçu − remboursements déjà faits.
        const base = (await dbGet('SELECT COALESCE(SUM(unit_price), 0) AS v FROM sale_items WHERE sale_id = ? AND COALESCE(is_gift, 0) = 0', [sale.id])).v || 0;
        const ratio = base > 0 ? Math.min(1, Math.max(0, (base - (sale.discount_amount || 0)) / base)) : 1;
        const received = ((await dbGet('SELECT COALESCE(SUM(amount), 0) AS v FROM sale_payments WHERE sale_id = ?', [sale.id])).v || 0)
            + ((await dbGet('SELECT COALESCE(SUM(amount), 0) AS v FROM sale_balance_payments WHERE sale_id = ?', [sale.id])).v || 0);
        let refundRoom = Math.max(0, received - ((await dbGet('SELECT COALESCE(SUM(refund_amount), 0) AS v FROM sale_returns WHERE sale_id = ?', [sale.id])).v || 0));
        const refundOf = item => {
            if (!(type === 'remboursement' || type === 'refacture') || item.is_gift) return 0;
            const r = Math.min(refundRoom, Math.round((item.unit_price || 0) * ratio));
            refundRoom -= r; return r;
        };
        await withTx(async () => {
            // Résout la liste d'items (par id, sinon par unit_id pour rétro-compatibilité).
            const items = [];
            if (Array.isArray(item_ids) && item_ids.length) {
                for (const iid of item_ids) { const it = await dbGet('SELECT * FROM sale_items WHERE sale_id = ? AND id = ? AND returned = 0', [sale.id, iid]); if (it) items.push(it); }
            } else if (Array.isArray(unit_ids) && unit_ids.length) {
                for (const uid of unit_ids) { const it = await dbGet('SELECT * FROM sale_items WHERE sale_id = ? AND unit_id = ? AND returned = 0', [sale.id, uid]); if (it) items.push(it); }
            }
            if (!items.length) throw txError(400, 'Aucun article sélectionné');
            for (const item of items) {
                const refund = refundOf(item);
                const r1 = await dbRun('UPDATE sale_items SET returned = 1 WHERE id = ? AND returned = 0', [item.id]);
                if (r1.changes !== 1) throw txError(409, `Article ${item.serial || item.product_name} déjà retourné entre-temps.`);
                // SERVICE (pas d'unité physique) : simple annulation de la ligne + remboursement éventuel.
                if (item.is_service || !item.unit_id) {
                    refundTotal += refund;
                    await dbRun(`INSERT INTO sale_returns (sale_id, unit_id, serial, type, destination, refund_amount, reason, user_id, user_name, created_at)
                                 VALUES (?, NULL, NULL, ?, 'service', ?, ?, ?, ?, ?)`,
                        [sale.id, type, refund, reason.trim(), me.id, meName, now]);
                    count++;
                    continue;
                }
                const uid = item.unit_id;
                const unitBefore = await dbGet('SELECT * FROM stock_units WHERE id = ?', [uid]);
                if (!unitBefore || unitBefore.status !== 'vendu')
                    throw txError(409, `Unité ${item.serial || uid} n'est plus « vendue » (${unitBefore ? unitBefore.status : 'introuvable'}) : retour impossible.`);
                let dest = 'stock';
                if (type === 'garantie') {
                    const covered = daysUntil(unitBefore.warranty_end) != null && daysUntil(unitBefore.warranty_end) >= 0;
                    dest = covered ? 'garantie_fournisseur' : 'garantie_exceptionnel';
                }
                await dbRun(`UPDATE stock_units SET status = 'retour_attente', note = ?, updated_at = ? WHERE id = ? AND status = 'vendu'`, [reason.trim(), now, uid]);
                refundTotal += refund;
                await dbRun(`INSERT INTO sale_returns (sale_id, unit_id, serial, type, destination, refund_amount, reason, user_id, user_name, created_at)
                             VALUES (?,?,?,?,?,?,?,?,?,?)`,
                    [sale.id, uid, item.serial, type, dest, refund, reason.trim(), me.id, meName, now]);
                await recordMovement(unitBefore, 'retour_attente', 'retour_vente', req, { from: 'vendu', ref_type: 'sale', ref_id: sale.id, note: `${type} — ${reason.trim()}` });
                count++; physicalCount++;
            }
            // Remboursement : mouvement de caisse (côté argent = caisse), avec son mode réel.
            if (refundTotal > 0)
                await dbRun(`INSERT INTO cash_movements (sale_date, kind, amount, method, reason, ref_id, user_id, user_name, created_at)
                             VALUES (?, 'remboursement', ?, ?, ?, ?, ?, ?, ?)`,
                    [getDate(), -refundTotal, refundMethod, type === 'refacture' ? `Annulation vente #${sale.sale_number} — montant reporté sur une nouvelle facture` : `Remboursement vente #${sale.sale_number}`, sale.id, me.id, meName, now]);
            const remaining = await dbGet('SELECT COUNT(*) AS n FROM sale_items WHERE sale_id = ? AND returned = 0', [sale.id]);
            await dbRun('UPDATE sales SET status = ? WHERE id = ?', [remaining.n === 0 ? 'returned' : 'completed', sale.id]);
        });
        if (physicalCount > 0) pushNotification({ target_role: 'gestion_stock', type: 'warn', title: 'Retour à réceptionner',
            message: `Vente #${sale.sale_number} : ${physicalCount} article(s) à réceptionner (${type}).`, link: '/stock.html', ref: `return:sale:${sale.id}` });
        logActivity(req, 'sale_return', 'sale', sale.id, { type, units: count, refund: refundTotal, refund_method: refundTotal > 0 ? refundMethod : undefined });
        broadcast('stock:update', {}); broadcast('sale:new', { sale_id: sale.id });
        res.json({ success: true, refund: refundTotal, refund_method: refundMethod });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Gestionnaire : liste des retours de vente à réceptionner.
app.get('/api/returns/pending', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT u.id AS unit_id, u.serial, u.warranty_end, p.name AS product_name, p.brand, p.model,
                    r.type, r.destination, r.reason, r.refund_amount, r.sale_id, r.user_name AS caisse_name, r.created_at,
                    s.sale_number
             FROM stock_units u
             JOIN sale_returns r ON r.unit_id = u.id
             LEFT JOIN products p ON p.id = u.product_id
             LEFT JOIN sales s ON s.id = r.sale_id
             WHERE u.status = 'retour_attente'
               AND r.id = (SELECT MAX(r2.id) FROM sale_returns r2 WHERE r2.unit_id = u.id)
             ORDER BY r.created_at DESC`);
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Composants REPRIS lors d'un upgrade (ancienne RAM, ancien disque…) pas encore réceptionnés au dépôt :
// alimente le bandeau permanent (stock + admin) qui ne disparaît qu'après la réception.
app.get('/api/upgrades/pending', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT u.id AS unit_id, u.serial, p.name AS product_name, r.sale_id, s.sale_number, r.created_at, r.user_name
             FROM stock_units u JOIN sale_returns r ON r.unit_id = u.id
             LEFT JOIN products p ON p.id = u.product_id LEFT JOIN sales s ON s.id = r.sale_id
             WHERE u.status = 'retour_attente' AND r.type = 'upgrade_repris'
               AND r.id = (SELECT MAX(r2.id) FROM sale_returns r2 WHERE r2.unit_id = u.id)
             ORDER BY r.created_at`);
        res.json({ count: rows.length, items: rows });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Gestionnaire : valider la réception physique des retours.
app.post('/api/returns/receive', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const { unit_ids } = req.body;
        if (!Array.isArray(unit_ids) || !unit_ids.length) return res.status(400).json({ error: 'Aucune unité sélectionnée' });
        const now = getDateTime();
        const saleIds = new Set();
        let done = 0;
        await withTx(async () => {
        for (const uid of unit_ids) {
            const u = await dbGet(`SELECT * FROM stock_units WHERE id = ? AND status = 'retour_attente'`, [uid]);
            if (!u) continue;
            const r = await dbGet(`SELECT * FROM sale_returns WHERE unit_id = ? ORDER BY id DESC LIMIT 1`, [uid]);
            if (!r) continue;
            const dest = r.destination || 'stock';
            const isGar = dest.startsWith('garantie');
            const up = await dbRun(`UPDATE stock_units SET status = ?, note = ?, updated_at = ? WHERE id = ? AND status = 'retour_attente'`,
                [dest, isGar ? r.reason : null, now, uid]);
            if (!up.changes) continue;
            await recordMovement(u, dest, 'retour_receptionne', req, { from: 'retour_attente', ref_type: 'sale', ref_id: r.sale_id, note: `Réception retour (${r.type})` });
            if (isGar) await logGarantie({ ...u, status: 'retour_attente' }, 'entree', dest === 'garantie_exceptionnel' ? 'exceptionnel' : 'fournisseur', req, { reason: r.reason });
            if (r.sale_id) saleIds.add(r.sale_id);
            // Ancienne pièce d'un échange (livraison / boutique) revenue : notification du stock résolue.
            const er = await dbGet(`SELECT id FROM exchange_requests WHERE old_unit_id = ? AND status = 'validated' ORDER BY id DESC LIMIT 1`, [uid]);
            if (er) resolveNotifs(`return:exchange:${er.id}`);
            done++;
        }
        });
        // Résout la notification de chaque vente entièrement réceptionnée.
        for (const sid of saleIds) {
            const left = await dbGet(`SELECT COUNT(*) AS n FROM stock_units WHERE status = 'retour_attente' AND id IN (SELECT unit_id FROM sale_returns WHERE sale_id = ?)`, [sid]);
            if (left.n === 0) { resolveNotifs(`return:sale:${sid}`); resolveNotifs(`return:sale:${sid}:upgrade`); }
        }
        logActivity(req, 'return_receive', 'sale', null, { units: done });
        broadcast('stock:update', {}); broadcast('garantie:update', {});
        res.json({ success: true, count: done });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// CA encaissé d'une période (page Ventes) — admin + caisse.
app.get('/api/ca', requireAuth, async (req, res) => {
    try {
        if (!canSeeCA(req.session.user)) return res.status(403).json({ error: 'Accès réservé à la caisse et à l\'admin' });
        const ok = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : null;
        if (await caTodayOnly(req.session.user) && (ok(req.query.from) !== getDate() || ok(req.query.to) !== getDate()))
            return res.status(403).json({ error: "Chiffre d'affaires des jours passés : accès réservé.", restricted: true });
        res.json({ ca: await caBetween(ok(req.query.from), ok(req.query.to)), by_method: await caByMethod(ok(req.query.from), ok(req.query.to)) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Détail du CA encaissé : argent reçu sur la période qui ne correspond PAS à une vente finalisée de la
// liste (acomptes de livraison, versements d'avance, reste atelier) + remboursements. Permet de
// retrouver chaque ariary du CA affiché dans la page Ventes.
app.get('/api/ca/detail', requireAuth, async (req, res) => {
    try {
        if (!canSeeCA(req.session.user)) return res.status(403).json({ error: 'Accès réservé à la caisse et à l\'admin' });
        const ok = d => /^\d{4}-\d{2}-\d{2}$/.test(d || '') ? d : null;
        if (await caTodayOnly(req.session.user) && (ok(req.query.from) !== getDate() || ok(req.query.to) !== getDate()))
            return res.status(403).json({ error: "Chiffre d'affaires des jours passés : accès réservé.", restricted: true });
        const from = ok(req.query.from) || '0000-00-00', to = ok(req.query.to) || '9999-12-31';
        const P = [from, to];
        const sales = (await dbGet(`SELECT COALESCE(SUM(sp.amount),0) AS v FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
            WHERE s.status IN ('completed','exchanged','returned') AND s.sale_date BETWEEN ? AND ?`, P)).v || 0;
        const rows = [
            ...(await dbAll(`SELECT 'acompte_livraison' AS kind, dp.id, dp.amount, dp.method, dp.sale_date, dp.created_at, dp.cashier_name AS by_name,
                    d.delivery_number AS num, d.delivery_date AS num_date, d.client_name, d.client_phone, d.commercial_name, d.total, d.status AS ref_status,
                    (SELECT GROUP_CONCAT(di.quantity || '× ' || di.product_name, ' · ') FROM delivery_items di WHERE di.delivery_id = d.id) AS items
                FROM delivery_payments dp LEFT JOIN deliveries d ON d.id = dp.delivery_id WHERE dp.sale_date BETWEEN ? AND ?`, P)),
            ...(await dbAll(`SELECT 'versement_avance' AS kind, lp.id, lp.amount, lp.method, lp.sale_date, lp.created_at, l.cashier_name AS by_name,
                    l.layaway_number AS num, substr(l.created_at, 1, 10) AS num_date, l.client_name, l.client_phone, l.commercial_name, l.total, l.status AS ref_status,
                    (SELECT GROUP_CONCAT(li.product_name, ' · ') FROM layaway_items li WHERE li.layaway_id = l.id) AS items
                FROM layaway_payments lp LEFT JOIN layaways l ON l.id = lp.layaway_id WHERE lp.sale_date BETWEEN ? AND ?`, P)),
            ...(await dbAll(`SELECT 'reste_atelier' AS kind, bp.id, bp.amount, bp.method, bp.sale_date, bp.created_at, bp.cashier_name AS by_name,
                    s.sale_number AS num, s.sale_date AS num_date, s.client_name, s.client_phone, s.commercial_name, s.total, s.status AS ref_status,
                    (SELECT GROUP_CONCAT(si.product_name, ' · ') FROM sale_items si WHERE si.sale_id = s.id) AS items
                FROM sale_balance_payments bp LEFT JOIN sales s ON s.id = bp.sale_id WHERE bp.sale_date BETWEEN ? AND ?`, P)),
            ...(await dbAll(`SELECT 'remboursement' AS kind, cm.id, cm.amount, cm.method, cm.sale_date, cm.created_at, cm.user_name AS by_name,
                    s.sale_number AS num, s.sale_date AS num_date, s.client_name, s.client_phone, s.commercial_name, s.total, s.status AS ref_status, cm.reason AS items
                FROM cash_movements cm LEFT JOIN sales s ON s.id = cm.ref_id WHERE cm.kind = 'remboursement' AND cm.sale_date BETWEEN ? AND ?`, P)),
        ].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
        const other = rows.filter(r => r.kind !== 'remboursement').reduce((t, r) => t + (r.amount || 0), 0);
        const refunds = rows.filter(r => r.kind === 'remboursement').reduce((t, r) => t - (r.amount || 0), 0);
        res.json({ sales, other, refunds, ca: sales + other - refunds, rows });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ============================================================
//  ÉCHANGE (depuis l'historique des ventes)
// ============================================================
// Échange après paiement — CHOIX MULTIPLE : un ou plusieurs articles rendus contre un ou plusieurs
// articles neufs (ex. routeur 150 000 + tapis 15 000 rendus → répéteur 180 000 : le client paie 15 000).
// Le client ne paie que la DIFFÉRENCE (total des nouveaux − total des rendus) ; différence négative =
// remboursement. Rétro-compatible : return_unit_id / new_unit_id / new_product_id (un seul article).
app.post('/api/sales/:id/exchange', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const { payment } = req.body;
        const toIds = v => (Array.isArray(v) ? v : (v != null && v !== '' ? [v] : [])).map(Number).filter(n => Number.isInteger(n) && n > 0);
        const returnIds = toIds(req.body.return_unit_ids || req.body.return_unit_id);
        let newIds = toIds(req.body.new_unit_ids || req.body.new_unit_id);
        const sale = await dbGet('SELECT * FROM sales WHERE id = ?', [req.params.id]);
        if (!sale) return res.status(404).json({ error: 'Vente introuvable' });
        if (!returnIds.length) return res.status(400).json({ error: 'Choisissez au moins un article rendu.' });
        if (new Set(returnIds).size !== returnIds.length) return res.status(400).json({ error: 'Un article rendu figure deux fois.' });
        const items = [];
        for (const uid of returnIds) {
            const it = await dbGet('SELECT * FROM sale_items WHERE sale_id = ? AND unit_id = ? AND returned = 0', [sale.id, uid]);
            if (!it) return res.status(400).json({ error: 'Article à échanger introuvable dans cette vente' });
            items.push(it);
        }
        // Vente non soldée (livraison pas encore livrée / payée, vente annulée ou déjà échangée) : refus.
        // Une pièce en cours de livraison s'échange depuis la LIVRAISON (demande du commercial, sortie stock).
        const linkedDel = await dbGet('SELECT id, delivery_number, status FROM deliveries WHERE sale_id = ?', [sale.id]);
        if (linkedDel && linkedDel.status !== 'livree')
            return res.status(400).json({ error: `Livraison #${linkedDel.delivery_number} pas encore livrée et encaissée : l'échange se fait depuis la livraison (le commercial demande l'échange, le stock sort la pièce de remplacement).` });
        if (sale.status !== 'completed') return res.status(400).json({ error: `Vente ${sale.status === 'annulee' ? 'annulée' : 'non soldée'} : échange impossible.` });
        // Remplacement(s) : unités EXISTANTES déjà sorties du dépôt (boutique / présentoir).
        if (!newIds.length && req.body.new_product_id) {
            const nu = await dbGet(`SELECT id FROM stock_units WHERE product_id = ? AND status IN ('presentoir','consignation') ORDER BY id LIMIT 1`, [req.body.new_product_id]);
            if (!nu) return res.status(400).json({ error: 'Aucune unité de ce produit sortie du dépôt : faites d’abord la sortie du stock.' });
            newIds = [nu.id];
        }
        if (!newIds.length) return res.status(400).json({ error: 'Scannez au moins un nouvel article (sinon utilisez « Retour »).' });
        if (new Set(newIds).size !== newIds.length) return res.status(400).json({ error: 'Un nouvel article figure deux fois.' });
        if (newIds.some(id => returnIds.includes(id))) return res.status(400).json({ error: "Un nouvel article doit être différent des articles rendus." });
        const newUnits = [];
        for (const id of newIds) {
            const nu = await dbGet(`SELECT u.*, p.name AS product_name FROM stock_units u LEFT JOIN products p ON p.id = u.product_id WHERE u.id = ?`, [id]);
            if (!nu || !POS_SELLABLE.includes(nu.status)) return res.status(400).json({ error: nu && nu.status === 'stock' ? posNotOut(nu) : `Nouvel article ${nu ? nu.serial : '#' + id} non disponible.` });
            newUnits.push(nu);
        }
        const oldTotal = items.reduce((t, it) => t + (it.unit_price || 0), 0);
        const newTotal = newUnits.reduce((t, u) => t + (u.sale_price || 0), 0);
        const priceDiff = Math.round(newTotal - oldTotal);
        const toCollect = Math.max(0, priceDiff);

        const settings = await getSettingsAsync();
        const freeDays = parseInt(settings.exchange_free_days, 10) || 5;
        const fee = parseFloat(settings.exchange_fee) || 0;
        const daysSince = -(daysUntil(sale.sale_date) || 0);
        const exchangeFee = daysSince > freeDays ? fee : 0;
        const now = getDateTime(), today = getDate();

        let pay = { lines: [], primary: null, first: { ref: null, phone: null } };
        if (toCollect > 0) {
            pay = normalizePayments(payment && (payment.method || payment.payments) ? payment : { method: 'especes' }, toCollect);
            if (pay.error) return res.status(400).json({ error: pay.error });
        }

        // Écriture ATOMIQUE : retours, nouvelle vente (écart), sortie des nouveaux, droit / remboursement.
        let newSaleId, saleNumber;
        await withTx(async () => {
            for (const item of items) {
                const oldUnit = await dbGet('SELECT * FROM stock_units WHERE id = ?', [item.unit_id]);
                const r1 = await dbRun(`UPDATE sale_items SET returned = 1 WHERE id = ? AND returned = 0`, [item.id]);
                if (r1.changes !== 1) throw txError(409, `Article ${item.serial} déjà échangé ou retourné entre-temps.`);
                await dbRun(`UPDATE stock_units SET status = 'retour_attente', holder_user_id = NULL, note = ?, updated_at = ? WHERE id = ?`, ['Échange', now, item.unit_id]);
                await dbRun(`INSERT INTO sale_returns (sale_id, unit_id, serial, type, destination, refund_amount, reason, user_id, user_name, created_at)
                             VALUES (?,?,?,?,?,?,?,?,?,?)`,
                    [sale.id, item.unit_id, item.serial, 'echange', 'stock', 0, 'Échange', req.session.user.id, req.session.user.full_name || req.session.user.username, now]);
                await recordMovement(oldUnit, 'retour_attente', 'echange_retour', req, { from: oldUnit.status, ref_type: 'sale', ref_id: sale.id, note: 'Retour pour échange — à réceptionner' });
            }
            saleNumber = await nextSaleNumber(today);
            const newSale = await dbRun(
                `INSERT INTO sales (sale_number, sale_date, client_name, client_phone, client_address, commercial_id, commercial_name, cashier_id, cashier_name, total, payment_method, payment_ref, payment_phone, channel, status, exchange_of, exchange_fee, note, created_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'completed', ?, ?, ?, ?)`,
                [saleNumber, today, sale.client_name, sale.client_phone, sale.client_address, sale.commercial_id, sale.commercial_name,
                 req.session.user.id, req.session.user.full_name || req.session.user.username, toCollect,
                 pay.primary, pay.first.ref, pay.first.phone, 'boutique', sale.id, exchangeFee,
                 `Échange de la vente #${sale.sale_number} (écart) — rendu : ${items.map(i => i.product_name).join(', ')}`, now]);
            newSaleId = newSale.lastID;
            await recordSalePayments(newSaleId, pay.lines, now);
            for (const nu of newUnits) {
                await dbRun(`INSERT INTO sale_items (sale_id, unit_id, serial, product_id, product_name, unit_price) VALUES (?,?,?,?,?,?)`,
                    [newSaleId, nu.id, displaySerial(nu), nu.product_id, nu.product_name, nu.sale_price || 0]);
                const r2 = await dbRun(`UPDATE stock_units SET status = 'vendu', holder_user_id = NULL, updated_at = ? WHERE id = ? AND status = ?`, [now, nu.id, nu.status]);
                if (r2.changes !== 1) throw txError(409, `Nouvel article ${nu.serial} vendu ou déplacé entre-temps.`);
                await recordMovement(nu, 'vendu', 'vente_echange', req, { from: nu.status, ref_type: 'sale', ref_id: newSaleId, note: `Échange #${saleNumber}${nu.status === 'consignation' ? ' (sorti de la boutique)' : ''}` });
            }
            // La vente d'origine RESTE 'completed' (recette des articles rendus conservée) ; la vente de
            // l'échange n'ajoute QUE l'écart → CA total = prix des nouveaux articles.
            if (exchangeFee > 0)
                await dbRun(`INSERT INTO cash_movements (sale_date, kind, amount, method, reason, ref_id, user_id, user_name, created_at)
                             VALUES (?, 'fond', ?, 'especes', ?, ?, ?, ?, ?)`,
                    [today, exchangeFee, `Droit d'échange vente #${saleNumber}`, newSaleId, req.session.user.id, req.session.user.full_name || req.session.user.username, now]);
            if (priceDiff < 0)
                await dbRun(`INSERT INTO cash_movements (sale_date, kind, amount, method, reason, ref_id, user_id, user_name, created_at)
                             VALUES (?, 'remboursement', ?, 'especes', ?, ?, ?, ?, ?)`,
                    [today, priceDiff, `Remboursement écart échange vente #${saleNumber}`, newSaleId, req.session.user.id, req.session.user.full_name || req.session.user.username, now]);
        });
        pushNotification({ target_role: 'gestion_stock', type: 'info', title: 'Retour échange à réceptionner',
            message: `${items.map(i => i.serial).join(', ')} revien${items.length > 1 ? 'nent' : 't'} (échange) — validez la réception.`, link: '/retour.html', ref: `return:sale:${sale.id}` });
        logActivity(req, 'sale_exchange', 'sale', newSaleId, { from: sale.id, fee: exchangeFee, price_diff: priceDiff, returned: items.map(i => i.unit_id), new_units: newIds });
        broadcast('stock:update', {}); broadcast('sale:new', { sale_id: newSaleId });
        const full = await getSaleFull(newSaleId);
        res.json({ success: true, sale: full, exchange_fee: exchangeFee, price_diff: priceDiff, old_total: oldTotal, new_total: newTotal });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Ventes journalières (vue STOCK) : tout ce qui a été VENDU aujourd'hui, quel que soit le canal
// (boutique, livraison, échange…). Séparé Ordinateurs / Accessoires, avec récap.
// Le CA global (agrégats monétaires) reste réservé caisse + admin ; les prix par ligne restent visibles.
app.get('/api/ventes-journalieres', requireAuth, requireRole('gestion_stock', 'caisse'), async (req, res) => {
    try {
        const me = req.session.user;
        const canCA = (me.role === 'admin' || hasRole(me, 'caisse'))
            && !(await caTodayOnly(me) && ((req.query.from || req.query.date || getDate()) !== getDate() || (req.query.to || req.query.date || req.query.from || getDate()) !== getDate()));
        const from = req.query.from || req.query.date || getDate();
        const to   = req.query.to   || req.query.date || from;
        // Les livraisons EN COURS (status 'en_livraison') « roulent » et restent visibles chaque jour
        // tant qu'elles ne sont pas confirmées : on ne les injecte que si la fenêtre atteint aujourd'hui.
        const showLivraison = to >= getDate();
        // Toute l'activité de vente du jour : ventes normales, ÉCHANGES (nouvelle vente issue d'un
        // échange), RETOURS (ligne retournée / vente échangée sortante), ANNULATIONS et LIVRAISONS EN
        // COURS. Chaque ligne reçoit un « etat » pour un label + code couleur côté page.
        const rows = await dbAll(
            `SELECT si.id AS item_id, si.unit_id, si.serial, si.product_id, si.product_name, si.unit_price,
                    si.is_gift, si.is_service, si.color, si.returned,
                    -- Classement accessoire/ordinateur : produit vivant, sinon SNAPSHOT de la corbeille
                    -- (un produit supprimé garde des ventes ; sans ce repli il serait classé « ordinateur »).
                    COALESCE(p.is_accessory,
                             (SELECT json_extract(t.snapshot, '$.product.is_accessory')
                              FROM trash_products t WHERE t.product_id = si.product_id ORDER BY t.id DESC LIMIT 1),
                             0) AS is_accessory,
                    p.brand, p.model, p.name AS pname,
                    s.id AS sale_id, s.sale_number, s.channel, s.payment_method,
                    s.status AS sale_status, s.exchange_of, s.total AS sale_total,
                    (SELECT sr.type FROM sale_returns sr WHERE sr.sale_id = s.id AND sr.unit_id = si.unit_id
                     ORDER BY sr.id DESC LIMIT 1) AS return_type,
                    s.commercial_name, s.cashier_name, s.client_name, s.created_at AS sold_at,
                    (SELECT dd.delivery_number FROM deliveries dd WHERE dd.sale_id = s.id) AS delivery_number,
                    (SELECT dd.payment_status FROM deliveries dd WHERE dd.sale_id = s.id) AS delivery_payment_status
             FROM sale_items si
             JOIN sales s ON s.id = si.sale_id
             LEFT JOIN products p ON p.id = si.product_id
             WHERE COALESCE(si.is_service, 0) = 0
               AND (
                    (s.status IN ('completed','exchanged','returned','annulee') AND date(s.created_at) BETWEEN date(?) AND date(?))
                    -- Livraisons EN COURS : non confirmées, affichées avec le label « En livraison »,
                    -- NON comptées dans le vendu / CA (pas encore encaissées).
                    OR (s.status = 'en_livraison' AND ? = 1)
               )
             ORDER BY s.created_at DESC, si.id`, [from, to, showLivraison ? 1 : 0]);

        // État par ligne : livraison | annule | retour | echange | vente.
        rows.forEach(r => {
            r.etat = r.sale_status === 'en_livraison' ? 'livraison'
                   : r.sale_status === 'annulee' ? 'annule'
                   // Un article repris pour ÉCHANGE n'est pas un retour remboursé : l'argent de la
                   // vente d'origine reste en caisse, la ligne reste donc une vente réelle de son jour.
                   : (r.returned && r.return_type !== 'echange') ? 'retour'
                   : (r.sale_status === 'completed' && r.exchange_of != null) ? 'echange'
                   : r.sale_status === 'exchanged' ? 'retour'
                   : 'vente';
            // Ligne d'échange : le montant retenu est l'ÉCART réellement encaissé (sales.total),
            // pas le prix plein du nouvel appareil (qui n'est qu'une valeur d'article).
            if (r.etat === 'echange') r.unit_price = r.sale_total || 0;
        });
        // « Vente réelle » = comptée dans les totaux / CA (vente normale ou échange). Les LIVRAISONS
        // EN COURS et les retours / annulations sont AFFICHÉS (avec label) mais NON comptés dans le
        // « vendu » du jour. On sépare les trois pour des compteurs justes.
        const isReal = r => r.etat === 'vente' || r.etat === 'echange';
        const isLivr = r => r.etat === 'livraison';
        const isExc  = r => !isReal(r) && !isLivr(r);

        const ordinateurs    = rows.filter(r => !r.is_accessory && isReal(r));
        const ordiLivraison  = rows.filter(r => !r.is_accessory && isLivr(r));
        const ordiExceptions = rows.filter(r => !r.is_accessory && isExc(r));
        const accReal        = rows.filter(r => r.is_accessory && isReal(r));
        const accLivraison   = rows.filter(r => r.is_accessory && isLivr(r));
        const accExceptions  = rows.filter(r => r.is_accessory && isExc(r));

        // Accessoires vendus : listés à l'UNITÉ (comme les ordinateurs), cliquables — plus de regroupement.
        const accessoires = accReal;
        const accModels = new Set(accReal.map(r => r.product_id)).size;

        const byChannel = (list, ch) => list.filter(r => r.channel === ch).length;
        const sum = (list) => list.reduce((t, r) => t + (r.unit_price || 0), 0);
        const recap = {
            date_from: from, date_to: to, can_see_ca: canCA,
            ordi_count: ordinateurs.length,
            ordi_boutique: byChannel(ordinateurs, 'boutique'),
            ordi_livraison: byChannel(ordinateurs, 'livraison'),
            ordi_echange: ordinateurs.filter(r => r.etat === 'echange').length,
            acc_pieces: accReal.length,
            acc_models: accModels,
            livraison_count: ordiLivraison.length + accLivraison.length,
            exceptions: ordiExceptions.length + accExceptions.length,
            ca_ordi: canCA ? sum(ordinateurs) : null,
            ca_acc:  canCA ? sum(accReal) : null,
            ca_total: canCA ? sum(ordinateurs.concat(accReal)) : null
        };
        res.json({ recap, ordinateurs, accessoires, ordiLivraison, accLivraison, ordiExceptions, accExceptions });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/top-ventes', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const re = /^\d{4}-\d{2}-\d{2}$/;
        const to = re.test(req.query.to || '') ? req.query.to : getDate();
        const from = re.test(req.query.from || '') ? req.query.from : to;
        const rows = await dbAll(
            `SELECT si.product_id, si.product_name, si.unit_price, si.returned, si.is_gift,
                    COALESCE(p.is_accessory, (SELECT json_extract(t.snapshot, '$.product.is_accessory') FROM trash_products t
                             WHERE t.product_id = si.product_id ORDER BY t.id DESC LIMIT 1), 0) AS is_accessory,
                    p.brand, p.model, p.category, p.cpu, p.ram, p.storage,
                    s.status AS sale_status, s.exchange_of, s.total AS sale_total, s.channel,
                    COALESCE(NULLIF(TRIM(s.commercial_name), ''), 'Sans commercial') AS commercial,
                    date(s.created_at) AS day,
                    (SELECT sr.type FROM sale_returns sr WHERE sr.sale_id = s.id AND sr.unit_id = si.unit_id ORDER BY sr.id DESC LIMIT 1) AS return_type
             FROM sale_items si JOIN sales s ON s.id = si.sale_id LEFT JOIN products p ON p.id = si.product_id
             WHERE COALESCE(si.is_service, 0) = 0
               AND s.status IN ('completed','exchanged','returned') AND date(s.created_at) BETWEEN date(?) AND date(?)`, [from, to]);
        const agg = new Map();
        for (const r of rows) {
            const retour = (r.returned && r.return_type !== 'echange') || r.sale_status === 'exchanged';
            if (retour) continue;
            const echange = r.sale_status === 'completed' && r.exchange_of != null;
            const amount = r.is_gift ? 0 : (echange ? (r.sale_total || 0) : (r.unit_price || 0));
            const name = [r.brand, r.model].filter(Boolean).join(' ') || r.product_name || 'Produit';
            const key = `${r.product_id || name}|${r.commercial}|${r.day}`;
            const a = agg.get(key) || { product_id: r.product_id, name, is_accessory: r.is_accessory ? 1 : 0, category: r.category || '',
                spec: [r.cpu, r.ram, r.storage].filter(Boolean).join(' · '), commercial: r.commercial, day: r.day, qty: 0, ca: 0, livraison: 0, echange: 0, repris: 0 };
            a.qty++; a.ca += amount; if (r.channel === 'livraison') a.livraison++;
            // Échanges : pièce REMISE en échange (vente d'échange) / pièce vendue puis REPRISE en échange.
            if (echange) a.echange++;
            if (r.returned && r.return_type === 'echange') a.repris++;
            agg.set(key, a);
        }
        res.json({ from, to, lines: [...agg.values()] });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Journal de caisse : tous les mouvements passés par la caisse sur une période.
app.get('/api/caisse/history', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const { from, to } = req.query;
        const dw = (col) => { const w = [], p = []; if (from) { w.push(`date(${col}) >= date(?)`); p.push(from); } if (to) { w.push(`date(${col}) <= date(?)`); p.push(to); } return { w: w.length ? 'WHERE ' + w.join(' AND ') : '', p }; };
        const sQ = dw('created_at');
        const sales = await dbAll(
            `SELECT id, sale_number, created_at, client_name, total, payment_method, payment_ref, channel, status,
                (SELECT GROUP_CONCAT(product_name, ' · ') FROM sale_items WHERE sale_id = sales.id) AS items_summary
             FROM sales ${sQ.w} ORDER BY created_at DESC LIMIT 1000`, sQ.p);
        const rQ = dw('created_at');
        const returns = await dbAll(
            `SELECT id, sale_id, serial, type, destination, refund_amount, reason, user_name, created_at
             FROM sale_returns ${rQ.w} ORDER BY created_at DESC LIMIT 1000`, rQ.p);
        const cQ = dw('created_at');
        const cash = await dbAll(
            `SELECT id, sale_date, kind, amount, method, reason, user_name, created_at
             FROM cash_movements ${cQ.w} ORDER BY created_at DESC LIMIT 1000`, cQ.p);
        // Totaux synthétiques.
        // RECETTE = ventes réellement encaissées (status 'completed') UNIQUEMENT — cohérent avec la
        // trésorerie du jour. Les commandes en livraison NON encore payées ('en_livraison') et les
        // ventes annulées ('annulee') sont EXCLUES du total (sinon écart à la clôture du soir).
        const paid = sales.filter(s => s.status === 'completed');
        const pending = sales.filter(s => s.status === 'en_livraison');   // livraison pas encore encaissée
        const totals = {
            ventes: paid.reduce((a, s) => a + (s.total || 0), 0),
            ventes_count: paid.length,
            pending_count: pending.length,
            pending_amount: pending.reduce((a, s) => a + (s.total || 0), 0),
            remboursements: returns.reduce((a, r) => a + (r.refund_amount || 0), 0),
            depenses: cash.filter(c => c.kind === 'depense').reduce((a, c) => a + Math.abs(c.amount || 0), 0),
            fond: cash.filter(c => c.kind === 'fond').reduce((a, c) => a + (c.amount || 0), 0)
        };
        res.json({ sales, returns, cash, totals });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
};
