// ══════════════════════════════════════════════════════
//  PAGE GARANTIE — Onglets: En attente / Traitées
// ══════════════════════════════════════════════════════
let _ctx, _warranties = [], _treated = [], _activeTab = 'pending';

export async function render(container, ctx) {
  _ctx = ctx;
  _activeTab = 'pending';

  container.innerHTML = `<div style="padding:clamp(14px,3vw,28px);" id="warMain">

    <!-- EN-TÊTE -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px;">
      <div>
        <div style="font-family:'Syne',sans-serif;font-size:20px;font-weight:800;">Garanties</div>
        <div style="font-size:13px;color:var(--text-dim);margin-top:2px;">Suivi des produits en garantie</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <button class="btn btn-secondary" onclick="exportWarrantiesReport()">
          <i class="fas fa-file-pdf"></i> Rapport
        </button>
      </div>
    </div>

    <!-- ONGLETS -->
    <div style="display:flex;gap:4px;margin-bottom:20px;background:var(--surface2);padding:4px;border-radius:12px;width:fit-content;">
      <button class="war-tab active" id="tab-pending" onclick="switchWarTab('pending')">
        <i class="fas fa-clock"></i> En attente
        <span class="war-tab-badge" id="badge-pending">—</span>
      </button>
      <button class="war-tab" id="tab-treated" onclick="switchWarTab('treated')">
        <i class="fas fa-check-double"></i> Traitées
        <span class="war-tab-badge" id="badge-treated" style="background:rgba(48,208,144,0.2);color:var(--green);">—</span>
      </button>
    </div>

    <!-- CONTENU -->
    <div id="warContent"><div class="loader-wrap"><div class="spinner"></div></div></div>
  </div>`;

  // Styles onglets
  injectTabStyles();
  await loadAll();
}

function injectTabStyles() {
  if (document.getElementById('war-tab-styles')) return;
  const s = document.createElement('style');
  s.id = 'war-tab-styles';
  s.textContent = `
    .war-tab {
      display:inline-flex; align-items:center; gap:7px;
      padding:8px 18px; border-radius:9px; border:none; cursor:pointer;
      font-family:'DM Sans',sans-serif; font-size:13px; font-weight:500;
      color:var(--text-dim); background:transparent; transition:all 0.18s;
    }
    .war-tab:hover { color:var(--text); background:rgba(255,255,255,0.04); }
    .war-tab.active { background:var(--surface); color:var(--text); font-weight:600; box-shadow:0 2px 8px rgba(0,0,0,0.2); }
    .war-tab-badge {
      background:rgba(240,80,96,0.2); color:var(--red);
      padding:1px 8px; border-radius:999px; font-size:11px; font-weight:700;
      font-family:'Syne',sans-serif;
    }
    .war-tab.active .war-tab-badge { background:rgba(240,80,96,0.25); }
  `;
  document.head.appendChild(s);
}

async function loadAll() {
  const { api, toast } = _ctx;
  try {
    // Charger les deux en parallèle
    [_warranties, _treated] = await Promise.all([
      api.get('/warranties?status=en_attente'),
      api.get('/warranties?status=traitee'),
    ]);
    updateBadges();
    renderTable();
  } catch(err) { toast('Erreur: ' + err.message, 'error'); }
}

function updateBadges() {
  const bp = document.getElementById('badge-pending');
  const bt = document.getElementById('badge-treated');
  if (bp) bp.textContent = _warranties.length;
  if (bt) bt.textContent = _treated.length;
}

window.switchWarTab = (tab) => {
  _activeTab = tab;
  ['pending','treated'].forEach(t => {
    document.getElementById(`tab-${t}`)?.classList.toggle('active', t === tab);
  });
  renderTable();
};

