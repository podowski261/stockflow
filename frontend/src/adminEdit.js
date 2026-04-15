// ══════════════════════════════════════════════════════
//  ADMIN EDIT / DELETE — Partagé entre toutes les pages
// ══════════════════════════════════════════════════════

/**
 * Ouvre le modal d'édition d'un produit (admin seulement)
 * @param {object} product - le produit complet
 * @param {object} ctx     - contexte (api, toast, showModal, esc, fmt)
 * @param {function} onSuccess - callback après sauvegarde/suppression
 */
export function openAdminEdit(product, ctx, onSuccess) {
  const { api, toast, showModal, esc, fmt, confirm } = ctx;
  const p = product;

  const body = `
    <div style="background:rgba(240,192,64,0.06);border:1px solid rgba(240,192,64,0.2);border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:var(--accent);">
      <i class="fas fa-shield-alt" style="margin-right:6px;"></i>
      Mode administrateur — Modification directe
    </div>
    <div style="margin-bottom:12px;"><span class="mono" style="font-size:11px;color:var(--text-faint);">SN: ${esc(p.internal_sn)}</span></div>

    <div class="form-row">
      <div class="form-group"><label class="label">Marque *</label><input class="input" id="ae_brand" value="${esc(p.brand||'')}"></div>
      <div class="form-group"><label class="label">Modèle *</label><input class="input" id="ae_model" value="${esc(p.model||'')}"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="label">Type</label>
        <select class="select" id="ae_type">
          ${['UC','Mini-UC','PC Tablette','Portable'].map(t=>`<option value="${t}" ${p.type===t?'selected':''}>${t}</option>`).join('')}
        </select>
      </div>
      <div class="form-group"><label class="label">État</label>
        <select class="select" id="ae_condition">
          <option value="sous_carton" ${p.condition==='sous_carton'?'selected':''}>Neuf (sous carton)</option>
          <option value="occasion" ${p.condition==='occasion'?'selected':''}>Occasion</option>
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="label">Processeur</label><input class="input" id="ae_processor" value="${esc(p.processor||'')}"></div>
      <div class="form-group"><label class="label">RAM</label><input class="input" id="ae_ram" value="${esc(p.ram||'')}"></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="label">Stockage</label><input class="input" id="ae_storage_size" value="${esc(p.storage_size||'')}"></div>
      <div class="form-group"><label class="label">Type stockage</label>
        <select class="select" id="ae_storage_type">
          <option value="">—</option>
          ${['SSD','HDD','NVMe','eMMC'].map(t=>`<option value="${t}" ${p.storage_type===t?'selected':''}>${t}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="label">Taille écran</label><input class="input" id="ae_screen" value="${esc(p.screen_size||'')}"></div>
      <div class="form-group"><label class="label">Prix de vente (Ar)</label><input class="input" id="ae_price" type="number" value="${p.sale_price||0}"></div>
    </div>
    <div class="form-group"><label class="label">N° Série réel (optionnel)</label><input class="input" id="ae_real_sn" value="${esc(p.real_sn||'')}"></div>
    <div class="form-group">
      <label class="label">Nouvelle photo (optionnel)</label>
      <div class="img-upload-area" onclick="document.getElementById('ae_image').click()" style="padding:14px;text-align:center;border:2px dashed var(--border);border-radius:10px;cursor:pointer;">
        <input type="file" id="ae_image" accept="image/*" style="display:none" onchange="this.nextElementSibling.src=URL.createObjectURL(this.files[0]);this.nextElementSibling.style.display='block'">
        ${p.image_url ? `<img src="${p.image_url}" style="width:100%;max-height:80px;object-fit:cover;border-radius:6px;margin-bottom:6px;">` : ''}
        <img id="ae_preview" style="display:none;width:100%;max-height:80px;object-fit:cover;border-radius:6px;margin-bottom:6px;">
        <span style="font-size:11px;color:var(--text-faint);"><i class="fas fa-camera"></i> Cliquer pour changer la photo</span>
      </div>
    </div>
    <p id="ae_error" style="color:var(--red);font-size:12px;display:none;margin-top:8px;"></p>
  `;

  const footer = `
    <button class="btn btn-danger" id="ae_delete_btn"><i class="fas fa-trash"></i> Supprimer</button>
    <div style="flex:1;"></div>
    <button class="btn btn-ghost" onclick="closeModal('adminedit')">Annuler</button>
    <button class="btn btn-primary" id="ae_save_btn"><i class="fas fa-save"></i> Enregistrer</button>
  `;

  showModal('adminedit', `Modifier — ${p.brand} ${p.model}`, body, footer);

  // Bouton Enregistrer
  document.getElementById('ae_save_btn').addEventListener('click', async () => {
    const brand  = document.getElementById('ae_brand')?.value?.trim();
    const model  = document.getElementById('ae_model')?.value?.trim();
    if (!brand || !model) {
      document.getElementById('ae_error').style.display = 'block';
      document.getElementById('ae_error').textContent = 'Marque et modèle requis';
      return;
    }
    const fd = new FormData();
    fd.append('brand', brand);
    fd.append('model', model);
    fd.append('type', document.getElementById('ae_type')?.value || '');
    fd.append('condition', document.getElementById('ae_condition')?.value || '');
    fd.append('processor', document.getElementById('ae_processor')?.value || '');
    fd.append('ram', document.getElementById('ae_ram')?.value || '');
    fd.append('storage_size', document.getElementById('ae_storage_size')?.value || '');
    fd.append('storage_type', document.getElementById('ae_storage_type')?.value || '');
    fd.append('screen_size', document.getElementById('ae_screen')?.value || '');
    fd.append('sale_price', document.getElementById('ae_price')?.value || '0');
    fd.append('real_sn', document.getElementById('ae_real_sn')?.value || '');
    const imgFile = document.getElementById('ae_image')?.files[0];
    if (imgFile) fd.append('image', imgFile);

    try {
      const updated = await api.putForm(`/products/${p.id}`, fd);
      closeModal('adminedit');
      toast(`${updated.brand} ${updated.model} mis à jour`, 'success');
      if (onSuccess) onSuccess('updated', updated);
    } catch(err) {
      document.getElementById('ae_error').style.display = 'block';
      document.getElementById('ae_error').textContent = err.message;
    }
  });

  // Bouton Supprimer
  document.getElementById('ae_delete_btn').addEventListener('click', async () => {
    const ok = await confirm(
      `Supprimer définitivement <strong>${p.brand} ${p.model}</strong> (${p.internal_sn}) ?<br><br>
       <span style="color:var(--red);">⚠️ Cette action est irréversible et supprime tout l'historique associé.</span>`,
      'Confirmer la suppression'
    );
    if (!ok) return;
    try {
      await api.delete(`/products/${p.id}`);
      closeModal('adminedit');
      toast(`${p.brand} ${p.model} supprimé`, 'warning');
      if (onSuccess) onSuccess('deleted', p);
    } catch(err) {
      toast(err.message, 'error');
    }
  });
}
