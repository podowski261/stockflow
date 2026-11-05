/* =====================================================================
   STOCKFLOW — Attribution d'un n° de série UNIQUE aux accessoires encore
   identifiés par le code de modèle partagé « A000xxx » (serial NULL).

   Format identique à la réception : AAMMJJ + séquence du jour (4 chiffres),
   ex. 2610130001. Seules les pièces encore présentes (stock, boutique,
   réservées, en livraison…) sont numérotées ; les pièces vendues/retirées
   gardent leur historique tel quel.

   Pour chaque pièce :
     - stock_units.serial = nouveau n°
     - lignes liées encore actives (sale_items, layaway_items, reservation_items,
       consignment_items, install_items) : serial vide/code A → nouveau n°
     - livraison en cours : 1re occurrence du code A dans delivery_items → nouveau n°
     - journal unit_movements (action « attribution_serie », ancien code en note)

   Usage (SERVEUR ARRÊTÉ) :
     node scripts/serialize-accessoires.js <database.sqlite>                → simulation
     node scripts/serialize-accessoires.js <database.sqlite> --apply        → applique
       options : --date AAAA-MM-JJ (défaut : aujourd'hui, Madagascar)
                 --out labels.json  (liste des pièces numérotées, pour les étiquettes)
   Une sauvegarde <db>.bak-<horodatage>-avant-serial-acc est créée avant --apply.
   ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const args = process.argv.slice(2);
const dbPath = args.find(a => !a.startsWith('--'));
const apply = args.includes('--apply');
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
if (!dbPath || !fs.existsSync(dbPath)) { console.error('Base introuvable : ' + dbPath); process.exit(1); }

const mgNow = () => new Date(Date.now() + 3 * 3600 * 1000);
const p2 = n => String(n).padStart(2, '0');
const nowStr = () => { const d = mgNow(); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`; };
const date = opt('--date') || nowStr().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error('Date invalide : ' + date); process.exit(1); }
const prefix = date.slice(2).replace(/-/g, '');            // AAMMJJ
const accCode = pid => 'A' + String(pid).padStart(6, '0');
const ACTIVE = ['stock', 'consignation', 'reserve', 'acompte', 'livraison', 'preparation', 'presentoir'];
const LINKED = ['sale_items', 'layaway_items', 'reservation_items', 'consignment_items', 'install_items'];

if (apply) {
    const ts = nowStr().replace(/[- :]/g, '').replace(/^(\d{8})(\d{6})$/, '$1-$2');
    const bak = `${dbPath}.bak-${ts}-avant-serial-acc`;
    fs.copyFileSync(dbPath, bak);
    console.log('Sauvegarde : ' + bak);
}

const db = new sqlite3.Database(dbPath);
const run = (sql, p = []) => new Promise((ok, ko) => db.run(sql, p, function (e) { e ? ko(e) : ok(this); }));
const get = (sql, p = []) => new Promise((ok, ko) => db.get(sql, p, (e, r) => e ? ko(e) : ok(r)));
const all = (sql, p = []) => new Promise((ok, ko) => db.all(sql, p, (e, r) => e ? ko(e) : ok(r || [])));

(async () => {
    const units = await all(
        `SELECT u.id, u.product_id, u.status, u.sale_price AS unit_price, u.created_at,
                p.name AS product_name, p.brand, p.model, p.category, p.subcategory, p.description,
                p.sale_price AS product_price, p.is_accessory, p.emplacement
         FROM stock_units u JOIN products p ON p.id = u.product_id
         WHERE p.is_accessory = 1 AND (u.serial IS NULL OR u.serial = '')
           AND u.status IN (${ACTIVE.map(() => '?').join(',')})
         ORDER BY p.name COLLATE NOCASE, u.id`, ACTIVE);
    const mx = await get(`SELECT MAX(CAST(substr(serial, 7) AS INTEGER)) AS mx FROM stock_units WHERE serial GLOB ?`, [prefix + '[0-9]*']);
    let seq = (mx && mx.mx) || 0;
    if (seq + units.length > 9999) throw new Error(`Séquence du jour insuffisante (${seq} + ${units.length} > 9999)`);

    const cols = {};
    for (const t of LINKED) cols[t] = (await all(`PRAGMA table_info(${t})`)).map(c => c.name);
    const byStatus = {};
    units.forEach(u => { byStatus[u.status] = (byStatus[u.status] || 0) + 1; });
    console.log(`${units.length} pièce(s) à numéroter, préfixe ${prefix}, à partir de ${prefix}${String(seq + 1).padStart(4, '0')}`, byStatus);

    const out = [], now = nowStr();
    if (apply) await run('BEGIN IMMEDIATE');
    try {
        for (const u of units) {
            seq++;
            const serial = prefix + String(seq).padStart(4, '0'), code = accCode(u.product_id);
            out.push({ id: u.id, serial, old_code: code, status: u.status, product_id: u.product_id, product_name: u.product_name,
                       brand: u.brand, model: u.model, category: u.category, subcategory: u.subcategory, description: u.description,
                       is_accessory: 1, emplacement: u.emplacement, sale_price: u.unit_price || u.product_price || 0 });
            if (!apply) continue;
            await run(`UPDATE stock_units SET serial = ?, updated_at = ? WHERE id = ? AND (serial IS NULL OR serial = '')`, [serial, now, u.id]);
            for (const t of LINKED) {
                if (!cols[t].includes('unit_id') || !cols[t].includes('serial')) continue;
                const extra = cols[t].includes('returned') ? ' AND returned = 0' : '';
                await run(`UPDATE ${t} SET serial = ? WHERE unit_id = ? AND (serial IS NULL OR serial = '' OR serial = ?)${extra}`, [serial, u.id, code]);
            }
            if (u.status === 'livraison') {
                const d = await get(`SELECT d.id FROM sale_items si JOIN deliveries d ON d.sale_id = si.sale_id
                                     WHERE si.unit_id = ? AND si.returned = 0 ORDER BY d.id DESC LIMIT 1`, [u.id]);
                if (d) {
                    const di = await get(`SELECT id, serial FROM delivery_items WHERE delivery_id = ? AND product_id = ? AND serial LIKE ? LIMIT 1`, [d.id, u.product_id, '%' + code + '%']);
                    if (di) await run(`UPDATE delivery_items SET serial = ? WHERE id = ?`, [String(di.serial).replace(code, serial), di.id]);
                }
            }
            await run(`INSERT INTO unit_movements (unit_id, serial, from_status, to_status, action, user_id, user_name, ref_type, ref_id, note, created_at)
                       VALUES (?, ?, ?, ?, 'attribution_serie', NULL, 'système', NULL, NULL, ?, ?)`,
                [u.id, serial, u.status, u.status, `N° de série unique attribué (ancien code modèle ${code})`, now]);
        }
        if (apply) await run('COMMIT');
    } catch (e) { if (apply) await run('ROLLBACK').catch(() => {}); throw e; }

    if (apply) {
        const ic = await get('PRAGMA integrity_check');
        const left = await get(`SELECT COUNT(*) AS n FROM stock_units u JOIN products p ON p.id = u.product_id
                                WHERE p.is_accessory = 1 AND (u.serial IS NULL OR u.serial = '') AND u.status IN (${ACTIVE.map(() => '?').join(',')})`, ACTIVE);
        console.log('integrity_check :', ic && ic.integrity_check, '· restant sans n° :', left.n);
    }
    const outFile = opt('--out');
    if (outFile) { fs.writeFileSync(outFile, JSON.stringify(out)); console.log('Liste écrite : ' + path.resolve(outFile)); }
    console.log(apply ? 'Terminé.' : 'Simulation uniquement (ajoutez --apply).');
    db.close();
})().catch(e => { console.error('ERREUR :', e.message); db.close(); process.exit(1); });
