// ============================================================
//  STOCKFLOW — Comptes, connexion, profil, utilisateurs, notifications, journal
//  Routes /api déplacées depuis server.js (code inchangé). Les helpers, la base et les
//  middlewares partagés arrivent par S (voir « Routes par domaine » en fin de server.js).
// ============================================================
module.exports = function register(app, S) {
    const { adminHasDefaultPassword, atelierResponsibleId, bcrypt, commandeResponsibleId, db, dbAll, decoyQuestion,
        FORGOT_DUMMY_HASH, FORGOT_FAIL, garantieResponsibleId, genRegCode, getDateTime, invalidateUserCache,
        logActivity, loginAttempts, loginRateLimit, normalizeCode, normalizeRole, notifTarget, parseExtraRoles,
        PASSWORD_MIN, pushNotification, pwdTag, registerFailedLogin, requireAdmin, requireAuth, requireRole,
        ROLE_HOME, ROLE_KEYS, ROLES, rolesOf, unlinkUpload, upload } = S;

app.post('/api/login', loginRateLimit, (req, res) => {
    const { username, password } = req.body;
    if (!username || !password)
        return res.status(400).json({ error: 'Identifiant et mot de passe requis' });
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err) return res.status(500).json({ error: 'Erreur serveur' });
        // Même coût bcrypt que l'identifiant existe ou non (pas de déduction par le temps de réponse).
        const ok = bcrypt.compareSync(String(password), user ? user.password : FORGOT_DUMMY_HASH) && !!user;
        if (!ok) {
            registerFailedLogin(req);
            db.run(`INSERT INTO activity_log (user_id, user_name, action, entity, entity_id, details, created_at, ip, path) VALUES (?,?,?,?,?,?,?,?,?)`,
                [user ? user.id : null, String(username).slice(0, 60), 'login_failed', 'user', user ? String(user.id) : null,
                 JSON.stringify({ known_user: !!user }), getDateTime(), String(req.headers['cf-connecting-ip'] || req.ip || '').replace(/^::ffff:/, ''), 'POST /api/login'], () => {});
            return res.status(401).json({ error: 'Identifiants incorrects' });
        }
        if (user.active === 0)
            return res.status(403).json({ error: 'Compte désactivé. Contactez l\'administrateur.' });
        loginAttempts.delete('user:' + String(username).trim().toLowerCase());
        // Nouvel identifiant de session à la connexion (pas de fixation de session).
        req.session.regenerate(rerr => {
            if (rerr) return res.status(500).json({ error: 'Erreur serveur' });
            req.session.user = { id: user.id, username: user.username, role: user.role, roles: rolesOf(user),
                                 full_name: user.full_name, profile_photo: user.profile_photo || null,
                                 home: ROLE_HOME[user.role] || '/index.html', pwd: pwdTag(user.password) };
            logActivity(req, 'login', 'user', user.id, null);
            garantieResponsibleId(async rid => {
                req.session.user.garantie_responsible = (rid === user.id);
                req.session.user.commande_responsible = ((await commandeResponsibleId()) === user.id);
                req.session.user.atelier_responsible = ((await atelierResponsibleId()) === user.id);
                req.session.user.full_ca = await S.hasFullCA(req.session.user);
                const { pwd, ...pub } = req.session.user;
                res.json({ success: true, user: pub });
            });
        });
    });
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ success: true })); });

app.get('/api/session', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Non connecté' });
    // Recalcule le drapeau responsable garantie (le réglage peut changer après connexion).
    garantieResponsibleId(async rid => {
        req.session.user.garantie_responsible = (rid === req.session.user.id);
        req.session.user.commande_responsible = ((await commandeResponsibleId()) === req.session.user.id);
        req.session.user.atelier_responsible = ((await atelierResponsibleId()) === req.session.user.id);
        // Avertissement (admins uniquement) : mot de passe initial du compte admin toujours actif.
        const default_admin_password = req.session.user.role === 'admin' ? await adminHasDefaultPassword().catch(() => false) : false;
        req.session.user.full_ca = await S.hasFullCA(req.session.user).catch(() => false);
        const { pwd, ...pub } = req.session.user;
        res.json({ user: { ...pub, default_admin_password } });
    });
});

