#!/usr/bin/env node
/**
 * Change l'IDENTIFIANT d'une fiche produit (OLD → NEW), et met à jour TOUTES ses références.
 * Utile quand le code accessoire physique (étiquettes) = accCode = 'A' + id doit correspondre à
 * un id précis (ex. étiquettes imprimées « A000565 » alors que la fiche est passée à l'id 113).
 *
 * NEW doit être LIBRE (aucune fiche produit, aucune référence). Le code accessoire figé dans les
 * serials (accCode(OLD) → accCode(NEW)) est aussi migré (remplacement EXACT, jamais un vrai n° gravé).
 *
 * PROCÉDURE SÛRE (base de PRODUCTION) :
 *   1. Arrêter le serveur STOCKFLOW.
 *   2. node scripts/renumber-product.js <OLD_ID> <NEW_ID> [chemin_base]
 *   3. Relancer le serveur.
 * Backup horodaté auto + transaction (rollback si erreur) + PRAGMA integrity_check.
 *
 * Exemple : node scripts/renumber-product.js 113 565 "\\192.168.88.10\stockflow\database.sqlite"
 */
'use strict';
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const OLD = parseInt(process.argv[2], 10);
const NEW = parseInt(process.argv[3], 10);
const DB_PATH = process.argv[4] || path.join(__dirname, '..', 'database.sqlite');

if (!OLD || !NEW || OLD === NEW) {
    console.error('Usage: node scripts/renumber-product.js <OLD_ID> <NEW_ID> [chemin_base]');
    process.exit(1);
}
const REF_TABLES = ['stock_units', 'sale_items', 'reception_items', 'consignment_items', 'delivery_items', 'reservation_items', 'layaway_items', 'trash_products'];
const accCode = id => 'A' + String(id).padStart(6, '0');

const db = new sqlite3.Database(DB_PATH);
const run = (s, p = []) => new Promise((res, rej) => db.run(s, p, function (e) { e ? rej(e) : res(this); }));
const get = (s, p = []) => new Promise((res, rej) => db.get(s, p, (e, x) => e ? rej(e) : res(x || {})));
const all = (s, p = []) => new Promise((res, rej) => db.all(s, p, (e, x) => e ? rej(e) : res(x)));
const hasCol = async (t, c) => (await all(`PRAGMA table_info(${t})`)).some(x => x.name === c);

(async () => {
    const oldP = await get('SELECT id, name FROM products WHERE id = ?', [OLD]);
    if (!oldP.id) throw new Error(`Produit OLD #${OLD} introuvable`);
    const newP = await get('SELECT id FROM products WHERE id = ?', [NEW]);
    if (newP.id) throw new Error(`L'id NEW #${NEW} est déjà pris par un autre produit — abandon`);
    // NEW ne doit être référencé nulle part (sinon on mélangerait deux articles).
    for (const t of REF_TABLES) {
        if (!(await hasCol(t, 'product_id'))) continue;
        const r = await get(`SELECT COUNT(*) n FROM ${t} WHERE product_id = ?`, [NEW]);
        if (r.n) throw new Error(`L'id NEW #${NEW} est déjà référencé dans ${t} (${r.n}) — abandon`);
    }
    console.log(`Renumérotation produit #${OLD} « ${oldP.name} » → #${NEW}`);

    const backup = DB_PATH + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(DB_PATH, backup);
    console.log('Backup créé :', backup);

    await run('BEGIN');
    try {
        await run('UPDATE products SET id = ? WHERE id = ?', [NEW, OLD]);
        let moved = 0;
        for (const t of REF_TABLES) {
            if (!(await hasCol(t, 'product_id'))) continue;
            const r = await run(`UPDATE ${t} SET product_id = ? WHERE product_id = ?`, [NEW, OLD]);
            if (r.changes) console.log(`  ${t}: ${r.changes} référence(s)`);
            moved += r.changes;
        }
        // Code accessoire figé dans les serials : accCode(OLD) → accCode(NEW).
        const oldCode = accCode(OLD), newCode = accCode(NEW);
        const tables = (await all("SELECT name FROM sqlite_master WHERE type='table'")).map(t => t.name);
        let codeFixed = 0;
        for (const t of tables) {
            if (!(await hasCol(t, 'serial'))) continue;
            const r = await run(`UPDATE ${t} SET serial = ? WHERE serial = ?`, [newCode, oldCode]);
            if (r.changes) { console.log(`  ${t}: code ${oldCode} → ${newCode} sur ${r.changes} ligne(s)`); codeFixed += r.changes; }
        }
        await run('COMMIT');
        console.log(`OK — produit renuméroté, ${moved} référence(s) + ${codeFixed} code(s) accessoire mis à jour.`);
    } catch (e) {
        await run('ROLLBACK');
        throw e;
    }

    const ic = await get('PRAGMA integrity_check');
    console.log('integrity_check:', ic.integrity_check);
    db.close();
})().catch(e => { console.error('ÉCHEC:', e.message); db.close(); process.exit(1); });
