/* ============================================================
   STOCKFLOW — Classeurs Excel (.xlsx) sans bibliothèque.
   Vrai format Office Open XML (aucun avertissement à l'ouverture) :
   styles (titre, en-têtes, montants « Ar », dates), largeurs de
   colonnes, ligne d'en-tête figée, filtres, mise en page impression
   (paysage, ajusté à la largeur, pied « Page x / n »).

   Usage :
     SFXlsx.download('fichier.xlsx', {
       title, author,
       sheets: [{ name, rows: [[{ v, s }...]...], widths: [..], merges: ['A1:F1'],
                  freezeRow: 4, filter: 'A4:F120', heights: { 4: 22 }, footer }]
     });
   Styles (s) : title, subtitle, meta, section, head, headR, text, money, num,
                date, datetime, totText, totMoney, totNum, sumLabel, sumValue, sumMoney.
   ============================================================ */
(function () {
'use strict';

// ---------------------------------------------------------------- ZIP (sans compression)
const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
})();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

function zip(files) {
    const enc = new TextEncoder();
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const parts = [], central = [];
    let offset = 0;
    files.forEach(f => {
        const name = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
        const crc = crc32(data);
        const lh = new DataView(new ArrayBuffer(30));
        lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
        lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
        lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
        parts.push(lh, name, data);
        const ch = new DataView(new ArrayBuffer(46));
        ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
        ch.setUint16(10, 0, true); ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true);
        ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
        ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true);
        ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
        central.push(ch, name);
        offset += 30 + name.length + data.length;
    });
    const cdSize = central.reduce((t, p) => t + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ---------------------------------------------------------------- XML
// Caractères interdits en XML retirés ; échappement des entités.
const x = s => String(s == null ? '' : s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = i => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

const NAVY = 'FF1E3A5F', GOLD = 'FFE0A53A', INK = 'FF243244', MUTED = 'FF6B7787', LINE = 'FFDFE4EA', SOFT = 'FFF4F6F9', TOTAL = 'FFEAEFF6';
// Index des styles (cellXfs) — l'ordre doit suivre STYLES_XML ci-dessous.
const S = { def: 0, title: 1, subtitle: 2, meta: 3, section: 4, head: 5, headR: 6, text: 7, money: 8, num: 9, date: 10, datetime: 11,
            totText: 12, totMoney: 13, totNum: 14, sumLabel: 15, sumValue: 16, sumMoney: 17 };
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="4"><numFmt numFmtId="164" formatCode="#,##0&quot; Ar&quot;"/><numFmt numFmtId="165" formatCode="#,##0"/><numFmt numFmtId="166" formatCode="dd/mm/yyyy"/><numFmt numFmtId="167" formatCode="dd/mm/yyyy hh:mm"/></numFmts>
<fonts count="7">
 <font><sz val="10"/><color rgb="${INK}"/><name val="Calibri"/><family val="2"/></font>
 <font><b/><sz val="15"/><color rgb="${NAVY}"/><name val="Calibri"/><family val="2"/></font>
 <font><sz val="10"/><color rgb="${INK}"/><name val="Calibri"/><family val="2"/></font>
 <font><i/><sz val="9"/><color rgb="${MUTED}"/><name val="Calibri"/><family val="2"/></font>
 <font><b/><sz val="11"/><color rgb="${NAVY}"/><name val="Calibri"/><family val="2"/></font>
 <font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>
 <font><b/><sz val="10"/><color rgb="${NAVY}"/><name val="Calibri"/><family val="2"/></font>
</fonts>
<fills count="5">
 <fill><patternFill patternType="none"/></fill>
 <fill><patternFill patternType="gray125"/></fill>
 <fill><patternFill patternType="solid"><fgColor rgb="${NAVY}"/><bgColor indexed="64"/></patternFill></fill>
 <fill><patternFill patternType="solid"><fgColor rgb="${TOTAL}"/><bgColor indexed="64"/></patternFill></fill>
 <fill><patternFill patternType="solid"><fgColor rgb="${SOFT}"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="4">
 <border><left/><right/><top/><bottom/><diagonal/></border>
 <border><left style="thin"><color rgb="${LINE}"/></left><right style="thin"><color rgb="${LINE}"/></right><top style="thin"><color rgb="${LINE}"/></top><bottom style="thin"><color rgb="${LINE}"/></bottom><diagonal/></border>
 <border><left style="thin"><color rgb="${LINE}"/></left><right style="thin"><color rgb="${LINE}"/></right><top style="medium"><color rgb="${NAVY}"/></top><bottom style="thin"><color rgb="${LINE}"/></bottom><diagonal/></border>
 <border><left/><right/><top/><bottom style="medium"><color rgb="${GOLD}"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="18">
 <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
 <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
 <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
 <xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
 <xf numFmtId="0" fontId="4" fillId="0" borderId="3" xfId="0" applyFont="1" applyBorder="1"/>
 <xf numFmtId="0" fontId="5" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
 <xf numFmtId="0" fontId="5" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center" wrapText="1"/></xf>
 <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
 <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
 <xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="top"/></xf>
 <xf numFmtId="166" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="top"/></xf>
 <xf numFmtId="167" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="top"/></xf>
 <xf numFmtId="0" fontId="6" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
 <xf numFmtId="164" fontId="6" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
 <xf numFmtId="165" fontId="6" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
 <xf numFmtId="0" fontId="3" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
 <xf numFmtId="0" fontId="6" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>
 <xf numFmtId="164" fontId="6" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function sheetXml(sh, footer) {
    const rows = sh.rows || [];
    const ncol = Math.max(1, ...rows.map(r => r.length));
    const widths = sh.widths || [];
    const cols = Array.from({ length: ncol }, (_, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${Math.max(6, Math.min(70, widths[i] || 14)).toFixed(1)}" customWidth="1"/>`).join('');
    const body = rows.map((r, ri) => {
        const ht = sh.heights && sh.heights[ri + 1];
        const cells = r.map((c, ci) => {
            if (c && c.f) return `<c r="${colName(ci)}${ri + 1}" s="${S[c.s] || 0}"><f>${x(c.f)}</f></c>`;
            if (c == null || c.v == null || c.v === '') return c && c.s ? `<c r="${colName(ci)}${ri + 1}" s="${S[c.s] || 0}"/>` : '';
            const ref = colName(ci) + (ri + 1), st = S[c.s] || 0;
            if (typeof c.v === 'number' && isFinite(c.v)) return `<c r="${ref}" s="${st}"><v>${c.v}</v></c>`;
            return `<c r="${ref}" s="${st}" t="inlineStr"><is><t xml:space="preserve">${x(c.v)}</t></is></c>`;
        }).join('');
        return `<row r="${ri + 1}"${ht ? ` ht="${ht}" customHeight="1"` : ''}>${cells}</row>`;
    }).join('');
    const pane = sh.freezeRow ? `<pane ySplit="${sh.freezeRow}" topLeftCell="A${sh.freezeRow + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${sh.freezeRow + 1}" sqref="A${sh.freezeRow + 1}"/>` : '';
    const merges = (sh.merges || []).length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
    const foot = x(footer || '').replace(/&amp;/g, '&amp;&amp;');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<sheetViews><sheetView workbookViewId="0" showGridLines="0">${pane}</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>${body}</sheetData>
${sh.filter ? `<autoFilter ref="${sh.filter}"/>` : ''}
${merges}
<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.6" header="0.3" footer="0.3"/>
<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>
<headerFooter><oddFooter>&amp;L&amp;8${foot}&amp;R&amp;8Page &amp;P / &amp;N</oddFooter></headerFooter>
</worksheet>`;
}

// Nom de feuille Excel : 31 caractères max, sans []:*?/\ et unique.
function sheetNames(list) {
    const used = new Set();
    return list.map((n, i) => {
        let base = String(n || ('Feuille ' + (i + 1))).replace(/[\[\]:*?\/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || ('Feuille ' + (i + 1));
        let name = base, k = 2;
        while (used.has(name.toLowerCase())) { const suf = ' (' + k++ + ')'; name = base.slice(0, 31 - suf.length) + suf; }
        used.add(name.toLowerCase());
        return name;
    });
}

function build(opts) {
    const sheets = opts.sheets || [];
    const names = sheetNames(sheets.map(s => s.name));
    const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const files = [
        { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>` },
        { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>` },
        { name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${x(opts.title || '')}</dc:title><dc:creator>${x(opts.author || 'STOCKFLOW')}</dc:creator><cp:lastModifiedBy>STOCKFLOW</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>` },
        { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView/></bookViews>
<sheets>${names.map((n, i) => `<sheet name="${x(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
<definedNames>${sheets.map((s, i) => [
    s.filter ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${x(names[i]).replace(/'/g, "''")}'!${s.filter.replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}</definedName>` : '',
    s.freezeRow ? `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">'${x(names[i]).replace(/'/g, "''")}'!$${s.freezeRow}:$${s.freezeRow}</definedName>` : ''
].join('')).join('')}</definedNames>
<calcPr calcId="191029" fullCalcOnLoad="1"/>
</workbook>` },
        { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
        { name: 'xl/styles.xml', data: STYLES_XML }
    ];
    sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s, s.footer || opts.footer || opts.title) }));
    return zip(files);
}

function download(filename, opts) {
    const blob = build(opts);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Feuille « tableau » prête à l'emploi : bandeau (société, titre, sous-titre, édition),
// en-tête figé + filtres, colonnes typées (text | money | num), totaux.
// totals : tableau aligné sur les colonnes ; 'sum' = SOUS.TOTAL qui suit les filtres.
function table(o) {
    const cols = o.columns || [], data = o.rows || [];
    const n = Math.max(2, cols.length);
    const rows = [[{ v: o.company || 'STOCKFLOW', s: 'section' }], [{ v: o.title || '', s: 'title' }]];
    if (o.subtitle) rows.push([{ v: o.subtitle, s: 'subtitle' }]);
    if (o.meta) rows.push([{ v: o.meta, s: 'meta' }]);
    const merges = rows.map((_, i) => `A${i + 1}:${colName(n - 1)}${i + 1}`);
    rows.push([]);
    const headRow = rows.length + 1, first = headRow + 1, last = headRow + data.length;
    const kind = c => (c && (c.type === 'money' || c.type === 'num')) ? c.type : 'text';
    rows.push(cols.map(c => ({ v: c.header, s: kind(c) === 'text' ? 'head' : 'headR' })));
    data.forEach(r => rows.push(r.map((v, i) => ({ v: v == null ? '' : v, s: kind(cols[i]) }))));
    if (o.totals && data.length) rows.push(o.totals.map((t, i) => {
        const k = kind(cols[i]);
        if (t === 'sum') return { f: `SUBTOTAL(9,${colName(i)}${first}:${colName(i)}${last})`, s: k === 'money' ? 'totMoney' : 'totNum' };
        return { v: t == null ? '' : t, s: 'totText' };
    }));
    const widths = cols.map((c, i) => c.width || Math.max(9, Math.min(50, Math.max(String(c.header).length,
        ...data.slice(0, 300).map(r => String(r[i] == null ? '' : r[i]).length)) + 3)));
    return { name: o.name, rows, widths, merges, freezeRow: headRow, heights: { 2: 22, [headRow]: 22 },
             filter: data.length ? `A${headRow}:${colName(cols.length - 1)}${last}` : null };
}

// Date Excel (numéro de série) depuis « JJ/MM/AAAA [HH:MM] ».
function excelDate(d, m, y, hh, mm) {
    return (Date.UTC(+y, +m - 1, +d, +(hh || 0), +(mm || 0)) - Date.UTC(1899, 11, 30)) / 86400000;
}

window.SFXlsx = { build, download, table, colName, excelDate };
})();