// ============================================================
//  UTILISATEURS
// ============================================================
app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
    db.all(`SELECT id, username, role, extra_roles, full_name, phone, active, created_at, is_default
            FROM users ORDER BY is_default DESC, created_at DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json((rows || []).map(u => ({ ...u, extra_roles: parseExtraRoles(u.extra_roles, normalizeRole(u.role)) })));
    });
});

app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
    const { username, password, role, full_name, phone } = req.body;
    if (!username || !password)
        return res.status(400).json({ error: "Identifiant et mot de passe requis" });
    if (String(password).length < PASSWORD_MIN)
        return res.status(400).json({ error: `Mot de passe : ${PASSWORD_MIN} caractères minimum` });
    const hash = bcrypt.hashSync(password, 10);
    const primaryRole = normalizeRole(role);
    const extra = parseExtraRoles(req.body.extra_roles, primaryRole).join(',') || null;
    db.run(`INSERT INTO users (username, password, role, extra_roles, full_name, phone, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [username.trim(), hash, primaryRole, extra, full_name || null, phone || null, getDateTime()],
        function (err) {
            if (err) {
                if (err.message.includes('UNIQUE'))
                    return res.status(400).json({ error: "Cet identifiant existe déjà" });
                return res.status(500).json({ error: err.message });
            }
            logActivity(req, 'create', 'user', this.lastID, { username, role });
            res.json({ id: this.lastID, success: true });
        });
});

app.put('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
    const { username, password, role, full_name, phone, active } = req.body;
    db.get('SELECT is_default FROM users WHERE id = ?', [req.params.id], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
        if (user.is_default === 1 && role && role !== 'admin')
            return res.status(403).json({ error: "Impossible de changer le rôle de l'admin par défaut" });
        // Garde-fous anti-verrouillage : l'admin par défaut et son propre compte restent actifs.
        if (active === 0 && (user.is_default === 1 || +req.params.id === req.session.user.id))
            return res.status(403).json({ error: user.is_default === 1 ? "L'admin par défaut ne peut pas être désactivé" : 'Vous ne pouvez pas désactiver votre propre compte' });
        if (password && String(password).length < PASSWORD_MIN)
            return res.status(400).json({ error: `Mot de passe : ${PASSWORD_MIN} caractères minimum` });
        const primaryRole = user.is_default === 1 ? 'admin' : normalizeRole(role);
        const extra = user.is_default === 1 ? null : (parseExtraRoles(req.body.extra_roles, primaryRole).join(',') || null);
        const fields = ['username = ?', 'role = ?', 'extra_roles = ?', 'full_name = ?', 'phone = ?', 'active = ?'];
        const params = [username, primaryRole, extra,
                        full_name || null, phone || null, active === 0 ? 0 : 1];
        if (password) { fields.push('password = ?'); params.push(bcrypt.hashSync(password, 10)); }
        params.push(req.params.id);
        db.run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params, function (err) {
            if (err) return res.status(500).json({ error: err.message });
            invalidateUserCache(req.params.id);   // rôle / statut / mot de passe appliqués aux sessions ouvertes
            logActivity(req, 'update', 'user', req.params.id, null);
            res.json({ success: true });
        });
    });
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
    db.run('DELETE FROM users WHERE id = ? AND is_default = 0', [req.params.id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0)
            return res.status(403).json({ error: "Impossible de supprimer cet utilisateur" });
        invalidateUserCache(req.params.id);
        logActivity(req, 'delete', 'user', req.params.id, null);
        res.json({ success: true });
    });
});

