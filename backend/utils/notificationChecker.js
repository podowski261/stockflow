// ══════════════════════════════════════════════════════
//  NOTIFICATION CHECKER — vérification automatique
//  Lancé au démarrage + toutes les heures
// ══════════════════════════════════════════════════════
const { pool } = require('../db');
const { broadcast } = require('../sse');

/**
 * Crée ou met à jour une notification (évite les doublons via UPSERT)
 */
async function upsertNotif(productId, type, title, message, targetRoles) {
  try {
    await pool.query(`
      INSERT INTO notifications (product_id, type, title, message, target_roles, is_read, created_at)
      VALUES ($1, $2, $3, $4, $5, false, NOW())
      ON CONFLICT (product_id, type)
      DO UPDATE SET
        title = EXCLUDED.title,
        message = EXCLUDED.message,
        is_read = false,
        created_at = NOW()
    `, [productId, type, title, message, JSON.stringify(targetRoles)]);
  } catch (err) {
    console.error('upsertNotif error:', err.message);
  }
}

/**
 * Supprime une notification résolue (produit bougé, garantie traitée, etc.)
 */
async function resolveNotif(productId, type) {
  try {
    await pool.query(
      'DELETE FROM notifications WHERE product_id=$1 AND type=$2',
      [productId, type]
    );
  } catch {}
}

/**
 * Vérification principale — appelée au démarrage et toutes les heures
 */
async function runChecks() {
  console.log('🔔 Vérification des notifications…');
  const now = new Date();
  let newNotifs = 0;

  try {
    // ── 1. GARANTIE FOURNISSEUR SUR LE POINT D'EXPIRER ──────────────────────
    // Produits en atelier ou installation dont la garantie expire dans <= 3 jours
    const expiringWarranty = await pool.query(`
      SELECT p.id, p.internal_sn, p.brand, p.model, p.warranty_expiry,
             p.warranty_duration, p.current_stock, s.name AS supplier_name
      FROM products p
      LEFT JOIN suppliers s ON p.supplier_id = s.id
      WHERE p.current_stock IN ('atelier')
        AND p.warranty_expiry IS NOT NULL
        AND p.warranty_expiry > CURRENT_DATE
        AND p.warranty_expiry <= CURRENT_DATE + interval '3 days'
    `);

    for (const p of expiringWarranty.rows) {
      const daysLeft = Math.ceil((new Date(p.warranty_expiry) - now) / 86400000);
      const stockLabel = p.current_stock === 'atelier' ? 'Atelier' : 'Installation';
      const targetRoles = ['admin', 'atelier'];

      await upsertNotif(
        p.id,
        'warranty_expiring',
        `⚠️ Garantie expire bientôt — ${p.brand} ${p.model}`,
        `${p.internal_sn} (${p.brand} ${p.model}) — Garantie fournisseur ${p.supplier_name||''} expire dans ${daysLeft} jour(s) (${new Date(p.warranty_expiry).toLocaleDateString('fr-FR')}). Produit actuellement au stock ${stockLabel}. Vérifiez son état avant expiration.`,
        targetRoles
      );
      newNotifs++;
    }

    // ── 2. GARANTIE FOURNISSEUR EXPIRÉE — produit toujours en stock ──────────
    const expiredWarranty = await pool.query(`
      SELECT p.id, p.internal_sn, p.brand, p.model, p.warranty_expiry,
             p.current_stock, s.name AS supplier_name
      FROM products p
      LEFT JOIN suppliers s ON p.supplier_id = s.id
      WHERE p.current_stock IN ('atelier','boutique')
        AND p.warranty_expiry IS NOT NULL
        AND p.warranty_expiry < CURRENT_DATE
    `);

    for (const p of expiredWarranty.rows) {
      const stockLabel = { atelier:'Atelier', installation:'Installation', boutique:'Boutique' }[p.current_stock] || p.current_stock;
      const targetRoles = {
        atelier: ['admin','atelier'],
        boutique: ['admin','boutique'],
      }[p.current_stock] || ['admin'];

      await upsertNotif(
        p.id,
        'warranty_expired',
        `🔴 Garantie expirée — ${p.brand} ${p.model}`,
        `${p.internal_sn} (${p.brand} ${p.model}) — La garantie fournisseur ${p.supplier_name||''} a expiré le ${new Date(p.warranty_expiry).toLocaleDateString('fr-FR')}. Produit toujours au stock ${stockLabel}. À vérifier d'urgence.`,
        targetRoles
      );
      newNotifs++;
    }

    // ── 3. PRODUITS IMMOBILES DEPUIS 2 JOURS ────────────────────────────────
    // Produit reçu il y a >= 2 jours et toujours en atelier sans aucun mouvement
    const staleProducts = await pool.query(`
      SELECT p.id, p.internal_sn, p.brand, p.model, p.current_stock,
             p.reception_date, p.created_at, s.name AS supplier_name,
             EXTRACT(EPOCH FROM (NOW() - p.updated_at))/86400 AS days_stale
      FROM products p
      LEFT JOIN suppliers s ON p.supplier_id = s.id
      WHERE p.current_stock IN ('atelier')
        AND p.updated_at < NOW() - interval '2 days'
        AND p.warranty_expiry IS NOT NULL
    `);

    for (const p of staleProducts.rows) {
      const days = Math.floor(parseFloat(p.days_stale));
      const stockLabel = p.current_stock === 'atelier' ? 'Atelier' : 'Installation';
      const targetRoles = p.current_stock === 'atelier'
        ? ['admin','atelier']
        : ['admin','installation'];

      await upsertNotif(
        p.id,
        'stale_product',
        `⏳ Produit immobile (${days}j) — ${p.brand} ${p.model}`,
        `${p.internal_sn} (${p.brand} ${p.model}) n'a pas bougé depuis ${days} jour(s). Il est toujours au stock ${stockLabel}. Vérifiez son état et traitez-le.`,
        targetRoles
      );
      newNotifs++;
    }

    // ── 4. NETTOYER les notifs pour produits résolus ─────────────────────────
    // Produits qui ont bougé (vendu, garantie traitée, etc.) → supprimer notifs
    await pool.query(`
      DELETE FROM notifications n
      WHERE n.type = 'warranty_expiring'
        AND EXISTS (
          SELECT 1 FROM products p
          WHERE p.id = n.product_id
            AND p.current_stock NOT IN ('atelier','installation')
        )
    `);
    await pool.query(`
      DELETE FROM notifications n
      WHERE n.type = 'stale_product'
        AND EXISTS (
          SELECT 1 FROM products p
          WHERE p.id = n.product_id
            AND (p.current_stock NOT IN ('atelier','installation')
                 OR p.updated_at >= NOW() - interval '2 days')
        )
    `);

    if (newNotifs > 0) {
      // Broadcaster les nouvelles notifications via SSE
      broadcast('notifications:update', { count: newNotifs });
      console.log(`✅ ${newNotifs} notification(s) générée(s)`);
    } else {
      console.log('✅ Aucune nouvelle notification');
    }

  } catch (err) {
    console.error('❌ Erreur checkNotifications:', err.message);
  }
}

/**
 * Démarre le checker: immédiatement + toutes les heures
 */
function startNotificationChecker() {
  // Premier check au démarrage (délai 5s pour laisser le temps à la DB)
  setTimeout(runChecks, 5000);
  // Répétition toutes les heures
  setInterval(runChecks, 60 * 60 * 1000);
}

module.exports = { startNotificationChecker, runChecks, resolveNotif };
