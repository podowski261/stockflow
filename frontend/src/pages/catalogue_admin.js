// ══════════════════════════════════════════════════════
//  PAGE CATALOGUE ADMIN — Pré-catalogue public
//  Gestion des fiches produits visibles dans le catalogue
// ══════════════════════════════════════════════════════
let _ctx, _products = [], _suppliers = [];

export async function render(container, ctx) {
  _ctx = ctx;
  container.innerHTML = `<div style="padding:clamp(14px,3vw,28px);" id="catAdminPage">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
      <div>
        <div style="font-family:'Syne',sans-serif;font-size:20px;font-weight:800;">Pré-catalogue public</div>
        <div style="font-size:13px;color:var(--text-dim);margin-top:2px;">
          Fiches produits · informations visibles dans le catalogue public
        </div>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
        <div class="search-wrap"><i class="fas fa-search"></i>
          <input class="search-input" id="catSearch" placeholder="Rechercher…" oninput="filterCat()">
        </div>
        <select class="select" id="catStockFilter" onchange="filterCat()" style="width:auto;height:36px;font-size:13px;">
          <option value="">Tous les stocks</option>
          <option value="boutique">Boutique</option>
          <option value="atelier">Atelier</option>
          <option value="installation">Installation</option>
        </select>
        <a href="/catalogue.html" target="_blank" class="btn btn-secondary btn-sm">
          <i class="fas fa-external-link-alt"></i> Voir catalogue public
        </a>
      </div>
    </div>
    <div id="catAdminContent"><div class="loader-wrap"><div class="spinner"></div></div></div>
  </div>`;

  await loadAll();
}

async function loadAll() {
  const { api, toast } = _ctx;
  try {
    const [allP, sup] = await Promise.all([
      api.get('/products'),
      api.get('/suppliers')
    ]);
    _products = allP;
    _suppliers = sup;
    renderTable();
  } catch(err) { toast('Erreur: ' + err.message, 'error'); }
}

function renderTable() {
  const { fmt, stockBadge, conditionBadge, esc } = _ctx;
  const q = (document.getElementById('catSearch')?.value || '').toLowerCase();
  const stockF = document.getElementById('catStockFilter')?.value || '';

  const products = _products.filter(p => {
    const matchStock = !stockF || p.current_stock === stockF;
    const matchQ = !q || [p.brand,p.model,p.internal_sn,p.supplier_name,p.processor].join(' ').toLowerCase().includes(q);
    return matchStock && matchQ;
  });

  const content = document.getElementById('catAdminContent');
  if (!content) return;

  if (!products.length) {
    content.innerHTML = `<div class="empty-state"><i class="fas fa-store"></i><p>Aucun produit</p></div>`;
    return;
  }

  content.innerHTML = `
    <div style="font-size:13px;color:var(--text-dim);margin-bottom:14px;">
      <strong style="color:var(--text)">${products.length}</strong> produit(s)
      <span style="margin-left:12px;font-size:12px;">
        <i class="fas fa-info-circle" style="color:var(--accent);"></i>
        Cliquez <strong>Modifier fiche</strong> pour renseigner description, accessoires, remarques et prix barré
      </span>
    </div>
    <div class="table-wrap"><table class="data-table">
    <thead><tr>
      <th>Photo</th><th>Produit</th><th>Config</th><th>Stock</th>
      <th>Prix public</th><th>Prix barré</th><th>Remise</th>
      <th>Description</th><th>Catalogue</th><th>Actions</th>
    </tr></thead>
    <tbody>${products.map(p => {
      const hasDiscount = p.original_price && parseFloat(p.original_price) > parseFloat(p.sale_price);
      const discPct = p.discount_pct ? Math.round(parseFloat(p.discount_pct)) :
        hasDiscount ? Math.round((1 - parseFloat(p.sale_price)/parseFloat(p.original_price))*100) : null;
      return `<tr>
        <td>
          ${p.image_url
            ? `<img src="${esc(p.image_url)}" style="width:44px;height:44px;object-fit:cover;border-radius:8px;">`
            : `<div style="width:44px;height:44px;background:var(--surface2);border-radius:8px;display:flex;align-items:center;justify-content:center;"><i class="fas fa-laptop" style="color:var(--text-faint);"></i></div>`}
        </td>
        <td>
          <strong>${esc(p.brand)} ${esc(p.model)}</strong><br>
          <span class="mono" style="font-size:10px;color:var(--text-faint)">${esc(p.internal_sn)}</span>
        </td>
        <td style="font-size:11px;color:var(--text-dim)">
          ${[p.processor,p.ram,(p.storage_size||'')+(p.storage_type?' '+p.storage_type:'')].filter(Boolean).join('<br>')||'—'}
        </td>
        <td>${stockBadge(p.current_stock)}</td>
        <td style="color:var(--accent);font-family:'Syne',sans-serif;font-weight:700;white-space:nowrap;">
          ${fmt.currency(p.sale_price)}
        </td>
        <td style="font-size:12px;">
          ${p.original_price && parseFloat(p.original_price) > 0
            ? `<span style="color:var(--text-faint);text-decoration:line-through;">${fmt.currency(p.original_price)}</span>`
            : '<span style="color:var(--text-faint)">—</span>'}
        </td>
        <td style="text-align:center;">
          ${discPct ? `<span style="background:rgba(240,80,96,0.15);color:var(--red);padding:3px 8px;border-radius:999px;font-size:11px;font-weight:700;">-${discPct}%</span>` : '—'}
        </td>
        <td style="max-width:160px;">
          ${p.catalogue_description
            ? `<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--text-dim)" title="${esc(p.catalogue_description)}">${esc(p.catalogue_description)}</div>`
            : '<span style="color:var(--text-faint);font-size:11px;font-style:italic;">Non renseignée</span>'}
        </td>
        <td style="text-align:center;">
          ${p.show_in_catalogue === false
            ? `<span class="badge" style="background:rgba(240,80,96,0.12);color:var(--red)"><i class="fas fa-eye-slash"></i> Masqué</span>`
            : `<span class="badge" style="background:rgba(48,208,144,0.12);color:var(--green)"><i class="fas fa-eye"></i> Visible</span>`}
        </td>
        <td>
          <div style="display:flex;gap:5px;">
            <button class="btn btn-primary btn-sm" onclick="openCatEdit(${p.id})">
              <i class="fas fa-edit"></i> Modifier fiche
            </button>
            <button class="btn btn-ghost btn-sm btn-icon" onclick="previewCard(${p.id})" title="Aperçu carte catalogue">
              <i class="fas fa-eye"></i>
            </button>
            <button class="btn btn-danger btn-sm btn-icon" onclick="deleteCatProduct(${p.id})" title="Supprimer">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        </td>
      </tr>`;
    }).join('')}
    </tbody>
  </table></div>`;
}

