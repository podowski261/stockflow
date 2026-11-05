// ============================================================
//  STOCKFLOW — Installation / préparation, garantie, service atelier
//  Routes /api déplacées depuis server.js (code inchangé). Les helpers, la base et les
//  middlewares partagés arrivent par S (voir « Routes par domaine » en fin de server.js).
// ============================================================
module.exports = function register(app, S) {
    const { addDays, applyInstallItemValidation, ATELIER_SELECT, broadcast, closeInstallTaskIfComplete, dateFR, dbAll,
        dbGet, dbRun, GARANTIE_DEPOT, garantieResponsibleId, garantieType, getDate, getDateTime, getSettingsAsync,
        htmlEsc, invoiceRef, logActivity, logGarantie, productDisplayName, productSignature, pushNotification,
        recordMovement, requireAtelier, requireAuth, requireGarantieResponsible, requireGarantieViewer, requireRole,
        resolveDepotUnits, resolveNotifs, storage, technicianView, txError, withRef, withTx } = S;

app.post('/api/installations', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const { technician_id, unit_ids, lines, note, purpose } = req.body;
        if (!technician_id) return res.status(400).json({ error: 'Technicien requis' });
        const tech = await dbGet('SELECT * FROM users WHERE id = ? AND role = ?', [technician_id, 'technicien']);
        if (!tech) return res.status(400).json({ error: 'Technicien introuvable' });

        // Séries SCANNÉES (unit_ids) prioritaires ; repli auto par produit/quantité (lines).
        const resolved = await resolveDepotUnits(unit_ids, lines);
        if (resolved.error) return res.status(400).json({ error: resolved.error });
        const units = resolved.units;
        if (!units.length) return res.status(400).json({ error: 'Aucune unité sélectionnée' });

        const settings = await getSettingsAsync();
        const minPer = parseInt(settings.install_minutes_per_unit, 10) || 3;
        const now = getDateTime();
        // Réception implicite : c'est le technicien lui-même qui choisit et retire les unités
        // du stock dépôt. La sortie est donc validée « reçue » dès sa création : la tâche démarre
        // directement en « en_cours » et le compte à rebours court immédiatement (plus d'étape
        // « à réceptionner » / « Valider la réception »).
        const minutesAllowed = minPer * units.length;
        const deadline = Date.now() + minutesAllowed * 60000;
        const taskId = await withTx(async () => {
            const task = await dbRun(
                `INSERT INTO installation_tasks (technician_id, technician_name, created_by_id, created_by_name, purpose, status, unit_count, minutes_allowed, started_at, deadline_ms, note, created_at)
                 VALUES (?, ?, ?, ?, ?, 'en_cours', ?, ?, ?, ?, ?, ?)`,
                [tech.id, tech.full_name || tech.username, req.session.user.id, req.session.user.full_name || req.session.user.username,
                 purpose || 'installation', units.length, minutesAllowed, now, deadline, note || null, now]);
            for (const u of units) {
                const up = await dbRun(`UPDATE stock_units SET status = 'preparation', holder_user_id = ?, updated_at = ? WHERE id = ? AND status = 'stock'`, [tech.id, now, u.id]);
                if (up.changes !== 1) throw txError(409, `Unité ${u.serial || u.id} sortie entre-temps par ailleurs — rechargez.`);
                await dbRun(`INSERT INTO install_items (task_id, unit_id, serial, product_name) VALUES (?, ?, ?, ?)`,
                    [task.lastID, u.id, u.serial, u.product_name]);
                await recordMovement(u, 'preparation', 'envoi_installation', req, { from: 'stock', ref_type: 'installation', ref_id: task.lastID, note: 'Envoi en installation/préparation' });
            }
            return task.lastID;
        });

        logActivity(req, 'installation_send', 'installation', taskId, { units: units.length, technician: tech.full_name });
        pushNotification({ target_user: tech.id, type: 'info', title: 'Nouvelle tâche d\'installation',
            message: `${units.length} unité(s) à préparer (${minutesAllowed} minutes). Le compte à rebours a démarré.`,
            link: '/installation.html', data: { task_id: taskId } });
        broadcast('install:update', { task_id: taskId }, { userId: tech.id });
        broadcast('install:update', { task_id: taskId }, { role: 'gestion_stock' });
        broadcast('stock:update', { task_id: taskId });   // unités passées de 'stock' à 'preparation'
        res.json({ success: true, task_id: taskId, minutes_allowed: minPer * units.length });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/installations', requireAuth, requireRole('technicien', 'gestion_stock'), async (req, res) => {
    try {
        const me = req.session.user;
        const w = [], p = [];
        if (technicianView(me)) { w.push('t.technician_id = ?'); p.push(me.id); }
        if (req.query.status) { w.push('t.status = ?'); p.push(req.query.status); }
        const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
        const rows = await dbAll(
            `SELECT t.*,
                (SELECT COUNT(*) FROM install_items i WHERE i.task_id = t.id) AS items_total,
                (SELECT COUNT(*) FROM install_items i WHERE i.task_id = t.id AND i.result = 'termine')  AS items_done,
                (SELECT COUNT(*) FROM install_items i WHERE i.task_id = t.id AND i.result = 'probleme') AS items_problem
             FROM installation_tasks t ${where}
             ORDER BY CASE t.status WHEN 'en_cours' THEN 0 WHEN 'envoye' THEN 1 WHEN 'termine' THEN 2 ELSE 3 END, t.created_at DESC
             LIMIT 300`, p);
        // Joint les unités (cartes affichées directement dans la page) pour les tâches actives,
        // ET pour les 12 tâches clôturées les plus récentes (détails/suivi de l'historique).
        let closWithItems = 0;
        for (const t of rows) {
            let attach = ['envoye', 'en_cours', 'termine'].includes(t.status);
            if (!attach && t.status === 'clos' && closWithItems < 12) { attach = true; closWithItems++; }
            if (attach) {
                t.items = await dbAll(
                    `SELECT i.*, u.warranty_end, u.status AS unit_status, u.manufacturer_sn,
                            p.brand, p.model, p.category, p.condition, p.cpu, p.ram, p.storage, p.storage_type, p.screen_size, p.gpu, p.touchscreen, p.numpad, p.is_accessory
                     FROM install_items i LEFT JOIN stock_units u ON u.id = i.unit_id LEFT JOIN products p ON p.id = u.product_id
                     WHERE i.task_id = ? ORDER BY i.id`, [t.id]);
            }
        }
        res.json({ now: Date.now(), tasks: rows });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Historique des installations (terminées/clôturées) — role-scopé + filtres date. Défini AVANT /:id.
app.get('/api/installations/history', requireAuth, requireRole('technicien', 'gestion_stock'), async (req, res) => {
    try {
        const me = req.session.user;
        const { from, to } = req.query;
        const w = ["t.status IN ('termine','clos')"], p = [];
        if (technicianView(me)) { w.push('t.technician_id = ?'); p.push(me.id); }
        if (from) { w.push('date(t.created_at) >= date(?)'); p.push(from); }
        if (to)   { w.push('date(t.created_at) <= date(?)'); p.push(to); }
        const tasks = await dbAll(
            `SELECT t.*,
                (SELECT COUNT(*) FROM install_items i WHERE i.task_id = t.id) AS items_total,
                (SELECT COUNT(*) FROM install_items i WHERE i.task_id = t.id AND i.result = 'termine')  AS items_done,
                (SELECT COUNT(*) FROM install_items i WHERE i.task_id = t.id AND i.result = 'probleme') AS items_problem
             FROM installation_tasks t WHERE ${w.join(' AND ')}
             ORDER BY t.created_at DESC LIMIT 300`, p);
        for (const t of tasks) {
            t.items = await dbAll(
                `SELECT i.*, p.brand, p.model, p.category, p.condition, p.cpu, p.ram, p.storage, p.storage_type, p.screen_size, p.gpu, p.is_accessory
                 FROM install_items i LEFT JOIN stock_units u ON u.id = i.unit_id LEFT JOIN products p ON p.id = u.product_id
                 WHERE i.task_id = ? ORDER BY i.id`, [t.id]);
        }
        res.json(tasks);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/installations/:id', requireAuth, requireRole('technicien', 'gestion_stock'), async (req, res) => {
    try {
        const t = await dbGet('SELECT * FROM installation_tasks WHERE id = ?', [req.params.id]);
        if (!t) return res.status(404).json({ error: 'Tâche introuvable' });
        if (technicianView(req.session.user) && t.technician_id !== req.session.user.id)
            return res.status(403).json({ error: 'Tâche non assignée' });
        const items = await dbAll(
            `SELECT i.*, u.warranty_end, u.status AS unit_status, u.manufacturer_sn,
                    p.brand, p.model, p.category, p.condition, p.cpu, p.ram, p.storage, p.storage_type, p.screen_size, p.gpu, p.touchscreen, p.numpad, p.is_accessory
             FROM install_items i LEFT JOIN stock_units u ON u.id = i.unit_id LEFT JOIN products p ON p.id = u.product_id
             WHERE i.task_id = ? ORDER BY i.id`, [req.params.id]);
        res.json({ ...t, now: Date.now(), items });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Technicien : valider la réception → démarrage du compte à rebours.
app.post('/api/installations/:id/accept', requireAuth, requireRole('technicien'), async (req, res) => {
    try {
        const t = await dbGet('SELECT * FROM installation_tasks WHERE id = ?', [req.params.id]);
        if (!t) return res.status(404).json({ error: 'Tâche introuvable' });
        if (t.technician_id !== req.session.user.id) return res.status(403).json({ error: 'Tâche non assignée' });
        if (t.status !== 'envoye') return res.status(400).json({ error: 'Tâche déjà démarrée' });
        const deadline = Date.now() + t.minutes_allowed * 60000;
        await dbRun(`UPDATE installation_tasks SET status = 'en_cours', started_at = ?, deadline_ms = ?, last_reminder_at = NULL WHERE id = ?`,
            [getDateTime(), deadline, t.id]);
        resolveNotifs(`install:${t.id}:accept`);   // la tâche est prise en charge
        broadcast('install:update', { task_id: t.id }, { userId: t.technician_id });
        broadcast('install:update', { task_id: t.id }, { role: 'gestion_stock' });
        pushNotification({ target_role: 'gestion_stock', type: 'info', title: 'Installation démarrée',
            message: `${t.technician_name} a démarré la tâche #${t.id} (${t.minutes_allowed} minutes).`, link: '/installation.html' });
        res.json({ success: true, deadline_ms: deadline });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Technicien : démarre l'installation d'UNE unité (heure de début par produit). La fin = sa décision.
app.post('/api/installations/items/:itemId/start', requireAuth, requireRole('technicien'), async (req, res) => {
    try {
        const item = await dbGet(
            `SELECT i.*, t.technician_id, t.status AS task_status FROM install_items i JOIN installation_tasks t ON t.id = i.task_id WHERE i.id = ?`,
            [req.params.itemId]);
        if (!item) return res.status(404).json({ error: 'Élément introuvable' });
        if (item.technician_id !== req.session.user.id) return res.status(403).json({ error: 'Non autorisé' });
        if (item.task_status !== 'en_cours') return res.status(400).json({ error: 'Validez d\'abord la réception de la tâche' });
        if (item.result !== 'pending') return res.status(400).json({ error: 'Unité déjà traitée' });
        if (item.started_at) return res.json({ success: true, started_at: item.started_at });
        const now = getDateTime();
        await dbRun(`UPDATE install_items SET started_at = ? WHERE id = ? AND started_at IS NULL`, [now, item.id]);
        broadcast('install:update', { task_id: item.task_id }, { role: 'gestion_stock' });
        broadcast('install:update', { task_id: item.task_id }, { userId: item.technician_id });
        res.json({ success: true, started_at: now });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Technicien : remarque libre sur UNE unité (ex. « Windows activé, pilote Wi-Fi ajouté »),
// modifiable tant que l'unité n'est pas renvoyée au stock / en garantie. Vide = effacée.
app.post('/api/installations/items/:itemId/remark', requireAuth, requireRole('technicien'), async (req, res) => {
    try {
        const remark = String(req.body.remark || '').trim().slice(0, 1000);
        const item = await dbGet(
            `SELECT i.*, t.technician_id, t.status AS task_status FROM install_items i JOIN installation_tasks t ON t.id = i.task_id WHERE i.id = ?`,
            [req.params.itemId]);
        if (!item) return res.status(404).json({ error: 'Élément introuvable' });
        if (item.technician_id !== req.session.user.id) return res.status(403).json({ error: 'Non autorisé' });
        if (item.task_status !== 'en_cours' || item.validated_at) return res.status(400).json({ error: 'Unité déjà renvoyée : remarque non modifiable' });
        await dbRun(`UPDATE install_items SET tech_remark = ? WHERE id = ?`, [remark || null, item.id]);
        broadcast('install:update', { task_id: item.task_id }, { role: 'gestion_stock' });
        broadcast('install:update', { task_id: item.task_id }, { userId: item.technician_id });
        res.json({ success: true, tech_remark: remark || null });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Technicien : décision par unité (terminée / problème).
app.post('/api/installations/items/:itemId', requireAuth, requireRole('technicien'), async (req, res) => {
    try {
        const { result, problem_note } = req.body;
        if (!['termine', 'probleme'].includes(result)) return res.status(400).json({ error: 'Résultat invalide' });
        if (result === 'probleme' && (!problem_note || !problem_note.trim()))
            return res.status(400).json({ error: 'Décrivez le problème rencontré' });
        const item = await dbGet(
            `SELECT i.*, t.technician_id, t.status AS task_status FROM install_items i JOIN installation_tasks t ON t.id = i.task_id WHERE i.id = ?`,
            [req.params.itemId]);
        if (!item) return res.status(404).json({ error: 'Élément introuvable' });
        if (item.technician_id !== req.session.user.id) return res.status(403).json({ error: 'Non autorisé' });
        if (item.task_status !== 'en_cours') return res.status(400).json({ error: 'La tâche n\'est pas en cours' });
        if (!item.started_at) return res.status(400).json({ error: 'Cliquez d\'abord sur « Commencer » pour cette unité (heure de début).' });
        await dbRun(`UPDATE install_items SET result = ?, problem_note = ?, decided_at = ? WHERE id = ?`,
            [result, result === 'probleme' ? problem_note.trim() : null, getDateTime(), item.id]);
        // Dès qu'une unité est décidée, elle est disponible pour le gestionnaire (validation individuelle).
        // Quand plus AUCUNE unité n'est en attente, la tâche se termine d'elle-même (plus de bouton « Terminer »).
        const rem = await dbGet(`SELECT COUNT(*) AS n FROM install_items WHERE task_id = ? AND result = 'pending'`, [item.task_id]);
        if (rem.n === 0) {
            const tk = await dbGet('SELECT * FROM installation_tasks WHERE id = ?', [item.task_id]);
            if (tk && tk.status === 'en_cours') {
                await dbRun(`UPDATE installation_tasks SET status = 'termine' WHERE id = ?`, [item.task_id]);
                resolveNotifs(`install:${item.task_id}:overdue`);   // travail technicien terminé
                pushNotification({ target_role: 'gestion_stock', type: 'success', title: 'Unités prêtes à valider',
                    message: `Toutes les unités de la tâche #${item.task_id} sont traitées.`, link: '/installation.html', ref: `install:${item.task_id}:validate` });
            }
        }
        broadcast('install:update', { task_id: item.task_id }, { role: 'gestion_stock' });
        broadcast('install:update', { task_id: item.task_id }, { userId: item.technician_id });
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Technicien : terminer la tâche (toutes les unités décidées).
app.post('/api/installations/:id/finish', requireAuth, requireRole('technicien'), async (req, res) => {
    try {
        const t = await dbGet('SELECT * FROM installation_tasks WHERE id = ?', [req.params.id]);
        if (!t) return res.status(404).json({ error: 'Tâche introuvable' });
        if (t.technician_id !== req.session.user.id) return res.status(403).json({ error: 'Tâche non assignée' });
        const pending = await dbGet(`SELECT COUNT(*) AS n FROM install_items WHERE task_id = ? AND result = 'pending'`, [t.id]);
        if (pending.n > 0) return res.status(400).json({ error: `${pending.n} unité(s) sans décision` });
        await dbRun(`UPDATE installation_tasks SET status = 'termine' WHERE id = ?`, [t.id]);
        resolveNotifs(`install:${t.id}:overdue`);   // fin des rappels de retard
        pushNotification({ target_role: 'gestion_stock', type: 'success', title: 'Retour technicien à valider',
            message: `${t.technician_name} a terminé la tâche #${t.id}. Validez le retour.`, link: '/installation.html', ref: `install:${t.id}:validate` });
        broadcast('install:update', { task_id: t.id }, { role: 'gestion_stock' });
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Technicien : indiquer la raison d'un retard (stoppe les rappels).
app.post('/api/installations/:id/reason', requireAuth, requireRole('technicien'), async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason || !reason.trim()) return res.status(400).json({ error: 'Raison requise' });
        const t = await dbGet('SELECT * FROM installation_tasks WHERE id = ?', [req.params.id]);
        if (!t || t.technician_id !== req.session.user.id) return res.status(403).json({ error: 'Non autorisé' });
        await dbRun(`UPDATE installation_tasks SET overdue_reason = ? WHERE id = ?`, [reason.trim(), t.id]);
        resolveNotifs(`install:${t.id}:overdue`);
        pushNotification({ target_role: 'gestion_stock', type: 'warn', title: 'Retard justifié',
            message: `Tâche #${t.id} (${t.technician_name}) : ${reason.trim()}`, link: '/installation.html' });
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Gestionnaire : envoyer UNE unité décidée vers sa destination (stock ou garantie), sans attendre le bloc.
app.post('/api/installations/items/:itemId/validate', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const it = await dbGet(
            `SELECT i.*, t.status AS task_status, t.technician_id FROM install_items i JOIN installation_tasks t ON t.id = i.task_id WHERE i.id = ?`,
            [req.params.itemId]);
        if (!it) return res.status(404).json({ error: 'Unité introuvable' });
        if (!['en_cours', 'termine'].includes(it.task_status)) return res.status(400).json({ error: 'Unité non disponible' });
        if (it.result === 'pending') return res.status(400).json({ error: 'Unité pas encore décidée par le technicien' });
        if (it.validated_at) return res.status(400).json({ error: 'Unité déjà envoyée' });
        const t = await dbGet('SELECT * FROM installation_tasks WHERE id = ?', [it.task_id]);
        const { outcome, closed } = await withTx(async () => {
            const outcome = await applyInstallItemValidation(it, t.id, req);
            return { outcome, closed: await closeInstallTaskIfComplete(t, req) };
        });
        if (outcome === 'problem')
            pushNotification({ target_role: 'gestion_stock', type: 'warn', title: 'Unité en garantie',
                message: `1 unité placée en garantie fournisseur (tâche #${t.id}).`, link: '/garantie.html' });
        broadcast('install:update', { task_id: t.id });
        broadcast('install:update', { task_id: t.id }, { userId: t.technician_id });
        broadcast('stock:update', {});
        res.json({ success: true, result: outcome, closed });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Gestionnaire : valider en une fois TOUT le reste des unités non encore envoyées.
app.post('/api/installations/:id/validate-return', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const t = await dbGet('SELECT * FROM installation_tasks WHERE id = ?', [req.params.id]);
        if (!t) return res.status(404).json({ error: 'Tâche introuvable' });
        if (!['en_cours', 'termine'].includes(t.status)) return res.status(400).json({ error: 'Tâche non disponible' });
        const items = await dbAll(`SELECT * FROM install_items WHERE task_id = ? AND validated_at IS NULL AND result != 'pending'`, [t.id]);
        let ok = 0, problem = 0;
        await withTx(async () => {
            for (const it of items) {
                const outcome = await applyInstallItemValidation(it, t.id, req);
                if (outcome === 'ok') ok++; else if (outcome === 'problem') problem++;
            }
            await closeInstallTaskIfComplete(t, req);
        });
        if (problem > 0)
            pushNotification({ target_role: 'gestion_stock', type: 'warn', title: 'Unités en garantie',
                message: `${problem} unité(s) placées en garantie fournisseur (tâche #${t.id}).`, link: '/garantie.html' });
        broadcast('install:update', { task_id: t.id });
        broadcast('stock:update', {});
        res.json({ success: true, ok, problem });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Services atelier avec un reste à payer (page Encaissements > Atelier, caisse).
app.get('/api/atelier/balances', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const rows = await dbAll(`SELECT s.id, s.sale_number, s.sale_date, s.created_at, s.client_name, s.client_phone, s.client_pc, s.total, s.balance_due,
                s.cashier_name, s.commercial_name,
                (SELECT GROUP_CONCAT(si.product_name, ' + ') FROM sale_items si WHERE si.sale_id = s.id AND si.is_service = 1) AS services,
                (SELECT l.status FROM atelier_labels l WHERE l.sale_id = s.id ORDER BY l.id DESC LIMIT 1) AS label_status
            FROM sales s WHERE s.status = 'completed' AND COALESCE(s.balance_due, 0) > 0 ORDER BY s.created_at`);
        res.json(rows.map(r => ({ ...r, invoice_ref: invoiceRef(r) })));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/garantie', requireAuth, requireGarantieViewer, async (req, res) => {
    try {
        const stage = req.query.stage || 'all';
        const statuses = stage === 'depot' ? GARANTIE_DEPOT
                       : stage === 'retour' ? ['retour_fournisseur']
                       : stage === 'a_renvoyer' ? ['garantie_a_renvoyer']
                       : stage === 'retournee' ? ['garantie_retournee']
                       : stage === 'remboursement' ? ['remboursement_attente']
                       : [...GARANTIE_DEPOT, 'garantie_a_renvoyer', 'retour_fournisseur', 'garantie_retournee', 'remboursement_attente'];
        const ph = statuses.map(() => '?').join(',');
        const p = [...statuses];
        let supFilter = '';
        if (req.query.supplier_id) { supFilter = 'AND u.supplier_id = ?'; p.push(req.query.supplier_id); }
        const rows = await dbAll(
            `SELECT u.*, p.name AS product_name, p.brand, p.model, p.category, p.is_accessory,
                    p.cpu, p.ram, p.storage, p.storage_type, p.screen_size, p.gpu, s.name AS supplier_name
             FROM stock_units u LEFT JOIN products p ON p.id = u.product_id LEFT JOIN suppliers s ON s.id = u.supplier_id
             WHERE u.status IN (${ph}) ${supFilter} ORDER BY u.supplier_id, u.updated_at DESC`, p);
        res.json(rows.map(u => ({ ...u, garantie_type: garantieType(u.status) })));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Suivi garantie consolidé PAR N° DE SÉRIE (ordinateurs) : état actuel + qui/quand
// pour l'entrée en garantie, l'envoi au fournisseur et le retour. Un responsable par étape.
app.get('/api/garantie/suivi', requireAuth, requireGarantieViewer, async (req, res) => {
    try {
        const GAR = ['garantie_fournisseur', 'garantie_exceptionnel', 'garantie_a_renvoyer', 'retour_fournisseur'];
        const ph = GAR.map(() => '?').join(',');
        const movs = await dbAll(
            `SELECT m.unit_id, m.serial, m.from_status, m.to_status, m.user_name, m.created_at,
                    u.status AS current_status, p.name AS product_name, p.brand, p.model, s.name AS supplier_name
             FROM unit_movements m
             JOIN stock_units u ON u.id = m.unit_id
             JOIN products p ON p.id = u.product_id
             LEFT JOIN suppliers s ON s.id = u.supplier_id
             WHERE p.is_accessory = 0 AND (m.to_status IN (${ph}) OR m.from_status IN (${ph}))
             ORDER BY m.unit_id, m.id`, [...GAR, ...GAR]);
        const byUnit = new Map();
        for (const m of movs) {
            let r = byUnit.get(m.unit_id);
            if (!r) {
                r = { unit_id: m.unit_id, serial: m.serial, product_name: [m.brand, m.model].filter(Boolean).join(' ') || m.product_name,
                      supplier_name: m.supplier_name, current_status: m.current_status,
                      entry_date: null, entry_by: null, sent_date: null, sent_by: null, return_date: null, return_by: null };
                byUnit.set(m.unit_id, r);
            }
            r.current_status = m.current_status;   // dernière valeur (jointure = statut réel actuel)
            if (['garantie_fournisseur', 'garantie_exceptionnel'].includes(m.to_status) && !r.entry_date) { r.entry_date = m.created_at; r.entry_by = m.user_name; }
            if (m.to_status === 'retour_fournisseur') { r.sent_date = m.created_at; r.sent_by = m.user_name; }
            if (m.from_status === 'retour_fournisseur' && m.to_status !== 'retour_fournisseur') { r.return_date = m.created_at; r.return_by = m.user_name; }
        }
        res.json([...byUnit.values()].sort((a, b) => String(b.entry_date || '').localeCompare(String(a.entry_date || ''))));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Retour au fournisseur (garantie_fournisseur → …).
// Si un responsable garantie est désigné : passe à « garantie_a_renvoyer »
// (le responsable validera l'envoi réel). Sinon : envoi direct (comportement d'origine).
app.post('/api/garantie/return-supplier', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const { unit_ids, sender_name } = req.body;
        if (!Array.isArray(unit_ids) || !unit_ids.length) return res.status(400).json({ error: 'Aucune unité sélectionnée' });
        const respId = await new Promise(r => garantieResponsibleId(r));
        const resp = respId ? await dbGet('SELECT id, full_name, username FROM users WHERE id = ? AND active = 1', [respId]) : null;
        if (!resp && (!sender_name || !sender_name.trim()))
            return res.status(400).json({ error: 'Nom de la personne qui renvoie requis' });
        // Motif / raison obligatoire pour toute unité envoyée en garantie.
        const units = [];
        for (const uid of unit_ids) {
            const u = await dbGet(`SELECT * FROM stock_units WHERE id = ? AND status = 'garantie_fournisseur'`, [uid]);
            if (u) units.push(u);
        }
        const missing = units.filter(u => !u.note || !String(u.note).trim());
        if (missing.length)
            return res.status(400).json({ error: `Motif / raison obligatoire manquant pour : ${missing.map(u => u.serial || ('#' + u.id)).join(', ')}` });
        const now = getDateTime(); let n = 0;
        await withTx(async () => {
        for (const u of units) {
            const uid = u.id;
            // Unité encore en « garantie fournisseur » (pas déjà traitée par une autre requête) ?
            const still = await dbGet(`SELECT 1 FROM stock_units WHERE id = ? AND status = 'garantie_fournisseur'`, [uid]);
            if (!still) continue;
            if (resp) {
                // Remis au responsable pour envoi.
                await dbRun(`UPDATE stock_units SET status = 'garantie_a_renvoyer', holder_user_id = ?, updated_at = ? WHERE id = ?`, [resp.id, now, uid]);
                await recordMovement(u, 'garantie_a_renvoyer', 'garantie_a_renvoyer', req, { from: 'garantie_fournisseur', note: `Confié à ${resp.full_name || resp.username}` });
                await logGarantie(u, 'a_renvoyer', 'fournisseur', req, { sender_name: resp.full_name || resp.username });
            } else {
                await dbRun(`UPDATE stock_units SET status = 'retour_fournisseur', updated_at = ? WHERE id = ?`, [now, uid]);
                await recordMovement(u, 'retour_fournisseur', 'retour_fournisseur', req, { from: 'garantie_fournisseur', note: `Renvoyé par ${sender_name.trim()}` });
                await logGarantie(u, 'retour_fournisseur', 'fournisseur', req, { sender_name: sender_name.trim() });
            }
            n++;
        }
        });
        if (resp && n)
            pushNotification({ target_user: resp.id, type: 'warn', persistent: true, ref: 'garantie:a_renvoyer',
                title: 'Garanties à renvoyer', message: `${n} unité(s) à envoyer au fournisseur.`, link: '/garantie-envoi.html' });
        logActivity(req, 'garantie_return_supplier', 'garantie', null, { units: n, responsible: resp ? (resp.full_name || resp.username) : null });
        broadcast('garantie:update', {}); broadcast('stock:update', {});
        res.json({ success: true, count: n, to_responsible: !!resp });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Liste des garanties à envoyer (interface du responsable), groupables par fournisseur.
app.get('/api/garantie/to-send', requireAuth, requireGarantieResponsible, async (req, res) => {
    try {
        const p = [];
        let supFilter = '';
        if (req.query.supplier_id) { supFilter = 'AND u.supplier_id = ?'; p.push(req.query.supplier_id); }
        const rows = await dbAll(
            `SELECT u.*, p.name AS product_name, p.brand, p.model, p.category, p.condition, p.cpu, p.ram, p.storage, p.storage_type, p.screen_size, p.gpu, p.is_accessory,
                    s.name AS supplier_name, s.phone AS supplier_phone, s.address AS supplier_address,
                    r.created_at AS reception_at, r.reference AS reception_ref
             FROM stock_units u LEFT JOIN products p ON p.id = u.product_id LEFT JOIN suppliers s ON s.id = u.supplier_id
             LEFT JOIN receptions r ON r.id = u.reception_id
             WHERE u.status = 'garantie_a_renvoyer' ${supFilter} ORDER BY u.supplier_id, u.updated_at`, p);
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Envoyés au fournisseur, sans retour (interface responsable) — pour marquer « retourné ».
app.get('/api/garantie/sent', requireAuth, requireGarantieResponsible, async (req, res) => {
    try {
        const p = []; let supFilter = '';
        if (req.query.supplier_id) { supFilter = 'AND u.supplier_id = ?'; p.push(req.query.supplier_id); }
        const rows = await dbAll(
            `SELECT u.*, p.name AS product_name, p.brand, p.model, p.category, p.condition, p.cpu, p.ram, p.storage, p.storage_type, p.screen_size, p.gpu, p.is_accessory,
                    s.name AS supplier_name, r.created_at AS reception_at
             FROM stock_units u LEFT JOIN products p ON p.id = u.product_id LEFT JOIN suppliers s ON s.id = u.supplier_id
             LEFT JOIN receptions r ON r.id = u.reception_id
             WHERE u.status = 'retour_fournisseur' ${supFilter} ORDER BY u.supplier_id, u.updated_at`, p);
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Le responsable déclare le retour du fournisseur (retour_fournisseur → garantie_retournee) → à réceptionner par le stock.
app.post('/api/garantie/mark-returned', requireAuth, requireGarantieResponsible, async (req, res) => {
    try {
        const { unit_ids } = req.body;
        if (!Array.isArray(unit_ids) || !unit_ids.length) return res.status(400).json({ error: 'Aucune unité sélectionnée' });
        const now = getDateTime(); let n = 0;
        await withTx(async () => {
            for (const uid of unit_ids) {
                const u = await dbGet(`SELECT * FROM stock_units WHERE id = ? AND status = 'retour_fournisseur'`, [uid]);
                if (!u) continue;
                await dbRun(`UPDATE stock_units SET status = 'garantie_retournee', updated_at = ? WHERE id = ?`, [now, uid]);
                await recordMovement(u, 'garantie_retournee', 'garantie_retournee', req, { from: 'retour_fournisseur', note: 'Revenu du fournisseur' });
                await logGarantie(u, 'retourne', 'fournisseur', req, { sender_name: req.session.user.full_name || req.session.user.username });
                n++;
            }
        });
        if (n) pushNotification({ target_role: 'gestion_stock', type: 'warn', persistent: true, ref: 'garantie:retournee',
            title: 'Garanties revenues à réceptionner', message: `${n} unité(s) revenue(s) du fournisseur — à réceptionner au stock.`, link: '/garantie.html' });
        logActivity(req, 'garantie_mark_returned', 'garantie', null, { units: n });
        broadcast('garantie:update', {}); broadcast('stock:update', {});
        res.json({ success: true, count: n });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Unités revenues du fournisseur, à re-réceptionner (stock).
app.get('/api/garantie/to-receive', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT u.*, p.name AS product_name, p.brand, p.model, p.category, p.condition, p.cpu, p.ram, p.storage, p.storage_type, p.screen_size, p.gpu, p.is_accessory,
                    s.name AS supplier_name, s.warranty_days AS supplier_warranty_days
             FROM stock_units u LEFT JOIN products p ON p.id = u.product_id LEFT JOIN suppliers s ON s.id = u.supplier_id
             WHERE u.status = 'garantie_retournee' ORDER BY u.supplier_id, u.updated_at`, []);
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Le stock re-réceptionne une unité revenue : seuls date d'entrée, RAM, Stockage, prix
// de vente (et prix d'achat) sont modifiables — le reste de la config et le n° série sont figés.
app.post('/api/garantie/receive-return', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const { unit_id, entry_date, ram, storage, storage_type, sale_price, purchase_price, warranty_days } = req.body;
        const u = await dbGet(`SELECT * FROM stock_units WHERE id = ? AND status = 'garantie_retournee'`, [unit_id]);
        if (!u) return res.status(400).json({ error: 'Unité non disponible' });
        const prod = await dbGet('SELECT * FROM products WHERE id = ?', [u.product_id]);
        if (!prod) return res.status(400).json({ error: 'Produit introuvable' });
        const now = getDateTime();
        const today = (entry_date && /^\d{4}-\d{2}-\d{2}$/.test(entry_date)) ? entry_date : getDate();
        const price = (sale_price != null && sale_price !== '') ? parseFloat(sale_price) || 0 : (u.sale_price || 0);
        // Si RAM/Stockage changent, l'unité pointe vers le modèle produit correspondant (créé si besoin).
        const newRam = (ram != null && ram !== '') ? String(ram).trim() : prod.ram;
        const newStorage = (storage != null && storage !== '') ? String(storage).trim() : prod.storage;
        const newStorageType = (storage_type != null && storage_type !== '') ? String(storage_type).trim() : prod.storage_type;
        let productId = prod.id;
        if (newRam !== prod.ram || newStorage !== prod.storage || newStorageType !== prod.storage_type) {
            const np = { ...prod, ram: newRam, storage: newStorage, storage_type: newStorageType };
            const sig = productSignature(np);
            let existing = await dbGet('SELECT id FROM products WHERE signature = ?', [sig]);
            if (existing) productId = existing.id;
            else {
                const pr = await dbRun(
                    `INSERT INTO products (signature, is_accessory, name, category, brand, model, condition, cpu, ram, storage, storage_type, gpu, screen_size, touchscreen, webcam, wifi, bluetooth, numpad, sale_price, purchase_price, image, description, created_at)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                    [sig, prod.is_accessory, productDisplayName(np), prod.category, prod.brand, prod.model, prod.condition, prod.cpu, newRam, newStorage, newStorageType,
                     prod.gpu, prod.screen_size, prod.touchscreen, prod.webcam, prod.wifi, prod.bluetooth, prod.numpad, price,
                     (purchase_price != null && purchase_price !== '' && req.session.user.role === 'admin') ? parseFloat(purchase_price) || 0 : (prod.purchase_price || 0),
                     prod.image, prod.description, now]);
                productId = pr.lastID;
            }
        } else if (req.session.user.role === 'admin' && purchase_price != null && purchase_price !== '') {
            await dbRun('UPDATE products SET purchase_price = ? WHERE id = ?', [parseFloat(purchase_price) || 0, prod.id]);
        }
        const wDays = (warranty_days != null && warranty_days !== '') ? parseInt(warranty_days, 10) : null;
        const warrantyEnd = wDays != null ? addDays(today, wDays) : (u.warranty_end || null);
        const up = await dbRun(`UPDATE stock_units SET status = 'stock', location = 'depot', product_id = ?, sale_price = ?, warranty_start = ?, warranty_end = ?, note = NULL, updated_at = ? WHERE id = ? AND status = 'garantie_retournee'`,
            [productId, price, today, warrantyEnd, now, unit_id]);
        if (up.changes !== 1) return res.status(409).json({ error: 'Unité déjà re-réceptionnée (rafraîchissez).' });
        await recordMovement({ ...u, product_id: productId }, 'stock', 'garantie_traitee', req, { from: 'garantie_retournee', note: 'Re-réceptionné après retour fournisseur' });
        await logGarantie({ ...u, product_id: productId }, 'traite', 'fournisseur', req, { reason: 'Revenu et re-réceptionné' });
        if (!(await dbGet(`SELECT COUNT(*) n FROM stock_units WHERE status = 'garantie_retournee'`)).n) resolveNotifs('garantie:retournee');
        logActivity(req, 'garantie_receive_return', 'garantie', unit_id, null);
        broadcast('garantie:update', {}); broadcast('stock:update', {});
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Le responsable confirme l'envoi réel (garantie_a_renvoyer → retour_fournisseur).
app.post('/api/garantie/confirm-send', requireAuth, requireGarantieResponsible, async (req, res) => {
    try {
        const { unit_ids } = req.body;
        if (!Array.isArray(unit_ids) || !unit_ids.length) return res.status(400).json({ error: 'Aucune unité sélectionnée' });
        const who = req.session.user.full_name || req.session.user.username;
        // Motif / raison obligatoire avant l'envoi effectif au fournisseur.
        const units = [];
        for (const uid of unit_ids) {
            const u = await dbGet(`SELECT * FROM stock_units WHERE id = ? AND status = 'garantie_a_renvoyer'`, [uid]);
            if (u) units.push(u);
        }
        const missing = units.filter(u => !u.note || !String(u.note).trim());
        if (missing.length)
            return res.status(400).json({ error: `Motif / raison obligatoire manquant pour : ${missing.map(u => u.serial || ('#' + u.id)).join(', ')}` });
        const now = getDateTime(); let n = 0;
        await withTx(async () => {
            for (const u of units) {
                const up = await dbRun(`UPDATE stock_units SET status = 'retour_fournisseur', holder_user_id = NULL, updated_at = ? WHERE id = ? AND status = 'garantie_a_renvoyer'`, [now, u.id]);
                if (!up.changes) continue;   // déjà envoyée par ailleurs
                await recordMovement(u, 'retour_fournisseur', 'retour_fournisseur', req, { from: 'garantie_a_renvoyer', note: `Envoyé par ${who}` });
                await logGarantie(u, 'retour_fournisseur', 'fournisseur', req, { sender_name: who });
                n++;
            }
        });
        if (n) resolveNotifs('garantie:a_renvoyer');
        logActivity(req, 'garantie_confirm_send', 'garantie', null, { units: n, sender: who });
        broadcast('garantie:update', {}); broadcast('stock:update', {});
        res.json({ success: true, count: n });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Récapitulatif garantie par fournisseur (admin, stock, responsable).
app.get('/api/garantie/summary', requireAuth, requireGarantieViewer, async (req, res) => {
    try {
        const active = await dbAll(
            `SELECT u.supplier_id, s.name AS supplier_name, u.status, COUNT(*) AS cnt
             FROM stock_units u LEFT JOIN suppliers s ON s.id = u.supplier_id
             WHERE u.status IN ('garantie_fournisseur','garantie_a_renvoyer','retour_fournisseur','garantie_retournee')
             GROUP BY u.supplier_id, u.status`, []);
        const returned = await dbAll(
            `SELECT supplier_id, supplier_name, COUNT(*) AS cnt
             FROM garantie_actions WHERE garantie_type = 'fournisseur' AND action IN ('traite','remplace','rembourse')
             GROUP BY supplier_id`, []);
        const map = new Map();
        const get = (id, name) => {
            const k = id || 0;
            if (!map.has(k)) map.set(k, { supplier_id: id || null, supplier_name: name || 'Sans fournisseur', to_send: 0, a_renvoyer: 0, sent: 0, retournee: 0, returned: 0 });
            const o = map.get(k); if (name && o.supplier_name === 'Sans fournisseur') o.supplier_name = name; return o;
        };
        active.forEach(r => {
            const o = get(r.supplier_id, r.supplier_name);
            if (r.status === 'garantie_fournisseur') o.to_send += r.cnt;
            else if (r.status === 'garantie_a_renvoyer') o.a_renvoyer += r.cnt;
            else if (r.status === 'retour_fournisseur') o.sent += r.cnt;
            else if (r.status === 'garantie_retournee') o.retournee += r.cnt;
        });
        returned.forEach(r => { get(r.supplier_id, r.supplier_name).returned += r.cnt; });
        const suppliers = Array.from(map.values()).sort((a, b) => (a.supplier_name || '').localeCompare(b.supplier_name || ''));
        const totals = suppliers.reduce((t, s) => ({
            to_send: t.to_send + s.to_send, a_renvoyer: t.a_renvoyer + s.a_renvoyer,
            sent: t.sent + s.sent, retournee: t.retournee + s.retournee, returned: t.returned + s.returned
        }), { to_send: 0, a_renvoyer: 0, sent: 0, retournee: 0, returned: 0 });
        res.json({ totals, suppliers });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Réparation (garantie exceptionnelle → stock).
app.post('/api/garantie/repair', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const { unit_ids, technician_name } = req.body;
        if (!Array.isArray(unit_ids) || !unit_ids.length) return res.status(400).json({ error: 'Aucune unité sélectionnée' });
        if (!technician_name || !technician_name.trim()) return res.status(400).json({ error: 'Nom du technicien requis' });
        const now = getDateTime(); let n = 0;
        await withTx(async () => {
            for (const uid of unit_ids) {
                const u = await dbGet(`SELECT * FROM stock_units WHERE id = ? AND status = 'garantie_exceptionnel'`, [uid]);
                if (!u) continue;
                await dbRun(`UPDATE stock_units SET status = 'stock', location = 'depot', note = NULL, updated_at = ? WHERE id = ?`, [now, uid]);
                await recordMovement(u, 'stock', 'garantie_reparee', req, { from: 'garantie_exceptionnel', note: `Réparé par ${technician_name.trim()}` });
                await logGarantie(u, 'repare', 'exceptionnel', req, { technician_name: technician_name.trim() });
                n++;
            }
        });
        logActivity(req, 'garantie_repair', 'garantie', null, { units: n, technician: technician_name.trim() });
        broadcast('garantie:update', {}); broadcast('stock:update', {});
        res.json({ success: true, count: n });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Annulation d'un envoi en garantie sur ERREUR DE SAISIE : l'unité, encore au dépôt
// (garantie_fournisseur / garantie_exceptionnel), revient telle quelle au stock disponible.
// Impossible une fois confiée au responsable ou envoyée au fournisseur (autre statut).
app.post('/api/garantie/cancel-entry', requireAuth, requireRole('admin', 'gestion_stock'), async (req, res) => {
    try {
        const { unit_ids, reason } = req.body;
        if (!Array.isArray(unit_ids) || !unit_ids.length) return res.status(400).json({ error: 'Aucune unité sélectionnée' });
        const now = getDateTime(); let n = 0;
        await withTx(async () => {
            for (const uid of unit_ids) {
                const u = await dbGet(`SELECT * FROM stock_units WHERE id = ? AND status IN ('garantie_fournisseur','garantie_exceptionnel')`, [uid]);
                if (!u) continue;   // déjà envoyée / confiée / statut différent : on ignore
                const note = (reason || '').trim() || 'Annulation — erreur de saisie';
                await dbRun(`UPDATE stock_units SET status = 'stock', location = 'depot', holder_user_id = NULL, note = NULL, updated_at = ? WHERE id = ?`, [now, uid]);
                await recordMovement(u, 'stock', 'garantie_annulee', req, { from: u.status, note });
                await logGarantie(u, 'annule', garantieType(u.status), req, { reason: note });
                n++;
            }
        });
        if (!n) return res.status(400).json({ error: 'Aucune unité annulable (déjà envoyée au fournisseur ?)' });
        logActivity(req, 'garantie_cancel', 'garantie', null, { units: n, reason: (reason || '').trim() || null });
        broadcast('garantie:update', {}); broadcast('stock:update', {});
        res.json({ success: true, count: n });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Traitement d'un retour fournisseur (réintégré / remplacé / supprimé).
app.post('/api/garantie/treat', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const { unit_ids, action, reason } = req.body;
        // Si un responsable garantie est désigné, le stock ne traite plus les retours :
        // c'est le responsable qui déclare le retour, puis le stock re-réceptionne.
        const respId = await new Promise(r => garantieResponsibleId(r));
        if (respId && req.session.user.role !== 'admin')
            return res.status(403).json({ error: 'Le retour est géré par le responsable des garanties, puis re-réceptionné au stock.' });
        if (!['reintegrer', 'remplace', 'supprime', 'rembourse'].includes(action)) return res.status(400).json({ error: 'Action invalide' });
        // Le REMBOURSEMENT (le fournisseur rembourse la valeur d'achat au lieu de réparer) n'est
        // validable QUE par un administrateur.
        if (action === 'rembourse' && req.session.user.role !== 'admin')
            return res.status(403).json({ error: 'Seul un administrateur peut valider un remboursement fournisseur.' });
        if (!Array.isArray(unit_ids) || !unit_ids.length) return res.status(400).json({ error: 'Aucune unité sélectionnée' });
        if (action !== 'reintegrer' && (!reason || !reason.trim())) return res.status(400).json({ error: 'Motif obligatoire' });
        // Montant du remboursement : valeur saisie par l'admin, sinon prix d'achat enregistré du produit.
        const overrideAmount = action === 'rembourse' ? Math.max(0, parseFloat(req.body.amount) || 0) : 0;
        const now = getDateTime(); let n = 0, refundTotal = 0;
        await withTx(async () => {
            for (const uid of unit_ids) {
                const u = await dbGet(`SELECT * FROM stock_units WHERE id = ? AND status = 'retour_fournisseur'`, [uid]);
                if (!u) continue;
                if (action === 'reintegrer') {
                    await dbRun(`UPDATE stock_units SET status = 'stock', location = 'depot', note = NULL, updated_at = ? WHERE id = ?`, [now, uid]);
                    await recordMovement(u, 'stock', 'garantie_traitee', req, { from: 'retour_fournisseur', note: 'Traité — réintégré au stock' });
                    await logGarantie(u, 'traite', 'fournisseur', req, { reason: 'Réintégré au stock' });
                } else if (action === 'rembourse') {
                    let amount = overrideAmount;
                    if (!amount) { const pr = await dbGet('SELECT purchase_price FROM products WHERE id = ?', [u.product_id]); amount = Math.max(0, (pr && pr.purchase_price) || 0); }
                    refundTotal += amount;
                    const note = `Remboursé par le fournisseur : ${amount.toLocaleString('fr-FR')} Ar — ${reason.trim()}`;
                    await dbRun(`UPDATE stock_units SET status = 'retire', location = 'retire', holder_user_id = NULL, note = ?, updated_at = ? WHERE id = ?`, [note, now, uid]);
                    await recordMovement(u, 'retire', 'rembourse', req, { from: 'retour_fournisseur', note });
                    await logGarantie(u, 'rembourse', 'fournisseur', req, { reason: reason.trim(), amount });
                } else {
                    await dbRun(`UPDATE stock_units SET status = 'retire', location = 'retire', note = ?, updated_at = ? WHERE id = ?`, [reason.trim(), now, uid]);
                    await recordMovement(u, 'retire', action, req, { from: 'retour_fournisseur', note: reason.trim() });
                    await logGarantie(u, action, 'fournisseur', req, { reason: reason.trim() });
                }
                n++;
            }
        });
        logActivity(req, 'garantie_treat', 'garantie', null, { action, units: n, refund_total: refundTotal || undefined });
        broadcast('garantie:update', {}); broadcast('stock:update', {});
        // Rappel : un remplacement se saisit ensuite dans la Réception (nouvel appareil).
        res.json({ success: true, count: n, hint: action === 'remplace' ? 'Enregistrez le nouvel appareil dans la Réception.'
            : (action === 'rembourse' && refundTotal ? `Remboursement enregistré : ${refundTotal.toLocaleString('fr-FR')} Ar` : null) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Le fournisseur rembourse la valeur d'achat au lieu de renvoyer l'appareil. Déclarable par le
// RESPONSABLE des garanties OU l'admin, à DEUX stades : « en attente » (retour_fournisseur) ET
// « revenue à réceptionner » (garantie_retournee) — l'admin peut donc requalifier en remboursement
// même après que le responsable a déclaré le retour au stock. L'unité SORT de la garantie (statut
// « retiré / remboursé ») et reste visible ainsi dans l'historique. Config et n° de série inchangés.
app.post('/api/garantie/refund', requireAuth, requireGarantieResponsible, async (req, res) => {
    try {
        const { unit_ids, reason } = req.body;
        if (!Array.isArray(unit_ids) || !unit_ids.length) return res.status(400).json({ error: 'Aucune unité sélectionnée' });
        if (!reason || !reason.trim()) return res.status(400).json({ error: 'Motif obligatoire' });
        // Montant : seul l'admin peut le forcer ; sinon prix d'achat enregistré du produit.
        const isAdmin = req.session.user.role === 'admin';
        const overrideAmount = isAdmin ? Math.max(0, parseFloat(req.body.amount) || 0) : 0;
        const now = getDateTime(); let n = 0, refundTotal = 0;
        await withTx(async () => {
            for (const uid of unit_ids) {
                const u = await dbGet(`SELECT * FROM stock_units WHERE id = ? AND status IN ('retour_fournisseur','garantie_retournee')`, [uid]);
                if (!u) continue;
                let amount = overrideAmount;
                if (!amount) { const pr = await dbGet('SELECT purchase_price FROM products WHERE id = ?', [u.product_id]); amount = Math.max(0, (pr && pr.purchase_price) || 0); }
                refundTotal += amount;
                if (isAdmin) {
                    // Admin : validation directe (double rôle) → l'unité sort de la garantie.
                    const note = `Remboursé par le fournisseur : ${amount.toLocaleString('fr-FR')} Ar — ${reason.trim()}`;
                    await dbRun(`UPDATE stock_units SET status = 'retire', location = 'retire', holder_user_id = NULL, note = ?, updated_at = ? WHERE id = ?`, [note, now, uid]);
                    await recordMovement(u, 'retire', 'rembourse', req, { from: u.status, note });
                    await logGarantie(u, 'rembourse', 'fournisseur', req, { reason: reason.trim(), amount });
                } else {
                    // Responsable garantie : le remboursement doit être VALIDÉ par le stock avant de
                    // sortir de la garantie. On place l'unité « à valider » sans la retirer.
                    const note = `Remboursement à valider par le stock — proposé : ${amount.toLocaleString('fr-FR')} Ar — ${reason.trim()}`;
                    await dbRun(`UPDATE stock_units SET status = 'remboursement_attente', location = 'garantie', holder_user_id = NULL, note = ?, updated_at = ? WHERE id = ?`, [note, now, uid]);
                    await recordMovement(u, 'remboursement_attente', 'rembourse_demande', req, { from: u.status, note });
                    await logGarantie(u, 'rembourse_demande', 'fournisseur', req, { reason: reason.trim(), amount });
                }
                n++;
            }
        });
        if (!n) return res.status(400).json({ error: 'Aucune unité éligible (retour fournisseur ou revenue à réceptionner)' });
        // Plus aucune unité « revenue » en attente ? on résout la notification de réception au stock.
        if (!(await dbGet(`SELECT COUNT(*) n FROM stock_units WHERE status = 'garantie_retournee'`)).n) resolveNotifs('garantie:retournee');
        // Nouvelle demande de remboursement à valider → notifie le stock.
        if (!isAdmin) pushNotification({ target_role: 'gestion_stock', type: 'warn', persistent: true, ref: 'garantie:rembourse-attente',
            title: 'Remboursement à valider', message: `${n} remboursement(s) fournisseur à valider au stock`, link: '/garantie.html' });
        logActivity(req, isAdmin ? 'garantie_refund' : 'garantie_refund_request', 'garantie', null, { units: n, refund_total: refundTotal || undefined });
        broadcast('garantie:update', {}); broadcast('stock:update', {});
        res.json({ success: true, count: n, pending: !isAdmin,
            hint: isAdmin ? (refundTotal ? `Remboursement enregistré : ${refundTotal.toLocaleString('fr-FR')} Ar` : null)
                          : `${n} remboursement(s) envoyé(s) au stock pour validation` });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// VALIDATION du remboursement par le STOCK (2ᵉ signature) : le responsable a déclaré un
// remboursement fournisseur (« remboursement_attente ») ; le stock confirme qu'il a bien eu
// lieu → l'unité SORT de la garantie (retiré / remboursé). Admin ou gestion du stock.
app.post('/api/garantie/refund-validate', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const { unit_ids } = req.body;
        if (!Array.isArray(unit_ids) || !unit_ids.length) return res.status(400).json({ error: 'Aucune unité sélectionnée' });
        const overrideAmount = req.session.user.role === 'admin' ? Math.max(0, parseFloat(req.body.amount) || 0) : 0;
        const now = getDateTime(); let n = 0, refundTotal = 0;
        await withTx(async () => {
            for (const uid of unit_ids) {
                const u = await dbGet(`SELECT * FROM stock_units WHERE id = ? AND status = 'remboursement_attente'`, [uid]);
                if (!u) continue;
                // Reprend le montant et le motif de la demande initiale du responsable.
                const req0 = await dbGet(`SELECT reason, amount FROM garantie_actions WHERE unit_id = ? AND action = 'rembourse_demande' ORDER BY id DESC LIMIT 1`, [uid]);
                let amount = overrideAmount || (req0 && req0.amount) || 0;
                if (!amount) { const pr = await dbGet('SELECT purchase_price FROM products WHERE id = ?', [u.product_id]); amount = Math.max(0, (pr && pr.purchase_price) || 0); }
                const reason = (req0 && req0.reason) || 'Remboursement fournisseur';
                refundTotal += amount;
                const note = `Remboursé par le fournisseur (validé stock) : ${amount.toLocaleString('fr-FR')} Ar — ${reason}`;
                await dbRun(`UPDATE stock_units SET status = 'retire', location = 'retire', holder_user_id = NULL, note = ?, updated_at = ? WHERE id = ?`, [note, now, uid]);
                await recordMovement(u, 'retire', 'rembourse', req, { from: 'remboursement_attente', note });
                await logGarantie(u, 'rembourse', 'fournisseur', req, { reason, amount });
                n++;
            }
        });
        if (!n) return res.status(400).json({ error: 'Aucune unité à valider (remboursement en attente)' });
        // Plus aucun remboursement en attente ? on résout la notification du stock.
        if (!(await dbGet(`SELECT COUNT(*) n FROM stock_units WHERE status = 'remboursement_attente'`)).n) resolveNotifs('garantie:rembourse-attente');
        logActivity(req, 'garantie_refund_validate', 'garantie', null, { units: n, refund_total: refundTotal || undefined });
        broadcast('garantie:update', {}); broadcast('stock:update', {});
        res.json({ success: true, count: n, hint: refundTotal ? `Remboursement validé : ${refundTotal.toLocaleString('fr-FR')} Ar` : null });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// REFUS du remboursement par le stock : le remboursement n'a finalement pas eu lieu →
// l'unité repart « en attente » chez le fournisseur (retour_fournisseur). Admin ou stock.
app.post('/api/garantie/refund-reject', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const { unit_ids, reason } = req.body;
        if (!Array.isArray(unit_ids) || !unit_ids.length) return res.status(400).json({ error: 'Aucune unité sélectionnée' });
        if (!reason || !reason.trim()) return res.status(400).json({ error: 'Motif du refus obligatoire' });
        const now = getDateTime(); let n = 0;
        await withTx(async () => {
            for (const uid of unit_ids) {
                const u = await dbGet(`SELECT * FROM stock_units WHERE id = ? AND status = 'remboursement_attente'`, [uid]);
                if (!u) continue;
                const note = `Remboursement refusé par le stock — ${reason.trim()}`;
                await dbRun(`UPDATE stock_units SET status = 'retour_fournisseur', location = 'garantie', note = ?, updated_at = ? WHERE id = ?`, [note, now, uid]);
                await recordMovement(u, 'retour_fournisseur', 'rembourse_refuse', req, { from: 'remboursement_attente', note });
                await logGarantie(u, 'rembourse_refuse', 'fournisseur', req, { reason: reason.trim() });
                n++;
            }
        });
        if (!n) return res.status(400).json({ error: 'Aucune unité à refuser (remboursement en attente)' });
        if (!(await dbGet(`SELECT COUNT(*) n FROM stock_units WHERE status = 'remboursement_attente'`)).n) resolveNotifs('garantie:rembourse-attente');
        logActivity(req, 'garantie_refund_reject', 'garantie', null, { units: n });
        broadcast('garantie:update', {}); broadcast('stock:update', {});
        res.json({ success: true, count: n });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Ajouter / modifier le motif (panne) d'une unité déjà en garantie, sans changer
// son statut ni son ancienneté (updated_at inchangé). Admin, stock ou responsable.
app.post('/api/garantie/set-reason', requireAuth, requireGarantieViewer, async (req, res) => {
    try {
        const { unit_id, reason } = req.body;
        if (!unit_id) return res.status(400).json({ error: 'Unité manquante' });
        const note = (reason || '').trim();
        if (!note) return res.status(400).json({ error: 'Motif requis' });
        const u = await dbGet(
            `SELECT * FROM stock_units WHERE id = ? AND status IN ('garantie_fournisseur','garantie_exceptionnel','garantie_a_renvoyer','retour_fournisseur')`,
            [unit_id]);
        if (!u) return res.status(400).json({ error: 'Unité non modifiable (statut invalide)' });
        // updated_at volontairement inchangé : le temps passé en garantie ne doit pas être remis à zéro.
        await dbRun(`UPDATE stock_units SET note = ? WHERE id = ?`, [note, unit_id]);
        logActivity(req, 'garantie_set_reason', 'garantie', unit_id, { reason: note });
        broadcast('garantie:update', {}); broadcast('stock:update', {});
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/garantie/history', requireAuth, requireGarantieViewer, async (req, res) => {
    try {
        const { supplier_id, from, to } = req.query;
        const w = [], p = [];
        if (supplier_id) { w.push('ga.supplier_id = ?'); p.push(supplier_id); }
        if (from)        { w.push('date(ga.created_at) >= date(?)'); p.push(from); }
        if (to)          { w.push('date(ga.created_at) <= date(?)'); p.push(to); }
        const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
        const rows = await dbAll(
            `SELECT ga.*, p.name AS product_name, p.brand, p.model, p.category, p.condition,
                    p.cpu, p.ram, p.storage, p.storage_type, p.screen_size, p.gpu, p.is_accessory
             FROM garantie_actions ga
             LEFT JOIN stock_units u ON u.id = ga.unit_id
             LEFT JOIN products p ON p.id = u.product_id
             ${where} ORDER BY ga.created_at DESC LIMIT 500`, p);
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Liste : à imprimer (par défaut) ou historique filtré (période, recherche).
app.get('/api/atelier-labels', requireAuth, requireAtelier, async (req, res) => {
    try {
        const w = [], p = [];
        if (req.query.scope === 'history') {
            if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')) { w.push('substr(l.created_at, 1, 10) >= ?'); p.push(req.query.from); }
            if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.to || ''))   { w.push('substr(l.created_at, 1, 10) <= ?'); p.push(req.query.to); }
        } else w.push("l.status = 'a_imprimer'");
        const q = String(req.query.q || '').trim();
        if (q) {
            w.push(`(COALESCE(s.client_name, l.client_name) LIKE ? OR COALESCE(s.client_phone, l.client_phone) LIKE ? OR COALESCE(s.client_pc, l.client_pc) LIKE ?
                     OR l.services LIKE ? OR CAST(COALESCE(s.sale_number, l.sale_number) AS TEXT) = ?
                     OR (replace(COALESCE(s.sale_date, l.sale_date), '-', '') || '-' || substr('0000' || COALESCE(s.sale_number, l.sale_number), -4)) = ?)`);
            p.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, q, q);
        }
        const rows = await dbAll(`${ATELIER_SELECT} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY l.id DESC LIMIT 500`, p);
        res.json(withRef(rows));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.get('/api/atelier-labels/pending', requireAuth, requireAtelier, async (req, res) => {
    try {
        const r = await dbGet(`SELECT COUNT(*) AS n FROM atelier_labels WHERE status = 'a_imprimer'`);
        res.json({ count: r ? r.n : 0 });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Impression (page 60×40 mm, une étiquette par page) : ouvrir = imprimer → marquée imprimée,
// compteur d'impressions incrémenté (réimpression possible à tout moment depuis l'historique).
// Marque des étiquettes « imprimées » (compteur, date, auteur) et résout leurs notifications.
// Séparé de la page d'impression : une requête GET ne modifie jamais de données (préchargement,
// actualisation ou lien ouvert deux fois ne faussent plus le compteur).
app.post('/api/atelier-labels/mark-printed', requireAuth, requireAtelier, async (req, res) => {
    try {
        const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(x => parseInt(x, 10)).filter(Boolean).slice(0, 100);
        if (!ids.length) return res.status(400).json({ error: 'Aucune étiquette' });
        const now = getDateTime(), who = req.session.user.full_name || req.session.user.username;
        const rows = await dbAll(`SELECT id FROM atelier_labels WHERE id IN (${ids.map(() => '?').join(',')}) AND status <> 'annulee'`, ids);
        await withTx(async () => {
            for (const r of rows)
                await dbRun(`UPDATE atelier_labels SET status = 'imprimee', print_count = COALESCE(print_count, 0) + 1,
                             printed_at = COALESCE(printed_at, ?), printed_by_name = COALESCE(printed_by_name, ?) WHERE id = ?`, [now, who, r.id]);
        });
        rows.forEach(r => resolveNotifs(`atelier_label:${r.id}`));
        broadcast('atelier:update', {});
        res.json({ success: true, count: rows.length });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.get('/api/atelier-labels/print', requireAuth, requireAtelier, async (req, res) => {
    try {
        const ids = String(req.query.ids || '').split(',').map(x => parseInt(x, 10)).filter(Boolean).slice(0, 100);
        if (!ids.length) return res.status(400).send('Aucune étiquette');
        const rows = withRef(await dbAll(`${ATELIER_SELECT} WHERE l.id IN (${ids.map(() => '?').join(',')}) AND l.status <> 'annulee' ORDER BY l.id`, ids));
        if (!rows.length) return res.status(404).send('Étiquette introuvable ou annulée');
        // Lecture seule (GET) : le marquage « imprimée » se fait par POST /api/atelier-labels/mark-printed.

        const cc = await dbGet('SELECT name FROM company_config WHERE id = 1');
        const company = ((cc && cc.name) || '').trim();
        const dt = s => { const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s || '')); return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : dateFR(s); };
        const arL = v => Math.round(v || 0).toLocaleString('fr-FR').replace(/\s/g, ' ') + ' Ar';   // prix sur l'étiquette
        const pages = rows.map((r, i) => `
  <div class="lbl${(r.parts || []).length ? ' has-parts' : ''}">
    <div class="top"><div class="co">${htmlEsc(company || 'Atelier')}</div><div class="num">FACT. N° ${htmlEsc(r.sale_number)}</div></div>
    <div class="ref">Réf. ${htmlEsc(r.invoice_ref)} · ${htmlEsc(dt(r.sale_created_at))}</div>
    <div class="cli"><span class="cn">${htmlEsc(r.client_name || '')}</span>${r.client_phone ? `<span class="cp">${htmlEsc(r.client_phone)}</span>` : ''}</div>
    <div class="pc">
      <div class="pcn">${htmlEsc(r.client_pc || '')}</div>
      <div class="cfg"><span>RAM : <b>${htmlEsc(r.client_pc_ram || '—')}</b></span><span>Stockage : <b>${htmlEsc(r.client_pc_storage || '—')}</b></span></div>
      <div class="chg ${r.client_pc_charger === 'avec' ? 'on' : 'off'}">${r.client_pc_charger === 'avec' ? 'AVEC CHARG.' : 'SANS CHARG.'}</div>
      <div class="pst ${r.balance_due > 0 ? 'due' : 'ok'}">${arL(r.service_price)} · ${r.balance_due > 0 ? 'RESTE ' + arL(r.balance_due) : 'PAYÉ'}</div>
    </div>
    <div class="todo"><b>À faire :</b> ${htmlEsc(r.services || '')}</div>
    ${(r.parts || []).length ? `<div class="parts"><b>Achats :</b> ${r.parts.map(x => `${x.qty > 1 ? x.qty + '× ' : ''}${htmlEsc(x.name)} <b>${x.gift ? 'offert' : arL(x.price)}</b>`).join(' · ')}</div>` : ''}
    ${r.client_pc_note ? `<div class="note">${htmlEsc(r.client_pc_note)}</div>` : ''}
    <svg class="bc" id="bc${i}" data-code="${htmlEsc(r.invoice_ref)}"></svg>
  </div>`).join('');
        const html = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><title>Étiquettes atelier (${rows.length})</title>
<script src="/vendor/js/JsBarcode.all.min.js"><\/script>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  @page{size:60mm 40mm;margin:0;}
  html,body{width:60mm;}
  body{font-family:Arial,Helvetica,sans-serif;color:#000;background:#fff;}
  .lbl{width:60mm;height:40mm;padding:1.3mm 1.6mm 1mm;display:flex;flex-direction:column;overflow:hidden;line-height:1.15;page-break-after:always;break-after:page;}
  .lbl:last-child{page-break-after:auto;break-after:auto;}
  .top{display:flex;justify-content:space-between;align-items:baseline;gap:1mm;border-bottom:.3mm solid #000;padding-bottom:.4mm;}
  .co{font-size:7.5px;font-weight:700;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;}
  .num{font-size:11px;font-weight:800;white-space:nowrap;}
  .ref{font-size:7px;margin-top:.3mm;}
  .cli{font-size:9.5px;font-weight:700;margin-top:.4mm;display:flex;gap:1.5mm;white-space:nowrap;}
  .cli .cn{overflow:hidden;text-overflow:ellipsis;min-width:0;}
  .cli .cp{flex-shrink:0;}
  .pc{border-top:.2mm dotted #000;margin-top:.5mm;padding-top:.4mm;}
  .pcn{font-size:9px;font-weight:800;max-height:7.4mm;overflow:hidden;}
  .lbl.has-parts .pcn{max-height:3.8mm;white-space:nowrap;text-overflow:ellipsis;}
  .lbl.has-parts .todo{max-height:4.4mm;}
  .parts{font-size:6.8px;line-height:1.12;margin-top:.3mm;max-height:6.3mm;overflow:hidden;border-top:.2mm dotted #000;padding-top:.3mm;}
  .lbl.has-parts .bc{height:4.4mm;}
  .cfg{font-size:7.5px;display:flex;gap:2mm;margin-top:.2mm;white-space:nowrap;overflow:hidden;}
  .chg{display:inline-block;font-size:7.5px;font-weight:800;padding:.2mm 1.2mm;margin-top:.4mm;border:.3mm solid #000;}
  .chg.on{background:#000;color:#fff;}
  .pst{display:inline-block;font-size:7.5px;font-weight:800;padding:.2mm 1.2mm;margin:.4mm 0 0 1mm;border:.3mm solid #000;white-space:nowrap;}
  .pst.due{background:#000;color:#fff;}
  .todo{font-size:8px;margin-top:.5mm;max-height:6.6mm;overflow:hidden;}
  .note{font-size:7px;font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .bc{display:block;width:100%;height:5.2mm;margin-top:auto;}
</style></head>
<body>${pages}
<script>
  window.onload = function () {
    try { document.querySelectorAll('svg.bc').forEach(function (el) {
      JsBarcode(el, el.getAttribute('data-code'), { format: 'CODE128', displayValue: false, margin: 0, height: 40, width: 1.6 });
      el.setAttribute('preserveAspectRatio', 'none');
    }); } catch (e) {}
    setTimeout(function () { window.print(); }, 250);
  };
<\/script>
</body></html>`;
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    } catch (e) { res.status(500).send('Erreur étiquette : ' + e.message); }
});
};
