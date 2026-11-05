/* ============================================================
   STOCKFLOW — Rapports PDF A4 (et classeur Excel jumeau).
   Identité commune à tous les documents de la société (bleu marine
   + liseré doré, comme factures et proformas) : en-tête société
   (logo aux bonnes proportions, NIF/STAT), titre + période + « édité
   par », encadrés de synthèse, tableaux (en-tête répété à chaque page,
   montants alignés à droite, totaux), pied « Page x / n ».

   Usage :
     await SFReport.build({
       company,                 // objet /api/config
       title, period, filename, orientation ('landscape' par défaut | 'portrait'),
       summary: [{label, value}],
       sections: [{ heading, note, columns:[{header,key,width,align,format}], rows, totals }],
       note, footer
     });
   Même description → Excel : SFReport.excel(opts), ou depuis un bouton :
     SFReport.as('xlsx', () => Page.exportPDF())
   ============================================================ */
(function () {
'use strict';

const PAGE = { landscape: { W: 297, H: 210 }, portrait: { W: 210, H: 297 } };
const M = 12;                                   // marges latérales (mm)
const NAVY = [30, 58, 95], GOLD = [224, 165, 58], INK = [36, 50, 68], MUTED = [107, 119, 135];
const LINE = [223, 228, 234], ZEBRA = [247, 249, 251], SOFT = [244, 246, 249], TOTAL_BG = [234, 239, 246];

// ---- Texte : les polices standard du PDF ne connaissent que l'alphabet Windows-1252. ----
// Sans ce filtre, une espace fine (montants « 1 250 000 Ar ») ou une flèche donnent
// « 1/250/000 Ar » et une ligne entière aux lettres espacées.
const WINANSI = new Set([0x20AC, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017D,
    0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x017E, 0x0178]);
const SUBST = { '→': '›', '⇒': '›', '➜': '›', '➔': '›', '⟶': '›', '←': '‹', '⇐': '‹', '↑': '', '↓': '', '✓': 'OK', '✔': 'OK',
    '✗': 'x', '✘': 'x', '⚠': '!', '≥': '>=', '≤': '<=', '≠': '<>', '−': '-', '‑': '-', '″': '"', '′': "'", '…': '…' };
function clean(s) {
    let out = '';
    for (const ch of String(s == null ? '' : s).replace(/[  -​  　]/g, ' ')) {
        const cp = ch.codePointAt(0);
        if (cp < 256 || WINANSI.has(cp)) out += ch;
        else if (SUBST[ch] != null) out += SUBST[ch];
    }
    return out;
}

const fmtNum = n => new Intl.NumberFormat('fr-FR').format(Math.round(Number(n) || 0)).replace(/[  ]/g, ' ');
const nowStr = () => new Date().toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(' ', ' à ');
const MONEY_RE = /^[-−]?\s*\d[\d\s  .,]*\s?Ar$/;
const SHORTNUM_RE = /^[-−]?\d[\d\s  ]{0,6}$/;
const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(?:à\s+)?(\d{2}):(\d{2}))?$/;

function today() { return (window.SF && SF.fmt && SF.fmt.today) ? SF.fmt.today() : new Date().toISOString().slice(0, 10); }
function stampName(name, ext) {
    let n = String(name || 'rapport').replace(/\.(pdf|xlsx?)$/i, '');
    if (!/\d{4}-\d{2}-\d{2}/.test(n)) n += '_' + today();
    return n + '.' + ext;
}
function author() {
    const u = window.SF && SF.Auth && SF.Auth.user;
    return u ? (u.full_name || u.username || '') : '';
}

// Logo : récupéré, ré-encodé en PNG (jsPDF ne lit ni WEBP ni SVG) et mesuré (proportions).
async function loadLogo(url) {
    try {
        const res = await fetch(url); if (!res.ok) return null;
        const blob = await res.blob();
        const src = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = () => r(null); fr.readAsDataURL(blob); });
        if (!src) return null;
        const img = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = src; });
        if (!img || !img.naturalWidth) return null;
        const k = Math.min(1, 600 / img.naturalWidth);
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.naturalWidth * k); cv.height = Math.round(img.naturalHeight * k);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        return { data: cv.toDataURL('image/png'), ratio: img.naturalWidth / img.naturalHeight };
    } catch (e) { return null; }
}

