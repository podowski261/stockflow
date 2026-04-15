const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { addClient } = require('../sse');

// ════════════════════════════════════════════════════════
//  CATALOGUE PUBLIC — produits groupés par config
//  Retourne boutique + vendus (avec stock disponible)
// ════════════════════════════════════════════════════════
router.get('/products', async (req, res) => {
  try {
    // On group par (type, brand, model, processor, ram, storage_size, storage_type, screen_size, condition, sale_price)
    // On compte combien sont en boutique (disponible) et combien sont vendus/livrés
    const result = await pool.query(`
      SELECT
        p.type, p.brand, p.model, p.processor, p.ram,
        p.storage_size, p.storage_type, p.screen_size, p.condition, p.sale_price,

        -- Champs catalogue (depuis le produit représentatif du groupe)
        MAX(p.catalogue_description) AS catalogue_description,
        MAX(p.catalogue_accessories) AS catalogue_accessories,
        MAX(p.catalogue_remarks) AS catalogue_remarks,
        MAX(p.original_price) AS original_price,
        MAX(p.discount_pct) AS discount_pct,

        -- Image
        (
          SELECT p2.image_url FROM products p2
          WHERE p2.type=p.type AND p2.brand=p.brand AND p2.model=p.model
            AND COALESCE(p2.processor,'')=COALESCE(p.processor,'')
            AND COALESCE(p2.ram,'')=COALESCE(p.ram,'')
            AND COALESCE(p2.storage_size,'')=COALESCE(p.storage_size,'')
            AND COALESCE(p2.condition,'')=COALESCE(p.condition,'')
            AND p2.image_url IS NOT NULL
          LIMIT 1
        ) AS image,

        COUNT(*) FILTER (WHERE p.current_stock = 'boutique') AS stock_dispo,
        COUNT(*) FILTER (WHERE p.current_stock IN ('vendu','livre')) AS total_vendu,
        MIN(p.id) FILTER (WHERE p.current_stock = 'boutique') AS sample_id_dispo,
        MIN(p.id) AS sample_id,

        (
          SELECT s2.name FROM products p2
          LEFT JOIN suppliers s2 ON p2.supplier_id=s2.id
          WHERE p2.type=p.type AND p2.brand=p.brand AND p2.model=p.model
            AND COALESCE(p2.processor,'')=COALESCE(p.processor,'')
            AND COALESCE(p2.ram,'')=COALESCE(p.ram,'')
            AND p2.current_stock='boutique'
          LIMIT 1
        ) AS supplier_name

      FROM products p
      WHERE (
        p.current_stock IN ('boutique','vendu','livre')
        OR EXISTS (
          SELECT 1 FROM products p3
          WHERE p3.type=p.type AND p3.brand=p.brand AND p3.model=p.model
            AND COALESCE(p3.processor,'')=COALESCE(p.processor,'')
            AND COALESCE(p3.ram,'')=COALESCE(p.ram,'')
            AND p3.current_stock='boutique'
        )
      )
      AND (p.show_in_catalogue IS NULL OR p.show_in_catalogue = true)

      GROUP BY p.type,p.brand,p.model,p.processor,p.ram,p.storage_size,p.storage_type,p.screen_size,p.condition,p.sale_price
      HAVING COUNT(*) FILTER (WHERE p.current_stock IN ('boutique','vendu','livre')) > 0
      ORDER BY
        COUNT(*) FILTER (WHERE p.current_stock='boutique') DESC,
        p.brand, p.model
    `);

    // Formater la réponse pour le frontend
    const products = result.rows.map((r) => {
      const salePrice = parseFloat(r.sale_price) || 0;
      const origPrice = r.original_price ? parseFloat(r.original_price) : null;
      // Calculer le discount si original_price renseigné mais pas discount_pct
      let discountPct = r.discount_pct ? parseFloat(r.discount_pct) : null;
      if (!discountPct && origPrice && origPrice > salePrice) {
        discountPct = Math.round((1 - salePrice / origPrice) * 100);
      }
      return {
        id: `grp-${r.brand}-${r.model}-${r.processor||''}-${r.ram||''}-${r.storage_size||''}-${r.condition}`.replace(/\s+/g,'_').toLowerCase(),
        sample_id: r.sample_id_dispo || r.sample_id,
        name: `${r.brand} ${r.model}`,
        brand: r.brand, model: r.model, type: r.type, category: r.type,
        processor: r.processor, ram: r.ram, storage_size: r.storage_size,
        storage_type: r.storage_type, screen_size: r.screen_size, condition: r.condition,
        sale_price: salePrice,
        original_price: origPrice,
        discount_pct: discountPct,
        catalogue_description: r.catalogue_description || null,
        catalogue_accessories: r.catalogue_accessories || null,
        catalogue_remarks: r.catalogue_remarks || null,
        image: r.image,
        stock_dispo: parseInt(r.stock_dispo) || 0,
        total_vendu: parseInt(r.total_vendu) || 0,
        supplier_name: r.supplier_name,
        quantity: parseInt(r.stock_dispo) || 0,
        min_stock: 1,
      };
    });

    res.json(products);
  } catch (err) {
    console.error('Public catalogue error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── DÉTAILS D'UN GROUPE (pour modal catalogue admin) ──
router.get('/group-detail', async (req, res) => {
  const { brand, model, processor, ram, storage_size, condition, sale_price } = req.query;
  try {
    const result = await pool.query(`
      SELECT p.*, s.name AS supplier_name
      FROM products p
      LEFT JOIN suppliers s ON p.supplier_id=s.id
      WHERE p.brand=$1 AND p.model=$2
        AND COALESCE(p.processor,'')=$3
        AND COALESCE(p.ram,'')=$4
        AND COALESCE(p.storage_size,'')=$5
        AND p.condition=$6
        AND p.current_stock IN ('boutique','vendu','livre','atelier','installation','garantie')
      ORDER BY
        CASE p.current_stock WHEN 'boutique' THEN 0 WHEN 'installation' THEN 1 WHEN 'atelier' THEN 2 ELSE 3 END,
        p.created_at DESC
    `, [brand, model, processor||'', ram||'', storage_size||'', condition]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SSE ─────────────────────────────────────────────
router.get('/events', (req, res) => {
  addClient(res);
});

module.exports = router;
