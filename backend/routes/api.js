const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { requireAuth, requireRole, SECRET } = require('../middleware/auth');
const { generateStockReportHTML, generateMovementReportHTML, generateBonReceptionHTML } = require('../utils/pdfGenerator');

// ── Middleware spécial pour les rapports PDF ouverts dans le navigateur ──
// Le token peut venir soit du header Authorization soit du query param ?token=
function requireAuthReport(req, res, next) {
  const headerToken = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;
  const queryToken = req.query.token;
  const token = headerToken || queryToken;
  if (!token) return res.status(401).send('<h2 style="font-family:sans-serif;color:#f05060">Non authentifié — Veuillez vous connecter</h2>');
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).send('<h2 style="font-family:sans-serif;color:#f05060">Session expirée — Veuillez vous reconnecter</h2>');
  }
}
function requireAdminReport(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).send('<h2 style="font-family:sans-serif;color:#f05060">Accès refusé</h2>');
  next();
}

// ══════════════════════════════════════════════════════
//  MOVEMENTS
// ══════════════════════════════════════════════════════
router.get('/movements', requireAuth, async (req, res) => {
  const { date_from, date_to, product_id, stock } = req.query;
  let conditions = ['1=1'];
  let params = [];
  let i = 1;

  if (date_from) { conditions.push(`m.created_at >= $${i++}`); params.push(date_from); }
  if (date_to) { conditions.push(`m.created_at < ($${i++}::date + interval '1 day')`); params.push(date_to); }
  if (product_id) { conditions.push(`m.product_id = $${i++}`); params.push(product_id); }
  if (stock) { conditions.push(`(m.from_stock = $${i} OR m.to_stock = $${i})`); params.push(stock); i++; }

  try {
    const result = await pool.query(`
      SELECT m.*, p.internal_sn, p.brand, p.model, p.type, s.name AS supplier_name
      FROM stock_movements m
      JOIN products p ON m.product_id = p.id
      LEFT JOIN suppliers s ON p.supplier_id = s.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY m.created_at DESC
      LIMIT 500
    `, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ══════════════════════════════════════════════════════
//  SUPPLIERS
// ══════════════════════════════════════════════════════
router.get('/suppliers', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT * FROM suppliers ORDER BY name');
  res.json(result.rows);
});

router.post('/suppliers', requireAuth, requireRole('admin', 'atelier'), async (req, res) => {
  const { name, contact, phone, email, address } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  try {
    const result = await pool.query(
      'INSERT INTO suppliers (name,contact,phone,email,address) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [name, contact||null, phone||null, email||null, address||null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Fournisseur déjà existant' });
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.put('/suppliers/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { name, contact, phone, email, address } = req.body;
  try {
    const result = await pool.query(
      'UPDATE suppliers SET name=$1,contact=$2,phone=$3,email=$4,address=$5 WHERE id=$6 RETURNING *',
      [name, contact||null, phone||null, email||null, address||null, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ══════════════════════════════════════════════════════
//  USERS (admin only)
// ══════════════════════════════════════════════════════
router.get('/users', requireAuth, requireRole('admin'), async (req, res) => {
  const result = await pool.query('SELECT id,username,full_name,role,is_active,created_at FROM users ORDER BY full_name');
  res.json(result.rows);
});

router.post('/users', requireAuth, requireRole('admin'), async (req, res) => {
  const { username, password, full_name, role } = req.body;
  if (!username || !password || !full_name || !role) return res.status(400).json({ error: 'Champs requis' });
  try {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username,password_hash,full_name,role) VALUES ($1,$2,$3,$4) RETURNING id,username,full_name,role,is_active,created_at',
      [username, hash, full_name, role]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(400).json({ error: 'Nom d\'utilisateur déjà pris' });
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.put('/users/:id', requireAuth, requireRole('admin'), async (req, res) => {
  const { full_name, role, is_active, new_password } = req.body;
  try {
    let hash;
    if (new_password) {
      const bcrypt = require('bcryptjs');
      hash = await bcrypt.hash(new_password, 10);
    }
    const fields = ['full_name=$1','role=$2','is_active=$3','updated_at=NOW()'];
    const vals = [full_name, role, is_active !== undefined ? is_active : true];
    if (hash) { fields.push(`password_hash=$${vals.length + 1}`); vals.push(hash); }
    vals.push(req.params.id);
    const result = await pool.query(
      `UPDATE users SET ${fields.join(',')} WHERE id=$${vals.length} RETURNING id,username,full_name,role,is_active`,
      vals
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ══════════════════════════════════════════════════════
//  GARANTIE
// ══════════════════════════════════════════════════════
router.get('/warranties', requireAuth, async (req, res) => {
  const { status } = req.query;
  let conditions = ['1=1'];
  let params = [];
  if (status) { conditions.push(`w.status=$1`); params.push(status); }

  const result = await pool.query(`
    SELECT w.*, p.internal_sn, p.brand, p.model, p.type, s.name AS supplier_name,
           p.warranty_expiry, p.condition
    FROM warranty_records w
    JOIN products p ON w.product_id = p.id
    LEFT JOIN suppliers s ON p.supplier_id = s.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY w.sent_at DESC
  `, params);
  res.json(result.rows);
});

router.post('/warranties/:id/treat', requireAuth, requireRole('garantie', 'admin'), async (req, res) => {
  const { treatment_notes, returned_to_supplier } = req.body;
  try {
    await pool.query(`
      UPDATE warranty_records SET status='traitee', treated_at=NOW(), treated_by=$1,
        treated_by_name=$2, treatment_notes=$3, returned_to_supplier=$4
      WHERE id=$5
    `, [req.user.id, req.user.full_name, treatment_notes||null, returned_to_supplier||false, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// DELETE warranty record (admin only)
router.delete('/warranties/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    await pool.query('DELETE FROM warranty_records WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ══════════════════════════════════════════════════════
//  SALES
// ══════════════════════════════════════════════════════
router.get('/sales', requireAuth, async (req, res) => {
  const { date_from, date_to } = req.query;
  let conditions = ['1=1'];
  let params = [];
  let i = 1;
  if (date_from) { conditions.push(`s.sold_at >= $${i++}`); params.push(date_from); }
  if (date_to) { conditions.push(`s.sold_at < ($${i++}::date + interval '1 day')`); params.push(date_to); }

  const result = await pool.query(`
    SELECT s.*, p.internal_sn, p.brand, p.model, p.type, sup.name AS supplier_name
    FROM sales s
    JOIN products p ON s.product_id = p.id
    LEFT JOIN suppliers sup ON p.supplier_id = sup.id
    WHERE ${conditions.join(' AND ')}
    ORDER BY s.sold_at DESC
  `, params);
  res.json(result.rows);
});

// ══════════════════════════════════════════════════════
//  BOUTIQUE RECEPTIONS
// ══════════════════════════════════════════════════════
router.get('/boutique-receptions/:product_id', requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM boutique_receptions WHERE product_id=$1 ORDER BY received_at DESC',
    [req.params.product_id]
  );
  res.json(result.rows);
});

// ══════════════════════════════════════════════════════
//  RAPPORTS PDF HTML
// ══════════════════════════════════════════════════════
router.get('/reports/stock', requireAuthReport, requireAdminReport, async (req, res) => {
  const { stock, date_from, date_to } = req.query;
  let conditions = ['1=1'];
  let params = [];
  let i = 1;
  if (stock) { conditions.push(`p.current_stock = $${i++}`); params.push(stock); }
  if (date_from) { conditions.push(`p.reception_date >= $${i++}`); params.push(date_from); }
  if (date_to) { conditions.push(`p.reception_date <= $${i++}`); params.push(date_to); }

  const products = await pool.query(`
    SELECT p.*, s.name AS supplier_name FROM products p
    LEFT JOIN suppliers s ON p.supplier_id=s.id
    WHERE ${conditions.join(' AND ')} ORDER BY p.reception_date DESC
  `, params);
  const cfg = await pool.query('SELECT * FROM company_config LIMIT 1');
  const LABELS = { atelier:'Stock Atelier', installation:'Installation', boutique:'Boutique', garantie:'Garantie', vendu:'Vendu', livre:'Livré' };
  const title = stock ? `État du Stock — ${LABELS[stock]||stock}` : 'État Général du Stock';
  const html = generateStockReportHTML(products.rows, title, cfg.rows[0], { date_from, date_to });
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

router.get('/reports/movements', requireAuthReport, requireAdminReport, async (req, res) => {
  const { date_from, date_to, stock } = req.query;
  let conditions = ['1=1'];
  let params = [];
  let i = 1;
  if (date_from) { conditions.push(`m.created_at >= $${i++}`); params.push(date_from); }
  if (date_to) { conditions.push(`m.created_at < ($${i++}::date + interval '1 day')`); params.push(date_to); }
  if (stock) { conditions.push(`(m.from_stock=$${i} OR m.to_stock=$${i})`); params.push(stock); i++; }

  const movements = await pool.query(`
    SELECT m.*, p.internal_sn, p.brand, p.model, s.name AS supplier_name
    FROM stock_movements m JOIN products p ON m.product_id=p.id
    LEFT JOIN suppliers s ON p.supplier_id=s.id
    WHERE ${conditions.join(' AND ')} ORDER BY m.created_at DESC
  `, params);
  const cfg = await pool.query('SELECT * FROM company_config LIMIT 1');
  const html = generateMovementReportHTML(movements.rows, 'Historique des Mouvements', cfg.rows[0], date_from, date_to);
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

router.get('/reports/bon-reception/:reception_id', requireAuthReport, async (req, res) => {
  const reception = await pool.query('SELECT * FROM boutique_receptions WHERE id=$1', [req.params.reception_id]);
  if (!reception.rows[0]) return res.status(404).json({ error: 'Non trouvé' });
  const product = await pool.query('SELECT p.*, s.name AS supplier_name FROM products p LEFT JOIN suppliers s ON p.supplier_id=s.id WHERE p.id=$1', [reception.rows[0].product_id]);
  const cfg = await pool.query('SELECT * FROM company_config LIMIT 1');
  const html = generateBonReceptionHTML(product.rows[0], reception.rows[0], cfg.rows[0]);
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
});

// ══════════════════════════════════════════════════════
//  COMPANY CONFIG
// ══════════════════════════════════════════════════════
router.get('/config', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT * FROM company_config LIMIT 1');
  res.json(result.rows[0] || {});
});

router.put('/config', requireAuth, requireRole('admin'), async (req, res) => {
  const { name, header_text, footer_text, address, phone, email, website } = req.body;
  try {
    await pool.query(`
      UPDATE company_config SET name=$1,header_text=$2,footer_text=$3,address=$4,phone=$5,email=$6,website=$7,updated_at=NOW()
      WHERE id=1
    `, [name,header_text,footer_text,address,phone,email,website]);
    const result = await pool.query('SELECT * FROM company_config LIMIT 1');
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ══════════════════════════════════════════════════════
//  DASHBOARD STATS (admin)
// ══════════════════════════════════════════════════════
router.get('/dashboard', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const [stocks, movements, sales, warranties] = await Promise.all([
      pool.query(`
        SELECT current_stock, COUNT(*) as count
        FROM products GROUP BY current_stock
      `),
      pool.query(`
        SELECT to_stock, COUNT(*) as count, DATE(created_at) as day
        FROM stock_movements
        WHERE created_at >= NOW() - interval '30 days'
        GROUP BY to_stock, day ORDER BY day
      `),
      pool.query(`
        SELECT SUM(sale_price) as total, COUNT(*) as count,
               DATE(sold_at) as day
        FROM sales
        WHERE sold_at >= NOW() - interval '30 days'
        GROUP BY day ORDER BY day
      `),
      pool.query(`SELECT COUNT(*) as count FROM warranty_records WHERE status='en_attente'`),
    ]);

    res.json({
      stocks: stocks.rows,
      recentMovements: movements.rows,
      salesByDay: sales.rows,
      pendingWarranties: parseInt(warranties.rows[0].count),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