// Valeur affichée d'une cellule : nettoyée pour le PDF ; pour Excel, texte intégral
// (seules les espaces spéciales sont normalisées).
function cellText(col, r, forExcel) {
    const v = typeof col.format === 'function' ? col.format(r[col.key], r) : r[col.key];
    const s = v == null ? '' : String(v);
    return forExcel ? s.replace(/[  -​  　]/g, ' ') : clean(s);
}
// Colonnes de montants (ou de petits nombres) → alignées à droite, sauf choix explicite.
function autoAlign(cols, disp) {
    cols.forEach((col, ci) => {
        if (col.align) return;
        const vals = disp.map(d => d[ci]).filter(v => v && v !== '—' && v !== '-');
        if (!vals.length) return;
        const num = vals.filter(v => MONEY_RE.test(v) || SHORTNUM_RE.test(v)).length;
        if (num / vals.length >= 0.8) col.align = 'right';
    });
}

let xlsxReady = null;
function loadXlsx() {
    if (window.SFXlsx) return Promise.resolve();
    if (!xlsxReady) xlsxReady = new Promise((ok, ko) => {
        const s = document.createElement('script'); s.src = '/js/sf-xlsx.js';
        s.onload = ok; s.onerror = () => { xlsxReady = null; ko(new Error('Module Excel indisponible')); };
        document.head.appendChild(s);
    });
    return xlsxReady;
}

