const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { pool } = require('../db');
const { requireAuth, requireRole, SECRET } = require('../middleware/auth');
const jwt = require('jsonwebtoken');
const { generateInternalSN } = require('../utils/snGenerator');
const { broadcast } = require('../sse');
const { generateLabelHTML } = require('../utils/pdfGenerator');
const { uploadImage, deleteImage, isStorageConfigured } = require('../utils/imageStorage');

// ─── MIDDLEWARE token query param ────────────────────────
function requireAuthQuery(req, res, next) {
  const h = req.headers.authorization;
  const headerToken = h?.startsWith('Bearer ') ? h.slice(7) : null;
  const token = headerToken || req.query.token;
  if (!token) return res.status(401).send('<h2 style="font-family:sans-serif;color:#f05060">Non authentifié</h2>');
  try { req.user = jwt.verify(token, SECRET); next(); }
  catch { return res.status(401).send('<h2 style="font-family:sans-serif;color:#f05060">Session expirée</h2>'); }
}

// ─── MULTER — stockage en mémoire (puis upload vers Supabase) ───────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB max
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Fichier image requis'));
    cb(null, true);
  }
});

// ─── HELPER: traiter l'image uploadée ───────────────────
async function handleImageUpload(file) {
  if (!file) return null;
  if (!isStorageConfigured()) {
    console.warn('⚠️  SUPABASE_URL/SUPABASE_SERVICE_KEY non configurés — image ignorée');
    return null;
  }
  const ext = path.extname(file.originalname) || '.jpg';
  const filename = `products/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
  const url = await uploadImage(file.buffer, filename, file.mimetype);
  return url;
}

// ════════════════════════════════════════════════════════
//  GET ALL PRODUCTS
// ════════════════════════════════════════════════════════
router.get('/', requireAuth, async (req, res) => {
  const { stock, brand, supplier_id, search, date_from, date_to } = req.query;
  let conditions = ['1=1'];
  let params = [];
  let i = 1;

  if (stock) { conditions.push(`p.current_stock = $${i++}`); params.push(stock); }
  if (brand) { conditions.push(`LOWER(p.brand) LIKE $${i++}`); params.push(`%${brand.toLowerCase()}%`); }
  if (supplier_id) { conditions.push(`p.supplier_id = $${i++}`); params.push(supplier_id); }
  if (search) {
    conditions.push(`(LOWER(p.brand) LIKE $${i} OR LOWER(p.model) LIKE $${i} OR LOWER(p.internal_sn) LIKE $${i} OR LOWER(s.name) LIKE $${i})`);
    params.push(`%${search.toLowerCase()}%`); i++;
  }
  if (date_from) { conditions.push(`p.reception_date >= $${i++}`); params.push(date_from); }
  if (date_to)   { conditions.push(`p.reception_date <= $${i++}`); params.push(date_to); }

  // Restriction par rôle
  const roleMap = {
    atelier:  `p.current_stock = 'atelier'`,
    boutique: `p.current_stock = 'boutique'`,
    garantie: `p.current_stock = 'garantie'`,
  };
  if (roleMap[req.user.role]) conditions.push(roleMap[req.user.role]);

  try {
    const result = await pool.query(`
      SELECT p.*, s.name AS supplier_name
      FROM products p
      LEFT JOIN suppliers s ON p.supplier_id = s.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY p.created_at DESC
    `, params);
    res.json(result.rows);
  } catch (err) {
    console.error('GET /products:', err.message);
    res.status(500).json({ error: 'Erreur serveur: ' + err.message });
  }
});

// ════════════════════════════════════════════════════════
//  GET SINGLE PRODUCT
// ════════════════════════════════════════════════════════
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, s.name AS supplier_name FROM products p LEFT JOIN suppliers s ON p.supplier_id=s.id WHERE p.id=$1`,
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Produit non trouvé' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════
//  CREATE PRODUCT (avec quantité)
//  quantite > 1 → crée plusieurs produits avec le même config
//  Chaque produit reçoit un internal_sn unique incrémenté
// ════════════════════════════════════════════════════════
router.post('/', requireAuth, requireRole('atelier', 'admin'), upload.single('image'), async (req, res) => {
  const { type, brand, model, processor, ram, storage_size, storage_type, screen_size,
          condition, sale_price, supplier_id, reception_date, warranty_duration,
          quantite, real_sn_list } = req.body;
  // quantite: nombre d'unités à créer (défaut 1)
  // real_sn_list: SN réels séparés par newline (optionnel, 1 par ligne)

  const qty = Math.max(1, Math.min(parseInt(quantite) || 1, 100)); // max 100 par lot

  if (!type || !brand || !model || !condition || !supplier_id || !reception_date) {
    return res.status(400).json({ error: 'Champs obligatoires manquants' });
  }

  try {
    const supResult = await pool.query('SELECT name FROM suppliers WHERE id=$1', [supplier_id]);
    if (!supResult.rows[0]) return res.status(400).json({ error: 'Fournisseur introuvable' });
    const supplierName = supResult.rows[0].name;

    // Calcul fin de garantie
    let warrantyExpiry = null;
    if (warranty_duration && reception_date) {
      const rd = new Date(reception_date);
      const match = warranty_duration.match(/(\d+)\s*(jour|mois|an)/i);
      if (match) {
        const n = parseInt(match[1]), unit = match[2].toLowerCase();
        if (unit === 'jour') rd.setDate(rd.getDate() + n);
        else if (unit === 'mois') rd.setMonth(rd.getMonth() + n);
        else rd.setFullYear(rd.getFullYear() + n);
        warrantyExpiry = rd.toISOString().split('T')[0];
      }
    }

    // Upload image une seule fois (partagée entre tous les produits du lot)
    let image_url = null;
    if (req.file) {
      try { image_url = await handleImageUpload(req.file); }
      catch (imgErr) { console.error('Image upload failed:', imgErr.message); }
    }

    // Liste des SN réels (optionnel)
    const realSNs = real_sn_list
      ? real_sn_list.split('\n').map(s => s.trim()).filter(Boolean)
      : [];

    // Créer qty produits
    const createdProducts = [];
    for (let k = 0; k < qty; k++) {
      const internal_sn = await generateInternalSN(supplierName, brand, model, reception_date);
      const real_sn = realSNs[k] || null;

      const result = await pool.query(`
        INSERT INTO products (
          internal_sn, real_sn, type, brand, model, processor, ram, storage_size,
          storage_type, screen_size, condition, sale_price, image_url, supplier_id,
          reception_date, warranty_expiry, warranty_duration, current_stock
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'atelier')
        RETURNING *
      `, [internal_sn, real_sn, type, brand, model, processor||null, ram||null,
          storage_size||null, storage_type||null, screen_size||null, condition,
          parseFloat(sale_price)||0, image_url, supplier_id, reception_date, warrantyExpiry,
          warranty_duration||null]);

      const product = result.rows[0];
      product.supplier_name = supplierName;

      await pool.query(
        `INSERT INTO stock_movements (product_id, from_stock, to_stock, reason, performed_by, performed_by_name)
         VALUES ($1, NULL, 'atelier', $2, $3, $4)`,
        [product.id,
         qty > 1 ? `Réception initiale (lot de ${qty})` : 'Réception initiale',
         req.user.id, req.user.full_name]
      );

      createdProducts.push(product);
      broadcast('product:new', { ...product, quantity: 1 });
    }

    // Retourner le résumé
    res.status(201).json({
      created: createdProducts.length,
      products: createdProducts,
      // Produit représentatif (le 1er) pour affichage
      ...createdProducts[0],
    });
  } catch (err) {
    console.error('POST /products:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
//  UPDATE PRODUCT (admin)
// ════════════════════════════════════════════════════════
router.put('/:id', requireAuth, requireRole('admin'), upload.single('image'), async (req, res) => {
  const { type, brand, model, processor, ram, storage_size, storage_type, screen_size,
          condition, sale_price, warranty_duration, real_sn,
          catalogue_description, catalogue_accessories, catalogue_remarks,
          original_price, discount_pct, show_in_catalogue } = req.body;
  try {
    // Upload nouvelle image si fournie
    let image_url;
    if (req.file) {
      try {
        image_url = await handleImageUpload(req.file);
        // Supprimer l'ancienne image
        const old = await pool.query('SELECT image_url FROM products WHERE id=$1', [req.params.id]);
        if (old.rows[0]?.image_url) await deleteImage(old.rows[0].image_url);
      } catch (imgErr) { console.error('Image update failed:', imgErr.message); }
    }

    const fields = [];
    const vals = [];
    let idx = 1;

    const add = (col, val) => { if (val !== undefined && val !== '') { fields.push(`${col}=$${idx++}`); vals.push(val); } };
    add('type', type);
    add('brand', brand); add('model', model); add('processor', processor);
    add('ram', ram); add('storage_size', storage_size); add('storage_type', storage_type);
    add('screen_size', screen_size); add('condition', condition);
    add('sale_price', sale_price ? parseFloat(sale_price) : undefined);
    add('real_sn', real_sn);
    // Champs catalogue public
    add('catalogue_description', catalogue_description);
    add('catalogue_accessories', catalogue_accessories);
    add('catalogue_remarks', catalogue_remarks);
    add('original_price', original_price ? parseFloat(original_price) : undefined);
    add('discount_pct', discount_pct ? parseFloat(discount_pct) : undefined);
    if (show_in_catalogue !== undefined) add('show_in_catalogue', show_in_catalogue === 'true' || show_in_catalogue === true);
    if (image_url) add('image_url', image_url);
    fields.push(`updated_at=NOW()`);
    vals.push(req.params.id);

    await pool.query(`UPDATE products SET ${fields.join(',')} WHERE id=$${idx}`, vals);

    const updated = await pool.query(
      `SELECT p.*, s.name AS supplier_name FROM products p LEFT JOIN suppliers s ON p.supplier_id=s.id WHERE p.id=$1`,
      [req.params.id]
    );
    broadcast('product:update', updated.rows[0]);
    res.json(updated.rows[0]);
  } catch (err) {
    console.error('PUT /products/:id:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
//  MOVE PRODUCT
// ════════════════════════════════════════════════════════
router.post('/:id/move', requireAuth, async (req, res) => {
  const { to_stock, reason, problem_description, destination_detail } = req.body;
  if (!to_stock) return res.status(400).json({ error: 'Destination requise' });

  try {
    const pResult = await pool.query('SELECT * FROM products WHERE id=$1', [req.params.id]);
    const product = pResult.rows[0];
    if (!product) return res.status(404).json({ error: 'Produit non trouvé' });

    const from_stock = product.current_stock;
    const roleStockMap = {
      atelier:  ['garantie','boutique'],
      boutique: ['garantie','vendu','livre'],
      garantie: ['atelier'],
      admin:    ['atelier','boutique','garantie','vendu','livre'],
    };
    const allowed = roleStockMap[req.user.role] || [];
    if (!allowed.includes(to_stock)) {
      return res.status(403).json({ error: `Vous ne pouvez pas envoyer vers ${to_stock}` });
    }
    if (to_stock === 'garantie' && !problem_description) {
      return res.status(400).json({ error: 'Description du problème obligatoire pour la garantie' });
    }

    await pool.query('UPDATE products SET current_stock=$1, updated_at=NOW() WHERE id=$2', [to_stock, req.params.id]);

    await pool.query(
      `INSERT INTO stock_movements (product_id, from_stock, to_stock, reason, problem_description, performed_by, performed_by_name, destination_detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [req.params.id, from_stock, to_stock, reason||null, problem_description||null, req.user.id, req.user.full_name, destination_detail||null]
    );

    if (to_stock === 'garantie') {
      await pool.query(
        `INSERT INTO warranty_records (product_id, sent_by, sent_by_name, sent_from_stock, problem_description)
         VALUES ($1,$2,$3,$4,$5)`,
        [req.params.id, req.user.id, req.user.full_name, from_stock, problem_description]
      );
    }

    if (to_stock === 'vendu' || to_stock === 'livre') {
      await pool.query(
        `INSERT INTO sales (product_id, sold_by, sold_by_name, sale_price, buyer_name, sale_type)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [req.params.id, req.user.id, req.user.full_name, product.sale_price, destination_detail||null, to_stock==='livre'?'livraison':'vente']
      );
    }

    const updated = await pool.query(
      `SELECT p.*, s.name AS supplier_name FROM products p LEFT JOIN suppliers s ON p.supplier_id=s.id WHERE p.id=$1`,
      [req.params.id]
    );
    broadcast('product:update', updated.rows[0]);
    res.json({ success: true, product: updated.rows[0] });
  } catch (err) {
    console.error('POST /products/:id/move:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════
//  CONFIRM BOUTIQUE RECEPTION
// ════════════════════════════════════════════════════════
router.post('/:id/confirm-reception', requireAuth, requireRole('boutique','admin'), async (req, res) => {
  const { sent_by_name, notes } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO boutique_receptions (product_id, received_by, received_by_name, sent_by_name, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, req.user.id, req.user.full_name, sent_by_name||null, notes||null]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════
//  LABEL HTML (token via query param pour window.open)
// ════════════════════════════════════════════════════════
router.get('/:id/label', requireAuthQuery, async (req, res) => {
  try {
    const pResult = await pool.query(
      `SELECT p.*, s.name AS supplier_name FROM products p LEFT JOIN suppliers s ON p.supplier_id=s.id WHERE p.id=$1`,
      [req.params.id]
    );
    const product = pResult.rows[0];
    if (!product) return res.status(404).json({ error: 'Produit non trouvé' });
    const cfgResult = await pool.query('SELECT * FROM company_config LIMIT 1');
    const html = generateLabelHTML(product, cfgResult.rows[0]?.name);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════
//  DELETE PRODUCT (admin)
// ════════════════════════════════════════════════════════
router.delete('/:id', requireAuth, requireRole('admin'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products WHERE id=$1', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Non trouvé' });
    if (result.rows[0].image_url) await deleteImage(result.rows[0].image_url);
    await pool.query('DELETE FROM products WHERE id=$1', [req.params.id]);
    broadcast('product:delete', { id: parseInt(req.params.id) });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
