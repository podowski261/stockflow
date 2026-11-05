#!/usr/bin/env node
/**
 * Fusionne deux fiches produit DOUBLONS (même article physique enregistré deux fois).
 * Toutes les références du produit DUP sont repointées vers le produit KEEP, les
 * libellés (snapshots) des lignes de commande sont mis au nom final, puis DUP est supprimé.
 *
 * PROCÉDURE SÛRE (obligatoire sur la base de PRODUCTION) :
 *   1. Arrêter le serveur STOCKFLOW (sinon la base est verrouillée / écriture concurrente).
 *   2. node scripts/merge-products.js <KEEP_ID> <DUP_ID> "Nom final" [chemin_base]
 *      - un backup horodaté est créé automatiquement avant toute écriture ;
 *      - tout est fait dans UNE transaction (rollback si erreur) ;
 *      - un PRAGMA integrity_check est lancé à la fin.
 *   3. Relancer le serveur.
 *
 * Exemple (ce cas) :  node scripts/merge-products.js 113 565 "HDMI PHONE 3 EN 1 L7-8"
 */
'use strict';
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const KEEP = parseInt(process.argv[2], 10);
const DUP  = parseInt(process.argv[3], 10);
const NEW_NAME = process.argv[4] || null;
const DB_PATH = process.argv[5] || path.join(__dirname, '..', 'database.sqlite');

if (!KEEP || !DUP || KEEP === DUP) {
    console.error('Usage: node scripts/merge-products.js <KEEP_ID> <DUP_ID> "Nom final" [chemin_base]');
    process.exit(1);
}

// Tables portant une colonne product_id (références à repointer).
const REF_TABLES = ['stock_units', 'sale_items', 'reception_items', 'consignment_items', 'delivery_items', 'reservation_items', 'layaway_items'];
// Tables portant un libellé product_name (snapshot) à harmoniser sur le nom final.
const NAME_TABLES = ['sale_items', 'delivery_items', 'consignment_items', 'reservation_items', 'layaway_items'];

const db = new sqlite3.Database(DB_PATH);
const run = (s, p = []) => new Promise((res, rej) => db.run(s, p, function (e) { e ? rej(e) : res(this); }));
const get = (s, p = []) => new Promise((res, rej) => db.get(s, p, (e, x) => e ? rej(e) : res(x || {})));
const all = (s, p = []) => new Promise((res, rej) => db.all(s, p, (e, x) => e ? rej(e) : res(x)));

(async () => {
    const keep = await get('SELECT id, name FROM products WHERE id = ?', [KEEP]);
    const dup  = await get('SELECT id, name FROM products WHERE id = ?', [DUP]);
    if (!keep.id) throw new Error(`Produit KEEP #${KEEP} introuvable`);
    if (!dup.id)  throw new Error(`Produit DUP #${DUP} introuvable`);
    console.log(`KEEP #${KEEP} « ${keep.name} »  ←  DUP #${DUP} « ${dup.name} »`);

    // Backup horodaté (copie fichier) avant toute écriture.
    const backup = DB_PATH + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(DB_PATH, backup);
    console.log('Backup créé :', backup);

    // Colonnes réellement présentes (le schéma peut varier).
    const hasCol = async (t, c) => (await all(`PRAGMA table_info(${t})`)).some(x => x.name === c);

    await run('BEGIN');
    try {
        let moved = 0;
        for (const t of REF_TABLES) {
            if (!(await hasCol(t, 'product_id'))) continue;
            const r = await run(`UPDATE ${t} SET product_id = ? WHERE product_id = ?`, [KEEP, DUP]);
            if (r.changes) console.log(`  ${t}: ${r.changes} ligne(s) repointée(s)`);
            moved += r.changes;
        }
        if (NEW_NAME) {
            await run('UPDATE products SET name = ? WHERE id = ?', [NEW_NAME, KEEP]);
            for (const t of NAME_TABLES) {
                if (!(await hasCol(t, 'product_name'))) continue;
                await run(`UPDATE ${t} SET product_name = ? WHERE product_id = ?`, [NEW_NAME, KEEP]);
            }
            console.log(`  produit #${KEEP} renommé → « ${NEW_NAME} » (+ snapshots harmonisés)`);
        }

        // Code accessoire générique = accCode(product_id) = 'A' + id sur 6 chiffres. Les unités
        // sans n° de série propre affichent ce code, et il est FIGÉ dans les serials déjà vendus/
        // livrés (sale_items, delivery_items, unit_movements…). On remplace l'ancien code DUP par
        // celui de KEEP — remplacement EXACT du code, ne touche jamais un vrai n° de série gravé.
        const oldCode = 'A' + String(DUP).padStart(6, '0');
        const newCode = 'A' + String(KEEP).padStart(6, '0');
        const tables = (await all("SELECT name FROM sqlite_master WHERE type='table'")).map(t => t.name);
        let codeFixed = 0;
        for (const t of tables) {
            if (!(await hasCol(t, 'serial'))) continue;
            const r = await run(`UPDATE ${t} SET serial = ? WHERE serial = ?`, [newCode, oldCode]);
            if (r.changes) { console.log(`  ${t}: code ${oldCode} → ${newCode} sur ${r.changes} ligne(s)`); codeFixed += r.changes; }
        }
        console.log(`  code accessoire harmonisé : ${codeFixed} ligne(s) (${oldCode} → ${newCode})`);
        const del = await run('DELETE FROM products WHERE id = ?', [DUP]);
        console.log(`  produit doublon #${DUP} supprimé : ${del.changes}`);
        await run('COMMIT');
        console.log(`OK — ${moved} référence(s) fusionnée(s).`);
    } catch (e) {
        await run('ROLLBACK');
        throw e;
    }

    const ic = await get('PRAGMA integrity_check');
    console.log('integrity_check:', ic.integrity_check);
    db.close();
})().catch(e => { console.error('ÉCHEC:', e.message); db.close(); process.exit(1); });
