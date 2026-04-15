// PAGE CONFIGURATION (admin)
let _ctx;
export async function render(container, ctx) {
  _ctx = ctx;
  container.innerHTML = `<div style="padding:clamp(14px,3vw,28px);">
    <div style="font-family:'Syne',sans-serif;font-size:20px;font-weight:800;margin-bottom:20px;">Configuration</div>
    <div id="configContent"><div class="loader-wrap"><div class="spinner"></div></div></div>
  </div>`;
  await loadConfig();
}

async function loadConfig() {
  const { api, toast } = _ctx;
  try {
    const cfg = await api.get('/config');
    renderForm(cfg);
  } catch (err) { toast('Erreur: ' + err.message, 'error'); }
}

function renderForm(cfg) {
  const { esc } = _ctx;
  document.getElementById('configContent').innerHTML = `
    <div style="max-width:640px;display:grid;gap:24px;">
      <!-- Infos entreprise -->
      <div class="chart-box">
        <div style="font-family:'Syne',sans-serif;font-size:15px;font-weight:700;margin-bottom:16px;">
          <i class="fas fa-building" style="color:var(--accent);margin-right:8px;"></i>Informations Entreprise
        </div>
        <div class="form-group"><label class="label">Nom de l'entreprise</label><input class="input" id="cfg_name" value="${esc(cfg.name||'')}"></div>
        <div class="form-row">
          <div class="form-group"><label class="label">Téléphone</label><input class="input" id="cfg_phone" value="${esc(cfg.phone||'')}"></div>
          <div class="form-group"><label class="label">Email</label><input class="input" id="cfg_email" value="${esc(cfg.email||'')}"></div>
        </div>
        <div class="form-group"><label class="label">Adresse</label><textarea class="textarea" id="cfg_address" rows="2">${esc(cfg.address||'')}</textarea></div>
        <div class="form-group"><label class="label">Site web</label><input class="input" id="cfg_website" value="${esc(cfg.website||'')}"></div>
      </div>

      <!-- En-tête / Pied de page -->
      <div class="chart-box">
        <div style="font-family:'Syne',sans-serif;font-size:15px;font-weight:700;margin-bottom:16px;">
          <i class="fas fa-file-alt" style="color:var(--accent);margin-right:8px;"></i>Documents PDF
        </div>
        <div class="form-group"><label class="label">En-tête des documents</label><input class="input" id="cfg_header" value="${esc(cfg.header_text||'')}" placeholder="Texte affiché en haut des rapports"></div>
        <div class="form-group"><label class="label">Pied de page</label><input class="input" id="cfg_footer" value="${esc(cfg.footer_text||'')}" placeholder="Texte affiché en bas des rapports"></div>
      </div>

      <!-- Compte admin -->
      <div class="chart-box">
        <div style="font-family:'Syne',sans-serif;font-size:15px;font-weight:700;margin-bottom:16px;">
          <i class="fas fa-lock" style="color:var(--accent);margin-right:8px;"></i>Changer mon mot de passe
        </div>
        <div class="form-group"><label class="label">Ancien mot de passe</label><input class="input" id="cfg_old_pw" type="password" placeholder="••••••••"></div>
        <div class="form-row">
          <div class="form-group"><label class="label">Nouveau mot de passe</label><input class="input" id="cfg_new_pw" type="password" placeholder="••••••••"></div>
          <div class="form-group"><label class="label">Confirmer</label><input class="input" id="cfg_confirm_pw" type="password" placeholder="••••••••"></div>
        </div>
        <button class="btn btn-secondary" onclick="changeMyPassword()"><i class="fas fa-key"></i> Changer le mot de passe</button>
      </div>

      <div style="display:flex;justify-content:flex-end;">
        <button class="btn btn-primary" onclick="saveConfig()"><i class="fas fa-save"></i> Enregistrer la configuration</button>
      </div>
    </div>
  `;
}

window.saveConfig = async () => {
  const { api, toast } = _ctx;
  const g = id => document.getElementById(id)?.value?.trim();
  try {
    await api.put('/config', {
      name: g('cfg_name'), phone: g('cfg_phone'), email: g('cfg_email'),
      address: g('cfg_address'), website: g('cfg_website'),
      header_text: g('cfg_header'), footer_text: g('cfg_footer')
    });
    toast('Configuration enregistrée', 'success');
  } catch (err) { toast(err.message, 'error'); }
};

window.changeMyPassword = async () => {
  const { api, toast } = _ctx;
  const old_pw = document.getElementById('cfg_old_pw')?.value;
  const new_pw = document.getElementById('cfg_new_pw')?.value;
  const confirm = document.getElementById('cfg_confirm_pw')?.value;
  if (!old_pw || !new_pw) { toast('Remplissez tous les champs', 'warning'); return; }
  if (new_pw !== confirm) { toast('Les mots de passe ne correspondent pas', 'error'); return; }
  try {
    await api.post('/auth/change-password', { old_password: old_pw, new_password: new_pw });
    document.getElementById('cfg_old_pw').value = '';
    document.getElementById('cfg_new_pw').value = '';
    document.getElementById('cfg_confirm_pw').value = '';
    toast('Mot de passe modifié', 'success');
  } catch (err) { toast(err.message, 'error'); }
};
