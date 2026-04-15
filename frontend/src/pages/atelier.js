// ══════════════════════════════════════════════════════
//  PAGE ATELIER
// ══════════════════════════════════════════════════════
import { initBulkSelect } from '../bulkMove.js';
let _ctx, _products = [], _suppliers = [];

export async function render(container, ctx) {
  _ctx = ctx;
  const isAdmin = ctx.user?.role === 'admin';

  container.innerHTML = `<div style="padding:clamp(14px,3vw,28px);" id="atelierMain">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
      <div>
        <div style="font-family:'Syne',sans-serif;font-size:20px;font-weight:800;">Stock Atelier</div>
        <div style="font-size:13px;color:var(--text-dim);margin-top:2px;">Produits en attente de traitement</div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <div class="search-wrap"><i class="fas fa-search"></i><input class="search-input" id="atelierSearch" placeholder="Rechercher…" oninput="filterAtelier()"></div>
        ${isAdmin ? '' : '<button class="btn btn-primary" onclick="openReceptionModal()"><i class="fas fa-plus"></i> Nouvelle réception</button>'}
        ${!isAdmin ? '' : '<button class="btn btn-primary" onclick="openReceptionModal()"><i class="fas fa-plus"></i> Nouvelle réception</button>'}
      </div>
    </div>
    <div id="atelierContent"><div class="loader-wrap"><div class="spinner"></div></div></div>
  </div>`;

  await loadData();
}

