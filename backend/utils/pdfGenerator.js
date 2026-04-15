/**
 * Générateur de PDF — utilise html-pdf-node ou retourne HTML imprimable
 * Le frontend peut utiliser window.print() avec CSS @media print
 */

function generateLabelHTML(product, company) {
  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  @page { size: 50mm 30mm; margin: 0; }
  body { margin: 0; padding: 2mm; font-family: Arial, sans-serif; width: 50mm; height: 30mm; overflow: hidden; box-sizing: border-box; }
  .label { width: 100%; height: 100%; display: flex; flex-direction: column; justify-content: space-between; }
  .top { font-size: 6pt; font-weight: bold; color: #333; }
  .brand-model { font-size: 8pt; font-weight: 900; }
  .sn { font-size: 5pt; letter-spacing: 0.5px; color: #555; margin: 1mm 0; }
  .specs { font-size: 5pt; color: #666; }
  .barcode-area { text-align: center; }
  svg.barcode { width: 100%; height: 12mm; }
  .sn-text { font-size: 5pt; font-family: monospace; }
</style>
</head>
<body>
<div class="label">
  <div class="top">${company || 'StockFlow'}</div>
  <div class="brand-model">${product.brand} ${product.model}</div>
  <div class="specs">${[product.processor, product.ram, product.storage_size].filter(Boolean).join(' | ')}</div>
  <div class="barcode-area">
    <div class="sn-text">${product.internal_sn}</div>
    <svg class="barcode" id="bc"></svg>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js"></script>
<script>
  JsBarcode("#bc", "${product.internal_sn}", {
    format: "CODE128", width: 1.2, height: 35, displayValue: false, margin: 0
  });
  window.onload = () => window.print();
</script>
</body>
</html>`;
}

function generateStockReportHTML(products, title, company, filters) {
  const cfg = company || {};
  const now = new Date().toLocaleString('fr-FR');
  const rows = products.map((p, i) => `
    <tr class="${i % 2 === 0 ? 'even' : ''}">
      <td>${i + 1}</td>
      <td style="font-family:monospace;font-size:9pt;">${p.internal_sn}</td>
      <td>${p.type || ''}</td>
      <td><strong>${p.brand}</strong> ${p.model}</td>
      <td>${p.processor || '—'}</td>
      <td>${p.ram || '—'}</td>
      <td>${p.storage_size || '—'} ${p.storage_type || ''}</td>
      <td>${p.condition === 'sous_carton' ? 'Neuf' : 'Occasion'}</td>
      <td>${p.supplier_name || '—'}</td>
      <td>${p.reception_date ? new Date(p.reception_date).toLocaleDateString('fr-FR') : '—'}</td>
      <td>${p.warranty_expiry ? new Date(p.warranty_expiry).toLocaleDateString('fr-FR') : '—'}</td>
      <td style="text-align:right;">${p.sale_price ? Number(p.sale_price).toLocaleString('fr-MG') + ' Ar' : '—'}</td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  @page { size: A4 landscape; margin: 15mm; }
  body { font-family: Arial, sans-serif; font-size: 9pt; color: #222; }
  .header { border-bottom: 2px solid #000; padding-bottom: 6pt; margin-bottom: 10pt; display: flex; justify-content: space-between; align-items: flex-start; }
  .company { font-size: 11pt; font-weight: bold; }
  .report-title { font-size: 14pt; font-weight: 900; text-align: center; }
  .meta { font-size: 8pt; color: #555; text-align: right; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #222; color: #fff; padding: 4pt 5pt; font-size: 8pt; text-align: left; }
  td { padding: 3pt 5pt; border-bottom: 0.5pt solid #ddd; font-size: 8pt; }
  tr.even td { background: #f8f8f8; }
  .footer { border-top: 1pt solid #999; margin-top: 10pt; padding-top: 4pt; font-size: 7pt; color: #666; display: flex; justify-content: space-between; }
  .total-row td { font-weight: bold; background: #eee; border-top: 1pt solid #999; }
</style>
</head>
<body>
<div class="header">
  <div>
    <div class="company">${cfg.name || 'StockFlow'}</div>
    <div style="font-size:8pt;color:#555;">${cfg.address || ''} ${cfg.phone ? '— Tél: ' + cfg.phone : ''}</div>
  </div>
  <div class="report-title">${title}</div>
  <div class="meta">Édité le : ${now}<br>Nb produits : ${products.length}</div>
</div>

<table>
  <thead>
    <tr>
      <th>#</th><th>N° Série Interne</th><th>Type</th><th>Marque / Modèle</th>
      <th>Processeur</th><th>RAM</th><th>Stockage</th><th>État</th>
      <th>Fournisseur</th><th>Date Réception</th><th>Fin Garantie</th><th>Prix</th>
    </tr>
  </thead>
  <tbody>
    ${rows}
    <tr class="total-row">
      <td colspan="11" style="text-align:right;">TOTAL :</td>
      <td style="text-align:right;">${products.reduce((s, p) => s + (Number(p.sale_price) || 0), 0).toLocaleString('fr-MG')} Ar</td>
    </tr>
  </tbody>
</table>

<div class="footer">
  <span>${cfg.header_text || 'StockFlow'}</span>
  <span>${cfg.footer_text || 'Document confidentiel'}</span>
</div>
</body>
</html>`;
}

function generateMovementReportHTML(movements, title, company, dateFrom, dateTo) {
  const cfg = company || {};
  const now = new Date().toLocaleString('fr-FR');
  const STOCK_LABELS = {
    atelier: 'Stock Atelier', installation: 'Installation', boutique: 'Boutique',
    garantie: 'Garantie', vendu: 'Vendu', livre: 'Livré'
  };

  const rows = movements.map((m, i) => `
    <tr class="${i % 2 === 0 ? 'even' : ''}">
      <td>${new Date(m.created_at).toLocaleString('fr-FR')}</td>
      <td style="font-family:monospace;font-size:8pt;">${m.internal_sn}</td>
      <td>${m.brand} ${m.model}</td>
      <td>${m.supplier_name || '—'}</td>
      <td style="color:#888;">${m.from_stock ? STOCK_LABELS[m.from_stock] || m.from_stock : '—'}</td>
      <td>→</td>
      <td style="font-weight:bold;">${STOCK_LABELS[m.to_stock] || m.to_stock}</td>
      <td>${m.reason || m.problem_description || '—'}</td>
      <td>${m.performed_by_name || '—'}</td>
    </tr>
  `).join('');

  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  @page { size: A4 landscape; margin: 15mm; }
  body { font-family: Arial, sans-serif; font-size: 9pt; color: #222; }
  .header { border-bottom: 2px solid #000; padding-bottom: 6pt; margin-bottom: 10pt; display: flex; justify-content: space-between; align-items: flex-start; }
  .company { font-size: 11pt; font-weight: bold; }
  .report-title { font-size: 14pt; font-weight: 900; text-align: center; }
  .meta { font-size: 8pt; color: #555; text-align: right; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #222; color: #fff; padding: 4pt 5pt; font-size: 8pt; text-align: left; }
  td { padding: 3pt 5pt; border-bottom: 0.5pt solid #ddd; font-size: 8pt; }
  tr.even td { background: #f8f8f8; }
  .footer { border-top: 1pt solid #999; margin-top: 10pt; padding-top: 4pt; font-size: 7pt; color: #666; display: flex; justify-content: space-between; }
  .period { background: #f0f0f0; padding: 4pt 8pt; border-radius: 4pt; font-size: 8pt; margin-bottom: 8pt; display: inline-block; }
</style>
</head>
<body>
<div class="header">
  <div>
    <div class="company">${cfg.name || 'StockFlow'}</div>
    <div style="font-size:8pt;color:#555;">${cfg.address || ''}</div>
  </div>
  <div class="report-title">${title}</div>
  <div class="meta">Édité le : ${now}<br>Nb mouvements : ${movements.length}</div>
</div>
${dateFrom || dateTo ? `<div class="period">Période : ${dateFrom || '—'} → ${dateTo || '—'}</div>` : ''}

<table>
  <thead>
    <tr>
      <th>Date / Heure</th><th>N° Série Interne</th><th>Produit</th>
      <th>Fournisseur</th><th>Depuis</th><th></th><th>Vers</th>
      <th>Motif / Problème</th><th>Effectué par</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>

<div class="footer">
  <span>${cfg.header_text || 'StockFlow'}</span>
  <span>${cfg.footer_text || 'Document confidentiel'}</span>
</div>
</body>
</html>`;
}

function generateBonReceptionHTML(product, reception, company) {
  const cfg = company || {};
  const now = new Date().toLocaleString('fr-FR');
  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  @page { size: A4 portrait; margin: 20mm; }
  body { font-family: Arial, sans-serif; font-size: 10pt; }
  .header { text-align: center; border-bottom: 2px solid #222; padding-bottom: 8pt; margin-bottom: 16pt; }
  .company-name { font-size: 16pt; font-weight: 900; }
  .doc-title { font-size: 13pt; font-weight: bold; margin-top: 6pt; }
  .doc-ref { font-size: 9pt; color: #555; }
  table.info { width: 100%; border-collapse: collapse; margin-bottom: 16pt; }
  table.info td { padding: 5pt 8pt; border: 0.5pt solid #ccc; }
  table.info td:first-child { font-weight: bold; background: #f5f5f5; width: 40%; }
  .signatures { display: flex; justify-content: space-between; margin-top: 40pt; }
  .sig-box { width: 45%; text-align: center; border-top: 1pt solid #444; padding-top: 4pt; font-size: 8pt; color: #555; }
</style>
</head>
<body>
<div class="header">
  <div class="company-name">${cfg.name || 'StockFlow'}</div>
  <div class="doc-title">BON DE RÉCEPTION — STOCK BOUTIQUE</div>
  <div class="doc-ref">Réf : BR-${String(reception.id).padStart(5,'0')} | ${now}</div>
</div>

<table class="info">
  <tr><td>N° Série Interne</td><td>${product.internal_sn}</td></tr>
  <tr><td>Type / Marque / Modèle</td><td>${product.type} — ${product.brand} ${product.model}</td></tr>
  <tr><td>Processeur</td><td>${product.processor || '—'}</td></tr>
  <tr><td>RAM</td><td>${product.ram || '—'}</td></tr>
  <tr><td>Stockage</td><td>${product.storage_size || '—'} ${product.storage_type || ''}</td></tr>
  <tr><td>État</td><td>${product.condition === 'sous_carton' ? 'Neuf (sous carton)' : 'Occasion'}</td></tr>
  <tr><td>Fournisseur</td><td>${product.supplier_name || '—'}</td></tr>
  <tr><td>Date de réception atelier</td><td>${product.reception_date ? new Date(product.reception_date).toLocaleDateString('fr-FR') : '—'}</td></tr>
  <tr><td>Fin de garantie</td><td>${product.warranty_expiry ? new Date(product.warranty_expiry).toLocaleDateString('fr-FR') : '—'}</td></tr>
  <tr><td>Remis par</td><td>${reception.sent_by_name || '—'}</td></tr>
  <tr><td>Reçu par</td><td>${reception.received_by_name || '—'}</td></tr>
  <tr><td>Date de réception boutique</td><td>${new Date(reception.received_at).toLocaleString('fr-FR')}</td></tr>
  ${reception.notes ? `<tr><td>Notes</td><td>${reception.notes}</td></tr>` : ''}
</table>

<div class="signatures">
  <div class="sig-box">Signature du remettant<br><br><br><br><strong>${reception.sent_by_name || '.....................'}</strong></div>
  <div class="sig-box">Signature du réceptionnaire<br><br><br><br><strong>${reception.received_by_name || '.....................'}</strong></div>
</div>

<div style="margin-top:30pt;font-size:8pt;color:#888;text-align:center;">${cfg.footer_text || 'StockFlow — Document interne'}</div>
</body>
</html>`;
}

module.exports = {
  generateLabelHTML,
  generateStockReportHTML,
  generateMovementReportHTML,
  generateBonReceptionHTML
};