function renderTable() {
  const { fmt, esc, user } = _ctx;
  const isAdmin = user?.role === 'admin';
  const data = _activeTab === 'pending' ? _warranties : _treated;
  const content = document.getElementById('warContent');
  if (!content) return;

  if (!data.length) {
    const emptyMsg = _activeTab === 'pending'
      ? 'Aucune garantie en attente de traitement'
      : 'Aucune garantie traitée pour le moment';
    const emptyIcon = _activeTab === 'pending' ? 'fa-shield-alt' : 'fa-check-double';
    content.innerHTML = `<div class="empty-state"><i class="fas ${emptyIcon}" style="color:${_activeTab==='pending'?'var(--text-faint)':'var(--green)'}"></i><p>${emptyMsg}</p></div>`;
    return;
  }

  if (_activeTab === 'pending') {
    renderPendingTable(data, fmt, esc, isAdmin, content);
  } else {
    renderTreatedTable(data, fmt, esc, isAdmin, content);
  }
}

function renderPendingTable(data, fmt, esc, isAdmin, content) {
  content.innerHTML = `<div class="table-wrap"><table class="data-table">
    <thead><tr>
      <th>Envoyé le</th><th>N° Série</th><th>Produit</th>
      <th>Fournisseur</th><th>Depuis</th><th style="max-width:180px;">Problème</th>
      <th>Envoyé par</th><th>Actions</th>
    </tr></thead>
    <tbody>${data.map(w => `<tr>
      <td style="font-size:11px;white-space:nowrap">${fmt.datetime(w.sent_at)}</td>
      <td><span class="mono">${esc(w.internal_sn)}</span></td>
      <td><strong>${esc(w.brand)} ${esc(w.model)}</strong></td>
      <td style="font-size:12px">${esc(w.supplier_name||'—')}</td>
      <td><span class="badge badge-${w.sent_from_stock||'atelier'}">${fmt.stock(w.sent_from_stock||'atelier')}</span></td>
      <td style="max-width:180px;">
        <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--red)"
             title="${esc(w.problem_description||'')}">${esc(w.problem_description||'—')}</div>
      </td>
      <td style="font-size:12px">${esc(w.sent_by_name||'—')}</td>
      <td><div style="display:flex;gap:5px;">
        <button class="btn btn-primary btn-sm" onclick="openTreat(${w.id})">
          <i class="fas fa-check"></i> Traiter
        </button>
        <button class="btn btn-ghost btn-sm btn-icon" onclick="viewWarranty(${w.id},'pending')" title="Détails">
          <i class="fas fa-eye"></i>
        </button>
        ${isAdmin ? `<button class="btn btn-danger btn-sm btn-icon" onclick="deleteWarrantyRecord(${w.id},'pending')" title="Supprimer"><i class="fas fa-trash"></i></button>` : ''}
      </div></td>
    </tr>`).join('')}
    </tbody>
  </table></div>`;
}

function renderTreatedTable(data, fmt, esc, isAdmin, content) {
  content.innerHTML = `<div class="table-wrap"><table class="data-table">
    <thead><tr>
      <th>Traitée le</th><th>N° Série</th><th>Produit</th>
      <th>Fournisseur</th><th>Problème</th><th>Traité par</th>
      <th>Retour fourn.</th><th>Notes</th><th></th>
    </tr></thead>
    <tbody>${data.map(w => `<tr>
      <td style="font-size:11px;white-space:nowrap">${fmt.datetime(w.treated_at)}</td>
      <td><span class="mono">${esc(w.internal_sn)}</span></td>
      <td><strong>${esc(w.brand)} ${esc(w.model)}</strong></td>
      <td style="font-size:12px">${esc(w.supplier_name||'—')}</td>
      <td style="max-width:150px;">
        <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--text-dim)"
             title="${esc(w.problem_description||'')}">${esc(w.problem_description||'—')}</div>
      </td>
      <td style="font-size:12px">${esc(w.treated_by_name||'—')}</td>
      <td style="text-align:center;">
        ${w.returned_to_supplier
          ? '<span class="badge" style="background:rgba(240,144,48,0.15);color:var(--orange)"><i class="fas fa-check"></i> Oui</span>'
          : '<span style="color:var(--text-faint);font-size:12px">Non</span>'}
      </td>
      <td style="max-width:160px;">
        <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--text-dim)"
             title="${esc(w.treatment_notes||'')}">${esc(w.treatment_notes||'—')}</div>
      </td>
      <td>
        <button class="btn btn-ghost btn-sm btn-icon" onclick="viewWarranty(${w.id},'treated')" title="Détails">
          <i class="fas fa-eye"></i>
        </button>
        ${isAdmin ? `<button class="btn btn-danger btn-sm btn-icon" onclick="deleteWarrantyRecord(${w.id},'treated')" title="Supprimer"><i class="fas fa-trash"></i></button>` : ''}
      </td>
    </tr>`).join('')}
    </tbody>
  </table></div>`;
}