window.filterCat = renderTable;

// ─── MODAL FICHE CATALOGUE ────────────────────────────
window.openCatEdit = (id) => {
  const { showModal, fmt, esc } = _ctx;
  const p = _products.find(x => x.id === id); if (!p) return;

  const origPrice = p.original_price ? parseFloat(p.original_price) : '';
  const discPct   = p.discount_pct   ? parseFloat(p.discount_pct)   : '';

  showModal('catedit', `Fiche catalogue — ${p.brand} ${p.model}`, `

    <!-- Aperçu mini -->
    <div style="background:var(--surface2);border-radius:10px;padding:12px;margin-bottom:18px;display:flex;align-items:center;gap:12px;">
      ${p.image_url
        ? `<img src="${esc(p.image_url)}" style="width:52px;height:52px;object-fit:cover;border-radius:8px;flex-shrink:0;">`
        : `<div style="width:52px;height:52px;background:var(--surface3);border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;"><i class="fas fa-laptop" style="color:var(--text-faint)"></i></div>`}
      <div>
        <strong>${esc(p.brand)} ${esc(p.model)}</strong>
        <div style="font-size:11px;color:var(--text-dim);margin-top:2px;">
          ${[p.processor,p.ram,p.storage_size].filter(Boolean).join(' · ')||'—'}
        </div>
        <div style="font-size:11px;color:var(--text-faint);margin-top:2px;" class="mono">${esc(p.internal_sn)}</div>
      </div>
      <div style="margin-left:auto;text-align:right;">
        <div style="font-family:'Syne',sans-serif;font-size:16px;font-weight:800;color:var(--accent)">${fmt.currency(p.sale_price)}</div>
        <div style="font-size:11px;color:var(--text-dim);margin-top:2px;">${p.condition==='sous_carton'?'Neuf':'Occasion'}</div>
      </div>
    </div>

    <!-- ─ SECTION PRIX ─ -->
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:2px;color:var(--text-faint);font-weight:700;margin-bottom:10px;">
      <i class="fas fa-tag" style="color:var(--accent);margin-right:6px;"></i>Prix & Remise
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:16px;">
      <div class="form-group" style="margin:0;">
        <label class="label">Prix de vente (Ar) *</label>
        <input class="input" id="ce_price" type="number" value="${parseFloat(p.sale_price)||0}"
          oninput="calcDiscount()" style="color:var(--accent);font-weight:700;">
      </div>
      <div class="form-group" style="margin:0;">
        <label class="label">Prix d'origine barré (Ar)</label>
        <input class="input" id="ce_orig_price" type="number" value="${origPrice}"
          placeholder="Laisser vide si pas de remise" oninput="calcDiscount()">
      </div>
      <div class="form-group" style="margin:0;">
        <label class="label">Remise calculée</label>
        <div id="ce_discount_preview" style="height:40px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;display:flex;align-items:center;justify-content:center;font-family:'Syne',sans-serif;font-size:16px;font-weight:800;color:var(--red);">
          ${discPct ? `-${Math.round(discPct)}%` : '—'}
        </div>
      </div>
    </div>

    <!-- ─ SECTION CATALOGUE ─ -->
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:2px;color:var(--text-faint);font-weight:700;margin-bottom:10px;">
      <i class="fas fa-align-left" style="color:var(--accent);margin-right:6px;"></i>Fiche catalogue
    </div>

    <div class="form-group">
      <label class="label">Description publique
        <span style="color:var(--text-faint);font-weight:400;text-transform:none;letter-spacing:0;">(visible dans le catalogue)</span>
      </label>
      <textarea class="textarea" id="ce_desc" rows="4"
        placeholder="Décrivez le produit : performances, usage recommandé, points forts…"
        >${esc(p.catalogue_description||'')}</textarea>
    </div>

    <div class="form-group">
      <label class="label">Accessoires inclus</label>
      <textarea class="textarea" id="ce_accessories" rows="2"
        placeholder="Ex: Chargeur, sacoche, souris, câble HDMI…"
        >${esc(p.catalogue_accessories||'')}</textarea>
    </div>

    <div class="form-group">
      <label class="label">Remarques / Notes publiques
        <span style="color:var(--text-faint);font-weight:400;text-transform:none;letter-spacing:0;">(rayures, état détaillé, etc.)</span>
      </label>
      <textarea class="textarea" id="ce_remarks" rows="2"
        placeholder="Ex: Légères rayures sur le boîtier, batterie neuve…"
        >${esc(p.catalogue_remarks||'')}</textarea>
    </div>

    <!-- ─ SECTION IMAGE & VISIBILITÉ ─ -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
      <div>
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:2px;color:var(--text-faint);font-weight:700;margin-bottom:10px;">
          <i class="fas fa-camera" style="color:var(--accent);margin-right:6px;"></i>Photo catalogue
        </div>
        <div class="img-upload-area" onclick="document.getElementById('ce_img').click()">
          <input type="file" id="ce_img" accept="image/*" style="display:none" onchange="prevCeImg(this)">
          ${p.image_url
            ? `<img src="${esc(p.image_url)}" style="width:100%;max-height:90px;object-fit:cover;border-radius:8px;margin-bottom:4px;">`
            : `<i class="fas fa-camera" style="font-size:20px;color:var(--text-faint);display:block;margin-bottom:4px;"></i>`}
          <span style="font-size:11px;color:var(--text-faint);">Cliquer pour changer</span>
          <img id="ce_preview" style="display:none;width:100%;max-height:80px;object-fit:cover;border-radius:8px;margin-top:6px;">
        </div>
      </div>
      <div>
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:2px;color:var(--text-faint);font-weight:700;margin-bottom:10px;">
          <i class="fas fa-eye" style="color:var(--accent);margin-right:6px;"></i>Visibilité
        </div>
        <label style="display:flex;align-items:flex-start;gap:10px;padding:14px;background:var(--surface2);border-radius:10px;cursor:pointer;border:1px solid var(--border);">
          <input type="checkbox" id="ce_show" ${p.show_in_catalogue !== false ? 'checked' : ''}
            style="width:18px;height:18px;accent-color:var(--accent);margin-top:2px;flex-shrink:0;">
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text);">Visible dans le catalogue public</div>
            <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">
              Si décoché, le produit n'apparaîtra pas dans le catalogue consulté par les clients
            </div>
          </div>
        </label>

        <!-- Infos techniques (non modifiables ici) -->
        <div style="margin-top:12px;padding:12px;background:var(--surface2);border-radius:8px;font-size:11px;color:var(--text-dim);">
          <div style="font-weight:600;color:var(--text);margin-bottom:6px;">Type & État</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
            <div>Type: <strong>${esc(p.type||'—')}</strong></div>
            <div>État: <strong>${p.condition==='sous_carton'?'Neuf':'Occasion'}</strong></div>
            <div>Marque: <strong>${esc(p.brand)}</strong></div>
            <div>Modèle: <strong>${esc(p.model)}</strong></div>
          </div>
        </div>
      </div>
    </div>

    <p id="ce_err" style="color:var(--red);font-size:12px;display:none;margin-top:10px;"></p>
  `,
  `<button class="btn btn-ghost" onclick="closeModal('catedit')">Annuler</button>
   <button class="btn btn-secondary" onclick="previewFromEdit(${id})">
     <i class="fas fa-eye"></i> Aperçu
   </button>
   <button class="btn btn-primary" onclick="saveCatEdit(${id})">
     <i class="fas fa-save"></i> Enregistrer la fiche
   </button>`);

  // Init calc discount
  setTimeout(calcDiscount, 50);
};

