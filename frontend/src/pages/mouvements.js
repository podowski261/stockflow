// PAGE MOUVEMENTS
let _ctx;

function rptUrl(path) {
  const t = localStorage.getItem('sf_token') || '';
  const sep = path.includes('?') ? '&' : '?';
  return `/api${path}${sep}token=${encodeURIComponent(t)}`;
}

export async function render(container, ctx) {
  _ctx = ctx;
  const today = new Date().toISOString().split('T')[0];
  const weekAgo = new Date(Date.now() - 7*86400000).toISOString().split('T')[0];

  container.innerHTML = `<div style="padding:clamp(14px,3vw,28px);">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
      <div style="font-family:'Syne',sans-serif;font-size:20px;font-weight:800;">Historique des Mouvements</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
        <input class="input" id="mvFrom" type="date" value="${weekAgo}" style="width:150px;height:36px;">
        <input class="input" id="mvTo" type="date" value="${today}" style="width:150px;height:36px;">
        <select class="select" id="mvStock" style="width:140px;height:36px;">
          <option value="">Tous les stocks</option>
          <option value="atelier">Atelier</option>
          <option value="installation">Installation</option>
          <option value="boutique">Boutique</option>
          <option value="garantie">Garantie</option>
          <option value="vendu">Vendu</option>
        </select>
        <button class="btn btn-secondary btn-sm" onclick="loadMouvements()"><i class="fas fa-filter"></i> Filtrer</button>
        <button class="btn btn-secondary" onclick="exportMvt()"><i class="fas fa-file-pdf"></i> PDF</button>
      </div>
    </div>
    <div id="mvContent"><div class="loader-wrap"><div class="spinner"></div></div></div>
  </div>`;

  await loadMouvements();
}

async function loadMouvements() {
  const { api, toast, fmt, stockBadge, esc } = _ctx;
  const from  = document.getElementById('mvFrom')?.value || '';
  const to    = document.getElementById('mvTo')?.value || '';
  const stock = document.getElementById('mvStock')?.value || '';

  const params = new URLSearchParams();
  if (from)  params.set('date_from', from);
  if (to)    params.set('date_to', to);
  if (stock) params.set('stock', stock);

  try {
    const data = await api.get(`/movements?${params}`);
    const content = document.getElementById('mvContent');
    if (!data.length) {
      content.innerHTML = `<div class="empty-state"><i class="fas fa-exchange-alt"></i><p>Aucun mouvement sur cette période</p></div>`;
      return;
    }
    content.innerHTML = `
      <div style="font-size:13px;color:var(--text-dim);margin-bottom:12px;">
        <strong style="color:var(--text)">${data.length}</strong> mouvement(s)
      </div>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>Date / Heure</th><th>N° Série</th><th>Produit</th><th>Fournisseur</th><th>Depuis</th><th></th><th>Vers</th><th>Motif / Problème</th><th>Par</th></tr></thead>
        <tbody>${data.map(m => `<tr>
          <td style="font-size:11px;white-space:nowrap">${fmt.datetime(m.created_at)}</td>
          <td><span class="mono">${esc(m.internal_sn)}</span></td>
          <td><strong>${esc(m.brand)} ${esc(m.model)}</strong></td>
          <td>${esc(m.supplier_name||'—')}</td>
          <td>${m.from_stock ? stockBadge(m.from_stock) : '<span style="color:var(--text-faint);font-size:11px">—</span>'}</td>
          <td style="color:var(--text-faint)">→</td>
          <td>${stockBadge(m.to_stock)}</td>
          <td style="font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.reason||m.problem_description||'—')}</td>
          <td style="font-size:12px">${esc(m.performed_by_name||'—')}</td>
        </tr>`).join('')}
        </tbody>
      </table></div>`;
  } catch(err) { toast('Erreur: ' + err.message, 'error'); }
}

window.loadMouvements = loadMouvements;
window.exportMvt = () => {
  const from  = document.getElementById('mvFrom')?.value || '';
  const to    = document.getElementById('mvTo')?.value || '';
  const stock = document.getElementById('mvStock')?.value || '';
  window.open(rptUrl(`/reports/movements?date_from=${from}&date_to=${to}&stock=${stock}`), '_blank');
};