// ─── TRAITER GARANTIE ────────────────────────────────
window.openTreat = (id) => {
  const { showModal, esc } = _ctx;
  const w = _warranties.find(x => x.id === id); if (!w) return;
  showModal('treat', 'Traitement de la Garantie', `
    <div style="background:var(--surface2);border-radius:10px;padding:14px;margin-bottom:16px;">
      <div style="display:flex;align-items:center;gap:10px;">
        <div>
          <strong>${esc(w.brand)} ${esc(w.model)}</strong><br>
          <span class="mono" style="font-size:11px;color:var(--text-faint)">${esc(w.internal_sn)}</span>
        </div>
      </div>
      <div style="margin-top:10px;padding:8px 10px;background:rgba(240,80,96,0.08);border-radius:7px;border-left:3px solid var(--red);">
        <span style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--red);">Problème</span><br>
        <span style="font-size:13px;">${esc(w.problem_description)}</span>
      </div>
    </div>
    <div class="form-group">
      <label class="label">Notes de traitement</label>
      <textarea class="textarea" id="treat_notes" placeholder="Actions effectuées, résultat du diagnostic…" rows="4"></textarea>
    </div>
    <div style="display:flex;align-items:center;gap:10px;padding:12px;background:var(--surface2);border-radius:8px;">
      <input type="checkbox" id="treat_return" style="width:16px;height:16px;accent-color:var(--accent);">
      <label for="treat_return" style="font-size:13px;cursor:pointer;">
        <strong>Retourné au fournisseur</strong>
        <span style="font-size:11px;color:var(--text-dim);display:block;margin-top:2px;">Cocher si le produit a été renvoyé au fournisseur</span>
      </label>
    </div>`,
  `<button class="btn btn-ghost" onclick="closeModal('treat')">Annuler</button>
   <button class="btn btn-primary" onclick="confirmTreat(${id})">
     <i class="fas fa-check-double"></i> Marquer comme traitée
   </button>`);
};

window.confirmTreat = async (id) => {
  const { api, toast } = _ctx;
  try {
    await api.post(`/warranties/${id}/treat`, {
      treatment_notes: document.getElementById('treat_notes')?.value?.trim(),
      returned_to_supplier: document.getElementById('treat_return')?.checked
    });
    // Déplacer de pending → treated
    const idx = _warranties.findIndex(w => w.id === id);
    if (idx > -1) {
      const w = _warranties.splice(idx, 1)[0];
      w.status = 'traitee';
      w.treated_at = new Date().toISOString();
      w.treatment_notes = document.getElementById('treat_notes')?.value?.trim();
      w.returned_to_supplier = document.getElementById('treat_return')?.checked;
      _treated.unshift(w);
    }
    updateBadges();
    renderTable();
    closeModal('treat');
    toast('Garantie marquée comme traitée ✅', 'success');
  } catch(err) { toast(err.message, 'error'); }
};

