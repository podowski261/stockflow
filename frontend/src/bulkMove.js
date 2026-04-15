// ══════════════════════════════════════════════════════
//  BULK MOVE — Sélection + envoi multiple de produits
//  Utilisé dans: atelier, installation, boutique
// ══════════════════════════════════════════════════════

/**
 * Injecte les styles de sélection une seule fois
 */
export function injectBulkStyles() {
  if (document.getElementById('bulk-styles')) return;
  const style = document.createElement('style');
  style.id = 'bulk-styles';
  style.textContent = `
    /* Checkboxes sur les lignes */
    .row-check { width:18px; height:18px; accent-color:var(--accent); cursor:pointer; flex-shrink:0; }

    /* Barre d'actions sélection */
    .bulk-bar {
      position:sticky; bottom:0; left:0; right:0;
      background:var(--surface);
      border-top:1px solid rgba(240,192,64,0.3);
      padding:12px 20px;
      display:flex; align-items:center; gap:12px; flex-wrap:wrap;
      z-index:40;
      animation:slideUp 0.2s ease;
      box-shadow:0 -8px 32px rgba(0,0,0,0.4);
    }
    .bulk-bar-info {
      font-family:'Syne',sans-serif; font-size:14px; font-weight:700;
      color:var(--accent);
    }
    .bulk-bar-sub { font-size:12px; color:var(--text-dim); margin-left:4px; }
    .bulk-bar-actions { margin-left:auto; display:flex; gap:8px; flex-wrap:wrap; }
    .btn-select-all {
      height:30px; padding:0 14px; border-radius:999px;
      background:var(--surface2); border:1px solid var(--border);
      color:var(--text-dim); font-size:12px; cursor:pointer;
      display:inline-flex; align-items:center; gap:6px;
      transition:all 0.15s;
    }
    .btn-select-all:hover { border-color:var(--border-hover); color:var(--text); }

    /* Ligne sélectionnée */
    tr.selected td { background:rgba(240,192,64,0.06) !important; }
    tr.selected td:first-child { border-left:3px solid var(--accent); }
  `;
  document.head.appendChild(style);
}

/**
 * Crée la barre de sélection + checkbox dans le tableau
 * @param {HTMLElement} container - le conteneur de la page
 * @param {Array} products - liste des produits
 * @param {Object} opts - { destinations, onMove, fmt, esc, stockBadge, showModal, api, toast }
 */
