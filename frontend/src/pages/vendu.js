// PAGE VENDU — Historique des ventes avec modal détails
let _ctx, _sales = [];

function rptUrl(path) {
  const t = localStorage.getItem('sf_token') || '';
  return `/api${path}${path.includes('?')?'&':'?'}token=${encodeURIComponent(t)}`;
}

export async function render(container, ctx) {
  _ctx = ctx;
  const today = new Date().toISOString().split('T')[0];
  const monthStart = today.slice(0, 7) + '-01';

  container.innerHTML = `<div style="padding:clamp(14px,3vw,28px);" id="vendoPage">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
      <div>
        <div style="font-family:'Syne',sans-serif;font-size:20px;font-weight:800;">Historique des Ventes</div>
        <div style="font-size:13px;color:var(--text-dim);margin-top:2px;" id="salesTotalLabel">—</div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <label style="font-size:12px;color:var(--text-dim)">Du</label>
          <input class="input" id="vendoFrom" type="date" value="${monthStart}" style="width:148px;height:36px;">
          <label style="font-size:12px;color:var(--text-dim)">au</label>
          <input class="input" id="vendoTo" type="date" value="${today}" style="width:148px;height:36px;">
          <button class="btn btn-secondary btn-sm" onclick="loadVendu()"><i class="fas fa-filter"></i></button>
        </div>
        <button class="btn btn-secondary" onclick="exportVentes()"><i class="fas fa-file-pdf"></i> PDF</button>
      </div>
    </div>
    <div id="vendoContent"><div class="loader-wrap"><div class="spinner"></div></div></div>
  </div>`;

  await loadVendu();
}

async function loadVendu() {
  const { api, toast, fmt } = _ctx;
  const from = document.getElementById('vendoFrom')?.value || '';
  const to   = document.getElementById('vendoTo')?.value || '';
  try {
    const params = new URLSearchParams();
    if (from) params.set('date_from', from);
    if (to)   params.set('date_to', to);
    _sales = await api.get(`/sales?${params}`);
    const totalCA = _sales.reduce((s,r) => s + (parseFloat(r.sale_price)||0), 0);
    const label = document.getElementById('salesTotalLabel');
    if (label) label.textContent = `${_sales.length} vente(s) · CA : ${fmt.currency(totalCA)}`;
    renderTable();
  } catch(err) { toast('Erreur: ' + err.message, 'error'); }
}

function renderTable() {
  const { fmt, esc } = _ctx;
  const content = document.getElementById('vendoContent');
  if (!content) return;
  if (!_sales.length) {
    content.innerHTML = `<div class="empty-state"><i class="fas fa-receipt"></i><p>Aucune vente sur cette période</p></div>`;
    return;
  }
  content.innerHTML = `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>Date</th><th>Produit</th><th>Config</th><th>Fournisseur</th><th>Type</th><th>Client</th><th>Vendeur</th><th>Prix</th><th>Détails</th></tr></thead>
    <tbody>${_sales.map((s,i) => `<tr style="cursor:pointer;" onclick="openSaleDetail(${i})">
      <td style="font-size:11px;white-space:nowrap">${fmt.datetime(s.sold_at)}</td>
      <td><strong>${esc(s.brand||'')} ${esc(s.model||'')}</strong></td>
      <td style="font-size:11px;color:var(--text-dim)">${esc(s.processor||'')} ${esc(s.ram||'')} ${esc(s.storage_size||'')}</td>
      <td style="font-size:12px">${esc(s.supplier_name||'—')}</td>
      <td><span class="badge" style="background:rgba(240,192,64,0.12);color:var(--accent)">${s.sale_type==='livraison'?'Livraison':'Vente'}</span></td>
      <td style="font-size:12px">${esc(s.buyer_name||'—')}</td>
      <td style="font-size:12px">${esc(s.sold_by_name||'—')}</td>
      <td style="color:var(--accent);font-family:'Syne',sans-serif;font-weight:700;white-space:nowrap">${fmt.currency(s.sale_price)}</td>
      <td><button class="btn btn-ghost btn-sm btn-icon" onclick="event.stopPropagation();openSaleDetail(${i})"><i class="fas fa-eye"></i></button></td>
    </tr>`).join('')}
    </tbody>
  </table></div>`;
}