// ─── VOIR DÉTAILS ────────────────────────────────────
window.viewWarranty = (id, list) => {
  const { showModal, fmt, esc } = _ctx;
  const data = list === 'pending' ? _warranties : _treated;
  const w = data.find(x => x.id === id); if (!w) return;
  showModal('warview', `Garantie — ${w.brand} ${w.model}`, `
    <div style="display:grid;gap:10px;">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div style="background:var(--surface2);border-radius:8px;padding:12px;">
          <div style="font-size:9px;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-faint);margin-bottom:3px;">N° Série</div>
          <div class="mono" style="font-size:12px;">${esc(w.internal_sn)}</div>
        </div>
        <div style="background:var(--surface2);border-radius:8px;padding:12px;">
          <div style="font-size:9px;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-faint);margin-bottom:3px;">Fournisseur</div>
          <div>${esc(w.supplier_name||'—')}</div>
        </div>
      </div>
      <div style="background:rgba(240,80,96,0.08);border:1px solid rgba(240,80,96,0.2);border-radius:8px;padding:12px;">
        <div style="font-size:9px;text-transform:uppercase;letter-spacing:1.5px;color:var(--red);margin-bottom:4px;">Problème signalé</div>
        <div style="line-height:1.5;">${esc(w.problem_description)}</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div style="background:var(--surface2);border-radius:8px;padding:12px;">
          <div style="font-size:9px;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-faint);margin-bottom:3px;">Envoyé le</div>
          <div style="font-size:13px;">${fmt.datetime(w.sent_at)}</div>
        </div>
        <div style="background:var(--surface2);border-radius:8px;padding:12px;">
          <div style="font-size:9px;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-faint);margin-bottom:3px;">Envoyé par</div>
          <div>${esc(w.sent_by_name||'—')}</div>
        </div>
      </div>
      ${w.treatment_notes || w.treated_at ? `
      <div style="background:rgba(48,208,144,0.08);border:1px solid rgba(48,208,144,0.2);border-radius:8px;padding:12px;">
        <div style="font-size:9px;text-transform:uppercase;letter-spacing:1.5px;color:var(--green);margin-bottom:4px;">Traitement</div>
        <div style="line-height:1.5;">${esc(w.treatment_notes||'—')}</div>
        <div style="font-size:11px;color:var(--text-faint);margin-top:6px;">
          Traité le ${fmt.datetime(w.treated_at)} par ${esc(w.treated_by_name||'—')}
          ${w.returned_to_supplier ? ' · <strong style="color:var(--orange)">Retourné au fournisseur</strong>' : ''}
        </div>
      </div>` : ''}
    </div>`,
  `<button class="btn btn-ghost" onclick="closeModal('warview')">Fermer</button>`);
};

// ─── SUPPRIMER (admin) ────────────────────────────────
window.deleteWarrantyRecord = async (id, list) => {
  const { api, toast, confirm: cfm, esc } = _ctx;
  const data = list === 'pending' ? _warranties : _treated;
  const w = data.find(x => x.id === id); if (!w) return;
  const ok = await cfm(
    `Supprimer l'enregistrement de garantie pour <strong>${esc(w.brand)} ${esc(w.model)}</strong> ?<br>
    <span style="color:var(--red);font-size:12px;">Irréversible.</span>`,
    'Supprimer'
  );
  if (!ok) return;
  try {
    await api.delete(`/warranties/${id}`);
    if (list === 'pending') _warranties = _warranties.filter(x => x.id !== id);
    else _treated = _treated.filter(x => x.id !== id);
    updateBadges();
    renderTable();
    toast('Supprimé', 'success');
  } catch(err) { toast(err.message, 'error'); }
};

// ─── RAPPORT ─────────────────────────────────────────
window.exportWarrantiesReport = () => {
  const token = localStorage.getItem('sf_token') || '';
  window.open(`/api/reports/movements?stock=garantie&token=${encodeURIComponent(token)}`, '_blank');
};
