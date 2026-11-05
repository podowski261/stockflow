#!/usr/bin/env node
/**
 * Corrige les FUITES « vendu → redevenu vendable » : un ordinateur possède une vente
 * VALIDE (statut 'completed', ligne non retournée = argent encaissé) mais son unité est
 * repassée en statut VENDABLE (stock / préparation / présentoir / consignation / réservé…).
 *
 * Cause connue : le retour d'une livraison ANNULÉE (return-confirm) remettait TOUTE unité
 * de la livraison en 'stock', même une unité déjà REVENDUE entre-temps sur une autre vente
 * — écrasant la vente valide. L'ordinateur redevenait vendable alors qu'il était déjà payé
 * (ni vu par la caisse sur la nouvelle vente, ni « vendu » côté stock → risque de falsification).
 * Le garde-fou est désormais posé dans server.js (return-confirm) ; ce script répare l'existant.
 *
 * Le correctif rétablit l'unité en 'vendu' (conforme à sa vente 'completed' active) et trace
 * un mouvement 'admin_correction'.
 *
 * PROCÉDURE SÛRE (obligatoire sur la base de PRODUCTION) :
 *   1. Arrêter le serveur STOCKFLOW (sinon base verrouillée / écriture concurrente).
 *   2. DRY-RUN d'abord (n'écrit RIEN, liste seulement les cas) :
 *        node scripts/fix-fuites-vente.js [chemin_base]
 *   3. Vérifier la liste, puis APPLIQUER :
 *        node scripts/fix-fuites-vente.js --apply [chemin_base]
 *      - backup horodaté créé automatiquement avant toute écriture ;
 *      - tout dans UNE transaction (rollback si erreur) ;
 *      - PRAGMA integrity_check lancé à la fin.
 *   4. Relancer le serveur.
 *
 * Idempotent : relancer après correction ne trouve plus rien.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DB_PATH = args.find(a => !a.startsWith('--')) || path.join(__dirname, '..', 'database.sqlite');

// Statuts « vendable » : une unité ici ne peut PAS avoir de vente 'completed' active.
const SELLABLE = ['stock', 'preparation', 'presentoir', 'acompte', 'consignation', 'reserve'];

// Horodatage heure Madagascar (UTC+3), même format que server.js (getDateTime).
function mgNow() {
    const d = new Date(Date.now() + 3 * 3600 * 1000), p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
         + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

if (!fs.existsSync(DB_PATH)) { console.error('Base introuvable :', DB_PATH); process.exit(1); }

const db = new sqlite3.Database(DB_PATH, APPLY ? sqlite3.OPEN_READWRITE : sqlite3.OPEN_READONLY);
const run = (s, p = []) => new Promise((res, rej) => db.run(s, p, function (e) { e ? rej(e) : res(this); }));
const get = (s, p = []) => new Promise((res, rej) => db.get(s, p, (e, x) => e ? rej(e) : res(x || {})));
const all = (s, p = []) => new Promise((res, rej) => db.all(s, p, (e, x) => e ? rej(e) : res(x)));

(async () => {
    console.log(`Base   : ${DB_PATH}`);
    console.log(`Mode   : ${APPLY ? 'APPLIQUER (écriture)' : 'DRY-RUN (lecture seule — aucune écriture)'}\n`);

    const ph = SELLABLE.map(() => '?').join(',');
    // Unités VENDABLES qui possèdent au moins une vente 'completed' active (ligne non retournée).
    const leaks = await all(
        `SELECT u.id AS unit_id, u.serial, u.status,
                s.id AS sale_id, s.sale_number, s.channel, s.total, date(s.created_at) AS sday,
                (SELECT COALESCE(SUM(amount),0) FROM sale_payments WHERE sale_id = s.id) AS paid
         FROM stock_units u
         JOIN sale_items si ON si.unit_id = u.id AND si.returned = 0
         JOIN sales s ON s.id = si.sale_id AND s.status = 'completed'
         WHERE u.status IN (${ph})
         ORDER BY u.id`, SELLABLE);

    // Garde-fou anti-faux-positif : une unité avec PLUSIEURS ventes 'completed' actives est une
    // double-vente (anomalie distincte) — on NE corrige PAS automatiquement, on signale.
    const byUnit = new Map();
    leaks.forEach(r => { (byUnit.get(r.unit_id) || byUnit.set(r.unit_id, []).get(r.unit_id)).push(r); });

    const toFix = [], ambiguous = [];
    for (const [unitId, rows] of byUnit) {
        if (rows.length > 1) ambiguous.push({ unitId, rows });
        else toFix.push(rows[0]);
    }

    if (!toFix.length && !ambiguous.length) { console.log('✅ Aucune fuite détectée. Rien à faire.'); db.close(); return; }

    if (toFix.length) {
        console.log(`FUITES à corriger (unité vendable + 1 vente completed active) : ${toFix.length}`);
        toFix.forEach(r => console.log(
            `  unit ${r.unit_id} · ${r.serial || '—'} · statut ${r.status}` +
            `  → Vente #${r.sale_number} (${r.channel}, ${r.total} Ar, encaissé ${r.paid} Ar, ${r.sday}, sale ${r.sale_id})`));
    }
    if (ambiguous.length) {
        console.log(`\n⚠️  AMBIGU — plusieurs ventes completed actives (double-vente, à traiter à la main) : ${ambiguous.length}`);
        ambiguous.forEach(a => console.log(`  unit ${a.unitId} · ${a.rows[0].serial} → ventes ` +
            a.rows.map(r => `#${r.sale_number}(sale ${r.sale_id})`).join(', ')));
    }

    if (!APPLY) {
        console.log(`\n(DRY-RUN) Aucune écriture. Pour appliquer : node scripts/fix-fuites-vente.js --apply ${DB_PATH === path.join(__dirname, '..', 'database.sqlite') ? '' : DB_PATH}`.trim());
        db.close(); return;
    }
    if (!toFix.length) { console.log('\nRien à appliquer automatiquement (cas ambigus uniquement).'); db.close(); return; }

    // Backup horodaté avant toute écriture.
    const stamp = mgNow().replace(/[: ]/g, '-');
    const backup = DB_PATH + '.bak-' + stamp + '-avant-fix-fuites';
    fs.copyFileSync(DB_PATH, backup);
    console.log('\nBackup créé :', backup);

    const now = mgNow();
    await run('BEGIN');
    try {
        for (const r of toFix) {
            await run(`UPDATE stock_units SET status = 'vendu', holder_user_id = NULL, updated_at = ? WHERE id = ? AND status IN (${ph})`,
                [now, r.unit_id, ...SELLABLE]);
            await run(
                `INSERT INTO unit_movements (unit_id, serial, from_status, to_status, action, user_id, user_name, ref_type, ref_id, note, created_at)
                 VALUES (?,?,?,?, 'admin_correction', NULL, 'Correction audit', 'sale', ?, ?, ?)`,
                [r.unit_id, r.serial, r.status, r.sale_id,
                 `Fuite corrigee : unite deja revendue (Vente #${r.sale_number}, ${r.total} Ar) etait repassee en '${r.status}'. Remise en 'vendu'.`,
                 now]);
            console.log(`  ✔ unit ${r.unit_id} (${r.serial}) → vendu`);
        }
        await run('COMMIT');
    } catch (e) { await run('ROLLBACK'); console.error('ROLLBACK —', e.message); db.close(); process.exit(1); }

    const ic = await get('PRAGMA integrity_check');
    console.log('\nintegrity_check :', ic.integrity_check || JSON.stringify(ic));

    // Ré-audit de contrôle.
    const rest = await all(
        `SELECT u.id FROM stock_units u
         JOIN sale_items si ON si.unit_id = u.id AND si.returned = 0
         JOIN sales s ON s.id = si.sale_id AND s.status = 'completed'
         WHERE u.status IN (${ph})`, SELLABLE);
    console.log('Fuites restantes :', rest.length);
    console.log(rest.length ? '⚠️  Des cas subsistent (probablement ambigus — voir ci-dessus).' : '✅ Terminé.');
    db.close();
})().catch(e => { console.error('ERREUR :', e.message); process.exit(1); });