// Profil courant (pour la fenêtre « Mon profil »).
app.get('/api/profile', requireAuth, (req, res) => {
    db.get('SELECT username, full_name, phone, role, extra_roles, profile_photo, security_question FROM users WHERE id = ?',
        [req.session.user.id], (err, u) => {
            if (err || !u) return res.status(500).json({ error: 'Erreur serveur' });
            res.json({
                username: u.username, full_name: u.full_name, phone: u.phone,
                role: u.role, roles: rolesOf(u), profile_photo: u.profile_photo || null,
                has_security_question: !!u.security_question, security_question: u.security_question || null
            });
        });
});

// Changer ses propres infos : nom, téléphone, mot de passe, question secrète.
app.put('/api/profile', requireAuth, (req, res) => {
    const { full_name, phone, current_password, new_password, security_question, security_answer } = req.body;
    db.get('SELECT * FROM users WHERE id = ?', [req.session.user.id], (err, user) => {
        if (err || !user) return res.status(500).json({ error: 'Erreur serveur' });

        const sets = ['full_name = ?', 'phone = ?'];
        const params = [full_name != null ? full_name : user.full_name, phone != null ? phone : user.phone];

        // Mot de passe : exige le mot de passe actuel correct.
        let newHash = null;
        if (new_password) {
            if (String(new_password).length < PASSWORD_MIN)
                return res.status(400).json({ error: `Le nouveau mot de passe doit contenir au moins ${PASSWORD_MIN} caractères` });
            if (!bcrypt.compareSync(current_password || '', user.password))
                return res.status(400).json({ error: 'Mot de passe actuel incorrect' });
            newHash = bcrypt.hashSync(new_password, 10);
            sets.push('password = ?'); params.push(newHash);
        }
        // Question secrète (récupération de mot de passe oublié) : réponse HACHÉE, insensible casse/espaces.
        if (security_question && security_answer) {
            if (String(security_answer).trim().length < 2)
                return res.status(400).json({ error: 'Réponse secrète trop courte' });
            sets.push('security_question = ?', 'security_answer = ?');
            params.push(String(security_question).trim(), bcrypt.hashSync(String(security_answer).trim().toLowerCase(), 10));
        }
        params.push(user.id);
        db.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params, err2 => {
            if (err2) return res.status(500).json({ error: err2.message });
            req.session.user.full_name = params[0];
            invalidateUserCache(user.id);
            // Nouveau mot de passe : cette session reste ouverte, les autres sessions du compte sont fermées.
            if (newHash) req.session.user.pwd = pwdTag(newHash);
            res.json({ success: true });
        });
    });
});

// Photo de profil : upload d'une image, remplace l'ancienne.
app.post('/api/profile/photo', requireAuth, upload.single('photo'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Aucune image reçue' });
    const rel = '/uploads/' + req.file.filename;
    db.get('SELECT profile_photo FROM users WHERE id = ?', [req.session.user.id], (e, old) => {
        db.run('UPDATE users SET profile_photo = ? WHERE id = ?', [rel, req.session.user.id], err => {
            if (err) return res.status(500).json({ error: err.message });
            // Supprime l'ancienne photo locale (si différente).
            if (old && old.profile_photo && old.profile_photo !== rel) unlinkUpload(old.profile_photo);
            req.session.user.profile_photo = rel;
            res.json({ success: true, photo: rel });
        });
    });
});

// ── Mot de passe oublié : récupération par QUESTION SECRÈTE (pas d'email/SMS). ──
// Étape 1 : renvoyer la question secrète du compte.
app.post('/api/forgot/question', loginRateLimit, (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Identifiant requis' });
    db.get('SELECT active, role, security_question FROM users WHERE username = ?', [String(username).trim()], (err, u) => {
        if (err) return res.status(500).json({ error: 'Erreur serveur' });
        // Compte inconnu, désactivé, sans question ou ADMINISTRATEUR : question LEURRE stable (dérivée de
        // l'identifiant), indiscernable d'une vraie. Un compte admin ne se récupère jamais par question
        // secrète (trop facile à deviner, page exposée sur internet) : un autre admin réinitialise.
        if (!u || u.active === 0 || !u.security_question || u.role === 'admin') return res.json({ question: decoyQuestion(username) });
        res.json({ question: u.security_question });
    });
});

