// ============================================================
//  STOCKFLOW — Stock dépôt : produits, unités, réceptions, inventaire, corbeille, mouvements, batteries, Starlink
//  Routes /api déplacées depuis server.js (code inchangé). Les helpers, la base et les
//  middlewares partagés arrivent par S (voir « Routes par domaine » en fin de server.js).
// ============================================================
module.exports = function register(app, S) {
    const { applyAutoImage, AutoImgQueue, autoImageQuery } = S;
    const { accCode, addDays, autoMergeIdenticalProducts, BAT_AUTO, BAT_WHERE, BatCatalog, batKey, BatQueue,
        batteryLookupAndSave, batterySweep, boutiqueResponsibleIdAsync, broadcast, canonicalBrandModel, clientError,
        DATE_RE, dbAll, dbGet, dbRun, displaySerial, garantieType, getDate, getDateTime, getSettingsAsync, INV_SCOPE,
        INV_ZONE, invDraftTable, inventaireExpected, inventaireKnownOther, invFilter, invGuard, invNorm, invoiceRef,
        logActivity, logGarantie, normEmplacement, parseAccCode, POS_SELLABLE, productDisplayName, productSignature,
        pushNotification, RECONF_FIELDS, RECONF_FLAGS, recordMovement, requireAdmin, requireAuth, requireRole, resolveNotifs,
        rqMatchReception, safeUploadPath, SELLABLE, sigAlnum, SQL_COMPACT, stripCost, syncUnitPrices, txError,
        UNIT_STATUS, unitCost, unlinkUpload, upload, withTx } = S;

// ============================================================
//  PRODUITS (modèles) — recherche / réutilisation
// ============================================================
app.get('/api/products', requireAuth, async (req, res) => {
    try {
        const q = (req.query.search || '').trim();
        const rows = q
            ? await dbAll(`SELECT * FROM products WHERE name LIKE ? OR model LIKE ? OR brand LIKE ? ORDER BY name LIMIT 50`,
                          [`%${q}%`, `%${q}%`, `%${q}%`])
            : await dbAll('SELECT * FROM products ORDER BY created_at DESC LIMIT 50');
        res.json(stripCost(rows, req.session.user));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ============================================================
//  RÉCEPTIONS
// ============================================================
app.post('/api/receptions', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const { supplier_id, reference, note, lines } = req.body;
        if (!Array.isArray(lines) || !lines.length)
            return res.status(400).json({ error: 'Aucune ligne de réception' });
        // Kits STARLINK : version + ID routeur obligatoires (un par kit, uniques, jamais déjà en stock).
        const seenRouters = new Set();
        for (const line of lines) {
            if (!line.starlink) continue;
            const version = String(line.subcategory || '').trim();
            if (!version) return res.status(400).json({ error: 'Starlink : version obligatoire (V3, V4, Standard, Mini…)' });
            const qty = Math.max(1, parseInt(line.quantity, 10) || 1);
            const ids = (Array.isArray(line.router_ids) ? line.router_ids : []).map(s => String(s || '').trim().toUpperCase());
            if (ids.length !== qty || ids.some(x => !x)) return res.status(400).json({ error: `Starlink ${version} : un ID routeur par kit (${qty} attendu(s)).` });
            // N° de série de l'ANTENNE : obligatoire aussi (un par kit, même ordre que les ID routeur).
            const sns = (Array.isArray(line.serials) ? line.serials : []).map(s => String(s || '').trim());
            if (sns.length !== qty || sns.some(x => !x)) return res.status(400).json({ error: `Starlink ${version} : n° de série de l'antenne obligatoire pour chaque kit (${qty} attendu(s)).` });
            for (const id of ids) {
                if (seenRouters.has(id)) return res.status(400).json({ error: `ID routeur ${id} saisi deux fois.` });
                seenRouters.add(id);
                // Comme pour les SN d'antenne, un kit retiré ou vendu ne bloque pas une nouvelle réception.
                const dup = await dbGet(`SELECT serial FROM stock_units
                    WHERE UPPER(router_id) = ? AND status NOT IN ('vendu','retire') LIMIT 1`, [id]);
                if (dup) return res.status(400).json({ error: `ID routeur ${id} déjà enregistré (kit ${dup.serial}).` });
            }
            line.router_ids = ids;
            line.is_accessory = true; line.category = 'Starlink'; line.brand = 'Starlink';
            line.model = `Kit ${version}`;
        }

        // N° de série constructeur scannés : UNIQUES (une étiquette = un appareil). Refus d'un doublon dans la
        // réception, ou d'un n° déjà porté par une unité encore présente (dépôt, boutique, garantie…).
        {
            const seenSn = new Map();
            for (const line of lines) for (const raw of (Array.isArray(line.serials) ? line.serials : [])) {
                const sn = String(raw || '').trim(); if (!sn) continue;
                const k = sn.toUpperCase();
                if (seenSn.has(k)) return res.status(400).json({ error: `N° de série « ${sn} » scanné deux fois dans cette réception.` });
                seenSn.set(k, sn);
            }
            for (const [k, sn] of seenSn) {
                const dup = await dbGet(`SELECT u.serial, p.name FROM stock_units u LEFT JOIN products p ON p.id = u.product_id
                    WHERE UPPER(u.manufacturer_sn) = ? AND u.status NOT IN ('vendu','retire') LIMIT 1`, [k]);
                if (dup) return res.status(400).json({ error: `N° de série « ${sn} » déjà en stock (${dup.name || 'produit'}, étiquette ${dup.serial}).` });
            }
        }

        const settings = await getSettingsAsync();
        const defWarr  = parseInt(settings.default_warranty_days, 10) || 30;
        const supplier = supplier_id ? await dbGet('SELECT * FROM suppliers WHERE id = ?', [supplier_id]) : null;
        const now = getDateTime(), today = getDate();

        // Écriture ATOMIQUE et sérialisée : deux réceptions simultanées ne peuvent plus calculer la même
        // séquence de n° de série, et une erreur en cours de route n'en laisse aucune trace partielle.
        const { receptionId, totalUnits, units } = await withTx(async () => {
        const recep = await dbRun(
            `INSERT INTO receptions (reference, supplier_id, user_id, user_name, note, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [reference || null, supplier_id || null, req.session.user.id,
             req.session.user.full_name || req.session.user.username, note || null, now]);
        const receptionId = recep.lastID;
        let totalUnits = 0;

        for (const line of lines) {
            const qty   = Math.max(1, parseInt(line.quantity, 10) || 1);
            const price = parseFloat(line.unit_price) || 0;
            const warrantyDays = (line.warranty_days != null && line.warranty_days !== '')
                ? parseInt(line.warranty_days, 10)
                : (supplier && supplier.warranty_days != null ? supplier.warranty_days : defWarr);

            const cbm = await canonicalBrandModel(line.brand || null, line.model || null);
            const prod = {
                is_accessory: line.is_accessory ? 1 : 0,
                category: line.category || null, subcategory: line.subcategory || null,
                brand: cbm.brand || null, model: cbm.model || null,
                condition: line.condition || null, cpu: line.cpu || null, ram: line.ram || null,
                storage: line.storage || null, storage_type: line.storage_type || null, gpu: line.gpu || null,
                screen_size: line.screen_size || null,
                touchscreen: line.touchscreen ? 1 : 0, webcam: line.webcam ? 1 : 0,
                wifi: line.wifi ? 1 : 0, bluetooth: line.bluetooth ? 1 : 0, numpad: line.numpad ? 1 : 0
            };
            const sig  = productSignature(prod);
            const name = productDisplayName(prod);
            // Tous les accessoires sont désormais suivis à l'unité : chaque pièce reçoit un
            // n° de série UNIQUE (comme les ordinateurs), au lieu d'un code de modèle partagé.
            const serialized = prod.is_accessory ? 1 : 0;
            // Emplacement(s) au dépôt saisi(s) en réception (facultatif, liste séparée par virgules) :
            // ne jamais écraser un emplacement existant si le champ est laissé vide (COALESCE sur l'UPDATE).
            const emplacement = normEmplacement(line.emplacement);
            const image = safeUploadPath(line.image);   // jamais de chemin arbitraire venant du client
            let existing = await dbGet('SELECT id FROM products WHERE signature = ?', [sig]);
            let productId;
            if (existing) {
                productId = existing.id;
                await dbRun(`UPDATE products SET sale_price = ?, image = COALESCE(?, image), image_source = CASE WHEN ? IS NOT NULL THEN 'manuel' ELSE image_source END, description = COALESCE(?, description), emplacement = COALESCE(?, emplacement), serialized = ? WHERE id = ?`,
                    [price, image, image, line.description || null, emplacement, serialized, productId]);
                await syncUnitPrices(productId, price, req);   // prix de la fiche = prix de toutes ses unités non vendues
            } else {
                const pr = await dbRun(
                    `INSERT INTO products (signature, is_accessory, serialized, name, category, subcategory, brand, model, condition, cpu, ram, storage, storage_type, gpu, screen_size, touchscreen, webcam, wifi, bluetooth, numpad, sale_price, image, description, emplacement, created_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                    [sig, prod.is_accessory, serialized, name, prod.category, prod.subcategory, prod.brand, prod.model, prod.condition, prod.cpu, prod.ram,
                     prod.storage, prod.storage_type, prod.gpu, prod.screen_size, prod.touchscreen, prod.webcam, prod.wifi,
                     prod.bluetooth, prod.numpad, price, image, line.description || null, emplacement, now]);
                productId = pr.lastID;
            }

            await dbRun(`INSERT INTO reception_items (reception_id, product_id, quantity, unit_price, warranty_days, created_at)
                         VALUES (?, ?, ?, ?, ?, ?)`, [receptionId, productId, qty, price, warrantyDays, now]);

            const warrantyEnd = addDays(today, warrantyDays);
            // Starlink : SN antenne POSITIONNEL (aligné sur l'ID routeur du même kit, vide autorisé).
            const serials = Array.isArray(line.serials) ? line.serials.map(s => String(s || '').trim()).filter(x => line.starlink || x) : [];
            for (let i = 0; i < qty; i++) {
                await dbRun(
                    `INSERT INTO stock_units (product_id, supplier_id, reception_id, status, location, sale_price, warranty_start, warranty_end, manufacturer_sn, router_id, created_at, updated_at)
                     VALUES (?, ?, ?, 'stock', 'depot', ?, ?, ?, ?, ?, ?, ?)`,
                    [productId, supplier_id || null, receptionId, price, today, warrantyEnd, serials[i] || null,
                     line.starlink ? line.router_ids[i] : null, now, now]);
                totalUnits++;
            }
        }

        // Numéros de série : chiffres uniquement, 6 chiffres de date (AAMMJJ)
        // du jour de la réception + séquence du jour. Ex : 2607280001.
        const prefix = getDate().slice(2).replace(/-/g, '');   // 'YYYY-MM-DD' → 'AAMMJJ'
        const maxRow = await dbGet(
            `SELECT MAX(CAST(substr(serial, 7) AS INTEGER)) AS mx FROM stock_units WHERE serial GLOB ?`,
            [prefix + '[0-9]*']);
        let seq = (maxRow && maxRow.mx) ? maxRow.mx : 0;
        // On numérote les ordinateurs ET tous les accessoires (désormais serialized = 1) : chaque
        // pièce reçoit un n° unique. Les unités d'accessoires DÉJÀ en stock (serial NULL, reçues
        // avant ce changement) gardent leur code de modèle partagé 'A…' à l'affichage/étiquette.
        const toNumber = await dbAll(
            `SELECT u.id FROM stock_units u JOIN products p ON p.id = u.product_id
             WHERE u.reception_id = ? AND u.serial IS NULL AND (p.is_accessory = 0 OR p.serialized = 1) ORDER BY u.id`, [receptionId]);
        for (const row of toNumber) {
            seq++;
            await dbRun(`UPDATE stock_units SET serial = ? WHERE id = ?`, [prefix + String(seq).padStart(4, '0'), row.id]);
        }
        await dbRun('UPDATE receptions SET total_units = ? WHERE id = ?', [totalUnits, receptionId]);

        const units = await dbAll(
            `SELECT u.*, p.name AS product_name, p.category, p.subcategory, p.brand, p.model, p.condition, p.cpu, p.ram, p.storage, p.storage_type, p.gpu, p.screen_size, p.touchscreen, p.numpad, p.description, p.is_accessory
             FROM stock_units u LEFT JOIN products p ON p.id = u.product_id
             WHERE u.reception_id = ? ORDER BY u.id`, [receptionId]);
        for (const u of units)
            await recordMovement(u, 'stock', 'reception', req, { from: null, ref_type: 'reception', ref_id: receptionId, note: 'Réception initiale' });
        return { receptionId, totalUnits, units };
        });

        logActivity(req, 'reception', 'reception', receptionId, { units: totalUnits, supplier: supplier ? supplier.name : null });
        broadcast('reception:new', { id: receptionId, units: totalUnits });
        broadcast('stock:update', { reception_id: receptionId });   // rafraîchit tout écran de stock ouvert
        rqMatchReception([...new Set(units.map(u => u.product_id))]);   // demandes clients satisfaites → commercial notifié
        // Nouvelle entrée en stock : les commerciaux (boutique + en ligne) sont prévenus immédiatement.
        {
            const byName = {};
            units.forEach(u => { const k = u.product_name || 'Produit'; byName[k] = (byName[k] || 0) + 1; });
            const names = Object.keys(byName);
            const top = names.sort((a, b) => byName[b] - byName[a]).slice(0, 3)
                .map(n => byName[n] > 1 ? `${n} ×${byName[n]}` : n).join(', ');
            const msg = `${totalUnits} unité(s) entrée(s) en stock${supplier ? ` (fournisseur ${supplier.name})` : ''} : ${top}${names.length > 3 ? ` +${names.length - 3} autre(s)` : ''}.`;
            pushNotification({ target_role: 'commercial', type: 'success', title: 'Nouvelle entrée en stock', message: msg, link: '/stock.html' });
            pushNotification({ target_role: 'commercial_ligne', type: 'success', title: 'Nouvelle entrée en stock', message: msg, link: '/online.html' });
        }
        // Étiquettes : les accessoires (serial NULL) reçoivent leur code de modèle partagé.
        const respUnits = units.map(u => ({ ...u, serial: displaySerial(u) }));
        batterySweep();   // batterie reçue (nouvelle référence) → recherche des ordinateurs compatibles
        // Produits reçus sans photo → photo Internet automatique (en priorité, en arrière-plan).
        [...new Set(units.map(u => u.product_id))].forEach(pid => AutoImgQueue.add(pid, true));
        res.json({ success: true, reception_id: receptionId, total_units: totalUnits, units: respUnits });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/receptions', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const { from, to, supplier_id, user_id } = req.query;
        const w = [], p = [];
        if (from)        { w.push('date(r.created_at) >= date(?)'); p.push(from); }
        if (to)          { w.push('date(r.created_at) <= date(?)'); p.push(to); }
        if (supplier_id) { w.push('r.supplier_id = ?'); p.push(supplier_id); }
        if (user_id)     { w.push('r.user_id = ?'); p.push(user_id); }
        const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
        const rows = await dbAll(
            `SELECT r.*, s.name AS supplier_name,
                (SELECT GROUP_CONCAT(ri.quantity || '× ' || COALESCE(p.name, 'produit'), ' · ')
                 FROM reception_items ri LEFT JOIN products p ON p.id = ri.product_id WHERE ri.reception_id = r.id) AS items_summary
             FROM receptions r LEFT JOIN suppliers s ON s.id = r.supplier_id ${where}
             ORDER BY r.created_at DESC LIMIT 500`, p);
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Détail unité par unité de toutes les réceptions d'une période (rapport détaillé).
// Défini AVANT /api/receptions/:id.
app.get('/api/receptions/detailed', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const { from, to, supplier_id } = req.query;
        const w = [], p = [];
        if (from)        { w.push('date(r.created_at) >= date(?)'); p.push(from); }
        if (to)          { w.push('date(r.created_at) <= date(?)'); p.push(to); }
        if (supplier_id) { w.push('r.supplier_id = ?'); p.push(supplier_id); }
        const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
        const rows = await dbAll(
            `SELECT u.serial, u.manufacturer_sn, u.sale_price, u.warranty_start, u.warranty_end,
                    r.id AS reception_id, r.reference, r.created_at AS reception_at, r.user_name,
                    s.name AS supplier_name,
                    p.name AS product_name, p.brand, p.model, p.category, p.condition,
                    p.cpu, p.ram, p.storage, p.storage_type, p.screen_size, p.gpu, p.touchscreen, p.numpad, p.is_accessory
             FROM stock_units u
             JOIN receptions r ON r.id = u.reception_id
             LEFT JOIN suppliers s ON s.id = r.supplier_id
             LEFT JOIN products p ON p.id = u.product_id
             ${where}
             ORDER BY r.created_at DESC, u.id LIMIT 3000`, p);
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Garanties revenues (retour fournisseur re-réceptionné au stock) — l'unité rentre
// à nouveau au stock : on la traite ici comme une réception, avec ré-impression de
// la nouvelle étiquette. Deux flux couverts : « Réintégré au stock » (traitement direct)
// et « Revenu et re-réceptionné » (via responsable garanties). Config/prix = état ACTUEL
// de l'unité (après correction éventuelle RAM/stockage/prix à la ré-réception).
app.get('/api/receptions/garantie-returns', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const { from, to, supplier_id } = req.query;
        const w = ["ga.garantie_type = 'fournisseur'", "ga.action = 'traite'"], p = [];
        if (from)        { w.push('date(ga.created_at) >= date(?)'); p.push(from); }
        if (to)          { w.push('date(ga.created_at) <= date(?)'); p.push(to); }
        if (supplier_id) { w.push('ga.supplier_id = ?'); p.push(supplier_id); }
        const rows = await dbAll(
            `SELECT ga.id, ga.serial, ga.created_at, ga.supplier_name, ga.user_name, ga.reason,
                    u.id AS unit_id, u.sale_price, u.warranty_start, u.warranty_end, u.manufacturer_sn, u.status,
                    p.name AS product_name, p.brand, p.model, p.category, p.subcategory, p.is_accessory,
                    p.cpu, p.ram, p.storage, p.storage_type, p.screen_size, p.gpu
             FROM garantie_actions ga
             LEFT JOIN stock_units u ON u.id = ga.unit_id
             LEFT JOIN products p ON p.id = u.product_id
             WHERE ${w.join(' AND ')}
             ORDER BY ga.created_at DESC LIMIT 500`, p);
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/receptions/:id', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const r = await dbGet(
            `SELECT r.*, s.name AS supplier_name FROM receptions r
             LEFT JOIN suppliers s ON s.id = r.supplier_id WHERE r.id = ?`, [req.params.id]);
        if (!r) return res.status(404).json({ error: 'Réception introuvable' });
        const items = await dbAll(
            `SELECT ri.*, p.name AS product_name, p.category, p.subcategory, p.brand, p.model, p.condition, p.cpu, p.ram, p.storage, p.storage_type, p.description, p.is_accessory,
                (SELECT COUNT(*) FROM stock_units su WHERE su.reception_id = ri.reception_id AND su.product_id = ri.product_id) AS unit_total,
                (SELECT COUNT(*) FROM stock_units su WHERE su.reception_id = ri.reception_id AND su.product_id = ri.product_id AND su.status = 'stock') AS unit_stock
             FROM reception_items ri LEFT JOIN products p ON p.id = ri.product_id
             WHERE ri.reception_id = ?`, [req.params.id]);
        const units = await dbAll(
            `SELECT u.*, p.name AS product_name, p.category, p.subcategory, p.cpu, p.ram, p.storage, p.storage_type, p.gpu, p.screen_size, p.touchscreen, p.numpad, p.condition, p.description, p.is_accessory, p.brand, p.model
             FROM stock_units u LEFT JOIN products p ON p.id = u.product_id
             WHERE u.reception_id = ? ORDER BY u.id`, [req.params.id]);
        res.json({ ...r, items, units });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Admin : supprimer un produit reçu (retire du stock les unités NON bougées de cette réception).
app.delete('/api/reception-items/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        const item = await dbGet('SELECT * FROM reception_items WHERE id = ?', [req.params.id]);
        if (!item) return res.status(404).json({ error: 'Ligne de réception introuvable' });
        const units = await dbAll(
            `SELECT id, serial FROM stock_units WHERE reception_id = ? AND product_id = ? AND status = 'stock'`,
            [item.reception_id, item.product_id]);
        const totalRow = await dbGet(`SELECT COUNT(*) AS n FROM stock_units WHERE reception_id = ? AND product_id = ?`,
            [item.reception_id, item.product_id]);
        const blocked = (totalRow.n || 0) - units.length;
        if (!units.length)
            return res.status(400).json({ error: 'Aucune unité supprimable : toutes ont déjà bougé dans le stock.' });
        const remaining = (totalRow.n || 0) - units.length;
        await withTx(async () => {
            for (const u of units) {
                const del = await dbRun(`DELETE FROM stock_units WHERE id = ? AND status = 'stock'`, [u.id]);
                if (del.changes !== 1) throw txError(409, `Unité ${u.serial || u.id} déplacée entre-temps — rechargez.`);
                await dbRun('DELETE FROM unit_movements WHERE unit_id = ?', [u.id]);
            }
            if (remaining <= 0) await dbRun('DELETE FROM reception_items WHERE id = ?', [item.id]);
            else await dbRun('UPDATE reception_items SET quantity = ? WHERE id = ?', [remaining, item.id]);
            const rt = await dbGet('SELECT COUNT(*) AS n FROM stock_units WHERE reception_id = ?', [item.reception_id]);
            await dbRun('UPDATE receptions SET total_units = ? WHERE id = ?', [rt.n || 0, item.reception_id]);
        });
        logActivity(req, 'delete', 'reception_item', item.id, { units: units.length, product_id: item.product_id });
        broadcast('stock:update', {}); broadcast('reception:new', {});
        res.json({ success: true, deleted: units.length, blocked });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Unités (pour les étiquettes).
app.get('/api/stock-units', requireAuth, async (req, res) => {
    try {
        const cols = `u.*, p.name AS product_name, p.category, p.subcategory, p.brand, p.model, p.condition, p.cpu, p.ram, p.storage, p.storage_type, p.gpu, p.screen_size, p.touchscreen, p.numpad, p.description, p.is_accessory`;
        let rows = [];
        if (req.query.reception_id) {
            rows = await dbAll(`SELECT ${cols} FROM stock_units u LEFT JOIN products p ON p.id = u.product_id WHERE u.reception_id = ? ORDER BY u.id`, [req.query.reception_id]);
        } else if (req.query.ids) {
            const arr = String(req.query.ids).split(',').map(x => parseInt(x, 10)).filter(Boolean);
            if (arr.length) {
                const ph = arr.map(() => '?').join(',');
                rows = await dbAll(`SELECT ${cols} FROM stock_units u LEFT JOIN products p ON p.id = u.product_id WHERE u.id IN (${ph})`, arr);
            }
        }
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/stock', requireAuth, async (req, res) => {
    try {
        const q = (req.query.search || '').trim();
        const like = `%${q}%`;
        const rows = await dbAll(
            `SELECT p.*,
                SUM(CASE WHEN u.status='stock'       THEN 1 ELSE 0 END) AS available,
                SUM(CASE WHEN u.status='preparation' THEN 1 ELSE 0 END) AS in_prep,
                SUM(CASE WHEN u.status='presentoir'  THEN 1 ELSE 0 END) AS presentoir,
                SUM(CASE WHEN u.status='reserve'     THEN 1 ELSE 0 END) AS reserved,
                SUM(CASE WHEN u.status='consignation' THEN 1 ELSE 0 END) AS in_presentation,
                COUNT(u.id) AS total,
                (SELECT COUNT(*) FROM stock_units ua WHERE ua.product_id = p.id AND ua.status = 'acompte') AS in_acompte,
                MIN(u.warranty_end) AS min_warranty_end,
                (SELECT COUNT(*) FROM sale_items si JOIN deliveries dd ON dd.sale_id = si.sale_id
                 WHERE si.product_id = p.id AND si.unit_id IS NULL AND dd.status = 'facturee') AS reserved_delivery,
                (SELECT su.supplier_id FROM stock_units su WHERE su.product_id = p.id AND su.supplier_id IS NOT NULL ORDER BY su.id LIMIT 1) AS supplier_id,
                (SELECT s.name FROM stock_units su JOIN suppliers s ON s.id = su.supplier_id WHERE su.product_id = p.id AND su.supplier_id IS NOT NULL ORDER BY su.id LIMIT 1) AS supplier_name,
                (SELECT COUNT(DISTINCT su.supplier_id) FROM stock_units su WHERE su.product_id = p.id AND su.supplier_id IS NOT NULL) AS supplier_count
             FROM products p
             LEFT JOIN stock_units u ON u.product_id = p.id AND u.status IN ('stock','preparation','presentoir','reserve','consignation')
             WHERE (EXISTS (SELECT 1 FROM stock_units su WHERE su.product_id = p.id) OR p.is_service = 1)
                ${q ? `AND (p.name LIKE ? OR p.model LIKE ? OR p.brand LIKE ? OR p.category LIKE ? OR p.subcategory LIKE ?
                          OR p.description LIKE ? OR p.cpu LIKE ? OR p.ram LIKE ? OR p.storage LIKE ? OR p.storage_type LIKE ?
                          OR p.gpu LIKE ? OR p.screen_size LIKE ? OR p.condition LIKE ? OR p.emplacement LIKE ?
                          OR ${SQL_COMPACT("COALESCE(p.brand,'') || COALESCE(p.model,'') || COALESCE(p.name,'')")} LIKE ?)` : ''}
             GROUP BY p.id
             ORDER BY p.is_accessory, (available > 0) DESC, p.name`,
            q ? [...Array(14).fill(like), '%' + sigAlnum(q) + '%'] : []);
        // Fournisseurs des unités encore détenues (dépôt + boutique) : code couleur + filtre des cartes.
        const sup = await dbAll(
            `SELECT u.product_id, u.supplier_id, s.name, COUNT(*) AS n
             FROM stock_units u LEFT JOIN suppliers s ON s.id = u.supplier_id
             WHERE u.status IN ('stock','preparation','presentoir','reserve','consignation') AND u.supplier_id IS NOT NULL
             GROUP BY u.product_id, u.supplier_id ORDER BY n DESC`, []);
        const byProd = new Map();
        sup.forEach(r => { if (!byProd.has(r.product_id)) byProd.set(r.product_id, []); byProd.get(r.product_id).push({ id: r.supplier_id, name: r.name || 'Fournisseur #' + r.supplier_id, n: r.n }); });
        rows.forEach(p => {
            p.suppliers = byProd.get(p.id)
                || (p.supplier_id ? [{ id: p.supplier_id, name: p.supplier_name || 'Fournisseur #' + p.supplier_id, n: 0 }] : []);
        });
        res.json(stripCost(rows, req.session.user));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Approvisionnement : produits connus + disponibilité (faible / rupture). Style TECHFLOW.
app.get('/api/stock/appro', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const settings = await getSettingsAsync();
        const threshold = Math.max(0, parseInt(settings.low_stock_threshold, 10) || 2);
        const q = (req.query.search || '').trim(), like = `%${q}%`;
        const rows = await dbAll(
            `SELECT p.*,
                (SELECT COUNT(*) FROM stock_units su WHERE su.product_id = p.id AND su.status = 'stock') AS available,
                (SELECT COUNT(*) FROM stock_units su WHERE su.product_id = p.id AND su.status IN ('stock','preparation','presentoir','reserve','consignation')) AS held,
                (SELECT s.name FROM stock_units su LEFT JOIN suppliers s ON s.id = su.supplier_id WHERE su.product_id = p.id AND su.supplier_id IS NOT NULL ORDER BY su.id DESC LIMIT 1) AS last_supplier
             FROM products p
             WHERE EXISTS (SELECT 1 FROM stock_units su WHERE su.product_id = p.id)
                ${q ? `AND (p.name LIKE ? OR p.model LIKE ? OR p.brand LIKE ? OR p.category LIKE ? OR p.subcategory LIKE ? OR p.description LIKE ?)` : ''}
             ORDER BY available ASC, p.is_accessory, p.name`,
            q ? Array(6).fill(like) : []);
        res.json({ threshold, products: stripCost(rows, req.session.user) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Unités d'un produit (pour sélection / envoi installation).
app.get('/api/products/:id/units', requireAuth, async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT u.*, us.full_name AS holder_name,
                    p.brand, p.model, p.category, p.subcategory, p.condition, p.cpu, p.ram, p.storage, p.storage_type, p.gpu, p.screen_size, p.touchscreen, p.numpad, p.description, p.name AS product_name, p.is_accessory
             FROM stock_units u
             LEFT JOIN users us ON us.id = u.holder_user_id
             LEFT JOIN products p ON p.id = u.product_id
             WHERE u.product_id = ? AND u.status IN ('stock','preparation','presentoir','reserve','consignation')
             ORDER BY CASE u.status WHEN 'stock' THEN 0 WHEN 'presentoir' THEN 1 WHEN 'consignation' THEN 2 ELSE 3 END, u.id`,
            [req.params.id]);
        // Accessoire sans serial → affiche le code de modèle partagé.
        res.json(rows.map(u => ({ ...u, serial: displaySerial(u) })));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Envoyer unité(s) en garantie — gestion stock.
// Envoi direct en garantie depuis le stock (hors retour client) : soit des unités précises
// (bouton dans le détail produit), soit un panier produit/quantité (auto-sélection des séries,
// même mécanisme que l'envoi en installation) depuis la sortie de stock (installModal).
app.post('/api/stock/send-warranty', requireAuth, requireRole('admin', 'gestion_stock'), async (req, res) => {
    try {
        const { unit_ids, lines, warranty_type, reason } = req.body;
        // NB : le statut correct est 'garantie_exceptionnel' (sans « le » final) — c'est celui
        // utilisé partout ailleurs (garantie.html, tableaux de bord, historique).
        if (!['garantie_fournisseur', 'garantie_exceptionnel'].includes(warranty_type))
            return res.status(400).json({ error: 'Type garantie invalide' });
        // Motif / raison obligatoire dès l'entrée en garantie.
        if (!reason || !String(reason).trim())
            return res.status(400).json({ error: 'Motif / raison obligatoire' });

        let units = [];
        if (Array.isArray(lines) && lines.length) {
            for (const l of lines) {
                const qty = Math.max(1, parseInt(l.quantity, 10) || 1);
                const avail = await dbAll(
                    `SELECT * FROM stock_units WHERE product_id = ? AND status = 'stock' AND location = 'depot' ORDER BY id LIMIT ?`,
                    [l.product_id, qty]);
                if (avail.length < qty) {
                    const pr = await dbGet('SELECT name FROM products WHERE id = ?', [l.product_id]);
                    return res.status(400).json({ error: `Stock insuffisant pour « ${pr ? pr.name : 'produit'} » (${avail.length}/${qty} disponibles)` });
                }
                units.push(...avail);
            }
        } else if (Array.isArray(unit_ids) && unit_ids.length) {
            const ph = unit_ids.map(() => '?').join(',');
            units = await dbAll(`SELECT * FROM stock_units WHERE id IN (${ph}) AND status = 'stock' AND location = 'depot'`, unit_ids);
            if (units.length < unit_ids.length) return res.status(400).json({ error: 'Une ou plusieurs unités ne sont plus disponibles au dépôt' });
        }
        if (!units.length) return res.status(400).json({ error: 'Aucune unité sélectionnée' });

        const now = getDateTime();
        await withTx(async () => {
            for (const u of units) {
                const up = await dbRun(`UPDATE stock_units SET location = 'garantie', status = ?, holder_user_id = NULL, note = ?, updated_at = ? WHERE id = ? AND status = 'stock'`,
                    [warranty_type, (reason || '').trim() || null, now, u.id]);
                if (up.changes !== 1) throw txError(409, `Unité ${u.serial || u.id} déplacée entre-temps — rechargez.`);
                await recordMovement(u, warranty_type, 'garantie_envoi', req, { from: 'stock', note: reason || '' });
                await logGarantie(u, 'entree', garantieType(warranty_type), req, { reason });
            }
        });

        logActivity(req, 'create', 'warranty', null, { warranty_type, reason, count: units.length });
        broadcast('stock:update', {});
        broadcast('warranty:update', {});
        res.json({ success: true, count: units.length });
    } catch (e) {
        if (!e.status) console.error('Send warranty error:', e);
        res.status(e.status || 500).json({ error: e.message });
    }
});

// Modifier un produit (image, prix, description) — gestionnaire.
// Créer un SERVICE (produit illimité, sans stock) : diagnostic, installation, réinstallation…
app.post('/api/services', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const name = String(req.body.name || '').trim();
        if (!name) return res.status(400).json({ error: 'Nom du service requis' });
        const price = Math.max(0, parseFloat(req.body.sale_price) || 0);
        const category = String(req.body.category || 'Service').trim() || 'Service';
        const description = String(req.body.description || '').trim() || null;
        const atelier = req.body.service_atelier ? 1 : 0;
        const now = getDateTime();
        const r = await dbRun(
            `INSERT INTO products (is_accessory, is_service, name, category, model, sale_price, description, condition, service_atelier, created_at)
             VALUES (0, 1, ?, ?, ?, ?, ?, 'neuf', ?, ?)`,
            [name, category, name, price, description, atelier, now]);
        broadcast('stock:update', {});
        res.json({ success: true, id: r.lastID });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Modification d'une fiche : responsable stock (gestion_stock) et admin — prix, identification,
// configuration, emplacement, photo, description. Prix d'achat et fournisseur : admin uniquement.
// Chaque modification est tracée (qui, quand, avant → après) : onglet « Historique » de la fiche (admin).
app.put('/api/products/:id', requireAuth, requireRole('gestion_stock'), upload.single('image'), async (req, res) => {
    try {
        const set = [], p = [];
        const isAdmin = req.session.user.role === 'admin';
        const before = await dbGet('SELECT * FROM products WHERE id = ?', [req.params.id]);
        if (!before) return res.status(404).json({ error: 'Produit introuvable' });
        const changes = {};
        const track = (f, v) => { if ((before[f] == null ? null : before[f]) !== v) changes[f] = [before[f] == null ? null : before[f], v]; };
        if (req.body.sale_price !== undefined)  { const v = parseFloat(req.body.sale_price) || 0; set.push('sale_price = ?'); p.push(v); track('sale_price', v); }
        if (req.body.description !== undefined)  { const v = req.body.description || null; set.push('description = ?'); p.push(v); track('description', v); }
        // Emplacement(s) au dépôt (ex. « E04, D03 ») — géré par le responsable stock (gestion_stock/admin).
        if (req.body.emplacement !== undefined)  { const v = normEmplacement(req.body.emplacement); set.push('emplacement = ?'); p.push(v); track('emplacement', v); }
        // Prix d'achat : réservé à l'admin (masqué aux autres).
        if (req.body.purchase_price !== undefined && isAdmin)
            { const v = parseFloat(req.body.purchase_price) || 0; set.push('purchase_price = ?'); p.push(v); track('purchase_price', v); }
        {
            ['category', 'subcategory', 'brand', 'model', 'cpu', 'ram', 'storage', 'storage_type', 'screen_size', 'gpu'].forEach(f => {
                if (req.body[f] === undefined) return;
                const v = String(req.body[f] || '').trim() || null;
                set.push(`${f} = ?`); p.push(v);
                if ((before[f] || null) !== v) changes[f] = [before[f] || null, v];
            });
            if (req.body.condition !== undefined) {
                const v = ['neuf', 'occasion', 'reconditionne'].includes(req.body.condition) ? req.body.condition : null;
                set.push('condition = ?'); p.push(v);
                if ((before.condition || null) !== v) changes.condition = [before.condition || null, v];
            }
            ['touchscreen', 'webcam', 'wifi', 'bluetooth', 'numpad'].forEach(f => {
                if (req.body[f] === undefined) return;
                const v = (req.body[f] === '1' || req.body[f] === 'true') ? 1 : 0;
                set.push(`${f} = ?`); p.push(v);
                if ((before[f] ? 1 : 0) !== v) changes[f] = [before[f] ? 1 : 0, v];
            });
            // Nom affiché recalculé quand la marque ou le modèle change (hors services).
            if ((changes.brand || changes.model) && !before.is_service) {
                set.push('name = ?');
                p.push(productDisplayName({ ...before,
                    brand: changes.brand ? changes.brand[1] : before.brand,
                    model: changes.model ? changes.model[1] : before.model }));
            }
        }
        if (req.body.service_atelier !== undefined && before.is_service) {
            const v = req.body.service_atelier === '1' || req.body.service_atelier === 'true' ? 1 : 0;
            set.push('service_atelier = ?'); p.push(v); if ((before.service_atelier ? 1 : 0) !== v) changes.service_atelier = [before.service_atelier ? 1 : 0, v];
        }
        if (req.file) { set.push('image = ?', "image_source = 'manuel'"); p.push('/uploads/' + req.file.filename); changes.image = [before.image || null, '/uploads/' + req.file.filename]; }
        if (!set.length) return res.json({ success: true });
        p.push(req.params.id);
        await dbRun(`UPDATE products SET ${set.join(', ')} WHERE id = ?`, p);
        if (Object.keys(changes).length) logActivity(req, 'product_edit', 'product', req.params.id, changes);
        // Nouveau prix → toutes les unités non vendues (dépôt, boutique, réservé, installation…) ;
        // la liste revient au front pour réimprimer leurs étiquettes.
        let repriced = [];
        if (req.body.sale_price !== undefined)
            repriced = await syncUnitPrices(+req.params.id, parseFloat(req.body.sale_price) || 0, req);
        // Après modification : si la fiche est devenue identique à une autre (mêmes détails + même prix),
        // fusion automatique dans la plus ancienne. Le front reçoit l'id conservé (merged_into).
        let mergedInto = null;
        try {
            const merged = await autoMergeIdenticalProducts(+req.params.id);
            const m = merged.find(x => x.dup === +req.params.id) || merged.find(x => x.keep === +req.params.id);
            if (m) mergedInto = { id: m.keep, name: m.name, count: merged.length };
        } catch (e) { console.error('autoMerge (PUT produit):', e.message); }
        broadcast('stock:update', { product_id: mergedInto ? mergedInto.id : +req.params.id });
        if (repriced.length) broadcast('consignment:update', {});
        // Nom / type / config modifiés → la recherche de photo change : nouvelle photo Internet tout de suite
        // (en arrière-plan, quelques secondes) avec toutes les nouvelles infos. Photo importée : conservée.
        let photoRefresh = false;
        const manualImg = x => x.image && (x.image_source === 'manuel' || !x.image_source);   // importée (ou ancienne photo sans source)
        if (!req.file && !before.is_service && !manualImg(before)) {
            const after = await dbGet('SELECT * FROM products WHERE id = ?', [mergedInto ? mergedInto.id : req.params.id]);
            if (after && !manualImg(after) && autoImageQuery(after, 0) && autoImageQuery(after, 0) !== autoImageQuery(before, 0)) {
                photoRefresh = true;
                applyAutoImage(after.id, { refresh: true }).catch(() => {});
            }
        }
        res.json({ success: true, merged_into: mergedInto, photo_refresh: photoRefresh,
                   repriced: repriced.map(u => ({ id: u.id, serial: u.serial, status: u.status, old_price: u.old_price })) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Image du catalogue (commande en ligne) : le commercial en ligne peut illustrer une fiche
// produit pour que tout le monde voie la photo. Endpoint dédié à l'image seule (ni prix ni
// description modifiables ici) — accessible au commercial en ligne (et à l'admin).
// Avancement des photos Internet automatiques (admin, Stock dépôt) : fiches avec / sans photo,
// file d'attente, rythme, pause éventuelle, dernière photo trouvée.
app.get('/api/auto-images/status', requireAuth, requireAdmin, async (req, res) => {
    try {
        const c = await dbGet(`SELECT COUNT(*) AS total,
                SUM(CASE WHEN image IS NOT NULL AND image <> '' THEN 1 ELSE 0 END) AS with_image,
                SUM(CASE WHEN image_source LIKE 'auto%' AND image IS NOT NULL AND image <> '' THEN 1 ELSE 0 END) AS auto,
                SUM(CASE WHEN image IS NOT NULL AND image <> '' AND COALESCE(image_source, '') NOT LIKE 'auto%' THEN 1 ELSE 0 END) AS manual,
                SUM(CASE WHEN (image IS NULL OR image = '') AND is_accessory = 0 THEN 1 ELSE 0 END) AS missing_pc
            FROM products WHERE COALESCE(is_service, 0) = 0`);
        const missing = await dbAll(`SELECT * FROM products WHERE COALESCE(is_service, 0) = 0 AND (image IS NULL OR image = '')`);
        const noQuery = missing.filter(p => !autoImageQuery(p)).length;
        const autos = await dbAll(`SELECT * FROM products WHERE COALESCE(is_service, 0) = 0 AND image_source = 'auto' AND image IS NOT NULL AND image <> ''`);
        const toRedo = autos.filter(p => p.image_query !== autoImageQuery(p, 0)).length;
        const q = AutoImgQueue;
        res.json({ total: c.total || 0, with_image: c.with_image || 0, auto: c.auto || 0, manual: c.manual || 0,
                   missing: missing.length, missing_pc: c.missing_pc || 0, no_query: noQuery, to_redo: toRedo,
                   pending: q.pending.size, running: q.running, paused_until: q.pausedUntil || null,
                   done: q.done, failed: q.failed, skipped: q.skipped, last: q.last, per_item_ms: 2500, now: Date.now() });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// Historique des modifications d'une fiche (admin) : qui, quand, quoi (avant → après).
app.get('/api/products/:id/history', requireAuth, requireAdmin, async (req, res) => {
    try {
        const rows = await dbAll(`SELECT l.id, l.user_id, l.user_name, l.action, l.details, l.created_at, u.role
                                  FROM activity_log l LEFT JOIN users u ON u.id = l.user_id
                                  WHERE l.entity = 'product' AND l.entity_id = ? ORDER BY l.id DESC LIMIT 300`, [String(req.params.id)]);
        res.json(rows.map(r => { let d = null; try { d = r.details ? JSON.parse(r.details) : null; } catch (e) {} return { ...r, details: d }; }));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// « Autre photo » : nouvelle recherche Internet (variante suivante de la requête) qui remplace la photo
// actuelle de la fiche — stock et commercial en ligne. Importer un fichier reste possible à tout moment.
app.post('/api/products/:id/auto-image', requireAuth, requireRole('gestion_stock', 'commercial_ligne'), async (req, res) => {
    try {
        const variant = Math.max(0, parseInt(req.body && req.body.variant, 10) || 0);
        const got = await applyAutoImage(req.params.id, { variant, force: true });
        if (!got) return res.status(404).json({ error: "Aucune photo trouvée sur Internet pour ce produit (vérifiez marque / modèle, ou importez une photo)." });
        logActivity(req, 'product_auto_image', 'product', req.params.id, { query: got.query });
        res.json({ success: true, image: got.rel, query: got.query });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.post('/api/products/:id/image', requireAuth, requireRole('commercial_ligne'), upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Aucune image reçue' });
        const prod = await dbGet('SELECT id, image FROM products WHERE id = ?', [req.params.id]);
        if (!prod) return res.status(404).json({ error: 'Produit introuvable' });
        const rel = '/uploads/' + req.file.filename;
        await dbRun(`UPDATE products SET image = ?, image_source = 'manuel' WHERE id = ?`, [rel, req.params.id]);
        logActivity(req, 'product_edit', 'product', req.params.id, { image: [prod.image || null, rel] });
        // Supprime l'ancienne image si elle était un upload local (évite d'encombrer le disque) —
        // uniquement un fichier de public/uploads, et seulement si aucune autre fiche ne l'utilise.
        if (prod.image && prod.image !== rel) {
            const shared = await dbGet('SELECT 1 FROM products WHERE image = ? AND id <> ? LIMIT 1', [prod.image, prod.id]);
            if (!shared) unlinkUpload(prod.image);
        }
        broadcast('stock:update', { product_id: +req.params.id });
        res.json({ success: true, image: rel });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Correction du fournisseur d'un produit (erreur de saisie en réception) — ADMIN uniquement.
// Met à jour le fournisseur de TOUTES les unités du produit (provenance corrigée partout).
app.patch('/api/products/:id/supplier', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const supplier_id = parseInt(req.body.supplier_id, 10);
        if (!supplier_id) return res.status(400).json({ error: 'Fournisseur requis' });
        const sup = await dbGet('SELECT id, name FROM suppliers WHERE id = ?', [supplier_id]);
        if (!sup) return res.status(400).json({ error: 'Fournisseur introuvable' });
        const prod = await dbGet('SELECT id, name FROM products WHERE id = ?', [req.params.id]);
        if (!prod) return res.status(404).json({ error: 'Produit introuvable' });
        const r = await dbRun(`UPDATE stock_units SET supplier_id = ? WHERE product_id = ?`, [supplier_id, req.params.id]);
        logActivity(req, 'product_supplier_edit', 'product', req.params.id, { supplier_id, supplier: sup.name, units: r.changes });
        broadcast('stock:update', { product_id: +req.params.id });
        res.json({ success: true, count: r.changes, supplier_name: sup.name });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Données de départ : liste attendue + connues (pour feedback instantané côté scanner).
app.get('/api/inventaire/data', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const kind = invGuard(req, res); if (!kind) return;
        const [expected, known] = await Promise.all([inventaireExpected(kind), inventaireKnownOther(kind)]);
        res.json({ scope: INV_SCOPE, kind, expected, known });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Brouillon d'inventaire (pause / reprendre) : un seul brouillon partagé pour le magasin. ──
// Récupère le brouillon en cours (s'il existe) pour le reprendre au chargement de la page.
app.get('/api/inventaire/draft', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const kind = invGuard(req, res); if (!kind) return;
        const d = await dbGet(`SELECT * FROM ${invDraftTable(kind)} WHERE id = 1`);
        if (!d) return res.json({ exists: false });
        // Le champ `scanned` stocke { phase, items:[{serial,loc}] } (nouveau) OU un tableau de
        // séries brutes (ancien format) — on normalise vers { phase, items }.
        let phase = 'boutique', items = [];
        try {
            const parsed = JSON.parse(d.scanned || '[]');
            if (Array.isArray(parsed)) items = parsed.map(s => ({ serial: String(s), loc: null }));
            else { phase = parsed.phase || 'boutique'; items = Array.isArray(parsed.items) ? parsed.items : []; }
        } catch (e) { items = []; }
        res.json({ exists: true, phase, items, scanned_count: d.scanned_count,
                   admin_name: d.admin_name, started_at: d.started_at, updated_at: d.updated_at });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Autosave : enregistre / met à jour le brouillon. Corps : { phase, items:[{serial,loc}] }
// (rétro-compat : accepte aussi { scanned:[séries brutes] }).
app.put('/api/inventaire/draft', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const kind = invGuard(req, res); if (!kind) return;
        const table = invDraftTable(kind);
        const rawItems = Array.isArray(req.body.items) ? req.body.items
                       : (Array.isArray(req.body.scanned) ? req.body.scanned : []);
        const phase = req.body.phase === 'depot' ? 'depot' : 'boutique';
        // Dédoublonne (par série normalisée) en conservant la série brute, l'emplacement de scan et l'ordre.
        const seen = new Set(), items = [];
        for (const it of rawItems) {
            const serial = (it && typeof it === 'object') ? it.serial : it;
            const loc = (it && typeof it === 'object') ? (it.loc || null) : null;
            const n = invNorm(serial);
            if (n && !seen.has(n)) { seen.add(n); items.push({ serial: String(serial).trim(), loc }); }
        }
        const payload = JSON.stringify({ phase, items });
        const now = getDateTime();
        const name = req.session.user.full_name || req.session.user.username;
        const existing = await dbGet(`SELECT id FROM ${table} WHERE id = 1`);
        if (existing) {
            await dbRun(`UPDATE ${table} SET admin_id = ?, admin_name = ?, scanned = ?, scanned_count = ?, updated_at = ? WHERE id = 1`,
                [req.session.user.id, name, payload, items.length, now]);
        } else {
            await dbRun(`INSERT INTO ${table} (id, admin_id, admin_name, scanned, scanned_count, started_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)`,
                [req.session.user.id, name, payload, items.length, now, now]);
        }
        res.json({ success: true, scanned_count: items.length, phase, updated_at: now });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Abandonne le brouillon (bouton « Réinitialiser » / démarrage d'un nouvel inventaire).
app.delete('/api/inventaire/draft', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const kind = invGuard(req, res); if (!kind) return;
        await dbRun(`DELETE FROM ${invDraftTable(kind)} WHERE id = 1`); res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Clôture d'un inventaire : recalcule présents / manquants / surplus et enregistre la session.
app.post('/api/inventaire/finish', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const kind = invGuard(req, res); if (!kind) return;
        // Accepte { scanned:[{serial,loc}] } (nouveau, avec emplacement de scan) ou [séries] (ancien).
        const scannedRaw = Array.isArray(req.body.scanned) ? req.body.scanned : [];
        const scannedSet = new Set(), scannedOrder = [], locByNorm = new Map();
        for (const s of scannedRaw) {
            const serial = (s && typeof s === 'object') ? s.serial : s;
            const loc = (s && typeof s === 'object') ? (s.loc || null) : null;
            const n = invNorm(serial);
            if (n && !scannedSet.has(n)) { scannedSet.add(n); scannedOrder.push(n); if (loc) locByNorm.set(n, loc); }
        }

        const [expected, known] = await Promise.all([inventaireExpected(kind), inventaireKnownOther(kind)]);
        const expByNorm = new Map(); expected.forEach(u => expByNorm.set(invNorm(u.serial), u));
        const knownByNorm = new Map(); known.forEach(u => knownByNorm.set(invNorm(u.serial), u));

        const present = [], surplus = [], misplaced = [];
        for (const n of scannedOrder) {
            if (expByNorm.has(n)) {
                const u = expByNorm.get(n);
                present.push(u);
                // Mauvais emplacement : zone physique du scan ≠ zone enregistrée dans la base.
                const loc = locByNorm.get(n), zone = INV_ZONE[u.status];
                if (loc && zone && zone !== loc) misplaced.push({ ...u, scan_loc: loc, recorded_zone: zone });
            }
            else if (knownByNorm.has(n)) surplus.push({ ...knownByNorm.get(n), kind: 'known' });
            // Code inconnu (absent de la base) : IGNORÉ — ni présent, ni surplus, non enregistré.
        }
        const missing = expected.filter(u => !scannedSet.has(invNorm(u.serial)));

        const now = getDateTime();
        const data = JSON.stringify({ present, missing, surplus, misplaced, scope: INV_SCOPE });
        const r = await dbRun(
            `INSERT INTO inventaire_sessions (admin_id, admin_name, kind, expected_count, scanned_count, present_count, missing_count, surplus_count, data, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [req.session.user.id, req.session.user.full_name || req.session.user.username, kind,
             expected.length, scannedOrder.length, present.length, missing.length, surplus.length, data, now]);
        // L'inventaire est clôturé → le brouillon en cours n'a plus lieu d'être.
        await dbRun(`DELETE FROM ${invDraftTable(kind)} WHERE id = 1`);
        logActivity(req, 'inventaire', 'inventaire', r.lastID,
            { kind, expected: expected.length, scanned: scannedOrder.length, missing: missing.length, surplus: surplus.length, misplaced: misplaced.length });
        res.json({ id: r.lastID, created_at: now, admin_name: req.session.user.full_name || req.session.user.username,
                   expected_count: expected.length, scanned_count: scannedOrder.length, present, missing, surplus, misplaced });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Action sur un surplus (admin ou gestion du stock) : remettre en stock OU retirer l'unité (erreur / doublon).
app.post('/api/inventaire/resolve', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const kind = invGuard(req, res); if (!kind) return;
        const unit_id = parseInt(req.body.unit_id, 10);
        const action = String(req.body.action || '');
        if (!unit_id) return res.status(400).json({ error: 'Unité requise' });
        const u = await dbGet(`SELECT u.*, p.name AS product_name, p.is_accessory, p.serialized FROM stock_units u LEFT JOIN products p ON p.id = u.product_id WHERE u.id = ?`, [unit_id]);
        if (!u) return res.status(404).json({ error: 'Unité introuvable' });
        // Garde-fou : on n'agit que sur des unités du bon type — inventaire 'composant' → accessoires
        // sérialisés uniquement ; inventaire 'pc' (ordinateurs) → tout sauf composants.
        const isComp = u.is_accessory === 1 && u.serialized === 1;
        if (kind === 'composant' && !isComp) return res.status(400).json({ error: 'Cette unité n\'est pas un composant suivi à l\'unité.' });
        if (kind === 'pc' && isComp) return res.status(400).json({ error: 'Cette unité est un composant — utilisez l\'inventaire des composants.' });

        if (action === 'restock') {
            // Intégrité : ne pas remettre en stock une unité encore liée à une vente NON retournée
            // (sinon elle serait à la fois « vendue » et « disponible » → double comptage).
            const sold = await dbGet(`SELECT id FROM sale_items WHERE unit_id = ? AND returned = 0 LIMIT 1`, [unit_id]);
            if (sold) return res.status(400).json({ error: 'Unité liée à une vente non retournée — remise en stock impossible. Corrigez ou annulez la vente d\'abord.' });
            const now = getDateTime();
            const up = await dbRun(`UPDATE stock_units SET status = 'stock', location = 'depot', holder_user_id = NULL, updated_at = ? WHERE id = ? AND status = ?`, [now, unit_id, u.status]);
            if (up.changes !== 1) return res.status(409).json({ error: 'Unité modifiée entre-temps — rechargez.' });
            await recordMovement(u, 'stock', 'inventaire_restock', req, { from: u.status, note: 'Remis en stock via inventaire' });
            logActivity(req, 'inventaire_restock', 'unit', unit_id, { serial: u.serial, from: u.status });
            broadcast('stock:update', {});
            return res.json({ success: true, action });
        }
        // « Retirer » (ex-« supprimer ») : SOFT — l'unité passe en « retire » (hors stock et inventaire),
        // mais la ligne et son historique sont CONSERVÉS (récupérable, contrairement à un DELETE définitif).
        if (action === 'delete' || action === 'retire') {
            const now = getDateTime();
            // reason='manquant' : unité attendue mais non scannée → probablement vendue non enregistrée.
            const reason = String(req.body.reason || '');
            const note = reason === 'manquant'
                ? 'Retiré via inventaire (manquant au comptage — probablement vendu non enregistré)'
                : 'Retiré via inventaire (surplus / écart de comptage)';
            const up = await dbRun(`UPDATE stock_units SET status = 'retire', location = 'retire', holder_user_id = NULL, note = ?, updated_at = ? WHERE id = ? AND status = ?`,
                [note, now, unit_id, u.status]);
            if (up.changes !== 1) return res.status(409).json({ error: 'Unité modifiée entre-temps — rechargez.' });
            await recordMovement(u, 'retire', 'inventaire_retire', req, { from: u.status, note });
            logActivity(req, 'inventaire_retire', 'unit', unit_id, { serial: u.serial, status: u.status, product: u.product_name, reason: reason || 'surplus' });
            broadcast('stock:update', {});
            return res.json({ success: true, action: 'retire' });
        }
        return res.status(400).json({ error: 'Action invalide' });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Historique des inventaires (filtré par type : ordinateurs ou composants).
app.get('/api/inventaire/history', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const kind = invGuard(req, res); if (!kind) return;
        const rows = await dbAll(
            `SELECT id, admin_name, kind, expected_count, scanned_count, present_count, missing_count, surplus_count, created_at
             FROM inventaire_sessions WHERE COALESCE(kind, 'pc') = ? ORDER BY id DESC LIMIT 100`, [kind]);
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.get('/api/inventaire/history/:id', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const kind = invGuard(req, res); if (!kind) return;
        const s = await dbGet(`SELECT * FROM inventaire_sessions WHERE id = ?`, [req.params.id]);
        if (!s) return res.status(404).json({ error: 'Introuvable' });
        // Cloisonnement : chaque page ne consulte que ses propres sessions.
        if ((s.kind || 'pc') !== kind) return res.status(404).json({ error: 'Introuvable' });
        let data = {}; try { data = JSON.parse(s.data || '{}'); } catch (e) {}
        res.json({ ...s, data });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Unités RETIRÉES (soft-delete, status='retire') — pour en restaurer une retirée par erreur.
// La restauration se fait via /api/inventaire/resolve { action:'restock' } (réutilise ses garde-fous).
app.get('/api/inventaire/retired', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const kind = invGuard(req, res); if (!kind) return;
        const rows = await dbAll(
            `SELECT u.id AS unit_id, u.serial, u.note, u.updated_at,
                    p.name AS product_name, p.brand, p.model, p.category, p.condition,
                    p.cpu, p.ram, p.storage, p.storage_type, p.gpu, p.screen_size,
                    (SELECT m.user_name FROM unit_movements m WHERE m.unit_id = u.id AND m.to_status = 'retire' ORDER BY m.id DESC LIMIT 1) AS retired_by,
                    (SELECT m.created_at FROM unit_movements m WHERE m.unit_id = u.id AND m.to_status = 'retire' ORDER BY m.id DESC LIMIT 1) AS retired_at,
                    (SELECT si.id FROM sale_items si WHERE si.unit_id = u.id AND si.returned = 0 LIMIT 1) AS active_sale
             FROM stock_units u JOIN products p ON p.id = u.product_id
             WHERE u.status = 'retire' AND ${invFilter(kind)}
             ORDER BY COALESCE(u.updated_at, '') DESC, u.id DESC LIMIT 500`, []);
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Admin : RETIRER un produit du STOCK (produit erroné / doublon).
// - Retire le produit + TOUTES ses unités du stock (récupérable depuis la Corbeille).
// - CONSERVE TOUT L'HISTORIQUE : ventes (sale_items détaché, instantané figé), mouvements
//   (unit_movements) ET garanties (garantie_actions) NE SONT PAS supprimés → le suivi reste lisible.
//   Seuls les LIENS opérationnels actifs (boutique / livraison / réservation / acompte / installation)
//   sont nettoyés, sinon ils pointeraient dans le vide.
// - Blocage (409) : livraison / acompte / préparation pour tous ; RÉSERVATION bloquée UNIQUEMENT pour
//   les ordinateurs. Les ACCESSOIRES restent supprimables même en boutique (consignation) ou réservés.
app.delete('/api/products/:id', requireAuth, requireAdmin, async (req, res) => {
    const pid = parseInt(req.params.id, 10);
    if (!pid) return res.status(400).json({ error: 'Produit invalide' });
    try {
        const prod = await dbGet(`SELECT id, name, is_accessory FROM products WHERE id = ?`, [pid]);
        if (!prod) return res.status(404).json({ error: 'Produit introuvable' });
        const units = await dbAll(`SELECT id, serial, status FROM stock_units WHERE product_id = ?`, [pid]);
        // Accessoires : boutique (consignation, déjà permis) ET réservation autorisées. Ordinateurs :
        // réservation bloquée (engagement client à annuler d'abord). Livraison/acompte/préparation
        // bloqués pour tous (livraison en cours / argent versé / préparation en cours).
        const BLOCK = prod.is_accessory
            ? ['preparation', 'livraison', 'acompte']
            : ['preparation', 'reserve', 'livraison', 'acompte'];
        const blocked = units.filter(u => BLOCK.includes(u.status));
        if (blocked.length) {
            const ops = prod.is_accessory ? 'livraison / acompte / préparation' : 'livraison / réservation / acompte / préparation';
            return res.status(409).json({
                error: `Suppression impossible : ${blocked.length} unité(s) engagée(s) dans une opération en cours (${ops}). Terminez ou annulez ces opérations avant de supprimer le produit.`
            });
        }
        const ids = units.map(u => u.id);
        const soldKept = units.filter(u => u.status === 'vendu').length;
        // Instantané COMPLET avant suppression → corbeille (restauration possible).
        const fullProduct = await dbGet(`SELECT * FROM products WHERE id = ?`, [pid]);
        const fullUnits = await dbAll(`SELECT * FROM stock_units WHERE product_id = ?`, [pid]);
        const phAll = ids.length ? ids.map(() => '?').join(',') : '';
        const movements = ids.length ? await dbAll(`SELECT * FROM unit_movements WHERE unit_id IN (${phAll})`, ids) : [];
        const garantie  = ids.length ? await dbAll(`SELECT * FROM garantie_actions WHERE unit_id IN (${phAll})`, ids) : [];
        const receptions = await dbAll(`SELECT * FROM reception_items WHERE product_id = ?`, [pid]);
        const saleLinks = ids.length ? await dbAll(`SELECT id, unit_id FROM sale_items WHERE unit_id IN (${phAll})`, ids) : [];
        const snapshot = JSON.stringify({ product: fullProduct, units: fullUnits, movements, garantie, receptions, sale_links: saleLinks });
        const emptiedResa = [];   // réservations vidées → notifications à résoudre après commit
        await withTx(async () => {
            await dbRun(`INSERT INTO trash_products (product_id, product_name, unit_count, sold_kept, snapshot, deleted_by, deleted_at) VALUES (?,?,?,?,?,?,?)`,
                [pid, prod.name, units.length, soldKept, snapshot, (req.session.user.full_name || req.session.user.username), getDateTime()]);
            if (ids.length) {
                const ph = ids.map(() => '?').join(',');
                // Conserver les ventes : on détache l'unité (nom/prix/série restent figés dans sale_items).
                await dbRun(`UPDATE sale_items SET unit_id = NULL WHERE unit_id IN (${ph})`, ids);
                // Réservations touchées (accessoire supprimé alors que réservé) — mémorisées avant nettoyage.
                const resaRows = await dbAll(`SELECT DISTINCT reservation_id FROM reservation_items WHERE unit_id IN (${ph}) AND reservation_id IS NOT NULL`, ids);
                // Nettoyer UNIQUEMENT les liens opérationnels ACTIFS (sinon boutique/livraison/réservation/
                // installation pointeraient dans le vide). L'HISTORIQUE (unit_movements, garantie_actions)
                // est VOLONTAIREMENT conservé : lisible via ses instantanés (serial), il garde le suivi.
                for (const t of ['consignment_items', 'delivery_items', 'reservation_items', 'layaway_items', 'install_items']) {
                    await dbRun(`DELETE FROM ${t} WHERE unit_id IN (${ph})`, ids);
                }
                // Réservation désormais sans unité → marquée annulée.
                for (const r of resaRows) {
                    const left = await dbGet(`SELECT COUNT(*) AS n FROM reservation_items WHERE reservation_id = ?`, [r.reservation_id]);
                    if (!left.n) { await dbRun(`UPDATE reservations SET status = 'annule' WHERE id = ? AND status = 'active'`, [r.reservation_id]); emptiedResa.push(r.reservation_id); }
                }
            }
            await dbRun(`DELETE FROM stock_units WHERE product_id = ?`, [pid]);
            await dbRun(`DELETE FROM reception_items WHERE product_id = ?`, [pid]);
            await dbRun(`DELETE FROM products WHERE id = ?`, [pid]);
        });
        for (const rid of emptiedResa) resolveNotifs(`reservation:${rid}`);
        if (emptiedResa.length) broadcast('reservation:update', {});
        logActivity(req, 'product_delete', 'product', pid, { name: prod.name, units: units.length, sold_kept: soldKept });
        broadcast('stock:update', {});
        res.json({ success: true, deleted_units: units.length, sold_kept: soldKept });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.get('/api/corbeille/units', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        const w = [`u.status = 'retire'`], p = [];
        if (q) {
            // Recherche : n° de série (STOCKFLOW ou constructeur) ou produit — sur toute la corbeille.
            w.push(`(u.serial LIKE ? OR u.manufacturer_sn LIKE ? OR p.name LIKE ? OR p.brand LIKE ? OR p.model LIKE ?)`);
            p.push(...Array(5).fill(`%${q}%`));
        } else {
            if (DATE_RE.test(req.query.from || '')) { w.push(`substr(COALESCE(r.created_at, u.updated_at), 1, 10) >= ?`); p.push(req.query.from); }
            if (DATE_RE.test(req.query.to || ''))   { w.push(`substr(COALESCE(r.created_at, u.updated_at), 1, 10) <= ?`); p.push(req.query.to); }
        }
        const rows = await dbAll(
            `SELECT u.id AS unit_id, u.serial, u.manufacturer_sn, u.note, u.sale_price, u.product_id,
                    p.name AS product_name, p.is_accessory, p.category,
                    r.from_status, r.user_name AS retired_by, COALESCE(r.created_at, u.updated_at) AS retired_at, r.note AS retire_note,
                    (SELECT si.id FROM sale_items si WHERE si.unit_id = u.id AND si.returned = 0 LIMIT 1) AS active_sale
             FROM stock_units u
             LEFT JOIN products p ON p.id = u.product_id
             LEFT JOIN unit_movements r ON r.id = (SELECT m.id FROM unit_movements m WHERE m.unit_id = u.id AND m.to_status = 'retire' ORDER BY m.id DESC LIMIT 1)
             WHERE ${w.join(' AND ')}
             ORDER BY retired_at DESC, u.id DESC LIMIT 2000`, p);
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.get('/api/corbeille/products', requireAuth, requireAdmin, async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        const rows = q
            ? await dbAll(`SELECT id, product_id, product_name, unit_count, sold_kept, deleted_by, deleted_at, snapshot FROM trash_products
                           WHERE product_name LIKE ? OR snapshot LIKE ? ORDER BY id DESC LIMIT 200`, [`%${q}%`, `%${q}%`])
            : await dbAll(`SELECT id, product_id, product_name, unit_count, sold_kept, deleted_by, deleted_at, snapshot FROM trash_products ORDER BY id DESC LIMIT 200`);
        const ql = q.toLowerCase();
        res.json(rows.map(r => {
            let units = [];
            try { units = (JSON.parse(r.snapshot || '{}').units || []); } catch (e) {}
            const hits = q ? units.filter(u => [u.serial, u.manufacturer_sn].some(s => s && String(s).toLowerCase().includes(ql)))
                               .map(u => ({ serial: u.serial, status: u.status })) : [];
            const { snapshot, ...rest } = r;
            return { ...rest, matched_units: hits.slice(0, 20), matched_count: hits.length };
        }));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// Remettre au dépôt des unités retirées par erreur (même garde-fou que l'inventaire : pas d'unité
// encore liée à une vente non retournée).
app.post('/api/corbeille/units/restore', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const ids = (Array.isArray(req.body.unit_ids) ? req.body.unit_ids : []).map(x => parseInt(x, 10)).filter(Boolean);
        if (!ids.length) return res.status(400).json({ error: 'Aucune unité sélectionnée' });
        const units = await dbAll(`SELECT u.*, p.name AS product_name FROM stock_units u LEFT JOIN products p ON p.id = u.product_id
                                   WHERE u.id IN (${ids.map(() => '?').join(',')})`, ids);
        const now = getDateTime();
        let restored = 0; const skipped = [];
        await withTx(async () => {
            for (const u of units) {
                if (u.status !== 'retire') { skipped.push(`${u.serial || u.id} (déjà « ${u.status} »)`); continue; }
                const sold = await dbGet(`SELECT id FROM sale_items WHERE unit_id = ? AND returned = 0 LIMIT 1`, [u.id]);
                if (sold) { skipped.push(`${u.serial || u.id} (liée à une vente)`); continue; }
                const up = await dbRun(`UPDATE stock_units SET status = 'stock', location = 'depot', holder_user_id = NULL, note = NULL, updated_at = ? WHERE id = ? AND status = 'retire'`, [now, u.id]);
                if (!up.changes) { skipped.push(`${u.serial || u.id} (modifiée entre-temps)`); continue; }
                await recordMovement(u, 'stock', 'corbeille_restaure', req, { from: 'retire', note: 'Restaurée depuis la corbeille (remise au dépôt)' });
                restored++;
            }
        });
        if (restored) {
            logActivity(req, 'corbeille_restore_units', 'unit', null, { count: restored, serials: units.filter(u => u.status === 'retire').map(u => u.serial) });
            broadcast('stock:update', {});
        }
        res.json({ success: true, restored, skipped });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── CORBEILLE : lister les produits supprimés (admin) — pour vérifier une suppression accidentelle.
app.get('/api/products/trash', requireAuth, requireAdmin, async (req, res) => {
    try {
        const rows = await dbAll(`SELECT id, product_id, product_name, unit_count, sold_kept, deleted_by, deleted_at FROM trash_products ORDER BY id DESC LIMIT 200`);
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── CORBEILLE : restaurer un produit supprimé (admin) depuis son instantané.
app.post('/api/products/trash/:id/restore', requireAuth, requireAdmin, async (req, res) => {
    const tid = parseInt(req.params.id, 10);
    if (!tid) return res.status(400).json({ error: 'Entrée corbeille invalide' });
    try {
        const entry = await dbGet(`SELECT * FROM trash_products WHERE id = ?`, [tid]);
        if (!entry) return res.status(404).json({ error: 'Entrée introuvable dans la corbeille' });
        let snap;
        try { snap = JSON.parse(entry.snapshot || '{}'); } catch (e) { return res.status(500).json({ error: 'Instantané illisible' }); }
        const prod = snap.product;
        if (!prod) return res.status(500).json({ error: 'Instantané incomplet (produit manquant)' });
        // Insertion générique d'une ligne (colonnes = clés de l'objet), sans échec sur doublon.
        const insertRow = (table, obj) => {
            const cols = Object.keys(obj);
            if (!cols.length) return Promise.resolve();
            const ph = cols.map(() => '?').join(',');
            return dbRun(`INSERT OR IGNORE INTO ${table} (${cols.map(c => `"${c}"`).join(',')}) VALUES (${ph})`, cols.map(c => obj[c]));
        };
        const { targetProductId, restoredUnits, skippedUnits } = await withTx(async () => {
            // 1) Produit : re-créer avec son id d'origine si libre + signature libre ; sinon fusionner
            //    les unités dans le produit qui a repris cette signature (ré-réception entre-temps).
            let targetProductId = prod.id;
            const existsSame = await dbGet(`SELECT id FROM products WHERE id = ?`, [prod.id]);
            const sigOwner = prod.signature ? await dbGet(`SELECT id FROM products WHERE signature = ? AND id <> ?`, [prod.signature, prod.id]) : null;
            if (!existsSame && !sigOwner) { await insertRow('products', prod); targetProductId = prod.id; }
            else if (sigOwner) targetProductId = sigOwner.id;       // fusion dans le produit courant
            else targetProductId = existsSame.id;                   // déjà présent

            // 2) Unités : ré-insérer (id d'origine) sauf si le n° de série (ou l'id) existe déjà.
            let restoredUnits = 0, skippedUnits = 0;
            for (const u of (snap.units || [])) {
                const clash = u.serial ? await dbGet(`SELECT id FROM stock_units WHERE serial = ?`, [u.serial]) : null;
                const idClash = await dbGet(`SELECT id FROM stock_units WHERE id = ?`, [u.id]);
                if (clash || idClash) { skippedUnits++; continue; }
                await insertRow('stock_units', { ...u, product_id: targetProductId });
                restoredUnits++;
            }
            // 3) Lignes de réception + historiques (mouvements, actions garantie).
            for (const r of (snap.receptions || [])) await insertRow('reception_items', { ...r, product_id: targetProductId });
            for (const m of (snap.movements || [])) await insertRow('unit_movements', m);
            for (const g of (snap.garantie || [])) await insertRow('garantie_actions', g);
            // 4) Re-lier les ventes détachées (si l'unité est bien revenue en base).
            for (const s of (snap.sale_links || [])) {
                const back = await dbGet(`SELECT id FROM stock_units WHERE id = ?`, [s.unit_id]);
                if (back) await dbRun(`UPDATE sale_items SET unit_id = ? WHERE id = ? AND unit_id IS NULL`, [s.unit_id, s.id]);
            }
            await dbRun(`DELETE FROM trash_products WHERE id = ?`, [tid]);
            return { targetProductId, restoredUnits, skippedUnits };
        });
        logActivity(req, 'product_restore', 'product', targetProductId, { name: entry.product_name, restored_units: restoredUnits, skipped_units: skippedUnits });
        broadcast('stock:update', {});
        res.json({ success: true, product_id: targetProductId, restored_units: restoredUnits, skipped_units: skippedUnits });
    } catch (e) { console.error('Restore product error:', e); res.status(500).json({ error: e.message }); }
});

// ── CORBEILLE : purger définitivement une entrée (admin).
app.delete('/api/products/trash/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
        await dbRun(`DELETE FROM trash_products WHERE id = ?`, [parseInt(req.params.id, 10)]);
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Ajustement de stock (ADMIN) : RETIRER des unités précises (par n° de série) du stock.
// Cas d'usage : une unité a été physiquement vendue/perdue mais la sortie n'a jamais été
// enregistrée → l'admin sélectionne la/les série(s) concernée(s) et les retire pour remettre
// le stock d'aplomb. Statut « retire » : l'unité disparaît de toutes les disponibilités et de
// l'inventaire, mais la LIGNE et son HISTORIQUE (série figée) sont conservés (traçabilité).
app.post('/api/units/retire', requireAuth, requireAdmin, async (req, res) => {
    try {
        const ids = Array.isArray(req.body.unit_ids) ? req.body.unit_ids.map(x => parseInt(x, 10)).filter(Boolean) : [];
        const reason = String(req.body.reason || '').trim();
        if (!ids.length)  return res.status(400).json({ error: 'Aucune unité sélectionnée' });
        if (!reason)      return res.status(400).json({ error: 'Motif obligatoire (ex. : vendue non enregistrée, perte, casse…)' });
        const ph = ids.map(() => '?').join(',');
        const units = await dbAll(`SELECT * FROM stock_units WHERE id IN (${ph})`, ids);
        if (units.length !== ids.length) return res.status(404).json({ error: 'Une ou plusieurs unités sont introuvables' });
        // Ajustables : unités au dépôt, en boutique (consignation / présentoir) ou réservées « à vendre »
        // — l'absence physique a été constatée, on corrige le stock. Restent exclues les unités
        // engagées dans un flux qui a sa propre clôture (préparation, livraison, avance, garantie…).
        const ADJUSTABLE = ['stock', 'presentoir', 'consignation', 'reserve'];
        const bad = units.find(u => !ADJUSTABLE.includes(u.status));
        if (bad) return res.status(409).json({ error: `L'unité « ${bad.serial || bad.id} » (statut « ${bad.status} ») n'est pas ajustable : seules les unités en stock, en boutique ou réservées peuvent être retirées.` });
        const now = getDateTime();
        const consIds = new Set(), resIds = new Set();
        await withTx(async () => {
            for (const u of units) {
                let ref = {};
                if (u.status === 'consignation') {
                    const c = await dbGet(`SELECT ci.consignment_id AS id FROM consignment_items ci WHERE ci.unit_id = ? ORDER BY ci.consignment_id DESC LIMIT 1`, [u.id]);
                    if (c) { consIds.add(c.id); ref = { ref_type: 'consignment', ref_id: c.id }; }
                } else if (u.status === 'reserve') {
                    const r = await dbGet(`SELECT reservation_id AS id FROM reservation_items WHERE unit_id = ? ORDER BY reservation_id DESC LIMIT 1`, [u.id]);
                    if (r) { resIds.add(r.id); ref = { ref_type: 'reservation', ref_id: r.id }; }
                }
                await dbRun(`UPDATE stock_units SET status = 'retire', location = 'retire', holder_user_id = NULL, note = ?, updated_at = ? WHERE id = ?`, [reason, now, u.id]);
                await recordMovement(u, 'retire', 'ajustement_retire', req, { from: u.status, note: reason, ...ref });
            }
            // Sortie boutique vidée → clôturée (comme un retour dépôt) ; réservation vidée → soldée.
            for (const cid of consIds) {
                const rem = await dbGet(`SELECT COUNT(*) n FROM consignment_items ci JOIN stock_units su ON su.id = ci.unit_id WHERE ci.consignment_id = ? AND su.status = 'consignation'`, [cid]);
                if (rem && rem.n === 0) await dbRun(`UPDATE consignments SET status = 'returned', resolved_at = ? WHERE id = ? AND status IN ('sent','received','boutique','cancelled')`, [now, cid]);
            }
            for (const rid of resIds) {
                const left = await dbGet(`SELECT COUNT(*) AS n FROM reservation_items i JOIN stock_units su ON su.id = i.unit_id WHERE i.reservation_id = ? AND su.status = 'reserve'`, [rid]);
                if ((left.n || 0) === 0) {
                    const sold = await dbGet(`SELECT COUNT(*) AS n FROM reservation_items i JOIN stock_units su ON su.id = i.unit_id WHERE i.reservation_id = ? AND su.status = 'vendu'`, [rid]);
                    await dbRun(`UPDATE reservations SET status = ? WHERE id = ? AND status = 'active'`, [(sold.n || 0) > 0 ? 'vendu' : 'annule', rid]);
                }
            }
        });
        for (const rid of resIds) resolveNotifs(`reservation:${rid}`);
        logActivity(req, 'stock_adjust_retire', 'unit', null, { count: units.length, reason, serials: units.map(u => u.serial), from: units.map(u => u.status) });
        if (consIds.size) broadcast('consignment:update', {});
        if (resIds.size) broadcast('reservation:update', {});
        broadcast('stock:update', {});
        res.json({ success: true, count: units.length });
    } catch (e) { console.error('Retire units error:', e); res.status(500).json({ error: e.message }); }
});

// Présentoir : désigner / retirer une unité de démonstration.
app.post('/api/products/:id/presentoir', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const action = req.body.action === 'unset' ? 'unset' : 'set';
        if (action === 'set') {
            const u = await dbGet(`SELECT * FROM stock_units WHERE product_id = ? AND status = 'stock' ORDER BY id LIMIT 1`, [req.params.id]);
            if (!u) return res.status(400).json({ error: 'Aucune unité disponible pour le présentoir' });
            const up = await dbRun(`UPDATE stock_units SET status = 'presentoir', updated_at = ? WHERE id = ? AND status = 'stock'`, [getDateTime(), u.id]);
            if (up.changes !== 1) return res.status(409).json({ error: 'Unité déplacée entre-temps — réessayez.' });
            await recordMovement(u, 'presentoir', 'presentoir', req, { from: 'stock', note: 'Mise en présentoir' });
        } else {
            const u = await dbGet(`SELECT * FROM stock_units WHERE product_id = ? AND status = 'presentoir' ORDER BY id LIMIT 1`, [req.params.id]);
            if (!u) return res.status(400).json({ error: 'Aucune unité en présentoir' });
            const up = await dbRun(`UPDATE stock_units SET status = 'stock', updated_at = ? WHERE id = ? AND status = 'presentoir'`, [getDateTime(), u.id]);
            if (up.changes !== 1) return res.status(409).json({ error: 'Unité déplacée entre-temps — réessayez.' });
            await recordMovement(u, 'stock', 'presentoir_retrait', req, { from: 'presentoir', note: 'Retrait du présentoir' });
        }
        broadcast('stock:update', { product_id: +req.params.id });
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Valeur du stock actuel + profit estimé si tout est vendu (admin).
app.get('/api/admin/stock-value', requireAuth, requireAdmin, async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT p.id, p.name, p.is_accessory, p.category, p.brand, p.purchase_price,
                    COUNT(u.id) AS cnt, SUM(u.sale_price) AS sale_sum
             FROM products p
             JOIN stock_units u ON u.product_id = p.id
             WHERE u.status IN ('stock','preparation','presentoir','reserve')
             GROUP BY p.id HAVING cnt > 0
             ORDER BY p.is_accessory, p.name`, []);
        let totalUnits = 0, totalSale = 0, totalCost = 0, estimatedUnits = 0;
        const products = rows.map(r => {
            const saleSum = parseFloat(r.sale_sum) || 0;
            const unitSale = r.cnt ? saleSum / r.cnt : 0;
            const c = unitCost(r.purchase_price, unitSale, r.is_accessory);
            const costSum = c.cost * r.cnt;
            const profit = saleSum - costSum;
            totalUnits += r.cnt; totalSale += saleSum; totalCost += costSum;
            if (c.estimated) estimatedUnits += r.cnt;
            return { id: r.id, name: r.name, is_accessory: r.is_accessory, category: r.category, brand: r.brand,
                     count: r.cnt, sale_value: saleSum, cost_value: costSum, profit,
                     purchase_price: parseFloat(r.purchase_price) || 0, cost_estimated: c.estimated };
        });
        res.json({
            total_units: totalUnits, total_sale_value: totalSale, total_cost_value: totalCost,
            total_profit: totalSale - totalCost, estimated_units: estimatedUnits,
            priced_units: totalUnits - estimatedUnits, products
        });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Recherche d'une unité par numéro de série (scan / saisie caisse).
app.get('/api/units/search', requireAuth, requireRole('caisse', 'commercial', 'gestion_stock'), async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        if (!q) return res.json([]);
        // Code de modèle accessoire ('A…') : ne concerne QUE les unités « génériques » (serial NULL,
        // non étiquetées individuellement). Les anciens accessoires déjà étiquetés se scannent par
        // leur propre n° de série (branche normale ci-dessous). Disponibles en tête.
        const accId = parseAccCode(q);
        if (accId) {
            const accRows = await dbAll(
                `SELECT u.*, p.name AS product_name, p.brand, p.model, p.category, p.condition, p.cpu, p.ram, p.storage, p.storage_type, p.is_accessory
                 FROM stock_units u JOIN products p ON p.id = u.product_id
                 WHERE u.product_id = ? AND p.is_accessory = 1 AND u.serial IS NULL
                 ORDER BY CASE u.status WHEN 'stock' THEN 0 WHEN 'presentoir' THEN 1 WHEN 'consignation' THEN 2 ELSE 3 END, u.id`,
                [accId]);
            return res.json(accRows.map(u => ({ ...u, serial: accCode(u.product_id), sellable: SELLABLE.includes(u.status), pos_sellable: POS_SELLABLE.includes(u.status) })));
        }
        // Recherche par n° de série local (code-barres) OU n° de série constructeur.
        const rows = await dbAll(
            `SELECT u.*, p.name AS product_name, p.brand, p.model, p.category, p.condition, p.cpu, p.ram, p.storage, p.storage_type, p.is_accessory
             FROM stock_units u LEFT JOIN products p ON p.id = u.product_id
             WHERE u.serial LIKE ? OR u.manufacturer_sn LIKE ? OR u.router_id LIKE ?
             ORDER BY CASE WHEN u.serial = ? OR u.manufacturer_sn = ? OR u.router_id = ? THEN 0 ELSE 1 END, u.serial LIMIT 20`,
            [q + '%', q + '%', q + '%', q, q, q]);
        res.json(rows.map(u => ({ ...u, sellable: SELLABLE.includes(u.status), pos_sellable: POS_SELLABLE.includes(u.status) })));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.post('/api/units/:id/reconfigure', requireAuth, requireAdmin, async (req, res) => {
    try {
        const u = await dbGet('SELECT * FROM stock_units WHERE id = ?', [req.params.id]);
        if (!u) return res.status(404).json({ error: 'Unité introuvable' });
        if (['vendu', 'livraison', 'acompte'].includes(u.status))
            return res.status(400).json({ error: 'Unité vendue, en livraison ou en avance : configuration non modifiable ici.' });
        const src = await dbGet('SELECT * FROM products WHERE id = ?', [u.product_id]);
        if (!src) return res.status(404).json({ error: 'Fiche produit introuvable' });
        const b = req.body || {};
        const np = { ...src };
        RECONF_FIELDS.forEach(f => { if (b[f] !== undefined) np[f] = String(b[f] || '').trim() || null; });
        RECONF_FLAGS.forEach(f => { if (b[f] !== undefined) np[f] = (b[f] === true || b[f] === 1 || b[f] === '1' || b[f] === 'true') ? 1 : 0; });
        if (b.condition !== undefined) np.condition = ['neuf', 'occasion', 'reconditionne'].includes(b.condition) ? b.condition : null;
        const price = b.sale_price != null && b.sale_price !== '' ? Math.max(0, Math.round(parseFloat(b.sale_price) || 0)) : Math.round(src.sale_price || 0);
        if (!np.is_accessory && (!np.ram || !np.storage)) return res.status(400).json({ error: 'RAM et stockage obligatoires' });
        const sig = productSignature(np);
        const same = sig === productSignature(src) && sigAlnum(np.condition) === sigAlnum(src.condition) && price === Math.round(src.sale_price || 0);
        if (same) return res.status(400).json({ error: 'Configuration et prix identiques à la fiche actuelle : rien à changer.' });
        // Fiche de destination : même signature + même état + même prix (règle de la fusion automatique).
        const cands = await dbAll(`SELECT * FROM products WHERE id <> ? AND COALESCE(is_service, 0) = 0 AND COALESCE(is_accessory, 0) = ? ORDER BY id`, [src.id, src.is_accessory ? 1 : 0]);
        const target = cands.find(p => productSignature(p) === sig && sigAlnum(p.condition) === sigAlnum(np.condition) && Math.round(p.sale_price || 0) === price) || null;
        const name = productDisplayName(np);
        const changes = {};
        [...RECONF_FIELDS, ...RECONF_FLAGS, 'condition'].forEach(f => { if ((src[f] || null) !== (np[f] || null)) changes[f] = [src[f] || null, np[f] || null]; });
        if (price !== Math.round(src.sale_price || 0)) changes.sale_price = [Math.round(src.sale_price || 0), price];
        if (b.dry_run) {
            const n = target ? (await dbGet(`SELECT COUNT(*) AS n FROM stock_units WHERE product_id = ? AND status NOT IN ('vendu','retire')`, [target.id])).n : 0;
            return res.json({ target: target ? { id: target.id, name: target.name, units: n, price: target.sale_price } : null, name, price, changes });
        }
        const now = getDateTime();
        let destId;
        await withTx(async () => {
            if (target) destId = target.id;
            else {
                const ins = await dbRun(
                    `INSERT INTO products (signature, is_accessory, serialized, name, category, subcategory, brand, model, condition, cpu, ram, storage, storage_type, gpu, screen_size,
                                           touchscreen, webcam, wifi, bluetooth, numpad, sale_price, purchase_price, image, description, emplacement, created_at)
                     VALUES (NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                    [np.is_accessory ? 1 : 0, np.serialized || 0, name, np.category, np.subcategory, np.brand, np.model, np.condition, np.cpu, np.ram, np.storage,
                     np.storage_type, np.gpu, np.screen_size, np.touchscreen ? 1 : 0, np.webcam ? 1 : 0, np.wifi ? 1 : 0, np.bluetooth ? 1 : 0, np.numpad ? 1 : 0,
                     price, src.purchase_price || 0, src.image || null, src.description || null, src.emplacement || null, now]);
                destId = ins.lastID;
            }
            await dbRun('UPDATE stock_units SET product_id = ?, sale_price = ?, updated_at = ? WHERE id = ?', [destId, price, now, u.id]);
            // Lignes encore ouvertes qui portent l'unité (sortie boutique, réservation, préparation).
            for (const t of ['consignment_items', 'reservation_items', 'install_items']) {
                const cols = (await dbAll(`PRAGMA table_info(${t})`)).map(c => c.name);
                if (cols.includes('product_id') && cols.includes('unit_id')) await dbRun(`UPDATE ${t} SET product_id = ? WHERE unit_id = ?`, [destId, u.id]);
            }
            const desc = Object.entries(changes).map(([k, v]) => `${k} : ${v[0] == null ? '—' : v[0]} → ${v[1] == null ? '—' : v[1]}`).join(' ; ');
            await recordMovement(u, u.status, 'reconfiguration', req, { from: u.status, ref_type: 'product', ref_id: destId,
                note: `Configuration corrigée (fiche #${src.id} → #${destId}${target ? ' existante' : ' nouvelle'}) — ${desc}` });
        });
        logActivity(req, 'unit_reconfigure', 'stock_unit', u.id, { serial: u.serial, from_product: src.id, to_product: destId, merged: !!target, changes });
        try { await autoMergeIdenticalProducts(destId); } catch (e) { console.error('autoMerge (reconfigure):', e.message); }
        const fin = await dbGet('SELECT product_id FROM stock_units WHERE id = ?', [u.id]);   // après fusion éventuelle
        const unit = await dbGet(`SELECT u.*, p.name AS product_name, p.category, p.subcategory, p.brand, p.model, p.condition, p.cpu, p.ram, p.storage, p.storage_type,
                p.gpu, p.screen_size, p.touchscreen, p.numpad, p.description, p.is_accessory FROM stock_units u LEFT JOIN products p ON p.id = u.product_id WHERE u.id = ?`, [u.id]);
        broadcast('stock:update', { product_id: fin.product_id });
        res.json({ success: true, product_id: fin.product_id, merged: !!target, name, unit: { ...unit, serial: displaySerial(unit) } });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/units/:id/defectueux', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const reason = String(req.body.reason || '').trim();
        if (!reason) return res.status(400).json({ error: 'Motif obligatoire' });
        const u = await dbGet(`SELECT * FROM stock_units WHERE id = ? AND status = 'stock'`, [req.params.id]);
        if (!u) return res.status(400).json({ error: 'Unité introuvable ou non disponible en stock (seules les unités en stock réel sont marquables défectueuses).' });
        const now = getDateTime();
        const up = await dbRun(`UPDATE stock_units SET status = 'defectueux', holder_user_id = NULL, note = ?, updated_at = ? WHERE id = ? AND status = 'stock'`, [reason, now, u.id]);
        if (up.changes !== 1) return res.status(409).json({ error: 'Unité déplacée entre-temps — rechargez.' });
        await recordMovement(u, 'defectueux', 'defectueux', req, { from: 'stock', note: reason });
        logActivity(req, 'unit_defectueux', 'stock_unit', u.id, { serial: u.serial, reason });
        broadcast('stock:update', {});
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Stock : liste (historique + recherche) du stock défectueux. Pas de retour ni réparation : lecture seule.
app.get('/api/defectueux', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const q = String(req.query.search || '').trim();
        const like = `%${q}%`;
        const rows = await dbAll(
            `SELECT su.id, su.serial, su.manufacturer_sn, su.updated_at, su.sale_price,
                    p.name AS product_name, p.brand, p.model, p.category, p.is_accessory,
                    (SELECT s.name FROM suppliers s WHERE s.id = su.supplier_id) AS supplier_name,
                    (SELECT m.created_at FROM unit_movements m WHERE m.unit_id = su.id AND m.to_status = 'defectueux' ORDER BY m.id DESC LIMIT 1) AS marked_at,
                    (SELECT m.user_name FROM unit_movements m WHERE m.unit_id = su.id AND m.to_status = 'defectueux' ORDER BY m.id DESC LIMIT 1) AS marked_by,
                    (SELECT m.note FROM unit_movements m WHERE m.unit_id = su.id AND m.to_status = 'defectueux' ORDER BY m.id DESC LIMIT 1) AS motif
             FROM stock_units su LEFT JOIN products p ON p.id = su.product_id
             WHERE su.status = 'defectueux'
               ${q ? `AND (su.serial LIKE ? OR su.manufacturer_sn LIKE ? OR p.name LIKE ? OR p.brand LIKE ? OR p.model LIKE ? OR p.category LIKE ?)` : ''}
             ORDER BY su.updated_at DESC LIMIT 500`,
            q ? Array(6).fill(like) : []);
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Admin + responsable stock (dépôt) : unités EN STOCK affectées à l'USAGE DU MAGASIN (matériel utilisé en
// interne : poste de caisse, écran d'affichage…). Elles sortent du stock vendable (statut « usage_magasin »),
// restent tracées (mouvement + journal : qui, quand) et peuvent être remises en stock.
app.post('/api/units/usage-magasin', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const ids = Array.isArray(req.body.unit_ids) ? req.body.unit_ids.map(x => parseInt(x, 10)).filter(Boolean) : [];
        const note = String(req.body.note || '').trim().slice(0, 300) || null;
        if (!ids.length) return res.status(400).json({ error: 'Aucune unité sélectionnée' });
        const units = await dbAll(`SELECT * FROM stock_units WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
        if (units.length !== ids.length) return res.status(404).json({ error: 'Une ou plusieurs unités sont introuvables' });
        const bad = units.find(u => u.status !== 'stock');
        if (bad) return res.status(409).json({ error: `L'unité « ${bad.serial || bad.id} » n'est pas en stock (statut « ${UNIT_STATUS[bad.status] || bad.status} ») : seules les unités en stock peuvent passer en usage magasin.` });
        const now = getDateTime();
        await withTx(async () => {
            for (const u of units) {
                const up = await dbRun(`UPDATE stock_units SET status = 'usage_magasin', location = 'magasin', holder_user_id = NULL, note = ?, updated_at = ? WHERE id = ? AND status = 'stock'`, [note, now, u.id]);
                if (up.changes !== 1) throw txError(409, `Unité ${u.serial || u.id} déplacée entre-temps — rechargez.`);
                await recordMovement(u, 'usage_magasin', 'usage_magasin', req, { from: 'stock', note });
            }
        });
        logActivity(req, 'unit_usage_magasin', 'stock_unit', null, { ids, note });
        broadcast('stock:update', {});
        res.json({ success: true, count: units.length });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.post('/api/units/usage-magasin/return', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const ids = Array.isArray(req.body.unit_ids) ? req.body.unit_ids.map(x => parseInt(x, 10)).filter(Boolean) : [];
        if (!ids.length) return res.status(400).json({ error: 'Aucune unité sélectionnée' });
        const units = await dbAll(`SELECT * FROM stock_units WHERE status = 'usage_magasin' AND id IN (${ids.map(() => '?').join(',')})`, ids);
        if (!units.length) return res.status(404).json({ error: 'Aucune unité en usage magasin dans la sélection' });
        const now = getDateTime();
        await withTx(async () => {
            for (const u of units) {
                const up = await dbRun(`UPDATE stock_units SET status = 'stock', location = 'depot', note = NULL, updated_at = ? WHERE id = ? AND status = 'usage_magasin'`, [now, u.id]);
                if (up.changes) await recordMovement(u, 'stock', 'retour_usage_magasin', req, { from: 'usage_magasin' });
            }
        });
        logActivity(req, 'unit_usage_magasin_retour', 'stock_unit', null, { ids: units.map(u => u.id) });
        broadcast('stock:update', {});
        res.json({ success: true, count: units.length });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.get('/api/usage-magasin', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT su.id, su.serial, su.manufacturer_sn, su.note, su.updated_at, su.sale_price,
                    p.id AS product_id, p.name AS product_name, p.brand, p.model, p.category, p.is_accessory,
                    (SELECT m.created_at FROM unit_movements m WHERE m.unit_id = su.id AND m.to_status = 'usage_magasin' ORDER BY m.id DESC LIMIT 1) AS marked_at,
                    (SELECT m.user_name FROM unit_movements m WHERE m.unit_id = su.id AND m.to_status = 'usage_magasin' ORDER BY m.id DESC LIMIT 1) AS marked_by
             FROM stock_units su LEFT JOIN products p ON p.id = su.product_id
             WHERE su.status = 'usage_magasin' ORDER BY su.updated_at DESC`);
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Liste de toutes les batteries (épuisées comprises) : prix, disponibilité, ordinateurs compatibles.
app.get('/api/batteries', requireAuth, async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT p.id, p.name, p.brand, p.model, p.description, p.sale_price, p.emplacement, p.image,
                    SUM(CASE WHEN su.status = 'stock' THEN 1 ELSE 0 END) AS available,
                    SUM(CASE WHEN su.status IN ('consignation','presentoir') THEN 1 ELSE 0 END) AS boutique,
                    SUM(CASE WHEN su.status = 'vendu' THEN 1 ELSE 0 END) AS sold,
                    bc.models, bc.status AS compat_status, bc.source AS compat_source, bc.searched_at, bc.error AS compat_error, bc.edited_by
             FROM products p
             LEFT JOIN stock_units su ON su.product_id = p.id
             LEFT JOIN battery_compat bc ON bc.product_id = p.id
             WHERE ${BAT_WHERE}
             GROUP BY p.id ORDER BY p.brand, p.model`);
        rows.forEach(r => { try { r.models = JSON.parse(r.models || '[]'); } catch (e) { r.models = []; } });
        res.json({ rows, queue: BAT_AUTO ? BatQueue.pending.size : 0, paused_until: BatQueue.pauseUntil > Date.now() ? BatQueue.pauseUntil : null,
                   catalog: { count: BatCatalog.rows.length, url: BatCatalog.url, error: BatCatalog.error } });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// Relancer la recherche internet d'une batterie (stock / admin).
app.post('/api/batteries/:id/lookup', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        if (BatQueue.pauseUntil > Date.now())
            return res.status(429).json({ error: `Recherche internet momentanément limitée par le moteur : réessayez dans ${Math.ceil((BatQueue.pauseUntil - Date.now()) / 60000)} min.` });
        const r = await batteryLookupAndSave(req.params.id, true);
        if (!r) return res.status(404).json({ error: 'Batterie introuvable' });
        BatQueue.pending.delete(+req.params.id);
        res.json({ success: true, models: r.models || [] });
    } catch (e) {
        if (e.blocked) BatQueue.pauseUntil = Date.now() + 60 * 60 * 1000;
        res.status(502).json({ error: e.message });
    }
});
// Correction manuelle de la liste (une ligne = un ordinateur / une gamme). auto=true → revenir à la recherche auto.
app.put('/api/batteries/:id/compat', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const p = await dbGet(`SELECT id, name, brand, model FROM products p WHERE id = ? AND ${BAT_WHERE}`, [req.params.id]);
        if (!p) return res.status(404).json({ error: 'Batterie introuvable' });
        if (req.body.auto) {
            await dbRun(`DELETE FROM battery_compat WHERE product_id = ?`, [p.id]);
            await batterySweep();
            broadcast('battery:update', { id: p.id });
            return res.json({ success: true, queued: true });
        }
        const models = (Array.isArray(req.body.models) ? req.body.models : String(req.body.models || '').split('\n'))
            .map(x => String(x).trim().slice(0, 120)).filter(Boolean).slice(0, 40);
        const who = req.session.user.full_name || req.session.user.username;
        await dbRun(`INSERT INTO battery_compat (product_id, query_key, models, source, status, error, searched_at, edited_by)
                     VALUES (?, ?, ?, 'manuel', ?, NULL, ?, ?)
                     ON CONFLICT(product_id) DO UPDATE SET query_key = excluded.query_key, models = excluded.models, source = 'manuel',
                        status = excluded.status, error = NULL, searched_at = excluded.searched_at, edited_by = excluded.edited_by`,
            [p.id, batKey(p), JSON.stringify(models), models.length ? 'ok' : 'vide', getDateTime(), who]);
        logActivity(req, 'battery_compat_edit', 'product', p.id, { models });
        broadcast('battery:update', { id: p.id });
        res.json({ success: true, models });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Historique des mouvements de stock (toutes entrées / sorties) — filtres + recherche.
app.get('/api/movements', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const { from, to, q, action, direction, type } = req.query;
        const w = [], p = [];
        if (from) { w.push('date(m.created_at) >= date(?)'); p.push(from); }
        if (to)   { w.push('date(m.created_at) <= date(?)'); p.push(to); }
        if (action) { w.push('m.action = ?'); p.push(action); }
        // Entrée / Sortie = franchissement de la frontière « en stock » (dépôt + boutique + installation),
        // cohérent avec le récap stock général. La boutique (consignation) et l'installation (preparation)
        // restent DANS le stock → un déplacement vers elles n'est NI une entrée NI une sortie. Seuls vendu,
        // garantie, livraison, retiré… (statuts hors stock) constituent une vraie sortie.
        const IN_STOCK = "('stock','preparation','presentoir','reserve','consignation')";
        if (direction === 'in')  w.push(`m.to_status IN ${IN_STOCK} AND (m.from_status NOT IN ${IN_STOCK} OR m.action = 'reception')`);
        if (direction === 'out') w.push(`m.from_status IN ${IN_STOCK} AND m.to_status NOT IN ${IN_STOCK}`);
        if (type === 'pc')  w.push('p.is_accessory = 0');
        if (type === 'acc') w.push('p.is_accessory = 1');
        if (q) { w.push('(m.serial LIKE ? OR p.name LIKE ? OR p.brand LIKE ? OR p.model LIKE ?)'); const l = `%${q}%`; p.push(l, l, l, l); }
        const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
        const rows = await dbAll(
            `SELECT m.*, p.name AS product_name, p.brand, p.model, p.is_accessory
             FROM unit_movements m
             LEFT JOIN stock_units u ON u.id = m.unit_id
             LEFT JOIN products p ON p.id = u.product_id
             ${where} ORDER BY m.created_at DESC, m.id DESC LIMIT 1000`, p);
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Récapitulatif des mouvements par fournisseur pour une date (défaut : aujourd'hui).
app.get('/api/movements/summary', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const date = req.query.date || getDate();
        // Entrée / sortie = franchissement de la frontière « en stock » (dépôt + boutique + installation),
        // cohérent avec le récap général : boutique et installation ne sont NI entrée NI sortie.
        const IN = "('stock','preparation','presentoir','reserve','consignation')";
        const INC  = `(m.to_status IN ${IN} AND (m.from_status NOT IN ${IN} OR m.action = 'reception'))`;
        const OUTC = `(m.from_status IN ${IN} AND m.to_status NOT IN ${IN})`;
        const rows = await dbAll(
            `SELECT s.id AS supplier_id, COALESCE(s.name, 'Sans fournisseur') AS supplier_name,
                SUM(CASE WHEN ${INC} THEN 1 ELSE 0 END) AS in_count,
                SUM(CASE WHEN ${OUTC} THEN 1 ELSE 0 END) AS out_count,
                SUM(CASE WHEN ${INC} AND p.is_accessory = 0 THEN 1 ELSE 0 END) AS in_pc,
                SUM(CASE WHEN ${INC} AND p.is_accessory = 1 THEN 1 ELSE 0 END) AS in_acc,
                SUM(CASE WHEN ${OUTC} AND p.is_accessory = 0 THEN 1 ELSE 0 END) AS out_pc,
                SUM(CASE WHEN ${OUTC} AND p.is_accessory = 1 THEN 1 ELSE 0 END) AS out_acc,
                SUM(CASE WHEN m.to_status IN ('garantie_fournisseur','garantie_exceptionnel') THEN 1 ELSE 0 END) AS gar_in,
                SUM(CASE WHEN m.to_status = 'retour_fournisseur' THEN 1 ELSE 0 END) AS gar_out
             FROM unit_movements m
             LEFT JOIN stock_units u ON u.id = m.unit_id
             LEFT JOIN products p ON p.id = u.product_id
             LEFT JOIN suppliers s ON s.id = u.supplier_id
             WHERE date(m.created_at) = date(?)
             GROUP BY s.id HAVING (in_count + out_count + gar_in + gar_out) > 0
             ORDER BY supplier_name`, [date]);
        const totals = rows.reduce((t, r) => ({
            in_count: t.in_count + r.in_count, out_count: t.out_count + r.out_count,
            in_pc: t.in_pc + r.in_pc, in_acc: t.in_acc + r.in_acc,
            out_pc: t.out_pc + r.out_pc, out_acc: t.out_acc + r.out_acc,
            gar_in: t.gar_in + r.gar_in, gar_out: t.gar_out + r.gar_out
        }), { in_count: 0, out_count: 0, in_pc: 0, in_acc: 0, out_pc: 0, out_acc: 0, gar_in: 0, gar_out: 0 });
        res.json({ date, suppliers: rows, totals });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ============================================================
//  SORTIES DU DÉPÔT — rapport quotidien des ORDINATEURS ayant
//  physiquement QUITTÉ le dépôt (vendus, en livraison, ou sortis
//  chez un commercial sans être revenus). But : savoir chaque jour
//  combien d'ordinateurs sont sortis du dépôt, et leur destinée.
// ============================================================
// Un « départ » = 1er franchissement de la frontière interne
//   {stock, préparation, présentoir, avance} → {boutique, réservé, livraison, vendu}.
// La revente d'une unité DÉJÀ sortie (ex. consignation→vendu) n'est PAS un nouveau départ :
// son from_status n'est plus « interne », donc elle n'est pas recomptée. Chaque unité qui sort
// apparaît une fois par sortie physique, datée à l'heure où elle a quitté le dépôt.
app.get('/api/depot-sorties', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const from = req.query.from || req.query.date || getDate();
        const to   = req.query.to   || req.query.date || from;
        const IN_HOUSE = ['stock', 'preparation', 'presentoir', 'acompte'];
        const FIELD    = ['consignation', 'reserve', 'livraison', 'vendu'];
        const inSql    = "('stock','preparation','presentoir','acompte')";
        const fieldSql = "('consignation','reserve','livraison','vendu')";
        // Mouvements de SORTIE (dépôt → terrain) sur la période.
        const rows = await dbAll(
            `SELECT m.id AS mov_id, m.unit_id, m.serial, m.to_status AS exit_status, m.created_at AS exit_at,
                    m.note AS exit_note, m.action AS exit_action,
                    p.name AS product_name, p.brand, p.model,
                    u.status AS current_status, u.manufacturer_sn, u.holder_user_id AS holder_id,
                    (SELECT full_name FROM users WHERE id = u.holder_user_id) AS holder_name
             FROM unit_movements m
             JOIN stock_units u ON u.id = m.unit_id
             JOIN products p ON p.id = u.product_id
             WHERE p.is_accessory = 0
               AND m.from_status IN ${inSql}
               AND m.to_status   IN ${fieldSql}
               AND date(m.created_at) BETWEEN date(?) AND date(?)
             ORDER BY m.created_at DESC, m.id DESC`, [from, to]);

        // DEVENIR PAR SORTIE : une même unité peut sortir plusieurs fois dans la période (ex. livraison
        // annulée → revient → ressort en boutique → vendue). Chaque sortie a son PROPRE résultat, qu'on
        // résout en suivant les mouvements APRÈS elle jusqu'au 1er retour au dépôt OU à la vente — au lieu
        // d'appliquer bêtement le statut ACTUEL de l'unité à toutes ses sorties (qui gonflait « vendu »).
        const unitIds = [...new Set(rows.map(r => r.unit_id))];
        const movsByUnit = new Map();
        if (unitIds.length) {
            const ph = unitIds.map(() => '?').join(',');
            const allMovs = await dbAll(
                `SELECT id, unit_id, from_status, to_status, action, ref_type, ref_id, created_at
                 FROM unit_movements WHERE unit_id IN (${ph}) ORDER BY unit_id, id`, unitIds);
            allMovs.forEach(m => { if (!movsByUnit.has(m.unit_id)) movsByUnit.set(m.unit_id, []); movsByUnit.get(m.unit_id).push(m); });
        }
        // Résout l'épisode d'une sortie : { kind: 'vendu'|'revenu'|'out', saleId?, deliveryId?, at? }.
        // Une vente au comptoir se solde par un mouvement 'vente' (ref = sale) ; une vente par
        // livraison par un 'livraison_livree' (ref = delivery, PAS sale) — on garde alors le
        // deliveryId pour retrouver la vente réelle via deliveries.sale_id (voir plus bas).
        const refOfVendu = (m) => m.ref_type === 'sale'     ? { saleId: m.ref_id }
                                : m.ref_type === 'delivery' ? { deliveryId: m.ref_id }
                                : {};
        const resolveEpisode = (row) => {
            const list = movsByUnit.get(row.unit_id) || [];
            const self = list.find(m => m.id === row.mov_id);
            // Sortie directe au comptoir (dépôt → vendu) = vente immédiate.
            if (self && self.to_status === 'vendu') return { kind: 'vendu', ...refOfVendu(self), at: self.created_at };
            for (const m of list) {
                if (m.id <= row.mov_id) continue;
                if (m.to_status === 'vendu')          return { kind: 'vendu', ...refOfVendu(m), at: m.created_at };
                if (IN_HOUSE.includes(m.to_status))   return { kind: 'revenu', at: m.created_at };   // revenu au dépôt
            }
            return { kind: 'out' };   // encore sur le terrain (dernière sortie non résolue)
        };
        rows.forEach(r => { r._ep = resolveEpisode(r); });

        // Épisodes « vendu » soldés par une livraison : retrouver la vente via deliveries.sale_id.
        const delIds = [...new Set(rows.filter(r => r._ep.kind === 'vendu' && !r._ep.saleId && r._ep.deliveryId).map(r => r._ep.deliveryId))];
        if (delIds.length) {
            const ph = delIds.map(() => '?').join(',');
            const dmap = new Map();
            (await dbAll(`SELECT id, sale_id FROM deliveries WHERE id IN (${ph})`, delIds)).forEach(d => dmap.set(String(d.id), d.sale_id));
            rows.forEach(r => { if (r._ep.kind === 'vendu' && !r._ep.saleId && r._ep.deliveryId) { const sid = dmap.get(String(r._ep.deliveryId)); if (sid) r._ep.saleId = sid; } });
        }

        // Ventes réellement liées aux épisodes « vendu » (canal / n° / commercial de CETTE vente).
        const saleIds = [...new Set(rows.filter(r => r._ep.kind === 'vendu' && r._ep.saleId).map(r => r._ep.saleId))];
        const saleMap = new Map();
        if (saleIds.length) {
            const ph = saleIds.map(() => '?').join(',');
            (await dbAll(`SELECT id, channel, sale_number, commercial_name FROM sales WHERE id IN (${ph})`, saleIds))
                .forEach(s => saleMap.set(s.id, s));
        }

        // Cas particulier : une unité EN CONSIGNATION détenue par le commercial RESPONSABLE de la
        // boutique n'est PAS un « retour attendu » — la vente au comptoir est la voie normale et le
        // retour est optionnel. Elle est classée « en boutique » (neutre), pas « non revenu ».
        const respId = await boutiqueResponsibleIdAsync();
        rows.forEach(r => {
            const ep = r._ep;
            if (ep.kind === 'vendu') {
                const s = ep.saleId ? saleMap.get(ep.saleId) : null;
                // Repli : un épisode soldé par une livraison est « livraison » même si la vente est introuvable.
                const channel = s ? s.channel : (ep.deliveryId ? 'livraison' : null);
                r.bucket = channel === 'livraison' ? 'vendu_livraison' : 'vendu_boutique';
                r.sale_channel = channel; r.sale_number = s ? s.sale_number : null;
                r.sold_at = ep.at || null; r.actor = s ? s.commercial_name : null;
            } else if (ep.kind === 'revenu') {
                r.bucket = 'revenu';
                r.sale_channel = null; r.sale_number = null; r.sold_at = null; r.actor = r.holder_name || null;
            } else {
                // Encore sur le terrain → destinée selon l'état ACTUEL de l'unité.
                const cs = r.current_status;
                r.bucket = cs === 'livraison' ? 'en_livraison'
                    : cs === 'consignation' ? ((respId && r.holder_id === respId) ? 'en_boutique' : 'sortie_dehors')
                    : cs === 'reserve' ? 'sortie_dehors'
                    : IN_HOUSE.includes(cs) ? 'revenu'
                    : cs === 'vendu' ? 'vendu_boutique' : 'autre';
                r.sale_channel = null; r.sale_number = null; r.sold_at = null; r.actor = r.holder_name || null;
            }
            delete r._ep;
        });

        const totals = { total: rows.length, vendu_boutique: 0, vendu_livraison: 0, en_livraison: 0, en_boutique: 0, sortie_dehors: 0, revenu: 0, autre: 0 };
        rows.forEach(r => { totals[r.bucket] = (totals[r.bucket] || 0) + 1; });
        // Ordinateurs DISTINCTS sortis (une même unité peut sortir plusieurs fois sur la période).
        totals.distinct = new Set(rows.map(r => r.unit_id)).size;
        res.json({ from, to, rows, totals });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Parcours complet d'une unité (tous ses mouvements) — pour l'affichage « chemin » cliquable.
// Parcours d'une unité : aussi ouvert à la caisse (détail d'une ligne du rapport journalier).
app.get('/api/units/:id/movements', requireAuth, requireRole('gestion_stock', 'caisse'), async (req, res) => {
    try {
        const u = await dbGet(`SELECT u.*, p.name AS product_name, p.brand, p.model, p.is_accessory
                               FROM stock_units u LEFT JOIN products p ON p.id = u.product_id WHERE u.id = ?`, [req.params.id]);
        if (!u) return res.status(404).json({ error: 'Unité introuvable' });
        const movements = await dbAll(`SELECT * FROM unit_movements WHERE unit_id = ? ORDER BY id ASC`, [req.params.id]);
        res.json({ unit: { id: u.id, serial: u.serial, status: u.status, manufacturer_sn: u.manufacturer_sn,
                           product_name: u.product_name, brand: u.brand, model: u.model }, movements });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Top ventes (admin) : articles réellement vendus sur une période (semaine par défaut), agrégés par
// produit × commercial × jour. La page construit le classement, la répartition par jour et, pour un
// produit recherché, ce que chaque commercial en a vendu par jour et sur la semaine.
// Même règle que le rapport journalier : vente ou échange comptés ; retours, annulations et livraisons
// non confirmées exclus (une livraison compte le jour de sa confirmation).
// Clients STARLINK (admin) : chaque kit (antenne + routeur) avec son client — vente (dernière, non retournée)
// ou avance en cours — et son adresse (lieu d'installation). Les kits encore en stock sont listés sans client.
app.get('/api/starlink/clients', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const rows = await dbAll(`
            SELECT u.id AS unit_id, u.serial, u.manufacturer_sn, u.router_id, u.status, u.sale_price, u.created_at AS received_at,
                   u.warranty_end, p.subcategory AS version, p.name AS product_name,
                   s.id AS sale_id, s.sale_number, s.sale_date, s.created_at AS sold_at, s.status AS sale_status, s.channel,
                   s.client_name, s.client_phone, s.client_address, s.commercial_name, s.cashier_name, si.unit_price AS sold_price,
                   s.client_lat, s.client_lng, l.client_lat AS lay_lat, l.client_lng AS lay_lng,
                   (SELECT d.delivery_number FROM deliveries d WHERE d.sale_id = s.id) AS delivery_number,
                   (SELECT d.client_address FROM deliveries d WHERE d.sale_id = s.id) AS delivery_address,
                   l.id AS layaway_id, l.layaway_number, l.client_name AS lay_client, l.client_phone AS lay_phone, l.client_address AS lay_address,
                   l.commercial_name AS lay_commercial, l.total AS lay_total, l.deposit AS lay_deposit, l.created_at AS lay_at, l.due_date AS lay_due
            FROM stock_units u
            LEFT JOIN products p ON p.id = u.product_id
            LEFT JOIN sale_items si ON si.id = (SELECT si2.id FROM sale_items si2 WHERE si2.unit_id = u.id AND COALESCE(si2.returned, 0) = 0 ORDER BY si2.id DESC LIMIT 1)
            LEFT JOIN sales s ON s.id = si.sale_id AND s.status NOT IN ('annulee')
            LEFT JOIN layaways l ON l.id = (SELECT li.layaway_id FROM layaway_items li JOIN layaways l2 ON l2.id = li.layaway_id
                                            WHERE li.unit_id = u.id AND l2.status = 'active' ORDER BY li.id DESC LIMIT 1)
            WHERE u.router_id IS NOT NULL OR LOWER(COALESCE(p.category, '')) = 'starlink'
            ORDER BY COALESCE(s.created_at, l.created_at, u.created_at) DESC`);
        res.json(rows.map(r => {
            const sold = !!(r.sale_id && r.client_name);
            const lay = !sold && r.layaway_id;
            return {
                unit_id: r.unit_id, serial: r.serial, dish_sn: r.manufacturer_sn, router_id: r.router_id, version: r.version || '',
                unit_status: r.status, price: sold ? r.sold_price : (r.sale_price || 0), received_at: r.received_at, warranty_end: r.warranty_end,
                kind: sold ? (r.sale_status === 'en_livraison' ? 'livraison' : 'vendu') : lay ? 'avance' : 'stock',
                client_name: sold ? r.client_name : lay ? r.lay_client : null,
                client_phone: sold ? r.client_phone : lay ? r.lay_phone : null,
                address: sold ? (r.client_address || r.delivery_address || null) : lay ? r.lay_address : null,
                date: sold ? r.sold_at : lay ? r.lay_at : r.received_at,
                ref: sold ? invoiceRef({ sale_date: r.sale_date, sale_number: r.sale_number }) : lay ? `AV-${r.layaway_number}` : null,
                sale_id: sold ? r.sale_id : null, delivery_number: sold ? r.delivery_number : null,
                commercial: sold ? (r.commercial_name || r.cashier_name) : lay ? r.lay_commercial : null,
                deposit: lay ? r.lay_deposit : null, lay_total: lay ? r.lay_total : null, lay_due: lay ? r.lay_due : null,
                lat: sold ? r.client_lat : lay ? r.lay_lat : null, lng: sold ? r.client_lng : lay ? r.lay_lng : null
            };
        }));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Admin : compléter / corriger les coordonnées du client d'un kit (nom, téléphone, adresse d'installation).
// Mise à jour de la VENTE (et de sa livraison) ou de l'AVANCE en cours : facture et historique suivent.
app.put('/api/starlink/clients/:unitId', requireAuth, requireRole('admin'), async (req, res) => {
    try {
        const t = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
        const name = t(req.body.name, 120), phone = t(req.body.phone, 40), address = t(req.body.address, 300);
        const err = clientError(name, phone);
        if (err) return res.status(400).json({ error: err });
        if (!address) return res.status(400).json({ error: "Adresse (lieu d'installation) obligatoire" });
        // Position GPS facultative : les deux coordonnées ou aucune (vide = effacer).
        const num = v => (v === '' || v == null) ? null : Number(v);
        const lat = num(req.body.lat), lng = num(req.body.lng);
        if ((lat == null) !== (lng == null) || (lat != null && (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)))
            return res.status(400).json({ error: 'Position GPS invalide (latitude, longitude)' });
        const uid = parseInt(req.params.unitId, 10);
        const si = await dbGet(`SELECT si.sale_id FROM sale_items si JOIN sales s ON s.id = si.sale_id
            WHERE si.unit_id = ? AND COALESCE(si.returned, 0) = 0 AND s.status <> 'annulee' ORDER BY si.id DESC LIMIT 1`, [uid]);
        const li = si ? null : await dbGet(`SELECT li.layaway_id FROM layaway_items li JOIN layaways l ON l.id = li.layaway_id
            WHERE li.unit_id = ? AND l.status = 'active' ORDER BY li.id DESC LIMIT 1`, [uid]);
        if (!si && !li) return res.status(400).json({ error: 'Ce kit n\'est ni vendu ni en avance : aucun client à modifier.' });
        let before;
        await withTx(async () => {
            if (si) {
                before = await dbGet('SELECT client_name, client_phone, client_address, client_id FROM sales WHERE id = ?', [si.sale_id]);
                await dbRun('UPDATE sales SET client_name = ?, client_phone = ?, client_address = ?, client_lat = ?, client_lng = ? WHERE id = ?', [name, phone, address, lat, lng, si.sale_id]);
                await dbRun('UPDATE deliveries SET client_name = ?, client_phone = ?, client_address = ? WHERE sale_id = ?', [name, phone, address, si.sale_id]);
            } else {
                before = await dbGet('SELECT client_name, client_phone, client_address, client_id FROM layaways WHERE id = ?', [li.layaway_id]);
                await dbRun('UPDATE layaways SET client_name = ?, client_phone = ?, client_address = ?, client_lat = ?, client_lng = ? WHERE id = ?', [name, phone, address, lat, lng, li.layaway_id]);
            }
            if (before && before.client_id) await dbRun('UPDATE clients SET name = ?, phone = ?, address = ? WHERE id = ?', [name, phone, address, before.client_id]);
        });
        logActivity(req, 'starlink_client_edit', si ? 'sale' : 'layaway', si ? si.sale_id : li.layaway_id,
            { unit_id: uid, before: before && { name: before.client_name, phone: before.client_phone, address: before.client_address }, after: { name, phone, address, lat, lng } });
        broadcast('sale:new', {});
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
};