// ─── CALC DISCOUNT EN TEMPS RÉEL ─────────────────────
window.calcDiscount = () => {
  const price = parseFloat(document.getElementById('ce_price')?.value) || 0;
  const orig  = parseFloat(document.getElementById('ce_orig_price')?.value) || 0;
  const prev  = document.getElementById('ce_discount_preview');
  if (!prev) return;

  if (orig > price && orig > 0) {
    const pct = Math.round((1 - price / orig) * 100);
    prev.textContent = `-${pct}%`;
    prev.style.color = 'var(--red)';
    prev.style.background = 'rgba(240,80,96,0.12)';
    prev.style.borderColor = 'rgba(240,80,96,0.25)';
  } else {
    prev.textContent = '—';
    prev.style.color = 'var(--text-faint)';
    prev.style.background = 'var(--surface2)';
    prev.style.borderColor = 'var(--border)';
  }
};

window.prevCeImg = (input) => {
  const f = input.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = e => { const img=document.getElementById('ce_preview'); img.src=e.target.result; img.style.display='block'; };
  r.readAsDataURL(f);
};

// ─── SAVE ────────────────────────────────────────────
window.saveCatEdit = async (id) => {
  const { api, toast } = _ctx;
  const g = sid => document.getElementById(sid)?.value?.trim();

  const price     = parseFloat(g('ce_price')) || 0;
  const origPrice = parseFloat(g('ce_orig_price')) || null;
  const showIn    = document.getElementById('ce_show')?.checked ? 'true' : 'false';

  // Recalcul du discount_pct
  let discPct = null;
  if (origPrice && origPrice > price) {
    discPct = Math.round((1 - price / origPrice) * 100);
  }

  const fd = new FormData();
  fd.append('sale_price',             price);
  fd.append('original_price',         origPrice || '');
  fd.append('discount_pct',           discPct || '');
  fd.append('catalogue_description',  g('ce_desc') || '');
  fd.append('catalogue_accessories',  g('ce_accessories') || '');
  fd.append('catalogue_remarks',      g('ce_remarks') || '');
  fd.append('show_in_catalogue',      showIn);

  const img = document.getElementById('ce_img')?.files[0];
  if (img) fd.append('image', img);

  try {
    const updated = await api.putForm(`/products/${id}`, fd);
    const idx = _products.findIndex(p => p.id === id);
    if (idx > -1) _products[idx] = { ..._products[idx], ...updated };
    renderTable();
    closeModal('catedit');
    toast('Fiche catalogue mise à jour ✅', 'success');
  } catch(err) {
    document.getElementById('ce_err').style.display = 'block';
    document.getElementById('ce_err').textContent = err.message;
  }
};

