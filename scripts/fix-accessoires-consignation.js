#!/usr/bin/env node
/**
 * Réconcilie les ACCESSOIRES FONGIBLES restés « en consignation » chez un commercial alors qu'une
 * vente ÉQUIVALENTE (même produit, attribuée à CE commercial) a décrémenté par erreur une unité du
 * DÉPÔT — bug corrigé désormais côté server.js (voir stockflow-accessoires-fongibles-vente).
 *
 * Ce script ne traite QUE les cas « sûrs » (stock-neutre, SANS toucher à l'argent) : pour chaque
 * unité bloquée, on APPARIE une vente déjà enregistrée qui a consommé une unité du dépôt (unité
 * 'vendu' n'ayant JAMAIS été une consignation de ce commercial), puis on BASCULE :
 *   - l'unité du commercial (consignation)  → 'vendu' (+ mouvement 'vente', rattachée à la vente) ;
 *   - l'unité du dépôt vendue par erreur     → 'stock' (+ mouvement 'vente_reaffectation') ;
 *   - sale_items.unit_id repointé sur l'unité du commercial.
 * Aucune vente créée/supprimée, aucun montant modifié. Les unités SANS vente appariable (ventes non
 * enregistrées) ne sont PAS traitées ici (elles exigent une régularisation avec encaissement).
 *
 * PROCÉDURE SÛRE (base de PRODUCTION) :
 *   1. Arrêter le serveur STOCKFLOW.
 *   2. DRY-RUN :   node scripts/fix-accessoires-consignation.js [chemin_base]
 *   3. APPLIQUER : node scripts/fix-accessoires-consignation.js --apply [chemin_base]
 *      (backup horodaté + transaction + PRAGMA integrity_check automatiques)
 *   4. Relancer le serveur.
 * Idempotent : relancer ne retrouve plus rien à apparier.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DB_PATH = args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', 'database.sqlite');
const OPEN = ['sent', 'received', 'boutique'];

function mgNow() {
    const d = new Date(Date.now() + 3 * 3600 * 1000), p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
         + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
if (!fs.existsSync(DB_PATH)) { console.error('Base introuvable :', DB_PATH); process.exit(1); }

const db = new sqlite3.Database(DB_PATH, APPLY ? sqlite3.OPEN_READWRITE : sqlite3.OPEN_READONLY);
const run = (s, p = []) => new Promise((res, rej) => db.run(s, p, function (e) { e ? rej(e) : res(this); }));
const get = (s, p = []) => new Promise((res, rej) => db.get(s, p, (e, x) => e ? rej(e) : res(x)));
const all = (s, p = []) => new Promise((res, rej) => db.all(s, p, (e, x) => e ? rej(e) : res(x)));
const ph = OPEN.map(() => '?').join(',');

async function recordMovement(unitId, serial, from, to, action, refId, note, now) {
    await run(`INSERT INTO unit_movements (unit_id, serial, from_status, to_status, action, user_id, user_name, ref_type, ref_id, note, created_at)
               VALUES (?,?,?,?,?, NULL, 'Correction audit', 'sale', ?, ?, ?)`, [unitId, serial, from, to, action, String(refId), note, now]);
}

(async () => {
    console.log(`Base : ${DB_PATH}`);
    console.log(`Mode : ${APPLY ? 'APPLIQUER (écriture)' : 'DRY-RUN (lecture seule)'}\n`);

    // 1) Unités bloquées : accessoire en 'consignation' chez un commercial, dont le commercial a ≥1 vente
    //    completed du même produit (indice qu'une équivalente aurait dû partir de sa sortie).
    const stuck = await all(
        `SELECT DISTINCT u.id AS unit_id, u.serial, u.product_id, c.commercial_id, c.commercial_name, i.product_name
         FROM consignment_items i
         JOIN consignments c ON c.id = i.consignment_id
         JOIN stock_units u ON u.id = i.unit_id AND u.status = 'consignation'
         JOIN products p ON p.id = i.product_id AND p.is_accessory = 1
         WHERE c.status IN (${ph})
           AND EXISTS (SELECT 1 FROM sale_items si JOIN sales s ON s.id = si.sale_id
                       WHERE si.product_id = u.product_id AND s.commercial_id = c.commercial_id
                         AND s.status = 'completed' AND si.returned = 0)
         ORDER BY c.commercial_name, i.product_name, u.id`, OPEN);

    // Groupe par (commercial, produit).
    const groups = new Map();
    stuck.forEach(r => { const k = r.commercial_id + '|' + r.product_id; (groups.get(k) || groups.set(k, []).get(k)).push(r); });

    const plan = [], unmatched = [];
    for (const [, units] of groups) {
        const { commercial_id, product_id } = units[0];
        // Ventes-dépôt appariables : lignes de vente (ce commercial, ce produit, completed, non retournées)
        // dont l'unité vendue est 'vendu' et n'a JAMAIS été une consignation de ce commercial.
        const depotSales = await all(
            `SELECT si.id AS si_id, si.unit_id AS depot_unit, si.serial AS depot_serial, s.sale_number
             FROM sale_items si JOIN sales s ON s.id = si.sale_id JOIN stock_units u ON u.id = si.unit_id
             WHERE si.product_id = ? AND s.commercial_id = ? AND s.status = 'completed' AND si.returned = 0
               AND u.status = 'vendu'
               AND NOT EXISTS (SELECT 1 FROM consignment_items ci JOIN consignments cc ON cc.id = ci.consignment_id
                               WHERE ci.unit_id = si.unit_id AND cc.commercial_id = ?)
             ORDER BY si.id`, [product_id, commercial_id, commercial_id]);
        const n = Math.min(units.length, depotSales.length);
        for (let k = 0; k < units.length; k++) {
            if (k < n) plan.push({ com: units[k].commercial_name, product: units[k].product_name,
                                   comUnit: units[k].unit_id, comSerial: units[k].serial, ...depotSales[k] });
            else unmatched.push(units[k]);
        }
    }

    console.log(`Unités bloquées : ${stuck.length}  →  appariables (sûres) : ${plan.length}  |  sans vente appariable : ${unmatched.length}\n`);
    console.log('== À RÉCONCILIER (stock-neutre) ==');
    plan.forEach((r, i) => console.log(
        `  ${String(i + 1).padStart(2)}. ${r.com} · ${r.product}\n` +
        `      commercial unit ${r.comUnit} (${r.comSerial || 'accessoire'}) → VENDU  ⟵ vente #${r.sale_number}` +
        `  |  dépôt unit ${r.depot_unit} → stock  |  sale_item ${r.si_id}`));
    if (unmatched.length) {
        console.log('\n== NON TRAITÉ (aucune vente enregistrée — régularisation manuelle requise) ==');
        unmatched.forEach(u => console.log(`  unit ${u.unit_id} · ${u.commercial_name} · ${u.product_name}`));
    }

    if (!APPLY) { console.log(`\n(DRY-RUN) Aucune écriture. Appliquer : node scripts/fix-accessoires-consignation.js --apply`); db.close(); return; }
    if (!plan.length) { console.log('\nRien à appliquer.'); db.close(); return; }

    const backup = DB_PATH + '.bak-' + mgNow().replace(/[: ]/g, '-') + '-avant-fix-acc-consignation';
    fs.copyFileSync(DB_PATH, backup);
    console.log('\nBackup créé :', backup);

    const now = mgNow();
    await run('BEGIN');
    try {
        for (const r of plan) {
            // Vérif « live » : l'unité du commercial est-elle toujours consignation, la dépôt toujours vendu ?
            const cu = await get('SELECT status FROM stock_units WHERE id = ?', [r.comUnit]);
            const du = await get('SELECT status FROM stock_units WHERE id = ?', [r.depot_unit]);
            if (!cu || cu.status !== 'consignation' || !du || du.status !== 'vendu') { console.log(`  ⊘ ignoré (état changé) unit ${r.comUnit}`); continue; }
            await run(`UPDATE stock_units SET status = 'vendu', holder_user_id = NULL, updated_at = ? WHERE id = ?`, [now, r.comUnit]);
            await recordMovement(r.comUnit, r.comSerial, 'consignation', 'vendu', 'vente', r.sale_number,
                `Vente #${r.sale_number} — réaffectation accessoire fongible (unité du commercial)`, now);
            await run(`UPDATE stock_units SET status = 'stock', location = 'depot', updated_at = ? WHERE id = ?`, [now, r.depot_unit]);
            await recordMovement(r.depot_unit, r.depot_serial, 'vendu', 'stock', 'vente_reaffectation', r.sale_number,
                `Accessoire fongible — vente #${r.sale_number} reportée sur l'unité du commercial`, now);
            await run(`UPDATE sale_items SET unit_id = ? WHERE id = ?`, [r.comUnit, r.si_id]);
            console.log(`  ✔ #${r.sale_number} : unit ${r.comUnit} → vendu, unit ${r.depot_unit} → stock`);
        }
        await run('COMMIT');
    } catch (e) { await run('ROLLBACK'); console.error('ROLLBACK —', e.message); db.close(); process.exit(1); }

    const ic = await get('PRAGMA integrity_check');
    console.log('\nintegrity_check :', ic.integrity_check || JSON.stringify(ic));
    console.log(unmatched.length ? `\n⚠️  ${unmatched.length} unité(s) restent sans vente (régularisation manuelle).` : '\n✅ Terminé.');
    db.close();
})().catch(e => { console.error('ERREUR :', e.message); process.exit(1); });
