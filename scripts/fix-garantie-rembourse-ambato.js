#!/usr/bin/env node
/**
 * Correction ponctuelle — GARANTIE AMBATO (fournisseur 3).
 *
 * Le 2026-08-25 10:24, le responsable des garanties a déclaré par ERREUR « revenu du fournisseur »
 * un lot de 9 pièces AMBATO qui auraient dû être « REMBOURSÉES » (le fournisseur a remboursé au lieu
 * de renvoyer). Depuis, 6 d'entre elles ont été re-réceptionnées / déplacées par le stock.
 * Décision (admin) : forcer les 9 en « remboursé » (montant 0), quel que soit leur statut actuel.
 *
 * Effet, pour chaque unité (sauf si déjà 'retire', ou 'vendu' → on NE TOUCHE PAS une vente) :
 *   - stock_units.status → 'retire', location → 'retire', holder_user_id → NULL, note = remboursé ;
 *   - unit_movements     : mouvement 'rembourse' (from = statut courant) ;
 *   - garantie_actions   : action 'rembourse', type 'fournisseur', amount 0 (→ historique + sort de la garantie).
 * Aucune vente touchée, aucun montant d'argent créé (amount = 0).
 *
 * PROCÉDURE SÛRE (base de PRODUCTION) :
 *   1. Arrêter le serveur STOCKFLOW.
 *   2. DRY-RUN :   node scripts/fix-garantie-rembourse-ambato.js [chemin_base]
 *   3. APPLIQUER : node scripts/fix-garantie-rembourse-ambato.js --apply [chemin_base]
 *      (backup horodaté + transaction + PRAGMA integrity_check automatiques)
 *   4. Relancer le serveur.
 * Idempotent : une unité déjà 'retire' est ignorée.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DB_PATH = args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', 'database.sqlite');

// Les 9 pièces AMBATO du lot erroné du 2026-08-25 10:24:25.
const IDS = [6013, 6014, 6035, 5796, 5798, 5801, 5802, 5809, 5811];
// Statuts « raisonnables » à basculer en remboursé. On NE touche PAS 'vendu' (vente en cours) ni 'retire' (déjà fait).
const SAFE = ['garantie_retournee', 'retour_fournisseur', 'garantie_a_renvoyer', 'garantie_fournisseur',
              'stock', 'presentoir', 'reserve', 'consignation', 'retour_attente'];
const REASON = 'Retour déclaré par erreur — le fournisseur AMBATO a remboursé (correction). Sort de la garantie.';

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

async function recordMovement(u, from, to, action, note, now) {
    await run(`INSERT INTO unit_movements (unit_id, serial, from_status, to_status, action, user_id, user_name, ref_type, ref_id, note, created_at)
               VALUES (?,?,?,?,?, NULL, 'Correction audit', 'garantie', NULL, ?, ?)`,
        [u.id, u.serial, from, to, action, note, now]);
}
async function logGarantieRembourse(u, now) {
    await run(`INSERT INTO garantie_actions (unit_id, serial, supplier_id, supplier_name, garantie_type, action, sender_name, technician_name, reason, amount, user_id, user_name, created_at)
               VALUES (?,?,?,?, 'fournisseur', 'rembourse', NULL, NULL, ?, 0, NULL, 'Correction audit', ?)`,
        [u.id, u.serial, u.supplier_id || null, u.supplier_name || null, REASON, now]);
}

(async () => {
    console.log(`Base : ${DB_PATH}`);
    console.log(`Mode : ${APPLY ? 'APPLIQUER (écriture)' : 'DRY-RUN (lecture seule)'}\n`);

    const ph = IDS.map(() => '?').join(',');
    const rows = await all(
        `SELECT u.id, u.serial, u.status, u.location, u.supplier_id, s.name AS supplier_name, p.name AS product
         FROM stock_units u LEFT JOIN suppliers s ON s.id = u.supplier_id LEFT JOIN products p ON p.id = u.product_id
         WHERE u.id IN (${ph})`, IDS);
    const byId = new Map(rows.map(r => [r.id, r]));

    const plan = [], skip = [];
    for (const id of IDS) {
        const u = byId.get(id);
        if (!u) { skip.push({ id, why: 'introuvable' }); continue; }
        if (u.status === 'retire') { skip.push({ id, serial: u.serial, why: 'déjà remboursé/retiré' }); continue; }
        if (u.status === 'vendu') { skip.push({ id, serial: u.serial, why: '⚠️ VENDU — non touché (vérifier manuellement)' }); continue; }
        if (!SAFE.includes(u.status)) { skip.push({ id, serial: u.serial, why: `statut inattendu « ${u.status} » — non touché` }); continue; }
        plan.push(u);
    }

    console.log(`== À REMBOURSER (${plan.length}) ==`);
    plan.forEach((u, i) => console.log(`  ${String(i + 1).padStart(2)}. unit ${u.id} · ${u.serial} · ${u.product} · ${u.supplier_name} · statut actuel « ${u.status} » → retire/remboursé`));
    if (skip.length) { console.log(`\n== IGNORÉ (${skip.length}) ==`); skip.forEach(s => console.log(`   unit ${s.id}${s.serial ? ' · ' + s.serial : ''} : ${s.why}`)); }

    if (!APPLY) { console.log(`\n(DRY-RUN) Aucune écriture. Appliquer : node scripts/fix-garantie-rembourse-ambato.js --apply`); db.close(); return; }
    if (!plan.length) { console.log('\nRien à appliquer.'); db.close(); return; }

    const backup = DB_PATH + '.bak-' + mgNow().replace(/[: ]/g, '-') + '-avant-rembourse-ambato';
    fs.copyFileSync(DB_PATH, backup);
    console.log('\nBackup créé :', backup);

    const now = mgNow();
    await run('BEGIN');
    try {
        for (const u of plan) {
            // Vérif « live » du statut (au cas où il aurait changé depuis la lecture).
            const cur = await get('SELECT status FROM stock_units WHERE id = ?', [u.id]);
            if (!cur || cur.status === 'retire' || cur.status === 'vendu' || !SAFE.includes(cur.status)) { console.log(`  ⊘ ignoré (état changé) unit ${u.id} (${cur ? cur.status : 'absent'})`); continue; }
            const note = 'Remboursé par le fournisseur : 0 Ar — ' + REASON;
            await run(`UPDATE stock_units SET status = 'retire', location = 'retire', holder_user_id = NULL, note = ?, updated_at = ? WHERE id = ?`, [note, now, u.id]);
            await recordMovement(u, cur.status, 'retire', 'rembourse', note, now);
            await logGarantieRembourse(u, now);
            console.log(`  ✔ unit ${u.id} · ${u.serial} : « ${cur.status} » → remboursé (retire)`);
        }
        await run('COMMIT');
    } catch (e) { await run('ROLLBACK'); console.error('ROLLBACK —', e.message); db.close(); process.exit(1); }

    const ic = await get('PRAGMA integrity_check');
    console.log('\nintegrity_check :', ic.integrity_check || JSON.stringify(ic));
    console.log('\n✅ Terminé. Les pièces AMBATO remboursées apparaissent dans l\'historique des garanties (action « Remboursé »).');
    db.close();
})().catch(e => { console.error('ERREUR :', e.message); process.exit(1); });
