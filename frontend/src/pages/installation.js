import { initBulkSelect } from '../bulkMove.js';
// PAGE INSTALLATION
let _ctx, _products = [];

export async function render(container, ctx) {
  _ctx = ctx;
  container.innerHTML = `<div id="installMain" style="padding:clamp(14px,3vw,28px);">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
      <div>
        <div style="font-family:'Syne',sans-serif;font-size:20px;font-weight:800;">Stock Installation</div>
        <div style="font-size:13px;color:var(--text-dim);margin-top:2px;">Produits en cours d'installation</div>
      </div>
      <div class="search-wrap"><i class="fas fa-search"></i><input class="search-input" id="installSearch" placeholder="Rechercher…" oninput="filterInstall()"></div>
    </div>
    <div id="installContent"><div class="loader-wrap"><div class="spinner"></div></div></div>
  </div>`;
  await loadData();
}

async function loadData() {
  const { api, toast } = _ctx;
  try {
    _products = await api.get('/products?stock=installation');
    renderTable();
    initBulkInstall();
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
}

function initBulkInstall() {
  const container = document.getElementById('installMain');
  if (!container || !_products.length) return;
  initBulkSelect(container, _products, {
    destinations: [
      { to:'en_attente_boutique', label:'Envoyer en Boutique', icon:'fa-store', btnClass:'btn-secondary' },
      { to:'garantie',  label:'Envoyer en Garantie', icon:'fa-shield-alt', btnClass:'btn-danger' },
    ],
    onMove: (dest, ok, fail) => {
      loadData();
      _ctx.toast(`${ok} produit(s) envoyé(s) en ${dest}${fail?' ('+fail+' erreur(s))':''}`, fail?'warning':'success', 4000);
    },
    showModal: _ctx.showModal, api: _ctx.api, toast: _ctx.toast, fmt: _ctx.fmt, esc: _ctx.esc,
  });
}

function renderTable(filter = '') {
  const { fmt, conditionBadge, esc, user } = _ctx;
  const isAdmin = user?.role === 'admin';
  const products = filter
    ? _products.filter(p => [p.brand,p.model,p.internal_sn,p.supplier_name].join(' ').toLowerCase().includes(filter.toLowerCase()))
    : _products;
  const content = document.getElementById('installContent');
  if (!content) return;
  if (!products.length) {
    content.innerHTML = `<div class="empty-state"><i class="fas fa-laptop"></i><p>${_products.length?'Aucun résultat':'Aucun produit en installation'}</p></div>`;
    return;
  }
  content.innerHTML = `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>N° Série</th><th>Produit</th><th>Config</th><th>État</th><th>Fournisseur</th><th>Réception</th><th>Prix</th><th>Actions</th></tr></thead>
    <tbody>${products.map(p=>`<tr>
      <td><span class="mono">${esc(p.internal_sn)}</span></td>
      <td><strong>${esc(p.brand)} ${esc(p.model)}</strong></td>
      <td style="font-size:11px;color:var(--text-dim)">${[p.processor,p.ram,p.storage_size].filter(Boolean).join(' | ')}</td>
      <td>${conditionBadge(p.condition)}</td>
      <td>${esc(p.supplier_name||'—')}</td>
      <td style="font-size:12px">${fmt.date(p.reception_date)}</td>
      <td style="color:var(--accent);font-family:'Syne',sans-serif;font-weight:700">${fmt.currency(p.sale_price)}</td>
      <td><div style="display:flex;gap:5px;flex-wrap:wrap;">
        <button class="btn btn-secondary btn-sm" onclick="sendInstall(${p.id},'en_attente_boutique')"><i class="fas fa-store"></i> Boutique</button>
        <button class="btn btn-danger btn-sm" onclick="sendInstall(${p.id},'garantie')"><i class="fas fa-shield-alt"></i></button>
        ${isAdmin?`
        <button class="btn btn-secondary btn-sm btn-icon" onclick="editInstall(${p.id})" title="Modifier"><i class="fas fa-edit"></i></button>
        <button class="btn btn-danger btn-sm btn-icon" onclick="deleteInstall(${p.id})" title="Supprimer"><i class="fas fa-trash"></i></button>`:''}
      </div></td>
    </tr>`).join('')}
    </tbody>
  </table></div>`;
}

window.filterInstall = () => renderTable(document.getElementById('installSearch')?.value||'');

window.sendInstall = (id, dest) => {
  const { showModal } = _ctx;
  const p=_products.find(x=>x.id===id); if(!p) return;
  const isGar=dest==='garantie';
  const destLabel = dest==='en_attente_boutique' ? 'Envoyer en Boutique (En attente)' : 'Envoyer en Garantie';
  showModal('move',isGar?'Envoyer en Garantie':destLabel,`
    <div style="background:var(--surface2);border-radius:10px;padding:12px;margin-bottom:14px;">
      <strong>${p.brand} ${p.model}</strong><br><span class="mono" style="font-size:11px;color:var(--text-faint)">${p.internal_sn}</span>
    </div>
    ${isGar
      ? `<div class="form-group"><label class="label">Problème * <span style="color:var(--red)">(obligatoire)</span></label>
           <textarea class="textarea" id="move_problem" placeholder="Décrivez le problème…"></textarea></div>`
      : `<div style="background:rgba(160,100,240,0.08);border:1px solid rgba(160,100,240,0.2);border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:13px;">
           <i class="fas fa-info-circle" style="color:#a060f0;margin-right:6px;"></i>
           Le produit sera mis <strong>en attente de réception</strong> jusqu'à confirmation par la boutique.
         </div>
         <div class="form-group"><label class="label">Envoyé par (votre nom)</label><input class="input" id="move_dest" placeholder="Votre nom"></div>`}
    <p id="move_error" style="color:var(--red);font-size:12px;display:none;"></p>`,
  `<button class="btn btn-ghost" onclick="closeModal('move')">Annuler</button>
   <button class="btn btn-primary" onclick="confirmInstallMove(${id},'${dest}',${isGar})"><i class="fas fa-check"></i> Confirmer</button>`);
};

window.confirmInstallMove = async (id, dest, isGar) => {
  const { api, toast } = _ctx;
  const problem=document.getElementById('move_problem')?.value?.trim();
  const d=document.getElementById('move_dest')?.value?.trim();
  if(isGar&&!problem){ document.getElementById('move_error').style.display='block'; document.getElementById('move_error').textContent='Description obligatoire'; return; }
  try {
    await api.post(`/products/${id}/move`,{to_stock:dest,problem_description:problem,destination_detail:d});
    _products=_products.filter(p=>p.id!==id); renderTable(); closeModal('move');
    toast(dest==='en_attente_boutique' ? 'Envoyé — En attente de confirmation boutique' : `Envoyé en ${dest}`,'success');
  } catch(err){ document.getElementById('move_error').style.display='block'; document.getElementById('move_error').textContent=err.message; }
};

// ─── EDIT / DELETE (admin) ────────────────────────────
window.editInstall = (id) => {
  const { showModal, esc } = _ctx;
  const p=_products.find(x=>x.id===id); if(!p) return;
  showModal('editi',`Modifier — ${p.brand} ${p.model}`,`
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="form-group"><label class="label">Marque</label><input class="input" id="ei_brand" value="${esc(p.brand||'')}"></div>
      <div class="form-group"><label class="label">Modèle</label><input class="input" id="ei_model" value="${esc(p.model||'')}"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="form-group"><label class="label">RAM</label><input class="input" id="ei_ram" value="${esc(p.ram||'')}"></div>
      <div class="form-group"><label class="label">Prix (Ar)</label><input class="input" id="ei_price" type="number" value="${p.sale_price||0}"></div>
    </div>
    <p id="ei_error" style="color:var(--red);font-size:12px;display:none;"></p>`,
  `<button class="btn btn-ghost" onclick="closeModal('editi')">Annuler</button>
   <button class="btn btn-primary" onclick="saveInstallEdit(${id})"><i class="fas fa-save"></i> Enregistrer</button>`);
};

window.saveInstallEdit = async (id) => {
  const { api, toast } = _ctx;
  const g=sid=>document.getElementById(sid)?.value?.trim();
  const fd=new FormData();
  fd.append('brand',g('ei_brand')); fd.append('model',g('ei_model'));
  fd.append('ram',g('ei_ram')); fd.append('sale_price',g('ei_price')||'0');
  try {
    const updated=await api.putForm(`/products/${id}`,fd);
    const idx=_products.findIndex(p=>p.id===id);
    if(idx>-1) _products[idx]={..._products[idx],...updated};
    renderTable(); closeModal('editi'); toast('Modifié','success');
  } catch(err){ document.getElementById('ei_error').style.display='block'; document.getElementById('ei_error').textContent=err.message; }
};

window.deleteInstall = async (id) => {
  const { api, toast, confirm: cfm } = _ctx;
  const p=_products.find(x=>x.id===id); if(!p) return;
  const ok=await cfm(`Supprimer <strong>${p.brand} ${p.model}</strong> ?<br><span style="color:var(--red);font-size:12px;">Irréversible.</span>`,'Supprimer');
  if(!ok) return;
  try { await api.delete(`/products/${id}`); _products=_products.filter(x=>x.id!==id); renderTable(); toast('Supprimé','success'); }
  catch(err){ toast(err.message,'error'); }
};