// Étape 2 : vérifier la réponse et poser un nouveau mot de passe.
app.post('/api/forgot/reset', loginRateLimit, (req, res) => {
    const { username, answer, new_password } = req.body;
    if (!username || !answer || !new_password) return res.status(400).json({ error: 'Tous les champs sont requis' });
    if (String(new_password).length < PASSWORD_MIN) return res.status(400).json({ error: `Le mot de passe doit contenir au moins ${PASSWORD_MIN} caractères` });
    db.get('SELECT * FROM users WHERE username = ?', [String(username).trim()], (err, u) => {
        if (err) return res.status(500).json({ error: 'Erreur serveur' });
        // Même réponse, même échec compté et même coût bcrypt, que le compte existe ou non.
        // Comptes admin exclus (voir /api/forgot/question).
        const real = u && u.active !== 0 && u.role !== 'admin' && u.security_answer;
        const ok = bcrypt.compareSync(String(answer).trim().toLowerCase(), real ? u.security_answer : FORGOT_DUMMY_HASH) && real;
        if (!ok) {
            registerFailedLogin(req);
            return res.status(400).json({ error: FORGOT_FAIL });
        }
        db.run('UPDATE users SET password = ? WHERE id = ?', [bcrypt.hashSync(new_password, 10), u.id], e2 => {
            if (e2) return res.status(500).json({ error: e2.message });
            invalidateUserCache(u.id);   // les sessions ouvertes avec l'ancien mot de passe sont fermées
            logActivity(req, 'password_reset', 'user', u.id, null);
            pushNotification({ target_role: 'admin', type: 'warn', title: 'Mot de passe réinitialisé',
                message: `Le compte « ${u.username} » a réinitialisé son mot de passe par question secrète.`, link: '/users.html' });
            res.json({ success: true });
        });
    });
});

