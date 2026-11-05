// ============================================================
//  STOCKFLOW — Trésorerie, finances, tableaux de bord, supervision
//  Routes /api déplacées depuis server.js (code inchangé). Les helpers, la base et les
//  middlewares partagés arrivent par S (voir « Routes par domaine » en fin de server.js).
// ============================================================
module.exports = function register(app, S) {
    const { addDays, caBetween, canSeeCA, caTodayOnly, caSeries, dbAll, dbGet, dbRun, displaySerial, getDate, getDateTime,
        getSettingsAsync, hasRole, logActivity, MM_METHODS, ORDI_EST_PROFIT, PAY_METHODS, requireAdmin, requireAuth,
        pushNotification, requireRole, treasuryEditGuard, treasurySummary, walletBalances } = S;

app.get('/api/treasury/summary', requireAuth, requireRole('caisse'), async (req, res) => {
    try { res.json(await treasurySummary(req.query.date || getDate())); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/treasury/movements', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const date = req.query.date || getDate();
        const rows = await dbAll(`SELECT * FROM cash_movements WHERE sale_date = ? ORDER BY created_at DESC`, [date]);
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/treasury/movement', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const { kind, amount, reason, method } = req.body;
        if (!['fond', 'depense'].includes(kind)) return res.status(400).json({ error: 'Type invalide' });
        const amt = Math.abs(parseFloat(amount) || 0);
        if (!amt) return res.status(400).json({ error: 'Montant invalide' });
        if (!reason || !reason.trim()) return res.status(400).json({ error: 'Motif obligatoire' });
        const date = req.query.date || getDate();
        const today = getDate();
        const isAdmin = req.session.user.role === 'admin';
        // La caisse ne peut agir QUE sur la journée en cours et non clôturée.
        // Toute journée passée (ou clôturée) est réservée à l'administrateur.
        if (!isAdmin) {
            if (date !== today)
                return res.status(403).json({ error: 'Journée passée : seul un administrateur peut saisir un mouvement de caisse antérieur.' });
            const closed = await dbGet('SELECT id FROM cash_closures WHERE sale_date = ?', [today]);
            if (closed)
                return res.status(403).json({ error: 'Caisse clôturée : seul un administrateur peut modifier.' });
        }
        const signed = kind === 'depense' ? -amt : amt;
        await dbRun(`INSERT INTO cash_movements (sale_date, kind, amount, method, reason, user_id, user_name, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [date, kind, signed, PAY_METHODS.includes(method) ? method : 'especes', reason.trim(), req.session.user.id, req.session.user.full_name || req.session.user.username, getDateTime()]);
        logActivity(req, 'treasury', 'cash_movement', null, { kind, amount: amt });
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Modifier un mouvement de caisse (fond de caisse / dépense uniquement). Les remboursements
// sont liés à une vente/retour et ne se modifient pas ici.
app.put('/api/treasury/movement/:id', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const mv = await dbGet('SELECT * FROM cash_movements WHERE id = ?', [req.params.id]);
        if (!mv) return res.status(404).json({ error: 'Mouvement introuvable' });
        if (!['fond', 'depense'].includes(mv.kind))
            return res.status(400).json({ error: 'Seuls le fond de caisse et les dépenses sont modifiables.' });
        const guard = await treasuryEditGuard(req, mv.sale_date);
        if (guard) return res.status(guard.code).json({ error: guard.error });
        const amt = Math.abs(parseFloat(req.body.amount) || 0);
        if (!amt) return res.status(400).json({ error: 'Montant invalide' });
        const reason = (req.body.reason || '').trim();
        if (!reason) return res.status(400).json({ error: 'Motif obligatoire' });
        const method = PAY_METHODS.includes(req.body.method) ? req.body.method : (mv.method || 'especes');
        const signed = mv.kind === 'depense' ? -amt : amt;
        await dbRun('UPDATE cash_movements SET amount = ?, reason = ?, method = ? WHERE id = ?', [signed, reason, method, mv.id]);
        logActivity(req, 'treasury', 'cash_movement', mv.id, { edit: mv.kind, amount: amt });
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Supprimer un mouvement de caisse (fond de caisse / dépense uniquement).
app.delete('/api/treasury/movement/:id', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const mv = await dbGet('SELECT * FROM cash_movements WHERE id = ?', [req.params.id]);
        if (!mv) return res.status(404).json({ error: 'Mouvement introuvable' });
        if (!['fond', 'depense'].includes(mv.kind))
            return res.status(400).json({ error: 'Seuls le fond de caisse et les dépenses sont supprimables.' });
        const guard = await treasuryEditGuard(req, mv.sale_date);
        if (guard) return res.status(guard.code).json({ error: guard.error });
        await dbRun('DELETE FROM cash_movements WHERE id = ?', [mv.id]);
        logActivity(req, 'treasury', 'cash_movement', mv.id, { delete: mv.kind, amount: Math.abs(mv.amount) });
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/treasury/close', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const date = req.query.date || getDate();
        if (req.session.user.role !== 'admin' && date !== getDate())
            return res.status(403).json({ error: 'Seul un administrateur peut clôturer une journée passée.' });
        const s = await treasurySummary(date);
        // Espèces comptées dans le tiroir : obligatoires ; l'écart (compté − attendu) est conservé.
        const counted = req.body && req.body.counted_cash !== undefined && req.body.counted_cash !== '' ? Math.round(parseFloat(req.body.counted_cash)) : NaN;
        if (!isFinite(counted) || counted < 0) return res.status(400).json({ error: 'Saisissez le montant des espèces comptées dans le tiroir.' });
        const ecart = counted - Math.round(s.expected_cash);
        if (ecart !== 0 && !(req.body.note || '').trim()) return res.status(400).json({ error: `Écart de ${ecart.toLocaleString('fr-FR')} Ar : expliquez-le dans la note avant de clôturer.` });
        // Blocage : livraisons impayées en cours non reportées.
        if (s.pending_deliveries.length)
            return res.status(409).json({ error: 'Des livraisons impayées sont en cours. Reportez-les (relance) ou finalisez-les avant de clôturer.', pending: s.pending_deliveries });
        await dbRun(`INSERT INTO cash_closures (sale_date, cash_sales, mm_sales, cheque_sales, virement_sales, fond_total, expenses_total, refunds_total, expected_cash, sales_count, note, closed_by, closed_at, counted_cash, ecart)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                     ON CONFLICT(sale_date) DO UPDATE SET cash_sales=excluded.cash_sales, mm_sales=excluded.mm_sales, cheque_sales=excluded.cheque_sales, virement_sales=excluded.virement_sales,
                       fond_total=excluded.fond_total, expenses_total=excluded.expenses_total, refunds_total=excluded.refunds_total,
                       expected_cash=excluded.expected_cash, sales_count=excluded.sales_count, note=excluded.note, closed_by=excluded.closed_by, closed_at=excluded.closed_at,
                       counted_cash=excluded.counted_cash, ecart=excluded.ecart`,
            [date, s.cash_sales, s.mm_sales, s.cheque_sales, s.virement_sales, s.fond_total, s.expenses_total, s.refunds_total, s.expected_cash, s.sales_count,
             (req.body && req.body.note) || null, req.session.user.full_name || req.session.user.username, getDateTime(), counted, ecart]);
        logActivity(req, 'treasury_close', 'cash_closure', date, { expected: s.expected_cash, counted, ecart });
        if (ecart !== 0) pushNotification({ target_role: 'admin', type: 'warn', title: `Écart de caisse ${ecart > 0 ? '+' : ''}${ecart.toLocaleString('fr-FR')} Ar`,
            message: `Clôture du ${date} par ${req.session.user.full_name || req.session.user.username} : attendu ${Math.round(s.expected_cash).toLocaleString('fr-FR')} Ar, compté ${counted.toLocaleString('fr-FR')} Ar. Note : ${(req.body.note || '').trim()}`, link: '/treasury.html' });
        res.json({ success: true, summary: s });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Évolution des ventes (graphique).
app.get('/api/treasury/chart', requireAuth, requireRole('caisse'), async (req, res) => {
    try {
        const range = req.query.range || '7d';
        const days = { '7d': 7, '1m': 30, '3m': 90, '6m': 180 }[range];
        // CA encaissé (base encaissement) par jour / par mois + nombre de ventes.
        res.json(await caSeries(days ? addDays(getDate(), -(days - 1)) : null, !days));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ============================================================
//  TABLEAU DE BORD ADMIN
// ============================================================
app.get('/api/dashboard/stats', requireAuth, requireAdmin, async (req, res) => {
    try {
        const today = getDate(), month = today.slice(0, 7);
        const one = async (sql, p = []) => (await dbGet(sql, p)) || {};
        // CA = argent réellement encaissé (ventes, avances, livraisons, reste atelier) − remboursements.
        const caGlobal = await caBetween(null, null);
        const caMonth  = await caBetween(month + '-01', month + '-31');
        const caToday  = await caBetween(today, today);
        const salesToday = (await one(`SELECT COUNT(*) AS v FROM sales WHERE status='completed' AND sale_date=?`, [today])).v || 0;
        const unitsReceivedToday = (await one(`SELECT SUM(total_units) AS v FROM receptions WHERE date(created_at)=date(?)`, [today])).v || 0;
        const delPending    = (await one(`SELECT COUNT(*) AS v FROM deliveries WHERE status IN ('nouvelle','assignee','acceptee')`)).v || 0;
        const delInProgress = (await one(`SELECT COUNT(*) AS v FROM deliveries WHERE status IN ('facturee','en_livraison')`)).v || 0;
        const delDoneToday  = (await one(`SELECT COUNT(*) AS v FROM deliveries WHERE status='livree' AND delivery_date=?`, [today])).v || 0;
        const summary = await treasurySummary(today);
        // Soldes mobile money / chèque (admin) : paiements mixtes et avances compris (cf. walletBalances).
        const wb = await walletBalances();
        const balances = {};
        for (const op of [...MM_METHODS, 'cheque']) balances[op] = wb[op].balance;
        const stockUnits = (await one(`SELECT COUNT(*) AS v FROM stock_units WHERE status IN ('stock','presentoir','reserve')`)).v || 0;
        const garantiePending = (await one(`SELECT COUNT(*) AS v FROM stock_units WHERE status IN ('garantie_fournisseur','garantie_exceptionnel','retour_fournisseur')`)).v || 0;

        // ---- KPI essentiels supplémentaires (vision dirigeant) ----
        // MARGE (bénéfice) = prix vendu − coût (coût réel si prix d'achat connu, sinon estimé, même
        // règle que la page Profits via unitCost). Base revenu = somme des lignes (comme Profits).
        const COST = `CASE WHEN p.purchase_price > 0 THEN p.purchase_price WHEN p.is_accessory = 1 THEN si.unit_price*0.6 ELSE MAX(0, si.unit_price - ${ORDI_EST_PROFIT}) END`;
        const marge = async (cond, pr) => (await one(
            `SELECT COALESCE(SUM(si.unit_price - (${COST})),0) AS profit, COALESCE(SUM(si.unit_price),0) AS rev
             FROM sale_items si JOIN sales s ON s.id = si.sale_id LEFT JOIN products p ON p.id = si.product_id
             WHERE s.status='completed' AND si.returned=0 ${cond}`, pr));
        const mToday = await marge('AND s.sale_date=?', [today]);
        const mMonth = await marge('AND substr(s.sale_date,1,7)=?', [month]);
        // À ENCAISSER = argent en attente d'encaissement : boutique reçue (unités encore détenues)
        // + livraisons à encaisser à la livraison.
        const aEncBoutique = (await one(`SELECT COALESCE(SUM(i.unit_price),0) AS v FROM consignments c
            JOIN consignment_items i ON i.consignment_id = c.id JOIN stock_units u ON u.id = i.unit_id
            WHERE c.status='received' AND u.status='consignation'`)).v || 0;
        const aEncLiv = await one(`SELECT COALESCE(SUM(total),0) AS v, COUNT(*) AS n FROM deliveries WHERE status='en_livraison' AND payment_status='a_livraison'`);
        // RÉAPPRO : produits (hors services) en rupture (0 en stock) ou faibles (≤ seuil).
        const settings = await getSettingsAsync();
        const th = Math.max(0, parseInt(settings.low_stock_threshold, 10) || 2);
        const low = await one(`SELECT COALESCE(SUM(CASE WHEN av=0 THEN 1 ELSE 0 END),0) AS rupture,
                                      COALESCE(SUM(CASE WHEN av>0 AND av<=? THEN 1 ELSE 0 END),0) AS faible
            FROM (SELECT (SELECT COUNT(*) FROM stock_units su WHERE su.product_id=p.id AND su.status='stock') AS av
                  FROM products p WHERE COALESCE(p.is_service,0)=0 AND EXISTS(SELECT 1 FROM stock_units su WHERE su.product_id=p.id))`, [th]);
        // ENGAGEMENTS clients actifs (réservations + acomptes) à honorer.
        const engagements = ((await one(`SELECT COUNT(*) AS v FROM reservations WHERE status='active'`)).v || 0)
                          + ((await one(`SELECT COUNT(*) AS v FROM layaways WHERE status='active'`)).v || 0);
        // VALEUR du stock disponible (au prix de vente) = capital immobilisé au dépôt.
        const stockValue = (await one(`SELECT COALESCE(SUM(sale_price),0) AS v FROM stock_units WHERE status='stock'`)).v || 0;
        // RETOURS à réceptionner (physique en attente côté stock).
        const returnsPending = (await one(`SELECT COUNT(*) AS v FROM stock_units WHERE status='retour_attente'`)).v || 0;

        const lim = await caTodayOnly(req.session.user);   // admin sans accès complet : ni marge ni CA passé
        res.json({
            ca_global: lim ? null : caGlobal, ca_month: lim ? null : caMonth, ca_today: caToday, sales_today: salesToday,
            marge_today: lim ? null : mToday.profit, marge_month: lim ? null : mMonth.profit,
            margin_today: lim ? null : (mToday.rev ? mToday.profit / mToday.rev : 0),
            margin_month: lim ? null : (mMonth.rev ? mMonth.profit / mMonth.rev : 0), full_ca: !lim,
            units_received_today: unitsReceivedToday,
            deliveries: { pending: delPending, in_progress: delInProgress, done_today: delDoneToday },
            expected_cash: summary.expected_cash, mm_balances: balances,
            a_encaisser: aEncBoutique + (aEncLiv.v || 0), a_encaisser_count: aEncLiv.n || 0,
            low_stock: { rupture: low.rupture, faible: low.faible },
            engagements, returns_pending: returnsPending,
            stock_units: stockUnits, stock_value: stockValue, garantie_pending: garantiePending
        });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/dashboard/top-products', requireAuth, requireAdmin, async (req, res) => {
    try {
        const range = req.query.range || 'month';
        const today = getDate();
        let cond = '', p = [];
        if (range === 'day')       { cond = 'AND s.sale_date = ?'; p = [today]; }
        else if (range === 'week') { cond = 'AND s.sale_date >= ?'; p = [addDays(today, -6)]; }
        else if (range === 'month'){ cond = 'AND substr(s.sale_date,1,7) = ?'; p = [today.slice(0, 7)]; }
        const rows = await dbAll(
            `SELECT si.product_id, COALESCE(p2.name, si.product_name) AS product_name,
                    p2.brand, p2.model, COUNT(*) AS qty, SUM(si.unit_price) AS revenue
             FROM sale_items si JOIN sales s ON s.id = si.sale_id LEFT JOIN products p2 ON p2.id = si.product_id
             WHERE s.status='completed' AND si.returned=0 ${cond}
             GROUP BY si.product_id ORDER BY qty DESC, revenue DESC LIMIT 10`, p);
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/dashboard/performance', requireAuth, requireAdmin, async (req, res) => {
    try {
        const range = req.query.range || 'month';
        const today = getDate();
        let cond = '', p = [];
        if (range === 'day')       { cond = 'AND sale_date = ?'; p = [today]; }
        else if (range === 'week') { cond = 'AND sale_date >= ?'; p = [addDays(today, -6)]; }
        else if (range === 'month'){ cond = 'AND substr(sale_date,1,7) = ?'; p = [today.slice(0, 7)]; }
        const commercials = await dbAll(
            `SELECT commercial_id AS id, commercial_name AS name, COUNT(*) AS sales, SUM(total) AS revenue
             FROM sales WHERE status='completed' AND commercial_id IS NOT NULL ${cond}
             GROUP BY commercial_id ORDER BY revenue DESC LIMIT 10`, p);
        let dCond = '', dp = [];
        if (range === 'day')       { dCond = 'AND delivery_date = ?'; dp = [today]; }
        else if (range === 'week') { dCond = 'AND delivery_date >= ?'; dp = [addDays(today, -6)]; }
        else if (range === 'month'){ dCond = 'AND substr(delivery_date,1,7) = ?'; dp = [today.slice(0, 7)]; }
        const livreurs = await dbAll(
            `SELECT livreur_name AS name,
                SUM(CASE WHEN status='livree' THEN 1 ELSE 0 END) AS done,
                SUM(CASE WHEN status IN ('annulee','retournee') THEN 1 ELSE 0 END) AS cancelled
             FROM deliveries WHERE livreur_name IS NOT NULL AND TRIM(livreur_name) <> '' ${dCond}
             GROUP BY livreur_name ORDER BY done DESC LIMIT 10`, dp);
        const actions = await dbAll(
            `SELECT user_id AS id, user_name AS name, COUNT(*) AS actions FROM activity_log
             WHERE user_id IS NOT NULL GROUP BY user_id ORDER BY actions DESC LIMIT 10`);
        res.json({ commercials, livreurs, actions });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ============================================================
//  SUPERVISION ADMIN — actions en attente / validations en cours
// ============================================================
app.get('/api/supervision', requireAuth, requireAdmin, async (req, res) => {
    try {
        const deliveries = await dbAll(
            `SELECT d.*, (SELECT GROUP_CONCAT(di.quantity || '× ' || di.product_name, ' · ') FROM delivery_items di WHERE di.delivery_id = d.id) AS items_summary
             FROM deliveries d WHERE d.status NOT IN ('livree','retournee') ORDER BY COALESCE(d.status_at, 0) ASC`);
        const installations = await dbAll(`SELECT * FROM installation_tasks WHERE status != 'clos' ORDER BY created_at ASC`);
        const returns_pending = (await dbGet(`SELECT COUNT(*) v FROM stock_units WHERE status = 'retour_attente'`)).v || 0;
        const garantie_pending = (await dbGet(`SELECT COUNT(*) v FROM stock_units WHERE status IN ('garantie_fournisseur','garantie_exceptionnel','retour_fournisseur')`)).v || 0;
        const reservations = await dbAll(
            `SELECT r.*, (SELECT SUM(unit_price) FROM reservation_items i WHERE i.reservation_id = r.id) AS total,
                (SELECT GROUP_CONCAT(product_name, ' · ') FROM reservation_items i WHERE i.reservation_id = r.id) AS items_summary
             FROM reservations r WHERE r.status = 'active' ORDER BY r.created_at ASC`);
        res.json({ now: Date.now(), deliveries, installations, returns_pending, garantie_pending, reservations });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ============================================================
//  STATISTIQUES PERSONNELLES (tableau de bord par utilisateur)
// ============================================================
// Récap stock d'un jour (défaut aujourd'hui), séparé Ordinateurs / Accessoires (dashboard gestion_stock).
// Définitions demandées :
//   - entrée  = unités NOUVELLES (réception ou réappro) créées ce jour.
//   - sortie  = unités DÉCLARÉES vendues & payées ce jour (ventes 'completed').
//   - reste   = stock détenu courant (dépôt + boutique) = cumul entrées − sorties.
// Bloc boutique : entrée boutique (sorties dépôt→boutique), sortie boutique (boutique→vendu), reste boutique.
app.get('/api/dashboard/stock-recap', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : getDate();
        const DEPOT = "('stock','preparation','presentoir','reserve','consignation')";
        const cnt = async (sql, p) => ((await dbGet(sql, p)) || {}).n || 0;

        const grp = async (isAcc) => ({
            reste:  await cnt(`SELECT COUNT(*) AS n FROM stock_units u JOIN products p ON p.id = u.product_id
                               WHERE u.status IN ${DEPOT} AND p.is_accessory = ?`, [isAcc]),
            // Entrée = unités créées ce jour (réception/réappro) + garanties revenues re-réceptionnées
            // au stock ce jour (garantie_traitee → stock : retour fournisseur réintégré OU re-réceptionné).
            entree: (await cnt(`SELECT COUNT(*) AS n FROM stock_units u JOIN products p ON p.id = u.product_id
                               WHERE date(u.created_at) = date(?) AND p.is_accessory = ?`, [date, isAcc]))
                  + (await cnt(`SELECT COUNT(*) AS n FROM unit_movements m JOIN stock_units u ON u.id = m.unit_id JOIN products p ON p.id = u.product_id
                               WHERE m.action = 'garantie_traitee' AND m.to_status = 'stock' AND date(m.created_at) = date(?) AND p.is_accessory = ?`, [date, isAcc])),
            sortie: await cnt(`SELECT COUNT(*) AS n FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN products p ON p.id = si.product_id
                               WHERE s.status = 'completed' AND s.sale_date = ? AND p.is_accessory = ?`, [date, isAcc])
        });
        // Bloc boutique.
        const boutique = async (isAcc) => ({
            reste:  await cnt(`SELECT COUNT(*) AS n FROM stock_units u JOIN products p ON p.id = u.product_id
                               WHERE u.status = 'consignation' AND p.is_accessory = ?`, [isAcc]),
            entree: await cnt(`SELECT COUNT(*) AS n FROM unit_movements m JOIN stock_units u ON u.id = m.unit_id JOIN products p ON p.id = u.product_id
                               WHERE m.action = 'sortie_boutique' AND date(m.created_at) = date(?) AND p.is_accessory = ?`, [date, isAcc]),
            sortie: await cnt(`SELECT COUNT(*) AS n FROM unit_movements m JOIN stock_units u ON u.id = m.unit_id JOIN products p ON p.id = u.product_id
                               WHERE m.from_status = 'consignation' AND m.to_status = 'vendu' AND date(m.created_at) = date(?) AND p.is_accessory = ?`, [date, isAcc])
        });

        // Récap par commercial responsable (boutique).
        const merge = (rows, field) => rows.forEach(r => {
            const k = r.name || '—'; const t = per[k] || (per[k] = { name: k, pc_reste: 0, acc_reste: 0, pc_entree: 0, acc_entree: 0, pc_sortie: 0, acc_sortie: 0 });
            t[(r.acc ? 'acc_' : 'pc_') + field] += r.n;
        });
        const per = {};
        merge(await dbAll(`SELECT us.full_name AS name, p.is_accessory AS acc, COUNT(*) AS n
                           FROM stock_units u JOIN users us ON us.id = u.holder_user_id JOIN products p ON p.id = u.product_id
                           WHERE u.status = 'consignation' GROUP BY us.id, p.is_accessory`), 'reste');
        merge(await dbAll(`SELECT c.commercial_name AS name, p.is_accessory AS acc, COUNT(*) AS n
                           FROM consignments c JOIN consignment_items i ON i.consignment_id = c.id JOIN products p ON p.id = i.product_id
                           WHERE date(c.created_at) = date(?) GROUP BY c.commercial_name, p.is_accessory`, [date]), 'entree');
        merge(await dbAll(`SELECT c.commercial_name AS name, p.is_accessory AS acc, COUNT(*) AS n
                           FROM unit_movements m JOIN consignment_items i ON i.unit_id = m.unit_id JOIN consignments c ON c.id = i.consignment_id
                                JOIN stock_units u ON u.id = m.unit_id JOIN products p ON p.id = u.product_id
                           WHERE m.from_status = 'consignation' AND m.to_status = 'vendu' AND date(m.created_at) = date(?)
                           GROUP BY c.commercial_name, p.is_accessory`, [date]), 'sortie');

        res.json({
            date,
            ordinateurs: await grp(0), accessoires: await grp(1),
            boutique_ordinateurs: await boutique(0), boutique_accessoires: await boutique(1),
            par_commercial: Object.values(per).sort((a, b) => (b.pc_reste + b.acc_reste) - (a.pc_reste + a.acc_reste))
        });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Drill-down : liste des unités derrière une case du récap boutique (clic).
app.get('/api/dashboard/boutique-units', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : getDate();
        const metric = req.query.metric;   // entree | sortie | reste
        const accFilter = req.query.is_accessory === '0' || req.query.is_accessory === '1' ? ` AND p.is_accessory = ${req.query.is_accessory}` : '';
        const comFilter = req.query.commercial ? ' AND c.commercial_name = ?' : '';
        const comP = req.query.commercial ? [req.query.commercial] : [];
        let rows = [];
        if (metric === 'reste') {
            rows = await dbAll(
                `SELECT u.serial, p.id AS product_id, p.name AS product_name, p.brand, p.model, p.is_accessory, p.category, u.sale_price AS unit_price, us.full_name AS commercial
                 FROM stock_units u JOIN products p ON p.id = u.product_id LEFT JOIN users us ON us.id = u.holder_user_id
                 WHERE u.status = 'consignation'${accFilter}${req.query.commercial ? ' AND us.full_name = ?' : ''} ORDER BY p.is_accessory, p.name`,
                req.query.commercial ? [req.query.commercial] : []);
        } else if (metric === 'entree') {
            rows = await dbAll(
                `SELECT i.serial, i.product_id, i.product_name, p.brand, p.model, p.is_accessory, p.category, i.unit_price, c.commercial_name AS commercial
                 FROM consignments c JOIN consignment_items i ON i.consignment_id = c.id JOIN products p ON p.id = i.product_id
                 WHERE date(c.created_at) = date(?)${accFilter}${comFilter} ORDER BY p.is_accessory, p.name`, [date, ...comP]);
        } else { // sortie
            rows = await dbAll(
                `SELECT i.serial, i.product_id, i.product_name, p.brand, p.model, p.is_accessory, p.category, i.unit_price, c.commercial_name AS commercial
                 FROM unit_movements m JOIN consignment_items i ON i.unit_id = m.unit_id JOIN consignments c ON c.id = i.consignment_id JOIN products p ON p.id = i.product_id
                 WHERE m.from_status = 'consignation' AND m.to_status = 'vendu' AND date(m.created_at) = date(?)${accFilter}${comFilter}
                 ORDER BY p.is_accessory, p.name`, [date, ...comP]);
        }
        res.json(rows.map(r => ({ ...r, serial: displaySerial(r) })));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Récap stock GÉNÉRAL (ordinateurs) sur une période choisie : stock ancien (ouverture = stock de la
// veille de `from`), entrées (réceptions), sorties (vendu / garantie / retiré) et stock disponible actuel.
app.get('/api/dashboard/stock-recap-general', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')   ? req.query.to   : getDate();
        const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : to;
        const IN_STOCK = "('stock','preparation','presentoir','reserve','consignation')";
        const cnt = async (sql, p) => ((await dbGet(sql, p)) || {}).n || 0;

        // Stock ancien = ordinateurs EN STOCK à la fin de la veille de `from` (ouverture de période).
        // Statut historique = to_status du dernier mouvement daté avant le début de `from`.
        const ancien = await cnt(
            `SELECT COUNT(*) AS n FROM stock_units u JOIN products p ON p.id = u.product_id
             WHERE p.is_accessory = 0 AND datetime(u.created_at) < datetime(? || ' 00:00:00')
               AND (SELECT m.to_status FROM unit_movements m
                    WHERE m.unit_id = u.id AND datetime(m.created_at) < datetime(? || ' 00:00:00')
                    ORDER BY m.id DESC LIMIT 1) IN ${IN_STOCK}`, [from, from]);

        // Entrées = ordinateurs ENTRANT au stock sur la période = franchissements de frontière vers
        // « en stock » : réceptions (action='reception') + retours/garanties revenus au stock.
        const entree = await cnt(
            `SELECT COUNT(*) AS n FROM unit_movements m
             JOIN stock_units u ON u.id = m.unit_id JOIN products p ON p.id = u.product_id
             WHERE p.is_accessory = 0 AND date(m.created_at) BETWEEN date(?) AND date(?)
               AND m.to_status IN ${IN_STOCK} AND (m.from_status NOT IN ${IN_STOCK} OR m.action = 'reception')`, [from, to]);

        // Sorties = ordinateurs QUITTANT vraiment le stock sur la période = franchissements « en stock » → hors stock.
        // NB : boutique (consignation) et installation (preparation) restent DANS le stock (statuts inclus
        // dans IN_STOCK) → ce ne sont PAS des sorties. Seuls vendu, garantie et livraison en sortent.
        const sortieOut = (toClause, params) => cnt(
            `SELECT COUNT(*) AS n FROM unit_movements m
             JOIN stock_units u ON u.id = m.unit_id JOIN products p ON p.id = u.product_id
             WHERE p.is_accessory = 0 AND date(m.created_at) BETWEEN date(?) AND date(?)
               AND m.from_status IN ${IN_STOCK} AND m.to_status NOT IN ${IN_STOCK}${toClause}`, params);
        const sortie_total     = await sortieOut('', [from, to]);
        const sortie_vendu     = await sortieOut(` AND m.to_status = 'vendu'`, [from, to]);
        const sortie_garantie  = await sortieOut(` AND m.to_status IN ('garantie_fournisseur','garantie_a_renvoyer','retour_fournisseur','garantie_exceptionnel')`, [from, to]);
        const sortie_livraison = await sortieOut(` AND m.to_status = 'livraison'`, [from, to]);
        const sortie_autre     = Math.max(0, sortie_total - sortie_vendu - sortie_garantie - sortie_livraison);   // retiré, acompte…

        // Stock disponible = ordinateurs actuellement en stock (dépôt + boutique).
        const disponible = await cnt(
            `SELECT COUNT(*) AS n FROM stock_units u JOIN products p ON p.id = u.product_id
             WHERE p.is_accessory = 0 AND u.status IN ${IN_STOCK}`, []);

        res.json({ from, to, ordinateurs: { ancien, entree, sortie_vendu, sortie_garantie, sortie_livraison, sortie_autre, sortie_total, disponible } });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Drill-down du récap stock général : liste des mouvements (unités) derrière une case
// « Entrées » ou « Sorties » sur la période — avec provenance/destination, l'auteur et
// le détail (le `note` du mouvement porte déjà « livreur X », le client, le n° de bon…).
app.get('/api/dashboard/stock-general-units', requireAuth, requireRole('gestion_stock'), async (req, res) => {
    try {
        const to   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')   ? req.query.to   : getDate();
        const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : to;
        const IN_STOCK = "('stock','preparation','presentoir','reserve','consignation')";
        const GAR = "('garantie_fournisseur','garantie_a_renvoyer','retour_fournisseur','garantie_exceptionnel')";
        let cond;
        switch (req.query.metric) {
            case 'entree':    cond = `m.to_status IN ${IN_STOCK} AND (m.from_status NOT IN ${IN_STOCK} OR m.action = 'reception')`; break;
            case 'vendu':     cond = `m.from_status IN ${IN_STOCK} AND m.to_status = 'vendu'`; break;
            case 'garantie':  cond = `m.from_status IN ${IN_STOCK} AND m.to_status IN ${GAR}`; break;
            case 'livraison': cond = `m.from_status IN ${IN_STOCK} AND m.to_status = 'livraison'`; break;
            case 'autre':     cond = `m.from_status IN ${IN_STOCK} AND m.to_status NOT IN ${IN_STOCK} AND m.to_status <> 'vendu' AND m.to_status <> 'livraison' AND m.to_status NOT IN ${GAR}`; break;
            default:          cond = `m.from_status IN ${IN_STOCK} AND m.to_status NOT IN ${IN_STOCK}`;   // sortie totale
        }
        const rows = await dbAll(
            `SELECT m.created_at, m.serial, m.from_status, m.to_status, m.action, m.user_name, m.note,
                    u.sale_price AS unit_price, p.name AS product_name, p.brand, p.model
             FROM unit_movements m JOIN stock_units u ON u.id = m.unit_id JOIN products p ON p.id = u.product_id
             WHERE p.is_accessory = 0 AND date(m.created_at) BETWEEN date(?) AND date(?) AND ${cond}
             ORDER BY m.created_at DESC LIMIT 1000`, [from, to]);
        res.json(rows);
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/dashboard/my-chart', requireAuth, async (req, res) => {
    try {
        const me = req.session.user;
        const range = req.query.range || '7d';
        const days = { '7d': 7, '1m': 30, '3m': 90, '6m': 180 }[range];
        const from = days ? addDays(getDate(), -(days - 1)) : null;
        // dateExpr : expression SQL de la date (AAAA-MM-JJ) ; groupe par jour, ou par mois en « global ».
        const series = async (dateExpr, aExpr, bExpr, fromWhere, params = []) => {
            const g = days ? dateExpr : `substr(${dateExpr},1,7)`;
            return dbAll(`SELECT ${g} AS d, ${aExpr} AS ca, ${bExpr} AS n ${fromWhere}${days ? ` AND ${dateExpr} >= ?` : ''} GROUP BY ${g} ORDER BY d`,
                days ? [...params, from] : params);
        };
        const charts = [];
        const add = (title, icon, a, b, moneyA, rows, unitA = '') => charts.push({ title, icon, a, b, moneyA, unitA, rows });
        if (me.role === 'caisse') {
            add('Ventes du magasin', 'fa-chart-area', "Chiffre d'affaires", 'Ventes', true, await caSeries(from, !days));
        }
        if (me.role === 'gestion_stock') {
            add('Réceptions', 'fa-truck-ramp-box', 'Unités reçues', 'Réceptions', false,
                await series('substr(created_at,1,10)', 'SUM(total_units)', 'COUNT(*)', `FROM receptions WHERE 1=1`), 'unités');
        }
        // Sans accès au CA : courbe = nombre (ventes / commandes / livraisons), barres = articles.
        const ca = canSeeCA(me);
        const saleArticles = `SUM((SELECT COUNT(*) FROM sale_items si WHERE si.sale_id = sales.id AND COALESCE(si.returned,0) = 0 AND COALESCE(si.is_service,0) = 0))`;
        const delArticles = `SUM((SELECT COALESCE(SUM(di.quantity),0) FROM delivery_items di WHERE di.delivery_id = deliveries.id))`;
        const moneyOrCount = async (title, icon, moneyLabel, countLabel, dateExpr, from, params = [], articles) => ca
            ? add(title, icon, moneyLabel, countLabel, true, await series(dateExpr, 'SUM(total)', 'COUNT(*)', from, params))
            : add(title, icon, countLabel, 'Articles', false, await series(dateExpr, 'COUNT(*)', articles, from, params));
        if (hasRole(me, 'commercial'))
            await moneyOrCount('Mes ventes boutique', 'fa-chart-area', "Mon chiffre d'affaires", 'Ventes', 'sale_date',
                `FROM sales WHERE status='completed' AND commercial_id=?`, [me.id], saleArticles);
        if (hasRole(me, 'commercial_ligne'))
            await moneyOrCount('Mes commandes en ligne', 'fa-globe', 'Montant commandé', 'Commandes', 'substr(created_at,1,10)',
                `FROM deliveries WHERE status NOT IN ('annulee','retournee') AND commercial_id=?`, [me.id], delArticles);
        if (me.role === 'coordinateur')
            await moneyOrCount('Livraisons livrées', 'fa-truck-fast', 'Montant livré', 'Livrées', 'delivery_date',
                `FROM deliveries WHERE status='livree'`, [], delArticles);
        if (me.role === 'livreur')
            await moneyOrCount('Mes livraisons', 'fa-motorcycle', 'Montant livré', 'Livrées', 'delivery_date',
                `FROM deliveries WHERE status='livree' AND livreur_id=?`, [me.id], delArticles);
        if (me.role === 'technicien') {
            add('Unités préparées', 'fa-screwdriver-wrench', 'Unités terminées', 'Problèmes', false,
                await series('substr(i.decided_at,1,10)', "SUM(CASE WHEN i.result='termine' THEN 1 ELSE 0 END)", "SUM(CASE WHEN i.result='probleme' THEN 1 ELSE 0 END)",
                    `FROM install_items i JOIN installation_tasks t ON t.id=i.task_id WHERE i.decided_at IS NOT NULL AND t.technician_id=?`, [me.id]), 'unités');
        }
        res.json({ charts });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Tableau de bord des rôles : meilleurs produits (caisse = magasin ; commercial = ses ventes ; en ligne = ses commandes) ──
app.get('/api/dashboard/my-top', requireAuth, async (req, res) => {
    try {
        const me = req.session.user;
        const range = req.query.range || 'month';
        const today = getDate();
        const period = (col) => range === 'day' ? [`AND ${col} = ?`, [today]]
            : range === 'week' ? [`AND ${col} >= ?`, [addDays(today, -6)]]
            : range === 'month' ? [`AND substr(${col},1,7) = ?`, [today.slice(0, 7)]] : ['', []];
        let rows = [];
        if (me.role === 'caisse' || hasRole(me, 'commercial')) {
            const [cond, p] = period('s.sale_date');
            const mine = me.role === 'caisse' ? '' : 'AND s.commercial_id = ?';
            rows = await dbAll(
                `SELECT si.product_id, COALESCE(p2.name, si.product_name) AS product_name, p2.brand, p2.model,
                        COUNT(*) AS qty, SUM(si.unit_price) AS revenue
                 FROM sale_items si JOIN sales s ON s.id = si.sale_id LEFT JOIN products p2 ON p2.id = si.product_id
                 WHERE s.status='completed' AND si.returned=0 ${mine} ${cond}
                 GROUP BY si.product_id ORDER BY qty DESC, revenue DESC LIMIT 8`, me.role === 'caisse' ? p : [me.id, ...p]);
        } else if (hasRole(me, 'commercial_ligne')) {
            const [cond, p] = period('substr(d.created_at,1,10)');
            rows = await dbAll(
                `SELECT di.product_id, COALESCE(p2.name, di.product_name) AS product_name, p2.brand, p2.model,
                        SUM(di.quantity) AS qty, SUM(di.unit_price * di.quantity) AS revenue
                 FROM delivery_items di JOIN deliveries d ON d.id = di.delivery_id LEFT JOIN products p2 ON p2.id = di.product_id
                 WHERE d.status NOT IN ('annulee','retournee') AND d.commercial_id = ? ${cond}
                 GROUP BY di.product_id ORDER BY qty DESC, revenue DESC LIMIT 8`, [me.id, ...p]);
        } else return res.json({ available: false, rows: [] });
        res.json({ available: true, rows: canSeeCA(me) ? rows : rows.map(({ revenue, ...r }) => r) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/dashboard/my-stats', requireAuth, async (req, res) => {
    try {
        const me = req.session.user;
        const today = getDate(), month = today.slice(0, 7);
        const n = async (sql, p = []) => ((await dbGet(sql, p)) || {}).v || 0;
        const card = (label, value, icon, link, opts = {}) => ({ label, value, icon, link, money: !!opts.money, tone: opts.tone || 'normal' });
        let cards = [], title = 'Votre activité';

        if (me.role === 'gestion_stock' || me.role === 'admin') {
            title = 'Votre activité — stock';
            cards = [
                card('Mes réceptions du jour', await n(`SELECT COUNT(*) v FROM receptions WHERE user_id=? AND date(created_at)=date(?)`, [me.id, today]), 'fa-truck-ramp-box', '/reception.html'),
                card('Unités reçues (mois)', await n(`SELECT SUM(total_units) v FROM receptions WHERE user_id=? AND substr(created_at,1,7)=?`, [me.id, month]), 'fa-boxes-packing', '/reception.html'),
                card('En préparation (envoyées)', await n(`SELECT COUNT(*) v FROM install_items i JOIN installation_tasks t ON t.id=i.task_id WHERE t.created_by_id=? AND t.status IN ('envoye','en_cours')`, [me.id]), 'fa-screwdriver-wrench', '/installation.html', { tone: 'warn' }),
                card('Retours à valider', await n(`SELECT COUNT(*) v FROM installation_tasks WHERE status='termine'`), 'fa-clipboard-check', '/installation.html', { tone: 'warn' }),
                card('Garanties à traiter', await n(`SELECT COUNT(*) v FROM stock_units WHERE status IN ('garantie_fournisseur','garantie_exceptionnel','retour_fournisseur')`), 'fa-shield-halved', '/garantie.html'),
                card('Livraisons à préparer', await n(`SELECT COUNT(*) v FROM deliveries WHERE status='facturee'`), 'fa-box-open', '/deliveries.html', { tone: 'warn' }),
                card('Stock disponible', await n(`SELECT COUNT(*) v FROM stock_units WHERE status='stock'`), 'fa-boxes-stacked', '/stock.html', { tone: 'accent' })
            ];
        } else if (me.role === 'caisse') {
            title = 'Votre activité — caisse';
            const s = await treasurySummary(today);
            cards = [
                card('Mes ventes du jour', await n(`SELECT COUNT(*) v FROM sales WHERE cashier_id=? AND status='completed' AND sale_date=?`, [me.id, today]), 'fa-receipt', '/sales.html'),
                card("Chiffre d'affaires du jour",
                    await caBetween(today, today),
                    'fa-coins', '/sales.html', { money: true, tone: 'accent' }),
                card('Encaisse attendue', s.expected_cash, 'fa-wallet', '/treasury.html', { money: true, tone: 'accent' }),
                card('Livraisons à facturer', await n(`SELECT COUNT(*) v FROM deliveries WHERE status='acceptee'`), 'fa-file-invoice', '/deliveries.html', { tone: 'warn' }),
                card('Livraisons en cours', await n(`SELECT COUNT(*) v FROM deliveries WHERE status='en_livraison'`), 'fa-truck-fast', '/deliveries.html')
            ];
        } else if (me.role === 'technicien') {
            title = 'Vos tâches — technicien';
            cards = [
                card('À réceptionner', await n(`SELECT COUNT(*) v FROM installation_tasks WHERE technician_id=? AND status='envoye'`, [me.id]), 'fa-inbox', '/installation.html', { tone: 'warn' }),
                card('En cours', await n(`SELECT COUNT(*) v FROM installation_tasks WHERE technician_id=? AND status='en_cours'`, [me.id]), 'fa-screwdriver-wrench', '/installation.html', { tone: 'accent' }),
                card('En attente de validation', await n(`SELECT COUNT(*) v FROM installation_tasks WHERE technician_id=? AND status='termine'`, [me.id]), 'fa-hourglass-half', '/installation.html'),
                card('Unités préparées (mois)', await n(`SELECT COUNT(*) v FROM install_items i JOIN installation_tasks t ON t.id=i.task_id WHERE t.technician_id=? AND i.result='termine' AND substr(t.created_at,1,7)=?`, [me.id, month]), 'fa-circle-check', '/installation.html')
            ];
        } else if (hasRole(me, 'commercial') || hasRole(me, 'commercial_ligne')) {
            // Un compte peut cumuler commercial boutique ET commercial en ligne : on additionne les deux jeux.
            const parts = [];
            if (hasRole(me, 'commercial')) {
                parts.push('ventes boutique');
                cards.push(
                    card('Mes ventes du jour', await n(`SELECT COUNT(*) v FROM sales WHERE commercial_id=? AND status='completed' AND sale_date=?`, [me.id, today]), 'fa-receipt', '/sales.html'),
                    card('Mes ventes du mois', await n(`SELECT COUNT(*) v FROM sales WHERE commercial_id=? AND status='completed' AND substr(sale_date,1,7)=?`, [me.id, month]), 'fa-calendar-check', '/sales.html', { tone: 'accent' }),
                    card('Mon chiffre d\'affaires du mois', await n(`SELECT SUM(total) v FROM sales WHERE commercial_id=? AND status='completed' AND substr(sale_date,1,7)=?`, [me.id, month]), 'fa-coins', '/sales.html', { money: true, tone: 'accent' })
                );
            }
            if (hasRole(me, 'commercial_ligne')) {
                parts.push('commandes en ligne');
                cards.push(
                    card('Commandes du jour', await n(`SELECT COUNT(*) v FROM deliveries WHERE commercial_id=? AND delivery_date=?`, [me.id, today]), 'fa-cart-plus', '/online.html'),
                    card('En cours', await n(`SELECT COUNT(*) v FROM deliveries WHERE commercial_id=? AND status NOT IN ('livree','retournee','annulee')`, [me.id]), 'fa-truck-fast', '/livraisons.html', { tone: 'warn' }),
                    card('Livrées (mois)', await n(`SELECT COUNT(*) v FROM deliveries WHERE commercial_id=? AND status='livree' AND substr(delivery_date,1,7)=?`, [me.id, month]), 'fa-circle-check', '/livraisons.html', { tone: 'accent' }),
                    card('Annulées (mois)', await n(`SELECT COUNT(*) v FROM deliveries WHERE commercial_id=? AND status IN ('annulee','retournee') AND substr(delivery_date,1,7)=?`, [me.id, month]), 'fa-ban', '/livraisons.html')
                );
            }
            title = 'Votre activité — ' + parts.join(' & ');
        } else if (me.role === 'coordinateur') {
            title = 'Coordination des livraisons';
            cards = [
                card('À assigner', await n(`SELECT COUNT(*) v FROM deliveries WHERE status='nouvelle'`), 'fa-inbox', '/coordination.html', { tone: 'warn' }),
                card('Assignées / en cours', await n(`SELECT COUNT(*) v FROM deliveries WHERE status IN ('assignee','acceptee','facturee','en_livraison')`), 'fa-route', '/coordination.html', { tone: 'accent' }),
                card('Livrées ce jour', await n(`SELECT COUNT(*) v FROM deliveries WHERE status='livree' AND delivery_date=?`, [today]), 'fa-circle-check', '/coordination.html')
            ];
        }
        res.json({ title, cards: canSeeCA(me) ? cards : cards.filter(c => !c.money) });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ============================================================
//  MOBILE MONEY / CHÈQUE (admin)
// ============================================================
app.get('/api/finance/mobile-money', requireAuth, requireAdmin, async (req, res) => {
    try {
        const balances = await walletBalances();
        const history = await dbAll(`SELECT * FROM admin_finance ORDER BY created_at DESC LIMIT 100`);
        res.json({ balances, history });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/finance/retrait', requireAuth, requireAdmin, async (req, res) => {
    try {
        const { operator, amount, note } = req.body;
        if (![...MM_METHODS, 'cheque'].includes(operator)) return res.status(400).json({ error: 'Opérateur invalide' });
        const amt = Math.abs(parseFloat(amount) || 0);
        if (!amt) return res.status(400).json({ error: 'Montant invalide' });
        await dbRun(`INSERT INTO admin_finance (operator, amount, note, user_id, user_name, created_at) VALUES (?,?,?,?,?,?)`,
            [operator, amt, note || null, req.session.user.id, req.session.user.full_name || req.session.user.username, getDateTime()]);
        logActivity(req, 'retrait', 'finance', null, { operator, amount: amt });
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
};
