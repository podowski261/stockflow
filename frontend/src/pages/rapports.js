// PAGE RAPPORTS PDF
let _ctx;

function token() { return localStorage.getItem('sf_token') || ''; }
function reportUrl(path) {
  const sep = path.includes('?') ? '&' : '?';
  return `/api${path}${sep}token=${encodeURIComponent(token())}`;
}

export async function render(container, ctx) {
  _ctx = ctx;
  const today = new Date().toISOString().split('T')[0];
  const monthStart = today.slice(0,7) + '-01';

  const stockBtns = [
    {s:'',label:'Tous',icon:'fa-layer-group',color:'var(--text)'},
    {s:'atelier',label:'Atelier',icon:'fa-tools',color:'var(--blue)'},
    {s:'installation',label:'Installation',icon:'fa-laptop',color:'var(--orange)'},
    {s:'boutique',label:'Boutique',icon:'fa-store',color:'var(--green)'},
    {s:'garantie',label:'Garantie',icon:'fa-shield-alt',color:'var(--red)'},
    {s:'vendu',label:'Vendus',icon:'fa-check-circle',color:'var(--accent)'},
  ].map(({s,label,icon,color}) =>
    `<button class="btn btn-secondary" style="justify-content:flex-start;border-color:${color}30" onclick="openStockReport('${s}')">
      <i class="fas ${icon}" style="color:${color}"></i> ${label}
    </button>`
  ).join('');

  container.innerHTML = `<div style="padding:clamp(14px,3vw,28px);">
    <div style="font-family:'Syne',sans-serif;font-size:20px;font-weight:800;margin-bottom:24px;">Rapports PDF</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:20px;">

      <div class="chart-box">
        <div style="font-family:'Syne',sans-serif;font-size:15px;font-weight:700;margin-bottom:6px;"><i class="fas fa-boxes" style="color:var(--accent);margin-right:8px;"></i>État du Stock</div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:16px;">Liste complète des produits par stock</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">${stockBtns}</div>
      </div>

      <div class="chart-box">
        <div style="font-family:'Syne',sans-serif;font-size:15px;font-weight:700;margin-bottom:6px;"><i class="fas fa-exchange-alt" style="color:var(--accent);margin-right:8px;"></i>Historique des Mouvements</div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:16px;">Tous les mouvements sur une période</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
          <div class="form-group" style="margin:0;"><label class="label">Du</label><input class="input" id="rpt_mv_from" type="date" value="${monthStart}"></div>
          <div class="form-group" style="margin:0;"><label class="label">Au</label><input class="input" id="rpt_mv_to" type="date" value="${today}"></div>
        </div>
        <select class="select" id="rpt_mv_stock" style="margin-bottom:12px;">
          <option value="">Tous les stocks</option>
          <option value="atelier">Atelier</option><option value="installation">Installation</option>
          <option value="boutique">Boutique</option><option value="garantie">Garantie</option>
          <option value="vendu">Vendu</option>
        </select>
        <button class="btn btn-primary" style="width:100%;" onclick="openMovementReport()"><i class="fas fa-file-pdf"></i> Générer</button>
      </div>

      <div class="chart-box">
        <div style="font-family:'Syne',sans-serif;font-size:15px;font-weight:700;margin-bottom:6px;"><i class="fas fa-receipt" style="color:var(--accent);margin-right:8px;"></i>Rapport des Ventes</div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:16px;">Historique des ventes par période</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
          <div class="form-group" style="margin:0;"><label class="label">Du</label><input class="input" id="rpt_vt_from" type="date" value="${monthStart}"></div>
          <div class="form-group" style="margin:0;"><label class="label">Au</label><input class="input" id="rpt_vt_to" type="date" value="${today}"></div>
        </div>
        <button class="btn btn-primary" style="width:100%;" onclick="openVenteReport()"><i class="fas fa-file-pdf"></i> Générer</button>
      </div>

      <div class="chart-box">
        <div style="font-family:'Syne',sans-serif;font-size:15px;font-weight:700;margin-bottom:6px;"><i class="fas fa-shield-alt" style="color:var(--accent);margin-right:8px;"></i>Rapport Garanties</div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:16px;">Historique complet des garanties</div>
        <button class="btn btn-primary" style="width:100%;" onclick="openWarrantyReport()"><i class="fas fa-file-pdf"></i> Générer</button>
      </div>

    </div>
  </div>`;
}

window.openStockReport = (stock) => {
  window.open(reportUrl('/reports/stock' + (stock ? '?stock='+stock : '')), '_blank');
};
window.openMovementReport = () => {
  const from  = document.getElementById('rpt_mv_from')?.value || '';
  const to    = document.getElementById('rpt_mv_to')?.value || '';
  const stock = document.getElementById('rpt_mv_stock')?.value || '';
  window.open(reportUrl('/reports/movements?date_from='+from+'&date_to='+to+'&stock='+stock), '_blank');
};
window.openVenteReport = () => {
  const from = document.getElementById('rpt_vt_from')?.value || '';
  const to   = document.getElementById('rpt_vt_to')?.value || '';
  window.open(reportUrl('/reports/movements?stock=vendu&date_from='+from+'&date_to='+to), '_blank');
};
window.openWarrantyReport = () => {
  window.open(reportUrl('/reports/movements?stock=garantie'), '_blank');
};
