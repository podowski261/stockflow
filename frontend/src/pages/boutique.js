// PAGE BOUTIQUE
import { initBulkSelect } from '../bulkMove.js';
let _ctx, _products = [];

export async function render(container, ctx) {
  _ctx = ctx;
  container.innerHTML = `<div id="boutiqueMain" style="padding:clamp(14px,3vw,28px);">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
      <div>
        <div style="font-family:'Syne',sans-serif;font-size:20px;font-weight:800;">Stock Boutique</div>
        <div style="font-size:13px;color:var(--text-dim);margin-top:2px;">Produits disponibles à la vente</div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <div class="search-wrap"><i class="fas fa-search"></i>
          <input class="search-input" id="boutiqueSearch" placeholder="Rechercher…" oninput="filterBoutique()">
        </div>
        <button class="btn btn-secondary" onclick="openBoutiqueReport()">
          <i class="fas fa-file-pdf"></i> Rapport
        </button>
      </div>
    </div>
    <div id="boutiqueContent"><div class="loader-wrap"><div class="spinner"></div></div></div>
  </div>`;
  await loadData();
}

async function loadData() {
  const { api, toast } = _ctx;
  try {
    _products = await api.get('/products?stock=boutique');
    renderTable();
    initBulkBoutique();
  } catch(err) { toast('Erreur: ' + err.message, 'error'); }
}

function renderTable(filter = '') {
  const { fmt, conditionBadge, esc, user } = _ctx;
  const isAdmin = user?.role === 'admin';
  const products = filter
    ? _products.filter(p => [p.brand,p.model,p.internal_sn,p.supplier_name].join(' ').toLowerCase().includes(filter.toLowerCase()))
    : _products;

  const content = document.getElementById('boutiqueContent');
  if (!content) return;
  if (!products.length) {
    content.innerHTML = `<div class="empty-state"><i class="fas fa-store"></i><p>${_products.length?'Aucun résultat':'Aucun produit en boutique'}</p></div>`;
    return;
  }

  content.innerHTML = `<div class="table-wrap"><table class="data-table" id="btqTable">
    <thead><tr>
      <th>N° Série</th><th>Type</th><th>Produit</th><th>Config</th>
      <th>État</th><th>Fournisseur</th><th>Fin Garantie</th><th>Prix</th><th>Actions</th>
    </tr></thead>
    <tbody>${products.map(p => `<tr id="brow-${p.id}">
      <td><span class="mono">${esc(p.internal_sn)}</span></td>
      <td><span class="badge badge-boutique" style="font-size:10px">${esc(p.type||'')}</span></td>
      <td>
        <strong>${esc(p.brand)} ${esc(p.model)}</strong>
        ${p.image_url?`<img src="${esc(p.image_url)}" style="width:26px;height:26px;object-fit:cover;border-radius:4px;margin-left:6px;vertical-align:middle;">`:''}
      </td>
      <td style="font-size:11px;color:var(--text-dim)">${[p.processor,p.ram,(p.storage_size||'')+(p.storage_type?' '+p.storage_type:'')].filter(Boolean).join(' | ')}</td>
      <td>${conditionBadge(p.condition)}</td>
      <td>${esc(p.supplier_name||'—')}</td>
      <td style="font-size:12px">${p.warranty_expiry?`<span style="color:${isNear(p.warranty_expiry)?'var(--orange)':'var(--text-dim)'}">${fmt.date(p.warranty_expiry)}</span>`:'—'}</td>
      <td style="color:var(--accent);font-family:'Syne',sans-serif;font-weight:700">${fmt.currency(p.sale_price)}</td>
      <td><div style="display:flex;gap:4px;flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" onclick="openSell(${p.id},'vente')"><i class="fas fa-shopping-cart"></i> Vendre</button>
        <button class="btn btn-secondary btn-sm" onclick="openSell(${p.id},'livraison')" title="Livraison"><i class="fas fa-truck"></i></button>
        <button class="btn btn-danger btn-sm" onclick="openSell(${p.id},'garantie')" title="Garantie"><i class="fas fa-shield-alt"></i></button>
        <button class="btn btn-ghost btn-sm btn-icon" onclick="openBonReception(${p.id})" title="Bon réception"><i class="fas fa-file-alt"></i></button>
        ${isAdmin?`
        <button class="btn btn-secondary btn-sm btn-icon" onclick="editBoutique(${p.id})" title="Modifier"><i class="fas fa-edit"></i></button>
        <button class="btn btn-danger btn-sm btn-icon" onclick="deleteBoutique(${p.id})" title="Supprimer"><i class="fas fa-trash"></i></button>`:''}
      </div></td>
    </tr>`).join('')}
    </tbody>
  </table></div>`;
}