async function loadData() {
  const { api, toast } = _ctx;
  try {
    [_products, _suppliers] = await Promise.all([
      api.get('/products?stock=atelier'),
      api.get('/suppliers')
    ]);
    renderTable();
    initBulkAtelier();
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
}

function initBulkAtelier() {
  const container = document.getElementById('atelierMain');
  if (!container || !_products.length) return;
  initBulkSelect(container, _products, {
    destinations: [
      { to:'boutique', label:'Envoyer en Boutique', icon:'fa-store', btnClass:'btn-secondary' },
      { to:'garantie',     label:'Envoyer en Garantie',    icon:'fa-shield-alt', btnClass:'btn-danger' },
    ],
    onMove: (dest, ok, fail) => {
      // Recharger la liste pour refléter les changements
      loadData();
      _ctx.toast(`${ok} produit(s) envoyé(s) en ${dest}${fail?' ('+fail+' erreur(s))':''}`, fail?'warning':'success', 4000);
    },
    showModal: _ctx.showModal,
    api: _ctx.api,
    toast: _ctx.toast,
    fmt: _ctx.fmt,
    esc: _ctx.esc,
  });
}

function renderTable(filter = '') {
  const { fmt, conditionBadge, esc, user } = _ctx;
  const isAdmin = user?.role === 'admin';
  const products = filter
    ? _products.filter(p => [p.brand,p.model,p.internal_sn,p.supplier_name].join(' ').toLowerCase().includes(filter.toLowerCase()))
    : _products;

  const content = document.getElementById('atelierContent');
  if (!content) return;

  if (!products.length) {
    content.innerHTML = `<div class="empty-state"><i class="fas fa-box-open"></i><p>${_products.length ? 'Aucun résultat' : 'Aucun produit en atelier'}</p></div>`;
    return;
  }

  content.innerHTML = `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>N° Série Interne</th><th>Type</th><th>Produit</th><th>Config</th><th>État</th><th>Fournisseur</th><th>Réception</th><th>Fin Garantie</th><th>Prix</th><th>Actions</th></tr></thead>
    <tbody>
    ${products.map(p => `<tr id="prow-${p.id}">
      <td>
        <span class="mono">${esc(p.internal_sn)}</span>
        <button class="btn btn-ghost btn-sm btn-icon" style="margin-left:4px;" title="Imprimer étiquette" onclick="printLabel(${p.id})"><i class="fas fa-tag"></i></button>
      </td>
      <td><span class="badge badge-atelier" style="font-size:10px">${esc(p.type||'')}</span></td>
      <td>
        <strong>${esc(p.brand)} ${esc(p.model)}</strong>
        ${p.real_sn ? `<br><span style="font-size:10px;color:var(--text-faint)">SN: ${esc(p.real_sn)}</span>` : ''}
      </td>
      <td style="font-size:11px;color:var(--text-dim);white-space:nowrap">
        ${[p.processor, p.ram, (p.storage_size||'')+(p.storage_type?' '+p.storage_type:'')].filter(Boolean).join('<br>')}
      </td>
      <td>${conditionBadge(p.condition)}</td>
      <td>${esc(p.supplier_name||'—')}</td>
      <td style="font-size:12px;white-space:nowrap">${fmt.date(p.reception_date)}</td>
      <td style="font-size:12px;white-space:nowrap">
        ${p.warranty_expiry
          ? `<span style="color:${isWarrantyNear(p.warranty_expiry)?'var(--orange)':'var(--text-dim)'}">${fmt.date(p.warranty_expiry)}</span>`
          : '—'}
      </td>
      <td style="color:var(--accent);font-family:'Syne',sans-serif;font-weight:700;white-space:nowrap">${fmt.currency(p.sale_price)}</td>
      <td>
        <div style="display:flex;gap:5px;flex-wrap:wrap;">
          <button class="btn btn-secondary btn-sm" onclick="sendProduct(${p.id},'boutique')"><i class="fas fa-store"></i> Boutique</button>
          <button class="btn btn-danger btn-sm" onclick="sendProduct(${p.id},'garantie')"><i class="fas fa-shield-alt"></i></button>
          <button class="btn btn-ghost btn-sm btn-icon" onclick="viewProduct(${p.id})" title="Détails"><i class="fas fa-eye"></i></button>
          ${isAdmin ? `
          <button class="btn btn-secondary btn-sm btn-icon" onclick="editProduct(${p.id})" title="Modifier"><i class="fas fa-edit"></i></button>
          <button class="btn btn-danger btn-sm btn-icon" onclick="deleteProduct(${p.id})" title="Supprimer"><i class="fas fa-trash"></i></button>` : ''}
        </div>
      </td>
    </tr>`).join('')}
    </tbody>
  </table></div>`;
}

function isWarrantyNear(d) { const diff=(new Date(d)-Date.now())/86400000; return diff<30&&diff>0; }
window.filterAtelier = () => renderTable(document.getElementById('atelierSearch')?.value||'');

// ─── MODAL RÉCEPTION ────────────────────────────────
window.openReceptionModal = () => {
  const { showModal, esc } = _ctx;
  const supOpts = _suppliers.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join('');
  showModal('reception','Nouvelle Réception', `
    <!-- QUANTITÉ — en évidence en haut -->
    <div style="background:rgba(240,192,64,0.08);border:1px solid rgba(240,192,64,0.25);border-radius:12px;padding:14px 16px;margin-bottom:16px;display:flex;align-items:center;gap:14px;">
      <div style="flex:1;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:var(--accent);font-weight:700;margin-bottom:4px;">Quantité reçue</div>
        <div style="font-size:12px;color:var(--text-dim);">Nombre d'unités identiques à enregistrer en une seule fois</div>
      </div>
      <div style="display:flex;align-items:center;gap:0;border:1px solid rgba(240,192,64,0.3);border-radius:10px;overflow:hidden;flex-shrink:0;">
        <button type="button" onclick="changeQty(-1)" style="width:36px;height:40px;background:var(--surface2);border:none;color:var(--text);font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s;" onmouseover="this.style.background='var(--surface3)'" onmouseout="this.style.background='var(--surface2)'">−</button>
        <input type="number" id="rf_quantite" value="1" min="1" max="100"
          style="width:52px;height:40px;background:var(--surface);border:none;border-left:1px solid rgba(240,192,64,0.2);border-right:1px solid rgba(240,192,64,0.2);color:var(--accent);font-family:'Syne',sans-serif;font-size:18px;font-weight:800;text-align:center;outline:none;"
          oninput="updateQtyUI()">
        <button type="button" onclick="changeQty(1)" style="width:36px;height:40px;background:var(--surface2);border:none;color:var(--text);font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s;" onmouseover="this.style.background='var(--surface3)'" onmouseout="this.style.background='var(--surface2)'">+</button>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="form-group">
        <label class="label">Fournisseur *</label>
        <div style="display:flex;gap:6px;">
          <select class="select" id="rf_supplier">${supOpts}</select>
          <button class="btn btn-ghost btn-sm btn-icon" onclick="openAddSupplier()" title="Nouveau"><i class="fas fa-plus"></i></button>
        </div>
      </div>
      <div class="form-group"><label class="label">Type *</label>
        <select class="select" id="rf_type">
          <option value="Portable" selected>Portable</option>
          <option value="UC">UC</option>
          <option value="Mini-UC">Mini-UC</option>
          <option value="PC Tablette">PC Tablette</option>
        </select>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="form-group"><label class="label">Marque *</label><input class="input" id="rf_brand" placeholder="HP, Dell…"></div>
      <div class="form-group"><label class="label">Modèle *</label><input class="input" id="rf_model" placeholder="640 G5…"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">
      <div class="form-group"><label class="label">Processeur</label><input class="input" id="rf_processor" placeholder="i5-8265U"></div>
      <div class="form-group"><label class="label">RAM</label><input class="input" id="rf_ram" placeholder="8 Go"></div>
      <div class="form-group"><label class="label">Stockage</label><input class="input" id="rf_storage_size" placeholder="256 Go"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="form-group"><label class="label">Type stockage</label>
        <select class="select" id="rf_storage_type"><option value="">—</option><option>SSD</option><option>HDD</option><option>NVMe</option><option>eMMC</option></select>
      </div>
      <div class="form-group"><label class="label">Taille écran</label><input class="input" id="rf_screen" placeholder='14"'></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="form-group"><label class="label">État *</label>
        <select class="select" id="rf_condition"><option value="sous_carton">Neuf (sous carton)</option><option value="occasion">Occasion</option></select>
      </div>
      <div class="form-group"><label class="label">Date réception *</label>
        <input class="input" id="rf_date" type="date" value="${new Date().toISOString().split('T')[0]}">
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="form-group"><label class="label">Durée garantie fournisseur</label><input class="input" id="rf_warranty" placeholder="3 mois, 1 an…"></div>
      <div class="form-group"><label class="label">Prix de vente (Ar)</label><input class="input" id="rf_price" type="number" placeholder="0"></div>
    </div>

    <!-- SN réels — visible seulement si quantité > 1 -->
    <div id="rf_sn_section" style="display:none;" class="form-group">
      <label class="label">
        N° Série fabricants <span style="color:var(--text-faint);font-weight:400;">(optionnel — 1 par ligne)</span>
      </label>
      <textarea class="textarea" id="rf_real_sn_list" placeholder="Ex:&#10;5CD1234ABC&#10;5CD5678DEF&#10;..." rows="3"
        style="font-family:monospace;font-size:12px;"></textarea>
      <div style="font-size:11px;color:var(--text-faint);margin-top:4px;">
        Laissez vide pour ignorer. Si renseigné, mettez autant de lignes que la quantité.
      </div>
    </div>

    <!-- SN unique — visible seulement si quantité = 1 -->
    <div id="rf_sn_single" class="form-group">
      <label class="label">N° Série fabricant <span style="color:var(--text-faint);font-weight:400;">(optionnel)</span></label>
      <input class="input" id="rf_real_sn" placeholder="SN du fabricant">
    </div>

    <div class="form-group">
      <label class="label">Photo <span style="color:var(--text-faint);font-weight:400;">(commune à tous les produits du lot)</span></label>
      <div class="img-upload-area" onclick="document.getElementById('rf_image').click()">
        <input type="file" id="rf_image" accept="image/*" style="display:none" onchange="previewImg(this,'rf_preview')">
        <i class="fas fa-camera" style="font-size:20px;color:var(--text-faint);display:block;margin-bottom:6px;"></i>
        <span style="font-size:12px;color:var(--text-faint)">Cliquer pour ajouter une photo</span>
        <img id="rf_preview" style="display:none;width:100%;max-height:100px;object-fit:cover;border-radius:8px;margin-top:8px;">
      </div>
    </div>
    <p id="rf_error" style="color:var(--red);font-size:12px;display:none;margin-top:6px;"></p>
  `,
  `<button class="btn btn-ghost" onclick="closeModal('reception')">Annuler</button>
   <button class="btn btn-primary" id="rf_submit_btn" onclick="submitReception()"><i class="fas fa-check"></i> Enregistrer <span id="rf_qty_label"></span></button>`);

  // Init qty UI après ouverture du modal
  setTimeout(updateQtyUI, 50);
};

window.previewImg = (input, previewId) => {
  const f=input.files[0]; if(!f) return;
  const r=new FileReader(); r.onload=e=>{const img=document.getElementById(previewId);img.src=e.target.result;img.style.display='block';};r.readAsDataURL(f);
};

window.openAddSupplier = () => {
  const { showModal } = _ctx;
  showModal('addsup','Nouveau Fournisseur',
    `<div class="form-group"><label class="label">Nom *</label><input class="input" id="sup_name" placeholder="Nom du fournisseur"></div>
     <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
       <div class="form-group"><label class="label">Téléphone</label><input class="input" id="sup_phone"></div>
       <div class="form-group"><label class="label">Email</label><input class="input" id="sup_email" type="email"></div>
     </div>`,
    `<button class="btn btn-ghost" onclick="closeModal('addsup')">Annuler</button>
     <button class="btn btn-primary" onclick="saveSupplier()">Enregistrer</button>`);
};

window.saveSupplier = async () => {
  const { api, toast } = _ctx;
  const name = document.getElementById('sup_name')?.value?.trim();
  if (!name) { toast('Nom requis','error'); return; }
  try {
    const sup = await api.post('/suppliers',{name,phone:document.getElementById('sup_phone')?.value,email:document.getElementById('sup_email')?.value});
    _suppliers.push(sup);
    const sel=document.getElementById('rf_supplier');
    if(sel) sel.innerHTML+=`<option value="${sup.id}" selected>${sup.name}</option>`;
    closeModal('addsup'); toast('Fournisseur créé','success');
  } catch(err){ toast(err.message,'error'); }
};

// ─── QUANTITÉ HELPERS ────────────────────────────────
window.changeQty = (delta) => {
  const input = document.getElementById('rf_quantite');
  if (!input) return;
  const val = Math.max(1, Math.min(100, (parseInt(input.value) || 1) + delta));
  input.value = val;
  updateQtyUI();
};

window.updateQtyUI = () => {
  const input = document.getElementById('rf_quantite');
  if (!input) return;
  const qty = Math.max(1, parseInt(input.value) || 1);
  input.value = qty;

  // Afficher/cacher les sections SN
  const snSection = document.getElementById('rf_sn_section');
  const snSingle  = document.getElementById('rf_sn_single');
  if (snSection) snSection.style.display = qty > 1 ? 'block' : 'none';
  if (snSingle)  snSingle.style.display  = qty > 1 ? 'none'  : 'block';

  // Mettre à jour le label du bouton
  const label = document.getElementById('rf_qty_label');
  if (label) label.textContent = qty > 1 ? `(${qty} unités)` : '';
};

window.submitReception = async () => {
  const { api, toast } = _ctx;
  const g = id => document.getElementById(id)?.value?.trim();

  // Validation champs obligatoires
  if (!g('rf_supplier')||!g('rf_brand')||!g('rf_model')||!g('rf_type')||!g('rf_condition')||!g('rf_date')) {
    document.getElementById('rf_error').style.display = 'block';
    document.getElementById('rf_error').textContent = 'Veuillez remplir tous les champs obligatoires (*)';
    return;
  }

  const qty = Math.max(1, Math.min(100, parseInt(document.getElementById('rf_quantite')?.value) || 1));

  const fd = new FormData();
  fd.append('supplier_id',       g('rf_supplier'));
  fd.append('type',              g('rf_type'));
  fd.append('brand',             g('rf_brand'));
  fd.append('model',             g('rf_model'));
  fd.append('processor',         g('rf_processor') || '');
  fd.append('ram',               g('rf_ram') || '');
  fd.append('storage_size',      g('rf_storage_size') || '');
  fd.append('storage_type',      g('rf_storage_type') || '');
  fd.append('screen_size',       g('rf_screen') || '');
  fd.append('condition',         g('rf_condition'));
  fd.append('reception_date',    g('rf_date'));
  fd.append('warranty_duration', g('rf_warranty') || '');
  fd.append('sale_price',        g('rf_price') || '0');
  fd.append('quantite',          qty);

  // SN réels
  if (qty === 1) {
    fd.append('real_sn_list', g('rf_real_sn') || '');
  } else {
    const snList = document.getElementById('rf_real_sn_list')?.value?.trim() || '';
    fd.append('real_sn_list', snList);
  }

  // Image
  const img = document.getElementById('rf_image')?.files[0];
  if (img) fd.append('image', img);

  // Désactiver bouton pendant la création
  const btn = document.getElementById('rf_submit_btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:2px;"></div> Création…'; }

  try {
    const result = await _ctx.api.postForm('/products', fd);

    // result.products = tableau de tous les produits créés
    const created = result.products || [result];
    created.forEach(p => _products.unshift(p));
    renderTable();
    closeModal('reception');

    if (qty === 1) {
      toast(`✅ Produit enregistré — SN: ${result.internal_sn}`, 'success', 5000);
    } else {
      toast(`✅ ${result.created} produits enregistrés (${g('rf_brand')} ${g('rf_model')})`, 'success', 6000);
    }
  } catch(err) {
    document.getElementById('rf_error').style.display = 'block';
    document.getElementById('rf_error').textContent = err.message;
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-check"></i> Enregistrer'; }
  }
};

// ─── SEND ────────────────────────────────────────────
window.sendProduct = (id, dest) => {
  const { showModal } = _ctx;
  const p=_products.find(x=>x.id===id); if(!p) return;
  const isGar=dest==='garantie';
  showModal('move', isGar?'Envoyer en Garantie':'Envoyer en Boutique',
    `<div style="background:var(--surface2);border-radius:10px;padding:12px;margin-bottom:14px;">
       <strong>${p.brand} ${p.model}</strong><br>
       <span class="mono" style="font-size:11px;color:var(--text-faint)">${p.internal_sn}</span>
     </div>
     ${isGar
       ? `<div class="form-group"><label class="label">Problème constaté * <span style="color:var(--red)">(obligatoire)</span></label>
            <textarea class="textarea" id="move_problem" placeholder="Décrivez le problème…"></textarea></div>`
       : `<div class="form-group"><label class="label">Envoyé par (votre nom)</label>
            <input class="input" id="move_dest" placeholder="Votre nom"></div>
          <div class="form-group"><label class="label">Motif (optionnel)</label>
            <input class="input" id="move_reason" placeholder="Motif du transfert"></div>`}
     <p id="move_error" style="color:var(--red);font-size:12px;display:none;"></p>`,
    `<button class="btn btn-ghost" onclick="closeModal('move')">Annuler</button>
     <button class="btn btn-primary" style="${isGar?'background:var(--red)':''}" onclick="confirmMove(${id},'${dest}',${isGar})">
       <i class="fas fa-check"></i> Confirmer
     </button>`);
};

window.confirmMove = async (id, dest, isGar) => {
  const { api, toast } = _ctx;
  const problem=document.getElementById('move_problem')?.value?.trim();
  const d=document.getElementById('move_dest')?.value?.trim();
  const reason=document.getElementById('move_reason')?.value?.trim();
  if(isGar&&!problem){ document.getElementById('move_error').style.display='block'; document.getElementById('move_error').textContent='Description obligatoire'; return; }
  try {
    await api.post(`/products/${id}/move`,{to_stock:dest,problem_description:problem,destination_detail:d,reason});
    _products=_products.filter(p=>p.id!==id); renderTable(); closeModal('move');
    toast(dest==='boutique' ? 'Envoyé en boutique' : 'Envoyé en garantie', 'success');
  } catch(err){ document.getElementById('move_error').style.display='block'; document.getElementById('move_error').textContent=err.message; }
};

// ─── VIEW ────────────────────────────────────────────
window.viewProduct = (id) => {
  const { showModal, fmt, esc, conditionBadge } = _ctx;
  const p=_products.find(x=>x.id===id); if(!p) return;
  showModal('view',`${p.brand} ${p.model}`,`
    ${p.image_url?`<img src="${p.image_url}" style="width:100%;height:180px;object-fit:cover;border-radius:10px;margin-bottom:14px;">` : ''}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
      ${tile('N° Série Interne',`<span class="mono" style="font-size:12px;">${esc(p.internal_sn)}</span>`)}
      ${tile('SN Fabricant',p.real_sn?esc(p.real_sn):'—')}
      ${tile('Type',p.type||'—')} ${tile('État',conditionBadge(p.condition))}
      ${tile('Processeur',p.processor||'—')} ${tile('RAM',p.ram||'—')}
      ${tile('Stockage',[p.storage_size,p.storage_type].filter(Boolean).join(' ')||'—')} ${tile('Écran',p.screen_size||'—')}
      ${tile('Fournisseur',p.supplier_name||'—')} ${tile('Réception',fmt.date(p.reception_date))}
      ${tile('Fin garantie',fmt.date(p.warranty_expiry))}
      ${tile('Prix',`<span style="color:var(--accent);font-weight:700">${fmt.currency(p.sale_price)}</span>`)}
    </div>`,
  `<button class="btn btn-secondary btn-sm" onclick="printLabel(${p.id})"><i class="fas fa-tag"></i> Étiquette</button>
   <button class="btn btn-ghost" onclick="closeModal('view')">Fermer</button>`);
};

// ─── EDIT (admin) ─────────────────────────────────────
window.editProduct = (id) => {
  const { showModal, esc } = _ctx;
  const p=_products.find(x=>x.id===id); if(!p) return;
  const supOpts=_suppliers.map(s=>`<option value="${s.id}" ${s.id===p.supplier_id?'selected':''}>${esc(s.name)}</option>`).join('');
  showModal('edit',`Modifier — ${p.brand} ${p.model}`,`
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">
      <div class="form-group"><label class="label">Type</label>
        <select class="select" id="ef_type">
          ${['Portable','UC','Mini-UC','PC Tablette'].map(t=>`<option value="${t}" ${p.type===t?'selected':''}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label class="label">Marque</label><input class="input" id="ef_brand" value="${esc(p.brand||'')}"></div>
      <div class="form-group"><label class="label">Modèle</label><input class="input" id="ef_model" value="${esc(p.model||'')}"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">
      <div class="form-group"><label class="label">Processeur</label><input class="input" id="ef_processor" value="${esc(p.processor||'')}"></div>
      <div class="form-group"><label class="label">RAM</label><input class="input" id="ef_ram" value="${esc(p.ram||'')}"></div>
      <div class="form-group"><label class="label">Stockage</label><input class="input" id="ef_storage_size" value="${esc(p.storage_size||'')}"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="form-group"><label class="label">Type stockage</label>
        <select class="select" id="ef_storage_type">
          <option value="">—</option>
          ${['SSD','HDD','NVMe','eMMC'].map(t=>`<option ${p.storage_type===t?'selected':''}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label class="label">Taille écran</label><input class="input" id="ef_screen" value="${esc(p.screen_size||'')}"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="form-group"><label class="label">État</label>
        <select class="select" id="ef_condition">
          <option value="sous_carton" ${p.condition==='sous_carton'?'selected':''}>Neuf (sous carton)</option>
          <option value="occasion" ${p.condition==='occasion'?'selected':''}>Occasion</option>
        </select>
      </div>
      <div class="form-group"><label class="label">Prix de vente (Ar)</label>
        <input class="input" id="ef_price" type="number" value="${p.sale_price||0}">
      </div>
    </div>
    <div class="form-group"><label class="label">N° Série réel</label><input class="input" id="ef_real_sn" value="${esc(p.real_sn||'')}"></div>
    <div class="form-group">
      <label class="label">Nouvelle photo (optionnel)</label>
      <div class="img-upload-area" onclick="document.getElementById('ef_image').click()">
        <input type="file" id="ef_image" accept="image/*" style="display:none" onchange="previewImg(this,'ef_preview')">
        ${p.image_url?`<img src="${p.image_url}" style="width:100%;max-height:100px;object-fit:cover;border-radius:8px;">` : '<span style="font-size:12px;color:var(--text-faint)">Cliquer pour changer la photo</span>'}
        <img id="ef_preview" style="display:none;width:100%;max-height:100px;object-fit:cover;border-radius:8px;margin-top:6px;">
      </div>
    </div>
    <p id="ef_error" style="color:var(--red);font-size:12px;display:none;"></p>`,
  `<button class="btn btn-ghost" onclick="closeModal('edit')">Annuler</button>
   <button class="btn btn-primary" onclick="saveEdit(${id})"><i class="fas fa-save"></i> Enregistrer</button>`);
};

window.saveEdit = async (id) => {
  const { api, toast } = _ctx;
  const g = sid => document.getElementById(sid)?.value?.trim();
  const fd = new FormData();
  fd.append('type',        g('ef_type'));
  fd.append('brand',       g('ef_brand'));
  fd.append('model',       g('ef_model'));
  fd.append('processor',   g('ef_processor'));
  fd.append('ram',         g('ef_ram'));
  fd.append('storage_size',g('ef_storage_size'));
  fd.append('storage_type',g('ef_storage_type'));
  fd.append('screen_size', g('ef_screen'));
  fd.append('condition',   g('ef_condition'));
  fd.append('sale_price',  g('ef_price')||'0');
  fd.append('real_sn',     g('ef_real_sn'));
  const img=document.getElementById('ef_image')?.files[0]; if(img) fd.append('image',img);
  try {
    const updated = await api.putForm(`/products/${id}`,fd);
    const idx=_products.findIndex(p=>p.id===id);
    if(idx>-1) _products[idx]={..._products[idx],...updated};
    renderTable(); closeModal('edit'); toast('Produit modifié','success');
  } catch(err){
    document.getElementById('ef_error').style.display='block';
    document.getElementById('ef_error').textContent=err.message;
  }
};

// ─── DELETE (admin) ───────────────────────────────────
window.deleteProduct = async (id) => {
  const { api, toast, confirm: cfm } = _ctx;
  const p=_products.find(x=>x.id===id); if(!p) return;
  const ok = await cfm(`Supprimer définitivement <strong>${p.brand} ${p.model}</strong> (${p.internal_sn}) ?<br><br><span style="color:var(--red);font-size:12px;">Cette action est irréversible.</span>`, 'Supprimer le produit');
  if(!ok) return;
  try {
    await api.delete(`/products/${id}`);
    _products=_products.filter(x=>x.id!==id);
    renderTable(); toast('Produit supprimé','success');
  } catch(err){ toast(err.message,'error'); }
};

function tile(label, val) {
  return `<div style="background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;">
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-faint);margin-bottom:3px;">${label}</div>
    <div style="font-size:13px;">${val}</div>
  </div>`;
}

window.printLabel = (id) => {
  const token = localStorage.getItem('sf_token')||'';
  window.open(`/api/products/${id}/label?token=${token}`, '_blank', 'width=400,height=300');
};
