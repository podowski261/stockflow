const { pool } = require('../db');

/**
 * Génère un numéro de série interne
 * Format: SUP-BRAND-MODEL-DDMMYY-XXXX
 * Ex: FG-HP-640G5-091026-0001
 */
async function generateInternalSN(supplierName, brand, model, receptionDate) {
  const date = new Date(receptionDate);
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yy = String(date.getFullYear()).slice(-2);
  const yearMonth = mm + yy;

  // Codes courts
  const supplierCode = supplierName.slice(0, 4).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const brandCode = brand.slice(0, 4).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const modelCode = model.slice(0, 8).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const dateStr = dd + mm + yy;

  // Incrément atomique
  const result = await pool.query(`
    INSERT INTO sn_counters (year_month, supplier_code, brand_code, model_code, last_count)
    VALUES ($1, $2, $3, $4, 1)
    ON CONFLICT (year_month, supplier_code, brand_code, model_code)
    DO UPDATE SET last_count = sn_counters.last_count + 1
    RETURNING last_count
  `, [yearMonth, supplierCode, brandCode, modelCode]);

  const count = String(result.rows[0].last_count).padStart(4, '0');
  return `${supplierCode}-${brandCode}-${modelCode}-${dateStr}-${count}`;
}

module.exports = { generateInternalSN };