function isNear(d) { const diff=(new Date(d)-Date.now())/86400000; return diff<30&&diff>0; }
window.filterBoutique = () => renderTable(document.getElementById('boutiqueSearch')?.value||'');
window.openBoutiqueReport = () => {
  const t = localStorage.getItem('sf_token')||'';
  window.open(`/api/reports/stock?stock=boutique&token=${encodeURIComponent(t)}`, '_blank');
};

// ─── SELL / LIVRAISON / GARANTIE ─────────────────────
window.openSell = (id, type) => {
  const { showModal, fmt, esc } = _ctx;
  const p=_products.find(x=>x.id===id); if(!p) return;
  const titles={vente:'Vente',livraison:'Livraison',garantie:'Envoyer en Garantie'};
  const isGar=type==='garantie';
  showModal('sell',titles[type],`
    <div style="background:var(--surface2);border-radius:10px;padding:12px;margin-bottom:14px;display:flex;align-items:center;gap:10px;">
      ${p.image_url?`<img src="${esc(p.image_url)}" style="width:44px;height:44px;object-fit:cover;border-radius:8px;">`:''}
      <div><strong>${esc(p.brand)} ${esc(p.model)}</strong><br>
        <span style="color:var(--accent);font-weight:700">${fmt.currency(p.sale_price)}</span>
      </div>
    </div>
    ${isGar
      ?`<div class="form-group"><label class="label">Problème * <span style="color:var(--red)">(obligatoire)</span></label>
          <textarea class="textarea" id="sell_problem" placeholder="Décrivez le problème…"></textarea></div>`
      :`<div class="form-group"><label class="label">Nom ${type==='vente'?"de l'acheteur":"du client / adresse"}</label>
          <input class="input" id="sell_buyer" placeholder="${type==='vente'?"Nom de l'acheteur":"Adresse ou nom"}"></div>
        <div class="form-group"><label class="label">Vendeur *</label>
          <input class="input" id="sell_seller" value="${_ctx.user?.full_name||''}"></div>
        <div class="form-group"><label class="label">Prix de vente (Ar)</label>
          <input class="input" id="sell_price" type="number" value="${p.sale_price||0}"></div>`}
    <p id="sell_error" style="color:var(--red);font-size:12px;display:none;"></p>`,
  `<button class="btn btn-ghost" onclick="closeModal('sell')">Annuler</button>
   <button class="btn btn-primary" style="${isGar?'background:var(--red)':''}" onclick="confirmSell(${id},'${type}')">
     <i class="fas fa-check"></i> Confirmer
   </button>`);
};

window.confirmSell = async (id, type) => {
  const { api, toast } = _ctx;
  const isGar=type==='garantie';
  const problem=document.getElementById('sell_problem')?.value?.trim();
  const buyer=document.getElementById('sell_buyer')?.value?.trim();
  const seller=document.getElementById('sell_seller')?.value?.trim();
  if(isGar&&!problem){document.getElementById('sell_error').style.display='block';document.getElementById('sell_error').textContent='Description obligatoire';return;}
  const dest=type==='vente'?'vendu':type==='livraison'?'livre':'garantie';
  try {
    await api.post(`/products/${id}/move`,{to_stock:dest,problem_description:problem,destination_detail:buyer||seller,reason:seller?`Vendeur: ${seller}`:undefined});
    _products=_products.filter(p=>p.id!==id); renderTable();
    closeModal('sell');
    toast(type==='garantie'?'Envoyé en garantie':`${type==='livraison'?'Livraison':'Vente'} enregistrée`,'success');
  } catch(err){document.getElementById('sell_error').style.display='block';document.getElementById('sell_error').textContent=err.message;}
};

// ─── BON RÉCEPTION ────────────────────────────────────
window.openBonReception = async (id) => {
  const { api, toast, showModal } = _ctx;
  const token=localStorage.getItem('sf_token')||'';
  try {
    const receptions=await api.get(`/boutique-receptions/${id}`);
    if(!receptions.length) {
      const p=_products.find(x=>x.id===id);
      showModal('bonrec','Confirmation de Réception',`
        <div style="background:var(--surface2);border-radius:10px;padding:12px;margin-bottom:14px;">
          <strong>${p?.brand} ${p?.model}</strong><br>
          <span class="mono" style="font-size:11px;color:var(--text-faint)">${p?.internal_sn}</span>
        </div>
        <div class="form-group"><label class="label">Remis par</label><input class="input" id="br_sentby" placeholder="Nom de l'expéditeur"></div>
        <div class="form-group"><label class="label">Notes</label><textarea class="textarea" id="br_notes" placeholder="Observations…"></textarea></div>`,
      `<button class="btn btn-ghost" onclick="closeModal('bonrec')">Annuler</button>
       <button class="btn btn-primary" onclick="confirmReception(${id})"><i class="fas fa-check"></i> Confirmer réception</button>`);
    } else {
      window.open(`/api/reports/bon-reception/${receptions[0].id}?token=${encodeURIComponent(token)}`, '_blank');
    }
  } catch(err){toast(err.message,'error');}
};

