// ============================================================
//  STOCKFLOW — Configuration, réglages, référentiels, fournisseurs, sauvegarde
//  Routes /api déplacées depuis server.js (code inchangé). Les helpers, la base et les
//  middlewares partagés arrivent par S (voir « Routes par domaine » en fin de server.js).
// ============================================================
module.exports = function register(app, S) {
    const { db, dbAll, dbRun, getDateTime, getSettings, logActivity, requireAdmin, requireAuth, requireRole, ROLES,
        runDailyBackup, UNIT_STATUS, upload } = S;

// Métadonnées publiques utiles au front (rôles).
app.get('/api/meta/roles', (req, res) => res.json(ROLES));

// ============================================================
//  CONFIGURATION ENTREPRISE
// ============================================================
app.get('/api/config', requireAuth, (req, res) => {
    db.get('SELECT * FROM company_config WHERE id = 1', [], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(row || {});
    });
});

app.put('/api/config', requireAuth, requireAdmin, upload.single('logo'), (req, res) => {
    const b = req.body;
    const fields = ['name', 'address', 'phone', 'email', 'website', 'nif', 'stat', 'rcs',
                    'tva_rate', 'invoice_note', 'invoice_header', 'invoice_footer', 'currency'];
    const set = [], params = [];
    fields.forEach(f => { if (b[f] !== undefined) { set.push(`${f} = ?`); params.push(b[f]); } });
    if (req.file) { set.push('logo = ?'); params.push('/uploads/' + req.file.filename); }
    if (!set.length) return res.json({ success: true });
    db.run(`UPDATE company_config SET ${set.join(', ')} WHERE id = 1`, params, err => {
        if (err) return res.status(500).json({ error: err.message });
        logActivity(req, 'update', 'config', 1, null);
        res.json({ success: true });
    });
});

app.post('/api/setup/complete', requireAuth, requireAdmin, (req, res) => {
    db.run('UPDATE company_config SET setup_done = 1 WHERE id = 1', [], err => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// ── Paramètres (clé/valeur) ──
app.get('/api/settings', requireAuth, (req, res) => getSettings(s => res.json(s)));

// Admin : sauvegarde manuelle de la base (en plus de la sauvegarde automatique du soir).
app.post('/api/backup', requireAuth, requireAdmin, async (req, res) => {
    try { const file = await runDailyBackup('manuelle (admin)'); res.json({ success: true, file }); }
    catch (e) { res.status(500).json({ error: 'Sauvegarde échouée : ' + e.message }); }
});
// Comptes ayant l'accès complet aux chiffres (Profits, marges, CA passé).
app.get('/api/settings/full-ca', requireAuth, requireAdmin, async (req, res) => {
    try { res.json({ ids: await S.fullCAIds(), me: await S.hasFullCA(req.session.user) }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/settings', requireAuth, requireAdmin, async (req, res) => {
    if (req.body && 'full_ca_users' in req.body && !(await S.hasFullCA(req.session.user)))
        return res.status(403).json({ error: "Seul un compte ayant l'accès complet aux chiffres peut modifier cette liste." });
    const entries = Object.entries(req.body || {});
    if (!entries.length) return res.json({ success: true });
    Promise.all(entries.map(([k, v]) =>
        dbRun('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, String(v)])))
    .then(() => {
        logActivity(req, 'update', 'settings', null, req.body);
        res.json({ success: true });
    })
    .catch(err => res.status(500).json({ error: err.message }));
});

// ============================================================
//  FOURNISSEURS
// ============================================================
app.get('/api/suppliers', requireAuth, (req, res) => {
    const all = req.query.all === '1';
    db.all(`SELECT * FROM suppliers ${all ? '' : 'WHERE active = 1'} ORDER BY name`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});
app.post('/api/suppliers', requireAuth, requireAdmin, (req, res) => {
    const { name, contact, phone, email, address, warranty_days, note, label_count } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Nom du fournisseur requis' });
    db.run(`INSERT INTO suppliers (name, contact, phone, email, address, warranty_days, note, label_count, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [name.trim(), contact || null, phone || null, email || null, address || null,
         warranty_days ? parseInt(warranty_days, 10) : null, note || null,
         Math.max(1, parseInt(label_count, 10) || 1), getDateTime()],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            logActivity(req, 'create', 'supplier', this.lastID, { name });
            res.json({ id: this.lastID, success: true });
        });
});
app.put('/api/suppliers/:id', requireAuth, requireAdmin, (req, res) => {
    const { name, contact, phone, email, address, warranty_days, note, active, label_count } = req.body;
    db.run(`UPDATE suppliers SET name = ?, contact = ?, phone = ?, email = ?, address = ?,
            warranty_days = ?, note = ?, label_count = ?, active = ? WHERE id = ?`,
        [name, contact || null, phone || null, email || null, address || null,
         warranty_days ? parseInt(warranty_days, 10) : null, note || null,
         Math.max(1, parseInt(label_count, 10) || 1), active === 0 ? 0 : 1, req.params.id],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
});
app.delete('/api/suppliers/:id', requireAuth, requireAdmin, (req, res) => {
    // Désactivation (on garde l'historique lié aux réceptions).
    db.run('UPDATE suppliers SET active = 0 WHERE id = ?', [req.params.id], err => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// ============================================================
//  MÉTA : libellés de statut d'unité
// ============================================================
app.get('/api/meta/statuses', requireAuth, (req, res) => res.json(UNIT_STATUS));

// ============================================================
//  RÉFÉRENTIELS (listes déroulantes)
// ============================================================
app.get('/api/referentiels', requireAuth, async (req, res) => {
    try {
        const rows = await dbAll('SELECT category, value FROM referentiels WHERE active = 1 ORDER BY category, value COLLATE NOCASE');
        const grouped = {};
        rows.forEach(r => { (grouped[r.category] = grouped[r.category] || []).push(r.value); });
        res.json(grouped);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.post('/api/referentiels', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    const { category, value } = req.body;
    if (!category || !value || !value.trim()) return res.status(400).json({ error: 'Catégorie et valeur requises' });
    try {
        await dbRun('INSERT OR IGNORE INTO referentiels (category, value, created_at) VALUES (?, ?, ?)',
            [category, value.trim(), getDateTime()]);
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
};
