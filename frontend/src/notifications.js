// ══════════════════════════════════════════════════════
//  NOTIFICATION CENTER — Bell icon + panel
// ══════════════════════════════════════════════════════

let _api, _user, _notifs = [], _panel = null, _pollInterval = null;

const ICONS = {
  warranty_expiring: { icon: 'fa-clock',         color: 'var(--orange)', bg: 'rgba(240,144,48,0.12)' },
  warranty_expired:  { icon: 'fa-exclamation-circle', color: 'var(--red)',    bg: 'rgba(240,80,96,0.12)' },
  stale_product:     { icon: 'fa-hourglass-half', color: 'var(--blue)',   bg: 'rgba(80,144,240,0.12)' },
};

const STOCK_LABELS = {
  atelier: 'Atelier', installation: 'Installation',
  boutique: 'Boutique', garantie: 'Garantie',
};

export function initNotifications(api, user) {
  _api = api;
  _user = user;
  injectStyles();
  buildBell();
  fetchAndUpdate();
  // Polling toutes les 5 minutes
  _pollInterval = setInterval(fetchAndUpdate, 5 * 60 * 1000);
}

// ─── STYLES ──────────────────────────────────────────
function injectStyles() {
  if (document.getElementById('notif-styles')) return;
  const s = document.createElement('style');
  s.id = 'notif-styles';
  s.textContent = `
    /* Bell button — toujours visible dans la topbar */
    .notif-bell {
      position:relative; width:38px; height:38px; flex-shrink:0;
      background:var(--surface2); border:1px solid var(--border);
      border-radius:10px; color:var(--text-dim); cursor:pointer;
      display:flex; align-items:center; justify-content:center;
      font-size:15px; transition:all 0.18s;
      /* PAS de margin-left:auto — la topbar-title flex:1 s'en charge */
    }
    .notif-bell:hover { background:var(--surface3); color:var(--text); border-color:var(--border-hover); }
    .notif-bell.has-unread {
      color:var(--accent); border-color:rgba(240,192,64,0.35);
      animation:bellRing 0.5s ease 0.2s 2;
    }
    @keyframes bellRing {
      0%,100%{transform:rotate(0)} 20%{transform:rotate(-15deg)} 60%{transform:rotate(12deg)} 80%{transform:rotate(-8deg)}
    }

    /* Badge count */
    .notif-count {
      position:absolute; top:-5px; right:-5px;
      background:var(--red); color:#fff; border:2px solid var(--bg);
      border-radius:999px; font-size:10px; font-weight:800;
      min-width:18px; height:18px; padding:0 4px;
      display:flex; align-items:center; justify-content:center;
      font-family:'Syne',sans-serif;
    }

    /* Panel */
    .notif-panel {
      position:fixed; top:68px; right:16px;
      width:420px; max-width:calc(100vw - 32px);
      background:var(--surface); border:1px solid var(--border);
      border-radius:16px; z-index:600;
      box-shadow:0 20px 60px rgba(0,0,0,0.6);
      animation:panelIn 0.2s cubic-bezier(.22,.68,0,1.2);
      display:flex; flex-direction:column;
      max-height:calc(100vh - 90px);
    }
    @keyframes panelIn { from{opacity:0;transform:translateY(-10px) scale(.97)} to{opacity:1;transform:none} }

    .notif-panel-header {
      padding:14px 18px; border-bottom:1px solid var(--border);
      display:flex; align-items:center; justify-content:space-between;
      flex-shrink:0;
    }
    .notif-panel-title {
      font-family:'Syne',sans-serif; font-size:15px; font-weight:700;
    }
    .notif-panel-actions { display:flex; gap:8px; align-items:center; }
    .notif-panel-btn {
      font-size:11px; color:var(--text-dim); background:none; border:none;
      cursor:pointer; padding:4px 8px; border-radius:6px; transition:all 0.15s;
      display:flex; align-items:center; gap:5px;
    }
    .notif-panel-btn:hover { background:var(--surface2); color:var(--text); }
    .notif-panel-btn.accent { color:var(--accent); }

    .notif-list { overflow-y:auto; flex:1; }
    .notif-empty {
      display:flex; flex-direction:column; align-items:center;
      gap:10px; padding:40px 20px; color:var(--text-faint);
    }
    .notif-empty i { font-size:32px; opacity:0.3; }
    .notif-empty p { font-size:13px; color:var(--text-dim); }

    /* Item */
    .notif-item {
      display:flex; align-items:flex-start; gap:12px;
      padding:13px 16px; border-bottom:1px solid rgba(255,255,255,0.04);
      transition:background 0.15s; position:relative; cursor:default;
    }
    .notif-item:last-child { border-bottom:none; }
    .notif-item:hover { background:rgba(255,255,255,0.02); }
    .notif-item.unread { background:rgba(240,192,64,0.03); }
    .notif-item.unread::before {
      content:''; position:absolute; left:0; top:0; bottom:0;
      width:3px; background:var(--accent); border-radius:0 2px 2px 0;
    }

    .notif-icon {
      width:36px; height:36px; border-radius:9px; flex-shrink:0;
      display:flex; align-items:center; justify-content:center; font-size:14px;
    }
    .notif-content { flex:1; min-width:0; }
    .notif-title {
      font-size:13px; font-weight:600; color:var(--text);
      line-height:1.3; margin-bottom:3px;
    }
    .notif-msg {
      font-size:11px; color:var(--text-dim); line-height:1.5;
      display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;
      overflow:hidden;
    }
    .notif-meta {
      font-size:10px; color:var(--text-faint); margin-top:5px;
      display:flex; align-items:center; gap:8px;
    }
    .notif-meta .stock-chip {
      padding:1px 7px; border-radius:999px; font-size:10px; font-weight:600;
    }
    .notif-btns {
      display:flex; gap:4px; margin-top:7px;
    }
    .notif-action-btn {
      font-size:10px; padding:3px 9px; border-radius:6px; cursor:pointer;
      border:none; font-family:'DM Sans',sans-serif; transition:all 0.15s;
    }
    .notif-action-btn.read-btn { background:var(--surface2); color:var(--text-dim); }
    .notif-action-btn.read-btn:hover { background:var(--surface3); color:var(--text); }
    .notif-action-btn.snooze-btn { background:transparent; color:var(--text-faint); }
    .notif-action-btn.snooze-btn:hover { color:var(--text-dim); }

    /* Overlay pour fermer le panel */
    .notif-overlay { position:fixed; inset:0; z-index:599; }

    @media (max-width:480px) {
      .notif-panel { top:56px; right:8px; left:8px; width:auto; }
    }
  `;
  document.head.appendChild(s);
}