window.confirmReception = async (id) => {
  const { api, toast } = _ctx;
  const token=localStorage.getItem('sf_token')||'';
  try {
    const reception=await api.post(`/products/${id}/confirm-reception`,{
      sent_by_name:document.getElementById('br_sentby')?.value?.trim(),
      notes:document.getElementById('br_notes')?.value?.trim()
    });
    closeModal('bonrec'); toast('Réception confirmée','success');
    window.open(`/api/reports/bon-reception/${reception.id}?token=${encodeURIComponent(token)}`, '_blank');
  } catch(err){toast(err.message,'error');}
};

// ─── EDIT / DELETE (admin) ────────────────────────────
window.editBoutique = (id) => {
  const { showModal, esc } = _ctx;
  const p=_products.find(x=>x.id===id); if(!p) return;
  showModal('editb',`Modifier — ${p.brand} ${p.model}`,`
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="form-group"><label class="label">Marque</label><input class="input" id="eb_brand" value="${esc(p.brand||'')}"></div>
      <div class="form-group"><label class="label">Modèle</label><input class="input" id="eb_model" value="${esc(p.model||'')}"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="form-group"><label class="label">État</label>
        <select class="select" id="eb_condition">
          <option value="sous_carton" ${p.condition==='sous_carton'?'selected':''}>Neuf</option>
          <option value="occasion" ${p.condition==='occasion'?'selected':''}>Occasion</option>
        </select>
      </div>
      <div class="form-group"><label class="label">Prix (Ar)</label><input class="input" id="eb_price" type="number" value="${p.sale_price||0}"></div>
    </div>
    <p id="eb_error" style="color:var(--red);font-size:12px;display:none;"></p>`,
  `<button class="btn btn-ghost" onclick="closeModal('editb')">Annuler</button>
   <button class="btn btn-primary" onclick="saveBoutiqueEdit(${id})"><i class="fas fa-save"></i> Enregistrer</button>`);
};

window.saveBoutiqueEdit = async (id) => {
  const { api, toast } = _ctx;
  const g=s=>document.getElementById(s)?.value?.trim();
  const fd=new FormData();
  fd.append('brand',g('eb_brand')); fd.append('model',g('eb_model'));
  fd.append('condition',g('eb_condition')); fd.append('sale_price',g('eb_price')||'0');
  try {
    const updated=await api.putForm(`/products/${id}`,fd);
    const idx=_products.findIndex(p=>p.id===id);
    if(idx>-1) _products[idx]={..._products[idx],...updated};
    renderTable(); closeModal('editb'); toast('Modifié','success');
  } catch(err){document.getElementById('eb_error').style.display='block';document.getElementById('eb_error').textContent=err.message;}
};

window.deleteBoutique = async (id) => {
  const { api, toast, confirm: cfm } = _ctx;
  const p=_products.find(x=>x.id===id); if(!p) return;
  const ok=await cfm(`Supprimer <strong>${p.brand} ${p.model}</strong> ?<br><span style="color:var(--red);font-size:12px;">Irréversible.</span>`,'Supprimer');
  if(!ok) return;
  try { await api.delete(`/products/${id}`); _products=_products.filter(x=>x.id!==id); renderTable(); toast('Supprimé','success'); }
  catch(err){toast(err.message,'error');}
};

function initBulkBoutique() {
  const container = document.getElementById('boutiqueMain');
  if (!container || !_products.length) return;
  initBulkSelect(container, _products, {
    destinations: [
      { to:'vendu',    label:'Marquer comme Vendus',  icon:'fa-shopping-cart', btnClass:'btn-primary' },
      { to:'livre',    label:'Marquer comme Livrés',  icon:'fa-truck',         btnClass:'btn-secondary' },
      { to:'garantie', label:'Envoyer en Garantie',   icon:'fa-shield-alt',    btnClass:'btn-danger' },
    ],
    onMove: (dest, ok, fail) => {
      loadData();
      _ctx.toast(`${ok} produit(s) ${dest==='vendu'?'vendus':dest==='livre'?'livrés':'envoyés en garantie'}${fail?' ('+fail+' erreur(s))':''}`, fail?'warning':'success', 4000);
    },
    showModal: _ctx.showModal, api: _ctx.api, toast: _ctx.toast, fmt: _ctx.fmt, esc: _ctx.esc,
  });
}
