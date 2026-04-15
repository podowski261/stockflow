// ══════════════════════════════════════════════════════
//  STOCKFLOW — App.js Principal
// ══════════════════════════════════════════════════════
import { initNotifications, onSSENotifUpdate } from './notifications.js';

// ─── AUTH ────────────────────────────────────────────
export const auth = {
  token: () => localStorage.getItem('sf_token'),
  user: () => { try { return JSON.parse(localStorage.getItem('sf_user')); } catch { return null; } },
  isLoggedIn: () => !!localStorage.getItem('sf_token'),
  logout() { localStorage.removeItem('sf_token'); localStorage.removeItem('sf_user'); window.location.href = 'login.html'; }
};

// Redirect si non connecté
if (!auth.isLoggedIn()) { window.location.href = 'login.html'; }
const currentUser = auth.user();

// ─── API CLIENT ──────────────────────────────────────
export const api = {
  async request(method, path, body, isFormData = false) {
    const opts = {
      method,
      headers: { Authorization: `Bearer ${auth.token()}` },
    };
    if (body && !isFormData) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    } else if (body && isFormData) {
      opts.body = body;
    }
    const res = await fetch(`/api${path}`, opts);
    if (res.status === 401) { auth.logout(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Erreur serveur');
    return data;
  },
  get: (path) => api.request('GET', path),
  post: (path, body) => api.request('POST', path, body),
  put: (path, body) => api.request('PUT', path, body),
  delete: (path) => api.request('DELETE', path),
  postForm: (path, formData) => api.request('POST', path, formData, true),
  putForm: (path, formData) => api.request('PUT', path, formData, true),};

// ─── TOAST ───────────────────────────────────────────
export function toast(message, type = 'success', duration = 3500) {
  const icons = { success: 'fa-check-circle', error: 'fa-times-circle', warning: 'fa-exclamation-triangle', info: 'fa-info-circle' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i><span>${message}</span>`;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(10px)'; el.style.transition = '0.3s'; setTimeout(() => el.remove(), 300); }, duration);
}

// ─── MODAL HELPER ────────────────────────────────────
export function showModal(id, title, bodyHTML, footerHTML = '') {
  closeModal(id);
  const el = document.createElement('div');
  el.className = 'modal-overlay';
  el.id = `modal-${id}`;
  el.innerHTML = `
    <div class="modal-box">
      <div class="modal-header">
        <div class="modal-title">${title}</div>
        <button class="btn btn-ghost btn-icon btn-sm" onclick="closeModal('${id}')"><i class="fas fa-times"></i></button>
      </div>
      <div class="modal-body">${bodyHTML}</div>
      ${footerHTML ? `<div class="modal-footer">${footerHTML}</div>` : ''}
    </div>`;
  el.addEventListener('click', e => { if (e.target === el) closeModal(id); });
  document.getElementById('modalsContainer').appendChild(el);
  requestAnimationFrame(() => el.classList.add('open'));
  document.body.style.overflow = 'hidden';
}
window.closeModal = (id) => {
  const el = document.getElementById(`modal-${id}`);
  if (el) { el.classList.remove('open'); setTimeout(() => el.remove(), 200); document.body.style.overflow = ''; }
};

// ─── CONFIRM DIALOG ──────────────────────────────────
export function confirm(message, title = 'Confirmation') {
  return new Promise(resolve => {
    showModal('confirm', title,
      `<p style="color:var(--text-dim);line-height:1.6;">${message}</p>`,
      `<button class="btn btn-ghost" onclick="closeModal('confirm');window._confirmResolve(false)">Annuler</button>
       <button class="btn btn-danger" onclick="closeModal('confirm');window._confirmResolve(true)">Confirmer</button>`
    );
    window._confirmResolve = resolve;
  });
}

// ─── FORMAT HELPERS ──────────────────────────────────
export const fmt = {
  currency: (n) => new Intl.NumberFormat('fr-MG').format(Math.round(n || 0)) + ' Ar',
  date: (d) => d ? new Date(d).toLocaleDateString('fr-FR') : '—',
  datetime: (d) => d ? new Date(d).toLocaleString('fr-FR') : '—',
  sn: (sn) => sn || '—',
  stock: (s) => ({ atelier: 'Atelier', boutique: 'Boutique', garantie: 'Garantie', vendu: 'Vendu', livre: 'Livré' }[s] || s),
  condition: (c) => c === 'sous_carton' ? 'Neuf' : 'Occasion',
  role: (r) => ({ admin: 'Administrateur', atelier: 'Atelier', installation: 'Installation', boutique: 'Boutique', garantie: 'Garantie' }[r] || r),
};

// ─── BADGE HTML ──────────────────────────────────────
export function stockBadge(stock) {
  return `<span class="badge badge-${stock}">${fmt.stock(stock)}</span>`;
}
export function conditionBadge(c) {
  return c === 'sous_carton'
    ? `<span class="badge" style="background:rgba(48,208,144,0.15);color:var(--green)">Neuf</span>`
    : `<span class="badge" style="background:rgba(240,192,64,0.12);color:var(--accent)">Occasion</span>`;
}

// ─── ESCAPING ────────────────────────────────────────
export function esc(str) { const d = document.createElement('div'); d.textContent = str || ''; return d.innerHTML; }

// ─── NAVIGATION ──────────────────────────────────────
const ROLE_PAGES = {
  admin:        ['dashboard', 'search', 'catalogue_admin', 'atelier', 'boutique', 'garantie', 'vendu', 'mouvements', 'rapports', 'utilisateurs', 'config'],
  atelier:      ['atelier', 'search'],
  boutique:     ['boutique', 'vendu', 'search'],
  garantie:     ['garantie', 'search'],
};

const PAGE_CONFIG = {
  dashboard:    { label: 'Dashboard', icon: 'fa-chart-pie', section: 'Vue d\'ensemble' },
  search:       { label: 'Recherche', icon: 'fa-search', section: null },
  atelier:      { label: 'Stock Atelier', icon: 'fa-tools', section: 'Stocks' },
  boutique:     { label: 'Boutique', icon: 'fa-store', section: null },
  garantie:     { label: 'Garantie', icon: 'fa-shield-alt', section: null },
  vendu:        { label: 'Historique Ventes', icon: 'fa-receipt', section: null },
  mouvements:   { label: 'Mouvements', icon: 'fa-exchange-alt', section: 'Rapports' },
  rapports:     { label: 'Rapports PDF', icon: 'fa-file-pdf', section: null },
  utilisateurs: { label: 'Utilisateurs', icon: 'fa-users', section: 'Administration' },
  catalogue_admin: { label: 'Catalogue produits', icon: 'fa-store', section: 'Stocks' },
  config:       { label: 'Configuration', icon: 'fa-cog', section: null },
};

let currentPage = null;
const pageModules = {};

function buildSidebar() {
  const user = currentUser;
  const pages = ROLE_PAGES[user.role] || [];
  const nav = document.getElementById('sidebarNav');
  let html = '';
  let lastSection = null;
  pages.forEach(pageId => {
    const cfg = PAGE_CONFIG[pageId];
    if (!cfg) return;
    if (cfg.section && cfg.section !== lastSection) {
      html += `<div class="nav-section">${cfg.section}</div>`;
      lastSection = cfg.section;
    }
    html += `<button class="nav-item" id="nav-${pageId}" onclick="navigateTo('${pageId}')">
      <i class="fas ${cfg.icon}"></i> ${cfg.label}
      ${pageId === 'garantie' ? '<span class="nav-badge" id="warrantyBadge" style="display:none">!</span>' : ''}
    </button>`;
  });
  nav.innerHTML = html;

  // User info
  document.getElementById('sideRoleLabel').textContent = fmt.role(user.role);
  document.getElementById('sideUsername').textContent = user.full_name;
  document.getElementById('sideUserRole').textContent = fmt.role(user.role);
  document.getElementById('userAvatarInitial').textContent = user.full_name.charAt(0).toUpperCase();

  // Check warranty badge pour admin
  if (user.role === 'admin' || user.role === 'garantie') {
    checkWarrantyBadge();
    setInterval(checkWarrantyBadge, 30000);
  }
}

async function checkWarrantyBadge() {
  try {
    const data = await api.get('/warranties?status=en_attente');
    const badge = document.getElementById('warrantyBadge');
    if (badge) {
      badge.style.display = data.length > 0 ? 'inline' : 'none';
      badge.textContent = data.length;
    }
  } catch {}
}


window.navigateTo = async function(pageId) {
  if (currentPage === pageId) return;
  const user = currentUser;
  const allowed = ROLE_PAGES[user.role] || [];
  if (!allowed.includes(pageId)) { toast('Accès refusé', 'error'); return; }

  // Update nav active
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  const navEl = document.getElementById(`nav-${pageId}`);
  if (navEl) navEl.classList.add('active');

  // Update topbar title
  document.getElementById('topbarTitle').textContent = PAGE_CONFIG[pageId]?.label || pageId;
  document.getElementById('topbarActions').innerHTML = '';

  // Render page
  const container = document.getElementById('pageContainer');
  container.innerHTML = `<div class="loader-wrap"><div class="spinner"></div><span>Chargement…</span></div>`;

  currentPage = pageId;
  if (window.closeSidebar) window.closeSidebar();
  try {
    if (!pageModules[pageId]) {
      const mod = await import(`./pages/${pageId}.js`);
      pageModules[pageId] = mod;
    }
    await pageModules[pageId].render(container, { user, api, toast, showModal, confirm, fmt, esc, stockBadge, conditionBadge });
  } catch (err) {
    console.error(err);
    container.innerHTML = `<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><p>Erreur de chargement</p><small>${err.message}</small></div>`;
  }
};

window.logout = auth.logout;

// ─── INIT ────────────────────────────────────────────

// ─── INJECT RESPONSIVE PAGE STYLES ──────────────────
(function injectPageStyles() {
  if (document.getElementById('sf-page-styles')) return;
  const style = document.createElement('style');
  style.id = 'sf-page-styles';
  style.textContent = `
    /* Responsive overrides for injected pages */
    @media (max-width: 900px) {
      .form-row, .form-row-3 { grid-template-columns: 1fr !important; }
    }
    @media (max-width: 600px) {
      .stats-grid { grid-template-columns: 1fr 1fr !important; }
      .chart-box { padding: 14px !important; }
      .table-wrap { border-radius: 8px; }
      /* Tables scroll horizontalement */
      .data-table { min-width: 500px; font-size: 11px; }
      .data-table th, .data-table td { padding: 7px 9px; }
      /* Hide less important columns on mobile */
      .data-table .col-hide-sm { display: none; }
      /* Modal full width */
      .modal-box { border-radius: 14px 14px 0 0 !important; }
      /* Buttons smaller */
      .topbar-actions .btn { height: 30px; padding: 0 10px; font-size: 11px; }
    }
    @media (max-width: 400px) {
      .stats-grid { grid-template-columns: 1fr !important; }
    }
  `;
  document.head.appendChild(style);
})();

buildSidebar();

// ─── INITIALISER LES NOTIFICATIONS ──────────────────
initNotifications(api, currentUser);

const defaultPage = (ROLE_PAGES[currentUser.role] || [])[0] || 'atelier';
navigateTo(defaultPage);