// ─── BELL ────────────────────────────────────────────
function buildBell() {
  const topbar = document.querySelector('.topbar');
  if (!topbar) return;

  const bell = document.createElement('button');
  bell.className = 'notif-bell';
  bell.id = 'notifBell';
  bell.title = 'Notifications';
  // Badge TOUJOURS présent dans le DOM, caché si 0 notifs non lues
  bell.innerHTML = `
    <i class="fas fa-bell"></i>
    <span class="notif-count" id="notifCount" style="display:none;"></span>
  `;
  bell.addEventListener('click', togglePanel);

  // Insérer AVANT les topbar-actions (donc toujours à droite, avant d'éventuels boutons)
  const actions = document.getElementById('topbarActions');
  if (actions) {
    topbar.insertBefore(bell, actions);
  } else {
    topbar.appendChild(bell);
  }
}

// ─── FETCH ───────────────────────────────────────────
async function fetchAndUpdate() {
  try {
    _notifs = await _api.get('/notifications');
    updateBell();
  } catch {}
}

function updateBell() {
  const bell = document.getElementById('notifBell');
  const countEl = document.getElementById('notifCount');
  if (!bell || !countEl) return;

  const unread = _notifs.filter(n => !n.is_read_by_me).length;

  // Bell toujours visible; animation seulement si non lues
  bell.classList.toggle('has-unread', unread > 0);

  // Badge: visible UNIQUEMENT si au moins 1 non lue
  if (unread > 0) {
    countEl.style.display = 'flex';
    countEl.textContent = unread > 9 ? '9+' : String(unread);
  } else {
    countEl.style.display = 'none';
  }

  // Mettre à jour le panel s'il est ouvert
  if (_panel) renderPanelContent();
}

// ─── PANEL ───────────────────────────────────────────
function togglePanel() {
  if (_panel) { closePanel(); return; }
  openPanel();
}

function openPanel() {
  // Overlay pour fermer
  const overlay = document.createElement('div');
  overlay.className = 'notif-overlay';
  overlay.addEventListener('click', closePanel);
  document.body.appendChild(overlay);

  _panel = document.createElement('div');
  _panel.className = 'notif-panel';
  _panel.id = 'notifPanel';
  document.body.appendChild(_panel);

  renderPanelContent();
}

function closePanel() {
  _panel?.remove();
  _panel = null;
  document.querySelector('.notif-overlay')?.remove();
}