// ─── APERÇU CARTE CATALOGUE ──────────────────────────
window.previewCard = (id) => { previewFromId(id); };
window.previewFromEdit = (id) => { closeModal('catedit'); setTimeout(() => previewFromId(id), 100); };

function previewFromId(id) {
  const { showModal, fmt, esc } = _ctx;
  const p = _products.find(x => x.id === id); if (!p) return;
  const price     = parseFloat(p.sale_price) || 0;
  const origPrice = p.original_price ? parseFloat(p.original_price) : null;
  const discPct   = p.discount_pct ? Math.round(parseFloat(p.discount_pct))
    : (origPrice && origPrice > price ? Math.round((1-price/origPrice)*100) : null);
  const specs = [p.processor, p.ram, (p.storage_size||'')+(p.storage_type?' '+p.storage_type:''), p.screen_size].filter(Boolean);
  const hasDispo = p.current_stock === 'boutique';

  showModal('preview', 'Aperçu — Carte catalogue public', `
    <!-- Rendu fidèle à la carte catalogue -->
    <div style="max-width:320px;margin:0 auto;background:var(--surface);border:1px solid var(--border);border-radius:14px;overflow:hidden;">

      <!-- Image -->
      <div style="width:100%;aspect-ratio:4/3;background:var(--surface2);display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;">
        ${p.image_url
          ? `<img src="${esc(p.image_url)}" style="width:100%;height:100%;object-fit:cover;">`
          : `<i class="fas fa-laptop" style="font-size:40px;color:var(--text-faint);"></i>`}
        <span style="position:absolute;top:10px;right:10px;padding:4px 10px;border-radius:999px;font-size:10px;font-weight:700;background:${hasDispo?'rgba(48,208,144,0.85)':'rgba(240,80,96,0.85)'};color:${hasDispo?'#0a0a0f':'#fff'};">
          ${hasDispo?'Disponible':'Rupture'}
        </span>
        ${discPct ? `<span style="position:absolute;top:10px;left:10px;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:800;background:var(--red);color:#fff;">-${discPct}%</span>` : ''}
      </div>

      <!-- Body -->
      <div style="padding:14px;">
        <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--accent);margin-bottom:5px;">${esc(p.type||'')}</div>
        <div style="font-family:'Syne',sans-serif;font-size:15px;font-weight:700;margin-bottom:5px;">${esc(p.brand)} ${esc(p.model)}</div>
        <div style="font-size:11px;color:var(--text-faint);margin-bottom:10px;">${specs.map(s=>esc(s)).join(' · ')||'—'}</div>

        ${p.catalogue_description ? `
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;line-height:1.5;border-top:1px solid var(--border);padding-top:8px;">
          ${esc(p.catalogue_description)}
        </div>` : ''}

        ${p.catalogue_accessories ? `
        <div style="font-size:11px;margin-bottom:8px;">
          <span style="color:var(--green);font-weight:600;"><i class="fas fa-check-circle"></i> Inclus :</span>
          <span style="color:var(--text-dim);"> ${esc(p.catalogue_accessories)}</span>
        </div>` : ''}

        ${p.catalogue_remarks ? `
        <div style="font-size:11px;padding:6px 10px;background:rgba(240,192,64,0.08);border-left:3px solid var(--accent);border-radius:0 6px 6px 0;margin-bottom:10px;color:var(--text-dim);">
          <i class="fas fa-info-circle" style="color:var(--accent);"></i> ${esc(p.catalogue_remarks)}
        </div>` : ''}

        <!-- Prix -->
        <div style="display:flex;align-items:flex-end;gap:10px;justify-content:space-between;margin-top:10px;">
          <div>
            ${origPrice ? `<div style="font-size:12px;color:var(--text-faint);text-decoration:line-through;">${fmt.currency(origPrice)}</div>` : ''}
            <div style="font-family:'Syne',sans-serif;font-size:${origPrice?'20px':'17px'};font-weight:800;color:var(--accent);">${fmt.currency(price)}</div>
          </div>
          <span style="font-size:10px;padding:2px 8px;border-radius:999px;font-weight:600;${p.condition==='sous_carton'?'background:rgba(48,208,144,0.15);color:var(--green)':'background:rgba(240,192,64,0.12);color:var(--accent)'}">
            ${p.condition==='sous_carton'?'Neuf':'Occasion'}
          </span>
        </div>
      </div>
    </div>
    <div style="text-align:center;margin-top:14px;font-size:12px;color:var(--text-faint);">
      <i class="fas fa-info-circle"></i> Aperçu fidèle de la carte dans le catalogue public
    </div>`,
  `<button class="btn btn-secondary" onclick="closeModal('preview');openCatEdit(${id})"><i class="fas fa-edit"></i> Modifier</button>
   <button class="btn btn-ghost" onclick="closeModal('preview')">Fermer</button>`);
}

// ─── DELETE ──────────────────────────────────────────
window.deleteCatProduct = async (id) => {
  const { api, toast, confirm: cfm, esc } = _ctx;
  const p = _products.find(x => x.id === id); if (!p) return;
  const ok = await cfm(
    `Supprimer définitivement <strong>${esc(p.brand)} ${esc(p.model)}</strong> ?<br>
    <span style="color:var(--red);font-size:12px;">⚠️ Irréversible — toutes les données seront perdues.</span>`,
    'Supprimer le produit'
  );
  if (!ok) return;
  try {
    await api.delete(`/products/${id}`);
    _products = _products.filter(x => x.id !== id);
    renderTable();
    toast('Produit supprimé', 'success');
  } catch(err) { toast(err.message, 'error'); }
};