export function initBulkSelect(container, products, opts) {
  injectBulkStyles();

  const { destinations, onMove, fmt, esc, showModal, api, toast } = opts;
  let selected = new Set();

  // ── Ajouter colonne checkbox dans le tableau ──────
  const table = container.querySelector('.data-table');
  if (!table) return;

  // Ajouter th checkbox
  const thead = table.querySelector('thead tr');
  const thCheck = document.createElement('th');
  thCheck.style.cssText = 'width:40px;padding:9px 8px;';
  thCheck.innerHTML = `<input type="checkbox" class="row-check" id="chk-all" title="Tout sélectionner" onchange="bulkToggleAll(this)">`;
  thead.prepend(thCheck);

  // Ajouter td checkbox sur chaque ligne
  const rows = table.querySelectorAll('tbody tr');
  rows.forEach((tr, i) => {
    const p = products[i];
    if (!p) return;
    tr.dataset.productId = p.id;
    const td = document.createElement('td');
    td.style.cssText = 'padding:8px;width:40px;';
    td.innerHTML = `<input type="checkbox" class="row-check" data-id="${p.id}" onchange="bulkToggleRow(this,${p.id})">`;
    tr.prepend(td);
  });

  // ── Crée la barre bulk ────────────────────────────
  const bar = document.createElement('div');
  bar.className = 'bulk-bar';
  bar.id = 'bulkBar';
  bar.style.display = 'none';
  bar.innerHTML = `
    <div>
      <span class="bulk-bar-info" id="bulkCount">0 sélectionné(s)</span>
      <span class="bulk-bar-sub">— Choisissez une action</span>
    </div>
    <div class="bulk-bar-actions">
      ${destinations.map(d => `
        <button class="btn ${d.btnClass||'btn-secondary'} btn-sm" onclick="bulkAction('${d.to}')">
          <i class="fas ${d.icon}"></i> ${d.label}
        </button>`).join('')}
      <button class="btn btn-ghost btn-sm" onclick="bulkClearSelection()">
        <i class="fas fa-times"></i> Désélectionner
      </button>
    </div>`;
  container.appendChild(bar);

  // ── Fonctions globales ────────────────────────────
  window.bulkToggleAll = (chk) => {
    const checks = table.querySelectorAll('tbody .row-check');
    checks.forEach(c => {
      c.checked = chk.checked;
      const id = parseInt(c.dataset.id);
      const tr = c.closest('tr');
      if (chk.checked) { selected.add(id); tr.classList.add('selected'); }
      else             { selected.delete(id); tr.classList.remove('selected'); }
    });
    updateBar();
  };

  window.bulkToggleRow = (chk, id) => {
    const tr = chk.closest('tr');
    if (chk.checked) { selected.add(id); tr.classList.add('selected'); }
    else             { selected.delete(id); tr.classList.remove('selected'); }

    // Mettre à jour le check-all
    const allChecks = table.querySelectorAll('tbody .row-check');
    const allChk = document.getElementById('chk-all');
    if (allChk) {
      allChk.checked = [...allChecks].every(c => c.checked);
      allChk.indeterminate = selected.size > 0 && !allChk.checked;
    }
    updateBar();
  };

  window.bulkClearSelection = () => {
    selected.clear();
    table.querySelectorAll('.row-check').forEach(c => c.checked = false);
    table.querySelectorAll('tr.selected').forEach(tr => tr.classList.remove('selected'));
    const allChk = document.getElementById('chk-all');
    if (allChk) { allChk.checked = false; allChk.indeterminate = false; }
    updateBar();
  };

  window.bulkAction = (dest) => {
    if (selected.size === 0) return;
    const destCfg = destinations.find(d => d.to === dest);
    const isGar = dest === 'garantie';
    const selectedProducts = products.filter(p => selected.has(p.id));

    showModal('bulk-move',
      `${destCfg?.label || dest} — ${selected.size} produit(s)`,
      `<div style="background:var(--surface2);border-radius:10px;padding:12px;margin-bottom:14px;max-height:160px;overflow-y:auto;">
        ${selectedProducts.map(p => `
          <div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);">
            <span class="mono" style="font-size:10px;color:var(--text-faint);flex-shrink:0;">${esc(p.internal_sn)}</span>
            <span style="font-size:12px;color:var(--text);">${esc(p.brand)} ${esc(p.model)}</span>
          </div>`).join('')}
       </div>
       ${isGar
         ? `<div class="form-group">
              <label class="label">Problème constaté * <span style="color:var(--red)">(obligatoire — commun à tous)</span></label>
              <textarea class="textarea" id="bulk_problem" placeholder="Décrivez le problème…" rows="3"></textarea>
            </div>`
         : `<div class="form-group">
              <label class="label">Destination / Nom du technicien <span style="color:var(--text-faint)">(optionnel)</span></label>
              <input class="input" id="bulk_dest" placeholder="Nom ou adresse">
            </div>
            <div class="form-group">
              <label class="label">Motif <span style="color:var(--text-faint)">(optionnel)</span></label>
              <input class="input" id="bulk_reason" placeholder="Motif du transfert">
            </div>`}
       <p id="bulk_error" style="color:var(--red);font-size:12px;display:none;margin-top:6px;"></p>`,
      `<button class="btn btn-ghost" onclick="closeModal('bulk-move')">Annuler</button>
       <button class="btn btn-primary" style="${isGar?'background:var(--red)':''}"
         onclick="confirmBulkMove('${dest}',${isGar})">
         <i class="fas fa-check"></i> Envoyer ${selected.size} produit(s)
       </button>`
    );
  };

  window.confirmBulkMove = async (dest, isGar) => {
    const problem = document.getElementById('bulk_problem')?.value?.trim();
    const d       = document.getElementById('bulk_dest')?.value?.trim();
    const reason  = document.getElementById('bulk_reason')?.value?.trim();
    const errEl   = document.getElementById('bulk_error');

    if (isGar && !problem) {
      errEl.style.display = 'block';
      errEl.textContent = 'Description du problème obligatoire';
      return;
    }

    const ids = [...selected];
    let ok = 0, fail = 0;

    // Désactiver le bouton
    const btn = document.getElementById('modal-bulk-move')?.querySelector('.btn-primary') ||
                document.querySelector('.modal-overlay.open .btn-primary');
    if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner" style="width:14px;height:14px;border-width:2px;"></div> Traitement…'; }

    for (const id of ids) {
      try {
        await api.post(`/products/${id}/move`, {
          to_stock: dest,
          problem_description: problem,
          destination_detail: d,
          reason,
        });
        ok++;
      } catch { fail++; }
    }

    closeModal('bulk-move');
    window.bulkClearSelection();
    onMove(dest, ok, fail);
  };

  function updateBar() {
    const bar = document.getElementById('bulkBar');
    if (!bar) return;
    const count = document.getElementById('bulkCount');
    if (selected.size > 0) {
      bar.style.display = 'flex';
      if (count) count.textContent = `${selected.size} sélectionné(s)`;
    } else {
      bar.style.display = 'none';
    }
  }

  return { selected, updateBar };
}
