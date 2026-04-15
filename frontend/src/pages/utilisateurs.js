// PAGE UTILISATEURS (admin)
let _ctx, _users = [];
export async function render(container, ctx) {
  _ctx = ctx;
  container.innerHTML = `<div style="padding:clamp(14px,3vw,28px);">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
      <div style="font-family:'Syne',sans-serif;font-size:20px;font-weight:800;">Gestion des Utilisateurs</div>
      <button class="btn btn-primary" onclick="openUserModal()"><i class="fas fa-user-plus"></i> Nouvel utilisateur</button>
    </div>
    <div id="usersContent"><div class="loader-wrap"><div class="spinner"></div></div></div>
  </div>`;
  await loadUsers();
}

async function loadUsers() {
  const { api, toast } = _ctx;
  try {
    _users = await api.get('/users');
    renderTable();
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
}

function renderTable() {
  const { fmt, esc } = _ctx;
  const content = document.getElementById('usersContent');
  if (!content) return;
  const ROLE_COLORS = { admin:'var(--accent)', atelier:'var(--blue)', installation:'var(--orange)', boutique:'var(--green)', garantie:'var(--red)' };
  content.innerHTML = `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>Nom complet</th><th>Identifiant</th><th>Rôle</th><th>Statut</th><th>Créé le</th><th>Actions</th></tr></thead>
    <tbody>${_users.map(u => `<tr>
      <td>
        <div style="display:flex;align-items:center;gap:10px;">
          <div style="width:34px;height:34px;background:rgba(240,192,64,0.1);border-radius:8px;display:flex;align-items:center;justify-content:center;font-family:'Syne',sans-serif;font-weight:700;color:var(--accent);">${(u.full_name||'?').charAt(0).toUpperCase()}</div>
          <strong>${esc(u.full_name)}</strong>
        </div>
      </td>
      <td class="mono">${esc(u.username)}</td>
      <td><span class="badge" style="background:${ROLE_COLORS[u.role]||'var(--text-dim)'}22;color:${ROLE_COLORS[u.role]||'var(--text-dim)'};">${fmt.role(u.role)}</span></td>
      <td><span class="badge" style="background:${u.is_active?'rgba(48,208,144,0.12)':'rgba(240,80,96,0.1)'};color:${u.is_active?'var(--green)':'var(--red)'};">${u.is_active?'Actif':'Inactif'}</span></td>
      <td style="font-size:12px">${fmt.date(u.created_at)}</td>
      <td><div style="display:flex;gap:6px;">
        <button class="btn btn-secondary btn-sm" onclick="openUserModal(${u.id})"><i class="fas fa-edit"></i></button>
        <button class="btn btn-ghost btn-sm" onclick="openChangePassword(${u.id})" title="Changer mot de passe"><i class="fas fa-key"></i></button>
      </div></td>
    </tr>`).join('')}
    </tbody>
  </table></div>`;
}

window.openUserModal = (id) => {
  const { showModal, fmt, esc } = _ctx;
  const u = id ? _users.find(x => x.id === id) : null;
  const isEdit = !!u;
  const roles = ['admin','atelier','boutique','garantie'];
  const body = `
    <div class="form-row">
      <div class="form-group"><label class="label">Nom complet *</label><input class="input" id="uf_name" value="${esc(u?.full_name||'')}"></div>
      <div class="form-group"><label class="label">Identifiant *</label><input class="input" id="uf_uname" value="${esc(u?.username||'')}" ${isEdit?'readonly style="opacity:0.6"':''}></div>
    </div>
    <div class="form-row">
      <div class="form-group"><label class="label">Rôle *</label>
        <select class="select" id="uf_role">${roles.map(r => `<option value="${r}" ${u?.role===r?'selected':''}>${fmt.role(r)}</option>`).join('')}</select>
      </div>
      ${isEdit ? `<div class="form-group"><label class="label">Statut</label>
        <select class="select" id="uf_active"><option value="true" ${u?.is_active?'selected':''}>Actif</option><option value="false" ${!u?.is_active?'selected':''}>Inactif</option></select>
      </div>` : `<div class="form-group"><label class="label">Mot de passe *</label><input class="input" id="uf_pass" type="password" placeholder="••••••••"></div>`}
    </div>
    <p id="uf_error" style="color:var(--red);font-size:12px;display:none;"></p>`;
  const footer = `<button class="btn btn-ghost" onclick="closeModal('usermod')">Annuler</button>
    <button class="btn btn-primary" onclick="saveUser(${id||0})">${isEdit?'Enregistrer':'Créer'}</button>`;
  showModal('usermod', isEdit ? 'Modifier l\'utilisateur' : 'Nouvel utilisateur', body, footer);
};

window.saveUser = async (id) => {
  const { api, toast } = _ctx;
  const name = document.getElementById('uf_name')?.value?.trim();
  const uname = document.getElementById('uf_uname')?.value?.trim();
  const role = document.getElementById('uf_role')?.value;
  const pass = document.getElementById('uf_pass')?.value?.trim();
  const active = document.getElementById('uf_active')?.value;
  if (!name || (!id && !uname)) { document.getElementById('uf_error').style.display='block'; document.getElementById('uf_error').textContent='Champs requis'; return; }
  if (!id && !pass) { document.getElementById('uf_error').style.display='block'; document.getElementById('uf_error').textContent='Mot de passe requis'; return; }
  try {
    if (id) {
      const updated = await api.put(`/users/${id}`, { full_name:name, role, is_active: active==='true' });
      const idx = _users.findIndex(u => u.id === id);
      if (idx > -1) _users[idx] = { ..._users[idx], ...updated };
    } else {
      const created = await api.post('/users', { username:uname, password:pass, full_name:name, role });
      _users.push(created);
    }
    renderTable();
    closeModal('usermod');
    toast(id ? 'Utilisateur mis à jour' : 'Utilisateur créé', 'success');
  } catch (err) { document.getElementById('uf_error').style.display='block'; document.getElementById('uf_error').textContent=err.message; }
};

window.openChangePassword = (id) => {
  const { showModal } = _ctx;
  const u = _users.find(x => x.id === id);
  showModal('changepw', `Mot de passe — ${u?.full_name}`,
    `<div class="form-group"><label class="label">Nouveau mot de passe *</label><input class="input" id="pw_new" type="password" placeholder="••••••••"></div>
     <div class="form-group"><label class="label">Confirmer *</label><input class="input" id="pw_confirm" type="password" placeholder="••••••••"></div>
     <p id="pw_error" style="color:var(--red);font-size:12px;display:none;"></p>`,
    `<button class="btn btn-ghost" onclick="closeModal('changepw')">Annuler</button>
     <button class="btn btn-primary" onclick="savePassword(${id})">Changer</button>`
  );
};

window.savePassword = async (userId) => {
  const { api, toast } = _ctx;
  const newpw = document.getElementById('pw_new')?.value;
  const confirm = document.getElementById('pw_confirm')?.value;
  if (!newpw || newpw !== confirm) { document.getElementById('pw_error').style.display='block'; document.getElementById('pw_error').textContent='Mots de passe différents'; return; }
  try {
    await api.post('/auth/change-password', { new_password: newpw, user_id: userId });
    closeModal('changepw');
    toast('Mot de passe modifié', 'success');
  } catch (err) { document.getElementById('pw_error').style.display='block'; document.getElementById('pw_error').textContent=err.message; }
};
