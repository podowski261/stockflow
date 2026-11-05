// ============================================================
//  STOCKFLOW — Bons de commande fournisseurs, demandes clients
//  Routes /api déplacées depuis server.js (code inchangé). Les helpers, la base et les
//  middlewares partagés arrivent par S (voir « Routes par domaine » en fin de server.js).
// ============================================================
module.exports = function register(app, S) {
    const { broadcast, clientError, commandeResponsibleId, dbAll, dbGet, dbRun, fs, getDateTime, hasRole, logActivity,
        path, pushNotification, requireAuth, requireRole, requireRqAccess, requireSoReader, requireSoWriter,
        resolveNotifs, RQ_STATUSES, RQ_WEAK, rqCanSeeAll, rqFindInStock, rqKeys, rqMarkAvailable, rqStrong, rqTokens,
        SO_FILE_DIR, SO_STATUS, soAttach, soNum, soParse, soUploadFiles, soWriteItems, withTx } = S;

app.get('/api/supplier-orders', requireAuth, requireSoReader, async (req, res) => {
    try {
        const w = [], p = [];
        if (req.query.from) { w.push('o.order_date >= ?'); p.push(req.query.from); }
        if (req.query.to) { w.push('o.order_date <= ?'); p.push(req.query.to); }
        if (SO_STATUS.includes(req.query.status)) { w.push('o.status = ?'); p.push(req.query.status); }
        if (req.query.supplier_id) { w.push('o.supplier_id = ?'); p.push(req.query.supplier_id); }
        const orders = await dbAll(`SELECT o.* FROM supplier_orders o ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
                                    ORDER BY (o.status = 'en_attente') DESC, o.order_date DESC, o.id DESC LIMIT 2000`, p);
        const u = req.session.user;
        res.json({ orders: await soAttach(orders),
                   can_write: u.role === 'admin' || (await commandeResponsibleId()) === u.id,
                   is_stock: hasRole(u, 'gestion_stock') });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Stock : commandes pas encore vues (badge menu persistant + rappel sur la page Réception).
app.get('/api/supplier-orders/pending', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const rows = await dbAll(`SELECT o.id, o.order_number, o.supplier_name, o.order_date, o.expected_date, o.created_by_name,
                                         (SELECT COALESCE(SUM(quantity), 0) FROM supplier_order_items i WHERE i.order_id = o.id) AS pieces
                                  FROM supplier_orders o WHERE o.status = 'en_attente' ORDER BY o.order_date, o.id`);
        res.json({ count: rows.length, orders: rows });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/supplier-orders', requireAuth, requireSoWriter, async (req, res) => {
    try {
        const r = await soParse(req.body);
        if (r.error) return res.status(400).json({ error: r.error });
        const o = r.order, me = req.session.user, now = getDateTime();
        const num = await withTx(async () => {
            const ins = await dbRun(`INSERT INTO supplier_orders (supplier_id, supplier_name, order_date, expected_date, reference, currency, status, total, paid_amount, note, created_by_id, created_by_name, created_at, updated_at)
                                     VALUES (?,?,?,?,?,'MGA','en_attente',?,0,?,?,?,?,?)`,
                [o.supplier_id, o.supplier_name, o.order_date, o.expected_date, o.reference, o.total, o.note, me.id, me.full_name || me.username, now, now]);
            // N° = id AUTOINCREMENT : jamais réutilisé, même après suppression.
            await dbRun('UPDATE supplier_orders SET order_number = ? WHERE id = ?', [ins.lastID, ins.lastID]);
            await soWriteItems(ins.lastID, r.items);
            return ins.lastID;
        });
        const pcs = r.items.reduce((t, l) => t + l.quantity, 0);
        pushNotification({ target_role: 'gestion_stock', type: 'warn', persistent: true, ref: `supplier_order:${num}`,
            title: 'Nouvelle commande fournisseur', link: '/commandes-fournisseurs.html',
            message: `${soNum(num)} — ${o.supplier_name} : ${pcs} pièce(s) commandée(s) par ${me.full_name || me.username}.` });
        logActivity(req, 'supplier_order_create', 'supplier_order', num, { number: num, supplier: o.supplier_name, pieces: pcs });
        broadcast('supplier-order:update', {});
        res.json({ success: true, id: num, order_number: num });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.put('/api/supplier-orders/:id', requireAuth, requireSoWriter, async (req, res) => {
    try {
        const cur = await dbGet('SELECT * FROM supplier_orders WHERE id = ?', [req.params.id]);
        if (!cur) return res.status(404).json({ error: 'Bon de commande introuvable' });
        if (cur.status === 'annulee') return res.status(400).json({ error: 'Bon annulé.' });
        const r = await soParse(req.body);
        if (r.error) return res.status(400).json({ error: r.error });
        const o = r.order, me = req.session.user;
        // Bon modifié après consultation : il redevient « non vu » pour que le stock voie la nouvelle version.
        await withTx(async () => {
            await dbRun(`UPDATE supplier_orders SET supplier_id = ?, supplier_name = ?, order_date = ?, expected_date = ?, reference = ?,
                         total = ?, note = ?, status = 'en_attente', updated_at = ? WHERE id = ?`,
                [o.supplier_id, o.supplier_name, o.order_date, o.expected_date, o.reference, o.total, o.note, getDateTime(), cur.id]);
            await soWriteItems(cur.id, r.items);
        });
        if (cur.status === 'vu')
            pushNotification({ target_role: 'gestion_stock', type: 'warn', persistent: true, ref: `supplier_order:${cur.id}`,
                title: 'Commande fournisseur modifiée', link: '/commandes-fournisseurs.html',
                message: `${soNum(cur.order_number || cur.id)} — ${o.supplier_name} : bon modifié par ${me.full_name || me.username}.` });
        logActivity(req, 'supplier_order_update', 'supplier_order', cur.id, { number: cur.order_number });
        broadcast('supplier-order:update', {});
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.post('/api/supplier-orders/:id/files', requireAuth, requireSoWriter, soUploadFiles, async (req, res) => {
    try {
        const cur = await dbGet('SELECT id FROM supplier_orders WHERE id = ?', [req.params.id]);
        if (!cur) { (req.files || []).forEach(f => fs.unlink(f.path, () => {})); return res.status(404).json({ error: 'Bon de commande introuvable' }); }
        const me = req.session.user, now = getDateTime();
        for (const f of (req.files || []))
            await dbRun(`INSERT INTO supplier_order_files (order_id, filename, original_name, mime, uploaded_by_id, uploaded_by_name, created_at) VALUES (?,?,?,?,?,?,?)`,
                [cur.id, f.filename, f.originalname, f.mimetype, me.id, me.full_name || me.username, now]);
        broadcast('supplier-order:update', {});
        res.json({ success: true, count: (req.files || []).length });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.get('/api/supplier-orders/files/:fid', requireAuth, requireSoReader, async (req, res) => {
    try {
        const f = await dbGet('SELECT * FROM supplier_order_files WHERE id = ?', [req.params.fid]);
        if (!f) return res.status(404).json({ error: 'Fichier introuvable' });
        const full = path.join(SO_FILE_DIR, path.basename(f.filename));
        if (!fs.existsSync(full)) return res.status(404).json({ error: 'Fichier absent du serveur' });
        res.type(f.mime);
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.original_name || f.filename)}"`);
        res.sendFile(full);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.delete('/api/supplier-orders/files/:fid', requireAuth, requireSoWriter, async (req, res) => {
    try {
        const f = await dbGet('SELECT * FROM supplier_order_files WHERE id = ?', [req.params.fid]);
        if (!f) return res.status(404).json({ error: 'Fichier introuvable' });
        await dbRun('DELETE FROM supplier_order_files WHERE id = ?', [f.id]);
        fs.unlink(path.join(SO_FILE_DIR, path.basename(f.filename)), () => {});
        broadcast('supplier-order:update', {});
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Responsable stock : ouvrir le détail d'un bon = « vu » (aucune autre action côté stock).
app.post('/api/supplier-orders/:id/seen', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const me = req.session.user;
        if (!hasRole(me, 'gestion_stock')) return res.json({ success: true, skipped: true });   // l'admin qui consulte ne compte pas
        const cur = await dbGet('SELECT * FROM supplier_orders WHERE id = ?', [req.params.id]);
        if (!cur) return res.status(404).json({ error: 'Bon de commande introuvable' });
        if (cur.status !== 'en_attente') return res.json({ success: true, status: cur.status });
        const now = getDateTime();
        await dbRun(`UPDATE supplier_orders SET status = 'vu', verified_by_id = ?, verified_by_name = ?, verified_at = ? WHERE id = ?`,
            [me.id, me.full_name || me.username, now, cur.id]);
        resolveNotifs(`supplier_order:${cur.id}`);
        logActivity(req, 'supplier_order_seen', 'supplier_order', cur.id, { number: cur.order_number });
        broadcast('supplier-order:update', {});
        res.json({ success: true, status: 'vu', seen_by: me.full_name || me.username, seen_at: now });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Annuler (responsable commande / admin).
app.post('/api/supplier-orders/:id/cancel', requireAuth, requireSoWriter, async (req, res) => {
    try {
        const cur = await dbGet('SELECT * FROM supplier_orders WHERE id = ?', [req.params.id]);
        if (!cur) return res.status(404).json({ error: 'Bon de commande introuvable' });
        if (cur.status === 'annulee') return res.json({ success: true });
        await dbRun(`UPDATE supplier_orders SET status = 'annulee', updated_at = ? WHERE id = ?`, [getDateTime(), cur.id]);
        resolveNotifs(`supplier_order:${cur.id}`);
        logActivity(req, 'supplier_order_cancel', 'supplier_order', cur.id, { number: cur.order_number });
        broadcast('supplier-order:update', {});
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.delete('/api/supplier-orders/:id', requireAuth, requireSoWriter, async (req, res) => {
    try {
        const cur = await dbGet('SELECT * FROM supplier_orders WHERE id = ?', [req.params.id]);
        if (!cur) return res.status(404).json({ error: 'Bon de commande introuvable' });
        const items = await dbAll('SELECT designation, quantity, unit_price FROM supplier_order_items WHERE order_id = ?', [cur.id]);
        const files = await dbAll('SELECT filename FROM supplier_order_files WHERE order_id = ?', [cur.id]);
        await withTx(async () => {
            await dbRun('DELETE FROM supplier_order_items WHERE order_id = ?', [cur.id]);
            await dbRun('DELETE FROM supplier_order_files WHERE order_id = ?', [cur.id]);
            await dbRun('DELETE FROM supplier_orders WHERE id = ?', [cur.id]);
        });
        files.forEach(f => fs.unlink(path.join(SO_FILE_DIR, path.basename(f.filename)), () => {}));
        resolveNotifs(`supplier_order:${cur.id}`);
        // Trace complète conservée dans le journal d'activité.
        logActivity(req, 'supplier_order_delete', 'supplier_order', cur.id, { ...cur, items });
        broadcast('supplier-order:update', {});
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/client-requests', requireAuth, requireRqAccess, async (req, res) => {
    try {
        const u = req.session.user, all = await rqCanSeeAll(u);
        const w = [], p = [];
        if (!all) { w.push('commercial_id = ?'); p.push(u.id); }
        if (RQ_STATUSES.includes(req.query.status)) { w.push('status = ?'); p.push(req.query.status); }
        const rows = await dbAll(`SELECT * FROM client_requests ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT 1000`, p);
        res.json({ can_see_all: all, requests: rows });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.get('/api/client-requests/:id', requireAuth, requireRqAccess, async (req, res) => {
    try {
        const r = await dbGet('SELECT * FROM client_requests WHERE id = ?', [req.params.id]);
        if (!r) return res.status(404).json({ error: 'Demande introuvable' });
        if (r.commercial_id !== req.session.user.id && !(await rqCanSeeAll(req.session.user))) return res.status(403).json({ error: "Demande d'un autre commercial" });
        res.json(r);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Analyse par mots-clés de TOUTES les demandes (tous commerciaux) sur une période :
// produits les plus demandés (demandes regroupées par similarité) + mots-clés fréquents.
app.get('/api/client-requests-analysis', requireAuth, requireRqAccess, async (req, res) => {
    try {
        const days = Math.max(0, parseInt(req.query.days, 10) || 0);
        const w = [], p = [];
        if (days) { w.push(`created_at >= datetime('now', '+3 hours', ?)`); p.push(`-${days} days`); }   // created_at en heure de Madagascar
        const st = req.query.status === 'all' ? null : (RQ_STATUSES.includes(req.query.status) ? req.query.status : 'en_attente');
        if (st) { w.push('status = ?'); p.push(st); }
        const rows = await dbAll(`SELECT id, product_text, quantity, client_name, commercial_name, status, created_at FROM client_requests
                                  ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id`, p);
        const kw = new Map();
        const groups = [];
        for (const r of rows) {
            const toks = rqTokens(r.product_text);
            const uniq = new Set(toks);
            for (let i = 0; i + 1 < toks.length; i++) if (!RQ_WEAK.has(toks[i]) || !RQ_WEAK.has(toks[i + 1])) uniq.add(toks[i] + ' ' + toks[i + 1]);
            uniq.forEach(k => kw.set(k, (kw.get(k) || 0) + 1));
            // Regroupement : même référence de modèle (X390, G3010…) ; sans référence, mots identifiants
            // qui se recoupent largement.
            const strong = new Set(rqStrong(toks));
            const key = [...new Set(rqKeys([...strong]))].sort().join(' ');
            let g = key ? groups.find(x => x.key === key) : groups.find(x => {
                if (x.key) return false;
                const inter = [...strong].filter(t => x.core.has(t)).length;
                const small = Math.min(strong.size, x.core.size);
                return small && (inter === small ? inter >= Math.min(2, small) : inter / (strong.size + x.core.size - inter) >= 0.6);
            });
            if (!g) { g = { key, core: strong, items: [], texts: new Map() }; groups.push(g); }
            g.items.push(r);
            const t = r.product_text.trim();
            g.texts.set(t, (g.texts.get(t) || 0) + 1);
        }
        const products = groups.map(g => {
            const label = [...g.texts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
            return { label, requests: g.items.length, quantity: g.items.reduce((s, r) => s + (r.quantity || 1), 0),
                     clients: [...new Set(g.items.map(r => r.client_name).filter(Boolean))].length,
                     last_at: g.items[g.items.length - 1].created_at, ids: g.items.map(r => r.id) };
        }).sort((a, b) => b.requests - a.requests || b.quantity - a.quantity || String(b.last_at).localeCompare(String(a.last_at)));
        const keywords = [...kw.entries()].filter(([k, n]) => n >= 2 && !RQ_WEAK.has(k))
            .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, 24).map(([k, n]) => ({ k, n }));
        res.json({ total: rows.length, products: products.slice(0, 30), keywords });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/client-requests', requireAuth, requireRole('commercial_ligne'), async (req, res) => {
    try {
        const t = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 300) || null;
        const product_text = t(req.body.product_text);
        if (!product_text) return res.status(400).json({ error: 'Produit recherché requis' });
        const client_name = t(req.body.client_name, 120);
        { const cErr = clientError(client_name, req.body.client_phone); if (cErr) return res.status(400).json({ error: cErr }); }
        const quantity = Math.max(1, Math.min(999, parseInt(req.body.quantity, 10) || 1));
        const budget = Math.max(0, parseFloat(req.body.budget) || 0) || null;
        const now = getDateTime(), u = req.session.user;
        const r = await dbRun(`INSERT INTO client_requests (commercial_id, commercial_name, client_name, client_phone, channel, product_text, quantity, budget, note, status, created_at, updated_at)
                               VALUES (?,?,?,?,?,?,?,?,?, 'en_attente', ?, ?)`,
            [u.id, u.full_name || u.username, client_name, t(req.body.client_phone, 80), t(req.body.channel, 40), product_text, quantity, budget, t(req.body.note, 500), now, now]);
        const row = await dbGet('SELECT * FROM client_requests WHERE id = ?', [r.lastID]);
        // Déjà en stock ? la demande est aussitôt « disponible » (rien à commander au fournisseur).
        const inStock = await rqFindInStock(product_text);
        if (inStock) await rqMarkAvailable(row, inStock, 'stock');
        else {
            const rid = await commandeResponsibleId();
            pushNotification({ ...(rid ? { target_user: rid } : { target_role: 'admin' }), type: 'info', title: 'Demande client',
                message: `« ${product_text} »${quantity > 1 ? ' ×' + quantity : ''} — ${u.full_name || u.username}`, link: '/demandes-clients.html',
                data: { request_id: r.lastID } });
        }
        broadcast('client-request:update', { id: r.lastID });
        res.json({ success: true, id: r.lastID, in_stock: inStock ? { id: inStock.id, name: inStock.name } : null });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Le commercial modifie / clôture SA demande (commandée, abandonnée, ou remise en attente).
app.put('/api/client-requests/:id', requireAuth, requireRole('commercial_ligne'), async (req, res) => {
    try {
        const r = await dbGet('SELECT * FROM client_requests WHERE id = ?', [req.params.id]);
        if (!r) return res.status(404).json({ error: 'Demande introuvable' });
        if (r.commercial_id !== req.session.user.id && req.session.user.role !== 'admin') return res.status(403).json({ error: "Demande d'un autre commercial" });
        const t = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 300) || null;
        const set = [], p = [];
        if (req.body.client_name !== undefined || req.body.client_phone !== undefined) {
            const cErr = clientError(req.body.client_name !== undefined ? req.body.client_name : r.client_name, req.body.client_phone !== undefined ? req.body.client_phone : r.client_phone);
            if (cErr) return res.status(400).json({ error: cErr });
        }
        if (req.body.status !== undefined) {
            if (!RQ_STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Statut invalide' });
            set.push('status = ?'); p.push(req.body.status);
            if (req.body.status === 'en_attente') set.push('matched_product_id = NULL', 'matched_product_name = NULL', 'matched_at = NULL', 'matched_source = NULL');
        }
        if (req.body.product_text !== undefined) {
            const v = t(req.body.product_text); if (!v) return res.status(400).json({ error: 'Produit recherché requis' });
            set.push('product_text = ?'); p.push(v);
        }
        if (req.body.client_name !== undefined) { const v = t(req.body.client_name, 120); if (!v) return res.status(400).json({ error: 'Nom du client requis' }); set.push('client_name = ?'); p.push(v); }
        ['client_phone', 'channel', 'note'].forEach(f => { if (req.body[f] !== undefined) { set.push(`${f} = ?`); p.push(t(req.body[f], f === 'note' ? 500 : 80)); } });
        if (req.body.quantity !== undefined) { set.push('quantity = ?'); p.push(Math.max(1, Math.min(999, parseInt(req.body.quantity, 10) || 1))); }
        if (req.body.budget !== undefined) { set.push('budget = ?'); p.push(Math.max(0, parseFloat(req.body.budget) || 0) || null); }
        if (!set.length) return res.json({ success: true });
        set.push('updated_at = ?'); p.push(getDateTime(), r.id);
        await dbRun(`UPDATE client_requests SET ${set.join(', ')} WHERE id = ?`, p);
        if (req.body.status && req.body.status !== 'disponible') resolveNotifs(`client_request:${r.id}`);
        broadcast('client-request:update', { id: r.id });
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
};
