// ══════════════════════════════════════════════════════
//  ROUTES NOTIFICATIONS
// ══════════════════════════════════════════════════════
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { runChecks } = require('../utils/notificationChecker');

// ─── GET mes notifications ────────────────────────────
// Filtrées selon le rôle de l'utilisateur connecté
router.get('/', requireAuth, async (req, res) => {
  const { role, id: userId } = req.user;

  try {
    const result = await pool.query(`
      SELECT n.*, p.internal_sn, p.brand, p.model, p.type,
             p.current_stock, p.warranty_expiry, p.image_url
      FROM notifications n
      LEFT JOIN products p ON n.product_id = p.id
      WHERE n.target_roles::jsonb ? $1
        AND (n.snoozed_until IS NULL OR n.snoozed_until < NOW())
      ORDER BY
        CASE n.type
          WHEN 'warranty_expired'  THEN 1
          WHEN 'warranty_expiring' THEN 2
          WHEN 'stale_product'     THEN 3
          ELSE 4
        END,
        n.created_at DESC
    `, [role]);

    // Marquer lesquelles ont été lues par cet utilisateur
    const notifications = result.rows.map(n => ({
      ...n,
      is_read_by_me: n.read_by && n.read_by[String(userId)] ? true : false,
    }));

    res.json(notifications);
  } catch (err) {
    console.error('GET /notifications:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Compter les non-lues (pour le badge) ─────────────
router.get('/count', requireAuth, async (req, res) => {
  const { role, id: userId } = req.user;
  try {
    const result = await pool.query(`
      SELECT COUNT(*) as count
      FROM notifications
      WHERE target_roles::jsonb ? $1
        AND (snoozed_until IS NULL OR snoozed_until < NOW())
        AND NOT (read_by::jsonb ? $2)
    `, [role, String(userId)]);
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Marquer comme lu ─────────────────────────────────
router.post('/:id/read', requireAuth, async (req, res) => {
  const { id: userId } = req.user;
  try {
    await pool.query(`
      UPDATE notifications
      SET read_by = read_by || jsonb_build_object($1::text, NOW()::text)
      WHERE id = $2
    `, [String(userId), req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Marquer toutes comme lues ────────────────────────
router.post('/read-all', requireAuth, async (req, res) => {
  const { role, id: userId } = req.user;
  try {
    await pool.query(`
      UPDATE notifications
      SET read_by = read_by || jsonb_build_object($1::text, NOW()::text)
      WHERE target_roles::jsonb ? $2
        AND NOT (read_by::jsonb ? $1)
    `, [String(userId), role]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Snooze (ignorer pendant X heures) ───────────────
router.post('/:id/snooze', requireAuth, async (req, res) => {
  const { hours = 24 } = req.body;
  try {
    await pool.query(`
      UPDATE notifications
      SET snoozed_until = NOW() + ($1 || ' hours')::interval
      WHERE id = $2
    `, [String(hours), req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Supprimer une notification (admin) ───────────────
router.delete('/:id', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
  try {
    await pool.query('DELETE FROM notifications WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Forcer un refresh (admin) ────────────────────────
router.post('/refresh', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' });
  await runChecks();
  res.json({ success: true });
});

module.exports = router;