// Liste des codes (admin).
app.get('/api/registration-codes', requireAuth, requireAdmin, (req, res) => {
    db.all(`SELECT id, code, role, note, status, created_by, created_at, used_by, used_at
            FROM registration_codes ORDER BY (status='active') DESC, created_at DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Génération d'un code pour un rôle (admin).
app.post('/api/registration-codes', requireAuth, requireAdmin, (req, res) => {
    const { role, note } = req.body;
    if (!role || !ROLE_KEYS.includes(role))
        return res.status(400).json({ error: 'Rôle invalide' });
    const tryInsert = (attempt) => {
        if (attempt > 6) return res.status(500).json({ error: 'Impossible de générer un code, réessayez' });
        const code = genRegCode();
        db.run(`INSERT INTO registration_codes (code, role, note, status, created_by, created_at)
                VALUES (?, ?, ?, 'active', ?, ?)`,
            [code, role, (note || '').trim() || null, req.session.user.full_name || req.session.user.username, getDateTime()],
            function (err) {
                if (err) {
                    if (String(err.message).includes('UNIQUE')) return tryInsert(attempt + 1);
                    return res.status(500).json({ error: err.message });
                }
                logActivity(req, 'create', 'registration_code', this.lastID, { role });
                res.json({ id: this.lastID, code, role });
            });
    };
    tryInsert(0);
});

// Révocation d'un code encore actif (admin).
app.post('/api/registration-codes/:id/revoke', requireAuth, requireAdmin, (req, res) => {
    db.run(`UPDATE registration_codes SET status='revoked' WHERE id = ? AND status='active'`,
        [req.params.id], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(400).json({ error: "Ce code n'est plus actif" });
            logActivity(req, 'revoke', 'registration_code', req.params.id, null);
            res.json({ success: true });
        });
});

// Vérifie un code (public) — sert à afficher le rôle avant validation.
app.get('/api/register/check', loginRateLimit, (req, res) => {
    const code = normalizeCode(req.query.code);
    if (!code) return res.status(400).json({ error: 'Code requis' });
    db.get(`SELECT role, status FROM registration_codes WHERE REPLACE(code,'-','') = ?`, [code], (err, row) => {
        if (err) return res.status(500).json({ error: 'Erreur serveur' });
        if (!row || row.status !== 'active') return res.status(404).json({ error: 'Code invalide ou déjà utilisé' });
        res.json({ valid: true, role: row.role, role_label: ROLES[row.role] || row.role });
    });
});

// Création de compte via code à usage unique (public).
app.post('/api/register', loginRateLimit, (req, res) => {
    const { username, password, full_name } = req.body;
    const code = normalizeCode(req.body.code);
    if (!code || !username || !password || !full_name)
        return res.status(400).json({ error: 'Tous les champs sont requis (nom, identifiant, mot de passe, code)' });
    if (String(password).length < PASSWORD_MIN)
        return res.status(400).json({ error: `Le mot de passe doit contenir au moins ${PASSWORD_MIN} caractères` });

    db.get(`SELECT * FROM registration_codes WHERE REPLACE(code,'-','') = ?`, [code], (err, rc) => {
        if (err) return res.status(500).json({ error: 'Erreur serveur' });
        if (!rc || rc.status !== 'active') {
            registerFailedLogin(req);
            return res.status(400).json({ error: 'Code invalide ou déjà utilisé' });
        }
        const hash = bcrypt.hashSync(password, 10);
        db.run(`INSERT INTO users (username, password, role, full_name, created_at)
                VALUES (?, ?, ?, ?, ?)`,
            [String(username).trim(), hash, rc.role, String(full_name).trim(), getDateTime()],
            function (uerr) {
                if (uerr) {
                    if (String(uerr.message).includes('UNIQUE'))
                        return res.status(400).json({ error: 'Cet identifiant existe déjà, choisissez-en un autre' });
                    return res.status(500).json({ error: uerr.message });
                }
                const userId = this.lastID;
                // Consomme le code (usage unique) — garde 'active' dans la clause pour éviter les courses.
                db.run(`UPDATE registration_codes SET status='used', used_by = ?, used_at = ?
                        WHERE id = ? AND status='active'`,
                    [String(username).trim(), getDateTime(), rc.id], function (cerr) {
                        if (cerr || this.changes === 0) {
                            // Code déjà consommé entre-temps : annule le compte créé.
                            db.run('DELETE FROM users WHERE id = ?', [userId]);
                            return res.status(400).json({ error: 'Code déjà utilisé, création annulée' });
                        }
                        pushNotification({
                            target_role: 'admin', type: 'info', persistent: true,
                            title: 'Nouveau compte créé',
                            message: `${String(full_name).trim()} (${ROLES[rc.role] || rc.role}) s'est inscrit via un code.`,
                            link: '/users.html'
                        });
                        res.json({ success: true, role: rc.role });
                    });
            });
    });
});
app.get('/api/notifications', requireAuth, (req, res) => {
    const t = notifTarget(req.session.user);
    db.all(`SELECT * FROM notifications
            WHERE ${t.sql} AND resolved = 0
            ORDER BY created_at DESC LIMIT 100`,
        t.params, (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json((rows || []).map(r => { let data = null; try { data = r.data ? JSON.parse(r.data) : null; } catch (e) {} return { ...r, data }; }));
        });
});
app.post('/api/notifications/:id/read', requireAuth, (req, res) => {
    const t = notifTarget(req.session.user);
    db.run(`UPDATE notifications SET is_read = 1 WHERE id = ? AND ${t.sql}`,
        [req.params.id, ...t.params], err => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
});
app.post('/api/notifications/read-link', requireAuth, (req, res) => {
    const t = notifTarget(req.session.user);
    const link = (req.body && req.body.link || '').trim();
    if (!link) return res.json({ success: true });
    db.run(`UPDATE notifications SET is_read = 1 WHERE ${t.sql} AND is_read = 0 AND link = ?`,
        [...t.params, link], err => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
});
app.post('/api/notifications/read-all', requireAuth, (req, res) => {
    const t = notifTarget(req.session.user);
    db.run(`UPDATE notifications SET is_read = 1 WHERE ${t.sql} AND is_read = 0`,
        t.params, err => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        });
});

// ============================================================
//  JOURNAL D'ACTIVITÉ (admin)
// ============================================================
// Filtres : from / to (AAAA-MM-JJ), user_id (ou « none » = sans compte), action (liste séparée par des
// virgules), q (texte libre), before (id : page suivante). Plus récent d'abord + récap par utilisateur.
app.get('/api/activity', requireAuth, requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
        const d = v => /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null;
        const w = [], p = [];
        if (d(req.query.from)) { w.push('l.created_at >= ?'); p.push(d(req.query.from)); }
        if (d(req.query.to))   { w.push('l.created_at < ?');  p.push(d(req.query.to) + ' 99'); }
        const period = [...w], periodP = [...p];
        if (req.query.user_id === 'none') w.push('l.user_id IS NULL');
        else if (parseInt(req.query.user_id, 10)) { w.push('l.user_id = ?'); p.push(parseInt(req.query.user_id, 10)); }
        const acts = String(req.query.action || '').split(',').map(s => s.trim()).filter(s => /^[a-z_]+$/.test(s));
        if (acts.length) { w.push(`l.action IN (${acts.map(() => '?').join(',')})`); p.push(...acts); }
        if (req.query.q) {
            const l = `%${String(req.query.q).slice(0, 80)}%`;
            w.push('(l.user_name LIKE ? OR l.action LIKE ? OR l.entity LIKE ? OR l.entity_id LIKE ? OR l.details LIKE ? OR l.path LIKE ? OR l.ip LIKE ?)');
            p.push(l, l, l, l, l, l, l);
        }
        const before = parseInt(req.query.before, 10);
        const where = a => a.length ? 'WHERE ' + a.join(' AND ') : '';
        const rows = await dbAll(`SELECT l.* FROM activity_log l ${where(before ? [...w, 'l.id < ?'] : w)} ORDER BY l.id DESC LIMIT ?`,
            [...p, ...(before ? [before] : []), limit]);
        let total = null, users = null;
        if (!before) {
            total = (await dbAll(`SELECT COUNT(*) AS n FROM activity_log l ${where(w)}`, p))[0].n;
            users = await dbAll(`SELECT l.user_id, COALESCE(u.full_name, u.username, l.user_name) AS name, u.role, u.active,
                    COUNT(*) AS n, MAX(l.created_at) AS last_at, SUM(l.action = 'login') AS logins, SUM(l.action = 'login_failed') AS failed
                FROM activity_log l LEFT JOIN users u ON u.id = l.user_id ${where(period)}
                GROUP BY l.user_id, CASE WHEN l.user_id IS NULL THEN l.user_name END ORDER BY n DESC`, periodP);
        }
        res.json({ total, users, rows: rows.map(r => { let details = null; try { details = r.details ? JSON.parse(r.details) : null; } catch (e) {} return { ...r, details }; }) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
//  UTILISATEURS PAR RÔLE (assignation technicien / commercial)
// ============================================================
app.get('/api/users/role/:role', requireAuth, requireRole('gestion_stock', 'coordinateur'), async (req, res) => {
    const role = req.params.role;
    if (!['technicien', 'commercial', 'commercial_ligne'].includes(role))
        return res.status(400).json({ error: 'Rôle non listable' });
    try {
        const rows = await dbAll('SELECT id, full_name, username, phone FROM users WHERE role = ? AND active = 1 ORDER BY full_name', [role]);
        res.json(rows.map(u => ({ id: u.id, name: u.full_name || u.username, phone: u.phone })));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
};
