// PAGE RECHERCHE GLOBALE
let _ctx;
export async function render(container, ctx) {
  _ctx = ctx;
  container.innerHTML = `<div style="padding:clamp(14px,3vw,28px);">
    <div style="margin-bottom:24px;">
      <div style="font-family:'Syne',sans-serif;font-size:20px;font-weight:800;margin-bottom:16px;">Recherche Globale</div>
      <div class="search-wrap" style="max-width:560px;">
        <i class="fas fa-search"></i>
        <input class="search-input" id="globalSearch" placeholder="Marque, modèle, N° série, fournisseur…" oninput="doGlobalSearch()" style="height:48px;padding-left:44px;font-size:15px;border-radius:12px;">
      </div>
      <div style="font-size:12px;color:var(--text-faint);margin-top:8px;">Recherche dans tous les stocks (atelier, installation, boutique, garantie, vendu)</div>
    </div>
    <div id="searchResults"></div>
  </div>`;

  document.getElementById('globalSearch').focus();
}

let searchTimer;
window.doGlobalSearch = () => {
  clearTimeout(searchTimer);
  const q = document.getElementById('globalSearch')?.value?.trim();
  if (!q || q.length < 2) { document.getElementById('searchResults').innerHTML = ''; return; }
  searchTimer = setTimeout(() => performSearch(q), 300);
};

async function performSearch(q) {
  const { api, toast, fmt, stockBadge, conditionBadge, esc } = _ctx;
  const content = document.getElementById('searchResults');
  content.innerHTML = `<div class="loader-wrap"><div class="spinner"></div><span>Recherche…</span></div>`;

  try {
    // Chercher dans tous les stocks
    const params = new URLSearchParams({ search: q });
    // Admin voit tout, sinon filtré par rôle côté serveur
    const data = await api.get(`/products?${params}`);

    if (!data.length) {
      content.innerHTML = `<div class="empty-state"><i class="fas fa-search"></i><p>Aucun résultat pour "${esc(q)}"</p></div>`;
      return;
    }

    content.innerHTML = `
      <div style="margin-bottom:14px;font-size:13px;color:var(--text-dim);">
        <strong style="color:var(--text)">${data.length}</strong> résultat(s) pour "<strong style="color:var(--accent)">${esc(q)}</strong>"
      </div>
      <div class="table-wrap"><table class="data-table">
        <thead><tr><th>N° Série Interne</th><th>Type</th><th>Produit</th><th>Config</th><th>État</th><th>Fournisseur</th><th>Réception</th><th>Prix</th><th>Stock actuel</th></tr></thead>
        <tbody>${data.map(p => `<tr>
          <td><span class="mono">${esc(p.internal_sn)}</span></td>
          <td><span style="font-size:11px;color:var(--text-dim)">${esc(p.type||'')}</span></td>
          <td>
            <div style="display:flex;align-items:center;gap:8px;">
              ${p.image_url ? `<img src="${p.image_url}" style="width:32px;height:32px;object-fit:cover;border-radius:6px;flex-shrink:0;">` : ''}
              <div><strong>${esc(p.brand)} ${esc(p.model)}</strong>${p.real_sn ? `<br><span style="font-size:10px;color:var(--text-faint)">SN: ${esc(p.real_sn)}</span>` : ''}</div>
            </div>
          </td>
          <td style="font-size:11px;color:var(--text-dim)">${[p.processor,p.ram,p.storage_size].filter(Boolean).join(' | ')||'—'}</td>
          <td>${conditionBadge(p.condition)}</td>
          <td>${esc(p.supplier_name||'—')}</td>
          <td style="font-size:12px;white-space:nowrap">${fmt.date(p.reception_date)}</td>
          <td style="color:var(--accent);font-family:'Syne',sans-serif;font-weight:700">${fmt.currency(p.sale_price)}</td>
          <td>${stockBadge(p.current_stock)}</td>
        </tr>`).join('')}
        </tbody>
      </table></div>`;
  } catch (err) {
    content.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>${err.message}</p></div>`;
  }
}