// ─── MODAL DÉTAILS VENTE ─────────────────────────────
window.openSaleDetail = (idx) => {
  const { showModal, fmt, esc, conditionBadge } = _ctx;
  const s = _sales[idx]; if (!s) return;

  // Fetch product details
  _ctx.api.get(`/products/${s.product_id}`).then(p => {
    const specs = [
      ['Type', p.type||'—'],
      ['Processeur', p.processor||'—'],
      ['RAM', p.ram||'—'],
      ['Stockage', [p.storage_size,p.storage_type].filter(Boolean).join(' ')||'—'],
      ['Écran', p.screen_size||'—'],
      ['État', p.condition==='sous_carton'?'Neuf':'Occasion'],
      ['Fournisseur', s.supplier_name||'—'],
      ['Vendu le', fmt.datetime(s.sold_at)],
    ];
    showModal('saledet', `${s.brand} ${s.model}`, `
      ${p.image_url ? `<img src="${esc(p.image_url)}" style="width:100%;height:180px;object-fit:cover;border-radius:10px;margin-bottom:14px;">` : ''}
      <div style="background:rgba(240,192,64,0.08);border:1px solid rgba(240,192,64,0.2);border-radius:10px;padding:14px;margin-bottom:14px;display:flex;align-items:center;gap:14px;">
        <div>
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-faint);margin-bottom:3px;">Prix de vente</div>
          <div style="font-family:'Syne',sans-serif;font-size:24px;font-weight:800;color:var(--accent)">${fmt.currency(s.sale_price)}</div>
        </div>
        <div style="margin-left:auto;text-align:right;">
          <div style="font-size:12px;color:var(--text-dim)">Vendu par <strong style="color:var(--text)">${esc(s.sold_by_name||'—')}</strong></div>
          ${s.buyer_name ? `<div style="font-size:12px;color:var(--text-dim);margin-top:3px;">Client: <strong style="color:var(--text)">${esc(s.buyer_name)}</strong></div>` : ''}
          <div style="margin-top:6px;"><span class="badge" style="background:rgba(240,192,64,0.12);color:var(--accent)">${s.sale_type==='livraison'?'Livraison':'Vente directe'}</span></div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <div style="grid-column:1/-1;background:var(--surface2);border-radius:8px;padding:10px 12px;">
          <div style="font-size:9px;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-faint);margin-bottom:3px;">N° Série Interne</div>
          <div style="font-family:monospace;font-size:12px;">${esc(p.internal_sn)}</div>
        </div>
        ${specs.map(([l,v]) => `<div style="background:var(--surface2);border-radius:8px;padding:10px 12px;">
          <div style="font-size:9px;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-faint);margin-bottom:3px;">${esc(l)}</div>
          <div style="font-size:13px;">${esc(v)}</div>
        </div>`).join('')}
      </div>`,
    `<button class="btn btn-ghost" onclick="closeModal('saledet')">Fermer</button>`);
  }).catch(() => {
    // Produit supprimé — afficher infos basiques
    showModal('saledet', `${s.brand||''} ${s.model||''}`, `
      <div style="background:rgba(240,192,64,0.08);border:1px solid rgba(240,192,64,0.2);border-radius:10px;padding:16px;margin-bottom:14px;">
        <div style="font-family:'Syne',sans-serif;font-size:22px;font-weight:800;color:var(--accent)">${fmt.currency(s.sale_price)}</div>
        <div style="font-size:13px;color:var(--text-dim);margin-top:6px;">
          Vendu par <strong>${esc(s.sold_by_name||'—')}</strong>
          ${s.buyer_name?` · Client: <strong>${esc(s.buyer_name)}</strong>`:''}
        </div>
        <div style="font-size:12px;color:var(--text-faint);margin-top:4px;">${fmt.datetime(s.sold_at)}</div>
      </div>
      <div style="background:rgba(240,80,96,0.08);border:1px solid rgba(240,80,96,0.2);border-radius:8px;padding:10px 12px;font-size:13px;color:var(--text-dim);">
        <i class="fas fa-info-circle" style="color:var(--red);"></i> Les détails complets du produit ne sont plus disponibles.
      </div>`,
    `<button class="btn btn-ghost" onclick="closeModal('saledet')">Fermer</button>`);
  });
};

window.loadVendu = loadVendu;
window.exportVentes = () => window.open(rptUrl('/reports/movements?stock=vendu&date_from=' + (document.getElementById('vendoFrom')?.value||'') + '&date_to=' + (document.getElementById('vendoTo')?.value||'')), '_blank');