function renderPanelContent() {
  if (!_panel) return;
  const unread = _notifs.filter(n => !n.is_read_by_me).length;

  _panel.innerHTML = `
    <div class="notif-panel-header">
      <div class="notif-panel-title">
        <i class="fas fa-bell" style="color:var(--accent);margin-right:7px;font-size:13px;"></i>
        Notifications ${_notifs.length ? `<span style="color:var(--text-dim);font-weight:400;font-size:12px;">(${_notifs.length})</span>` : ''}
      </div>
      <div class="notif-panel-actions">
        ${unread > 0 ? `<button class="notif-panel-btn accent" onclick="notifReadAll()"><i class="fas fa-check-double"></i> Tout lire</button>` : ''}
        ${_user.role === 'admin' ? `<button class="notif-panel-btn" onclick="notifRefresh()" title="Actualiser"><i class="fas fa-sync-alt"></i></button>` : ''}
        <button class="notif-panel-btn" onclick="notifClosePanel()"><i class="fas fa-times"></i></button>
      </div>
    </div>
    <div class="notif-list" id="notifList">
      ${renderItems()}
    </div>
  `;
}

function renderItems() {
  if (!_notifs.length) return `
    <div class="notif-empty">
      <i class="fas fa-check-circle" style="color:var(--green);opacity:0.5;"></i>
      <p>Aucune notification — tout va bien !</p>
    </div>`;

  return _notifs.map(n => {
    const cfg = ICONS[n.type] || { icon:'fa-info-circle', color:'var(--text-dim)', bg:'var(--surface2)' };
    const stockLabel = STOCK_LABELS[n.current_stock] || n.current_stock || '';
    const stockColor = {
      atelier:'var(--blue)', installation:'var(--orange)',
      boutique:'var(--green)', garantie:'var(--red)',
    }[n.current_stock] || 'var(--text-dim)';

    const timeAgo = formatTimeAgo(new Date(n.created_at));

    return `<div class="notif-item ${n.is_read_by_me ? '' : 'unread'}" id="notif-${n.id}">
      <div class="notif-icon" style="background:${cfg.bg};color:${cfg.color};">
        <i class="fas ${cfg.icon}"></i>
      </div>
      <div class="notif-content">
        <div class="notif-title">${esc(n.title)}</div>
        <div class="notif-msg">${esc(n.message)}</div>
        <div class="notif-meta">
          <span>${timeAgo}</span>
          ${stockLabel ? `<span class="stock-chip" style="background:${stockColor}22;color:${stockColor}">${stockLabel}</span>` : ''}
        </div>
        <div class="notif-btns">
          ${!n.is_read_by_me ? `<button class="notif-action-btn read-btn" onclick="notifMarkRead(${n.id})"><i class="fas fa-check"></i> Marquer lu</button>` : ''}
          <button class="notif-action-btn snooze-btn" onclick="notifSnooze(${n.id},24)"><i class="fas fa-clock"></i> Reporter 24h</button>
          ${_user.role === 'admin' ? `<button class="notif-action-btn snooze-btn" onclick="notifDelete(${n.id})" style="color:var(--red);"><i class="fas fa-trash"></i></button>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

// ─── ACTIONS ─────────────────────────────────────────
window.notifClosePanel = closePanel;

window.notifReadAll = async () => {
  try {
    await _api.post('/notifications/read-all', {});
    _notifs.forEach(n => n.is_read_by_me = true);
    updateBell();
  } catch {}
};

window.notifMarkRead = async (id) => {
  try {
    await _api.post(`/notifications/${id}/read`, {});
    const n = _notifs.find(x => x.id === id);
    if (n) { n.is_read_by_me = true; updateBell(); }
  } catch {}
};

window.notifSnooze = async (id, hours) => {
  try {
    await _api.post(`/notifications/${id}/snooze`, { hours });
    _notifs = _notifs.filter(n => n.id !== id);
    updateBell();
  } catch {}
};

window.notifDelete = async (id) => {
  try {
    await _api.delete(`/notifications/${id}`);
    _notifs = _notifs.filter(n => n.id !== id);
    updateBell();
  } catch {}
};

window.notifRefresh = async () => {
  const btn = document.querySelector('.notif-panel .notif-panel-btn [class*="sync"]')?.parentElement;
  if (btn) { btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; btn.disabled = true; }
  try {
    await _api.post('/notifications/refresh', {});
    await fetchAndUpdate();
  } catch {}
  if (btn) { btn.innerHTML = '<i class="fas fa-sync-alt"></i>'; btn.disabled = false; }
};

// ─── HELPERS ─────────────────────────────────────────
function formatTimeAgo(date) {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return 'À l\'instant';
  if (mins < 60) return `Il y a ${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `Il y a ${h}h`;
  const d = Math.floor(h / 24);
  return `Il y a ${d} jour${d > 1 ? 's' : ''}`;
}

function esc(str) {
  const d = document.createElement('div'); d.textContent = str || ''; return d.innerHTML;
}

// SSE listener pour refresh automatique
export function onSSENotifUpdate() {
  fetchAndUpdate();
}