window.SFReport = {
    fmtNum,
    ar: n => fmtNum(n) + ' Ar',
    clean,
    loadXlsx,
    stampName,
    editedLine: () => 'Édité le ' + nowStr() + (author() ? ' par ' + author() : ''),
    _fmt: null,

    // Exécute une fonction d'export de page dans un autre format (ex. 'xlsx').
    async as(fmt, fn) {
        this._fmt = fmt;
        try { await fn(); } finally { this._fmt = null; }
    },

    async build(opts) {
        if (this._fmt === 'xlsx') return this.excel(opts);
        try { await SF.needPDF(); } catch (e) { SF.toast(e.message, 'error'); return; }
        const { jsPDF } = window.jspdf;
        const orient = opts.orientation === 'portrait' ? 'portrait' : 'landscape';
        const { W, H } = PAGE[orient];
        const CW = W - 2 * M, BOTTOM = H - 15;
        const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: orient });
        const c = opts.company || {};
        const who = author();
        const logo = c.logo ? await loadLogo(c.logo) : null;
        const T = clean;
        doc.setProperties({ title: T(opts.title || 'Rapport'), subject: T(opts.period || ''), author: T(c.name || 'STOCKFLOW'), creator: 'STOCKFLOW' });
        doc.setLineHeightFactor(1.15);

        // ---- En-tête : complet en page 1, réduit ensuite ----
        const header = first => {
            doc.setFillColor(...GOLD).rect(0, 0, W, 2, 'F');
            doc.setFillColor(...NAVY).rect(0, 2, W, 0.8, 'F');
            const y = 10;
            if (!first) {
                doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(...NAVY).text(T(c.name || 'STOCKFLOW'), M, y + 2);
                doc.setFont('helvetica', 'normal').setFontSize(8.5).setTextColor(...MUTED)
                    .text(T([opts.title, opts.period].filter(Boolean).join('  ·  ')), W - M, y + 2, { align: 'right' });
                doc.setDrawColor(...LINE).setLineWidth(0.3).line(M, y + 5, W - M, y + 5);
                return y + 11;
            }
            let tx = M;
            if (logo) {
                const lh = 16, lw = Math.min(40, lh * logo.ratio), h = lw / logo.ratio;
                try { doc.addImage(logo.data, 'PNG', M, y - 1, lw, h); tx = M + lw + 4; } catch (e) {}
            }
            doc.setFont('helvetica', 'bold').setFontSize(14).setTextColor(...NAVY).text(T(c.name || 'STOCKFLOW'), tx, y + 4);
            doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...MUTED);
            let ly = y + 9;
            [c.address, [c.phone, c.email].filter(Boolean).join('  ·  '),
             [c.nif ? 'NIF ' + c.nif : '', c.stat ? 'STAT ' + c.stat : '', c.rcs ? 'RCS ' + c.rcs : ''].filter(Boolean).join('  ·  ')]
                .filter(Boolean).forEach(l => { doc.text(T(l), tx, ly); ly += 3.7; });
            doc.setFont('helvetica', 'bold').setFontSize(16).setTextColor(...NAVY).text(T(opts.title || 'Rapport'), W - M, y + 4.5, { align: 'right' });
            let ry = y + 10;
            if (opts.period) { doc.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(...INK).text(T(opts.period), W - M, ry, { align: 'right' }); ry += 4.4; }
            doc.setFont('helvetica', 'normal').setFontSize(7.8).setTextColor(...MUTED)
                .text(T('Édité le ' + nowStr() + (who ? ' par ' + who : '')), W - M, ry, { align: 'right' });
            ry += 3.7;
            const bottom = Math.max(ly, ry, logo ? y + 16 : y + 12) + 1.5;
            doc.setDrawColor(...NAVY).setLineWidth(0.45).line(M, bottom, W - M, bottom).setLineWidth(0.2);
            return bottom + 6;
        };

        let y = header(true);
        const newPage = () => { doc.addPage(); y = header(false); };
        const ensure = need => { if (y + need > BOTTOM) { newPage(); return true; } return false; };

        // ---- Encadrés de synthèse ----
        const sum = (opts.summary || []).filter(s => s && s.label != null);
        if (sum.length) {
            const perRow = Math.min(sum.length, orient === 'landscape' ? 5 : 3), gap = 3, bh = 15;
            const bw = (CW - gap * (perRow - 1)) / perRow;
            const nRows = Math.ceil(sum.length / perRow);
            ensure(nRows * (bh + gap));
            sum.forEach((s, i) => {
                const col = i % perRow, row = Math.floor(i / perRow);
                const bx = M + col * (bw + gap), by = y + row * (bh + gap);
                doc.setFillColor(...SOFT).setDrawColor(...LINE).roundedRect(bx, by, bw, bh, 1.5, 1.5, 'FD');
                doc.setFillColor(...NAVY).rect(bx, by + 2.5, 0.9, bh - 5, 'F');
                doc.setFont('helvetica', 'normal').setFontSize(7).setTextColor(...MUTED).text(T(String(s.label).toUpperCase()), bx + 3.5, by + 5.2);
                const val = T(s.value == null ? '—' : s.value);
                let fs = 11.5;
                doc.setFont('helvetica', 'bold');
                while (fs > 7.5 && doc.getStringUnitWidth(val) * fs / doc.internal.scaleFactor > bw - 6) fs -= 0.5;
                doc.setFontSize(fs).setTextColor(...NAVY).text(val, bx + 3.5, by + 11.3);
            });
            y += nRows * (bh + gap) + 4;
        }

        // ---- Sections (tableaux) ----
        for (const sec of (opts.sections || [])) {
            const cols = (sec.columns || []).map(col => Object.assign({}, col));
            const rows = sec.rows || [];
            const disp = rows.map(r => cols.map(col => cellText(col, r)));
            autoAlign(cols, disp);
            const totalW = cols.reduce((s, col) => s + (col.width || 10), 0);
            cols.forEach(col => col._w = (col.width || 10) * CW / totalW);
            const PAD = 2, LH = 3.55, FS = 8;

            const tableHead = () => {
                const lines = cols.map(col => doc.setFont('helvetica', 'bold').setFontSize(7.4).splitTextToSize(T(String(col.header || '').toUpperCase()), col._w - 2 * PAD));
                const hh = Math.max(7.2, Math.max(...lines.map(l => l.length)) * 3.2 + 3.6);
                doc.setFillColor(...NAVY).rect(M, y, CW, hh, 'F');
                doc.setTextColor(255, 255, 255);
                let xx = M;
                cols.forEach((col, ci) => {
                    const tx = col.align === 'right' ? xx + col._w - PAD : (col.align === 'center' ? xx + col._w / 2 : xx + PAD);
                    doc.text(lines[ci], tx, y + 4.6, { align: col.align || 'left' });
                    xx += col._w;
                });
                y += hh;
            };

            ensure(22);
            doc.setFillColor(...GOLD).rect(M, y - 3.3, 1.3, 4.6, 'F');
            doc.setFont('helvetica', 'bold').setFontSize(10.5).setTextColor(...NAVY).text(T(sec.heading || ''), M + 3.2, y);
            if (rows.length) {
                const hw = doc.getStringUnitWidth(T(sec.heading || '')) * 10.5 / doc.internal.scaleFactor;
                doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...MUTED).text(`${rows.length} ligne${rows.length > 1 ? 's' : ''}`, M + 3.2 + hw + 3, y);
            }
            y += 4;
            if (sec.note) { doc.setFont('helvetica', 'italic').setFontSize(8).setTextColor(...MUTED).text(T(sec.note), M + 3.2, y + 0.5); y += 4.5; }
            y += 1;
            tableHead();

            doc.setFont('helvetica', 'normal').setFontSize(FS).setTextColor(...INK);
            rows.forEach((r, idx) => {
                const cells = cols.map((col, ci) => doc.splitTextToSize(disp[idx][ci], col._w - 2 * PAD));
                const rh = Math.max(6.4, Math.max(1, ...cells.map(l => l.length)) * LH + 2.8);
                if (ensure(rh)) { tableHead(); doc.setFont('helvetica', 'normal').setFontSize(FS).setTextColor(...INK); }
                if (idx % 2 === 1) doc.setFillColor(...ZEBRA).rect(M, y, CW, rh, 'F');
                let xx = M;
                cols.forEach((col, ci) => {
                    const tx = col.align === 'right' ? xx + col._w - PAD : (col.align === 'center' ? xx + col._w / 2 : xx + PAD);
                    doc.text(cells[ci], tx, y + 4.2, { align: col.align || 'left' });
                    xx += col._w;
                });
                doc.setDrawColor(...LINE).setLineWidth(0.15).line(M, y + rh, W - M, y + rh);
                y += rh;
            });
            if (!rows.length) {
                doc.setFont('helvetica', 'italic').setFontSize(8.5).setTextColor(...MUTED).text('Aucune donnée sur cette période.', M + PAD, y + 4.6);
                y += 7;
            }
            if (sec.totals) {
                const tcells = cols.map(col => T(sec.totals[col.key] != null ? sec.totals[col.key] : ''));
                ensure(7.5);
                doc.setFillColor(...TOTAL_BG).rect(M, y, CW, 7.5, 'F');
                doc.setDrawColor(...NAVY).setLineWidth(0.35).line(M, y, W - M, y).setLineWidth(0.2);
                doc.setFont('helvetica', 'bold').setFontSize(8.3).setTextColor(...NAVY);
                let xx = M;
                cols.forEach((col, ci) => {
                    const tx = col.align === 'right' ? xx + col._w - PAD : (col.align === 'center' ? xx + col._w / 2 : xx + PAD);
                    if (tcells[ci]) doc.text(tcells[ci], tx, y + 4.9, { align: col.align || 'left' });
                    xx += col._w;
                });
                y += 7.5;
            }
            y += 8;
        }

        // ---- Remarque (optionnelle) ----
        if (opts.note) {
            const lines = doc.setFont('helvetica', 'italic').setFontSize(8.3).splitTextToSize(T(opts.note), CW - 8);
            const bh = lines.length * 3.8 + 5;
            ensure(bh + 2);
            doc.setFillColor(...SOFT).setDrawColor(...LINE).roundedRect(M, y, CW, bh, 1.5, 1.5, 'FD');
            doc.setTextColor(...MUTED).text(lines, M + 4, y + 5);
            y += bh + 4;
        }

        // ---- Pied de page sur toutes les pages : société · titre | Page x / n ----
        const n = doc.getNumberOfPages();
        for (let i = 1; i <= n; i++) {
            doc.setPage(i);
            doc.setDrawColor(...LINE).setLineWidth(0.2).line(M, H - 10, W - M, H - 10);
            doc.setFont('helvetica', 'normal').setFontSize(7.5).setTextColor(...MUTED);
            doc.text(T([c.name || 'STOCKFLOW', opts.title].filter(Boolean).join('  ·  ')), M, H - 6);
            if (opts.footer) doc.text(T(opts.footer), W / 2, H - 6, { align: 'center' });
            doc.text(`Page ${i} / ${n}`, W - M, H - 6, { align: 'right' });
        }
        doc.save(stampName(opts.filename, 'pdf'));
        if (window.SF) SF.toast('Rapport PDF généré', 'success');
    },

    // Même rapport en classeur Excel : synthèse + un tableau par section (valeurs typées :
    // montants et nombres en vraies cellules numériques, dates en dates Excel).
    async excel(opts) {
        try { await loadXlsx(); } catch (e) { if (window.SF) SF.toast(e.message, 'error'); return; }
        const c = opts.company || {}, who = author();
        const T = v => String(v == null ? '' : v);
        const meta = 'Édité le ' + nowStr() + (who ? ' par ' + who : '');
        const typed = (display, raw) => {
            const d = String(display == null ? '' : display).replace(/[  -​  　]/g, ' ').trim();
            if (!d) return { v: '', s: 'text' };
            if (MONEY_RE.test(d)) { const n = Number(d.replace(/Ar$/, '').replace(/[−]/g, '-').replace(/[^\d-]/g, '')); if (isFinite(n)) return { v: n, s: 'money' }; }
            const m = d.match(DATE_RE);
            if (m) return { v: SFXlsx.excelDate(m[1], m[2], m[3], m[4], m[5]), s: m[4] ? 'datetime' : 'date' };
            if (typeof raw === 'number' && d.replace(/[\s  ]/g, '') === String(raw)) return { v: raw, s: 'num' };
            return { v: d, s: 'text' };
        };
        const sections = opts.sections || [];
        const sum = (opts.summary || []).filter(s => s && s.label != null);
        const head = (title, sub, ncol) => {
            const rows = [[{ v: T(c.name || 'STOCKFLOW'), s: 'section' }], [{ v: T(title), s: 'title' }]];
            if (sub) rows.push([{ v: T(sub), s: 'subtitle' }]);
            rows.push([{ v: T(meta), s: 'meta' }]);
            const merges = rows.map((_, i) => `A${i + 1}:${SFXlsx.colName(Math.max(1, ncol) - 1)}${i + 1}`);
            return { rows, merges };
        };
        const tableSheet = (sec, withSummary) => {
            const cols = sec.columns || [];
            const n = cols.length;
            const h = head(opts.title || 'Rapport', [opts.period, sections.length > 1 ? sec.heading : ''].filter(Boolean).join('  ·  '), Math.max(n, 2));
            const rows = h.rows; rows.push([]);
            if (withSummary && sum.length) {
                sum.forEach(s => { const t = typed(s.value, s.value); rows.push([{ v: T(s.label), s: 'sumLabel' }, { v: t.v, s: t.s === 'money' ? 'sumMoney' : 'sumValue' }]); });
                rows.push([]);
            }
            const headRow = rows.length + 1;
            const disp = (sec.rows || []).map(r => cols.map(col => ({ d: cellText(col, r, true), raw: r[col.key] })));
            const isNum = cols.map((col, ci) => disp.length > 0 && disp.filter(x => x[ci].d && x[ci].d !== '—').every(x => ['money', 'num'].includes(typed(x[ci].d, x[ci].raw).s)));
            rows.push(cols.map((col, ci) => ({ v: T(col.header || ''), s: isNum[ci] ? 'headR' : 'head' })));
            disp.forEach(line => rows.push(line.map(x => typed(x.d, x.raw))));
            if (sec.totals) rows.push(cols.map((col, ci) => {
                const t = typed(sec.totals[col.key] != null ? sec.totals[col.key] : '', sec.totals[col.key]);
                return { v: t.v, s: t.s === 'money' ? 'totMoney' : (t.s === 'num' ? 'totNum' : 'totText') };
            }));
            const widths = cols.map((col, ci) => {
                const len = Math.max(String(col.header || '').length, ...disp.slice(0, 400).map(x => Math.min(60, x[ci].d.length)));
                return Math.max(9, Math.min(60, len + 3));
            });
            const lastRow = headRow + disp.length;
            return {
                name: sections.length > 1 ? String(sec.heading || 'Détail').replace(/\s*\(.*$/, '') : (opts.title || 'Rapport'),
                rows, widths, merges: h.merges, freezeRow: headRow, heights: { [headRow]: 22, 2: 22 },
                filter: disp.length ? `A${headRow}:${SFXlsx.colName(n - 1)}${lastRow}` : null
            };
        };
        const sheets = [];
        if (sections.length > 1 && sum.length) {
            const h = head(opts.title || 'Rapport', opts.period, 2);
            const rows = h.rows; rows.push([]);
            sum.forEach(s => { const t = typed(s.value, s.value); rows.push([{ v: T(s.label), s: 'sumLabel' }, { v: t.v, s: t.s === 'money' ? 'sumMoney' : 'sumValue' }]); });
            sheets.push({ name: 'Synthèse', rows, widths: [34, 24], merges: h.merges, heights: { 2: 22 } });
        }
        sections.forEach(sec => sheets.push(tableSheet(sec, sections.length === 1)));
        if (!sheets.length) { if (window.SF) SF.toast('Rien à exporter', 'error'); return; }
        SFXlsx.download(stampName(opts.filename, 'xlsx'), {
            title: T(opts.title || 'Rapport'), author: T(c.name || 'STOCKFLOW'),
            footer: T([c.name || 'STOCKFLOW', opts.title].filter(Boolean).join(' · ')), sheets
        });
        if (window.SF) SF.toast('Classeur Excel généré', 'success');
    }
};
})();
