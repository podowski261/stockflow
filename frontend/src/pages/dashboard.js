// ══════════════════════════════════════════════════════
//  PAGE DASHBOARD — Admin
// ══════════════════════════════════════════════════════
export async function render(container, ctx) {
  const { api, toast, fmt, stockBadge } = ctx;

  container.innerHTML = `<div id="dashPage" style="padding:clamp(14px,3vw,28px);">
    <div class="loader-wrap"><div class="spinner"></div><span>Chargement des statistiques…</span></div>
  </div>`;

  try {
    const [dash, movements] = await Promise.all([
      api.get('/dashboard'),
      api.get('/movements?date_from=' + new Date(Date.now() - 7*86400000).toISOString().split('T')[0])
    ]);

    const stockMap = {};
    (dash.stocks || []).forEach(r => { stockMap[r.current_stock] = parseInt(r.count); });

    const totalCirculation = (stockMap.atelier||0)+(stockMap.boutique||0)+(stockMap.garantie||0);
    const totalAll = Object.values(stockMap).reduce((a,b)=>a+b,0);
    const totalSales = (dash.salesByDay||[]).reduce((s,r)=>s+(parseFloat(r.total)||0),0);
    const totalSalesCount = (dash.salesByDay||[]).reduce((s,r)=>s+parseInt(r.count||0),0);

    document.getElementById('dashPage').innerHTML = `

      <!-- TOTAL GÉNÉRAL -->
      <div style="background:linear-gradient(135deg,rgba(240,192,64,0.12),rgba(240,120,48,0.06));border:1px solid rgba(240,192,64,0.25);border-radius:16px;padding:22px 28px;margin-bottom:24px;display:flex;align-items:center;gap:24px;flex-wrap:wrap;">
        <div>
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:2px;color:var(--text-faint);margin-bottom:6px;">
            <i class="fas fa-layer-group" style="margin-right:6px;"></i>Total général — tous les ordinateurs
          </div>
          <div style="font-family:'Syne',sans-serif;font-size:48px;font-weight:800;color:var(--accent);line-height:1;">${totalAll}</div>
          <div style="font-size:13px;color:var(--text-dim);margin-top:8px;">
            <span style="color:var(--text);font-weight:600;">${totalCirculation}</span> en circulation &nbsp;·&nbsp;
            <span style="color:var(--accent);font-weight:600;">${stockMap.vendu||0}</span> vendus &nbsp;·&nbsp;
            <span style="color:var(--text-dim);">${stockMap.livre||0}</span> livrés
          </div>
        </div>
        <div style="margin-left:auto;display:flex;gap:12px;flex-wrap:wrap;">
          <div style="text-align:center;padding:16px 22px;background:rgba(0,0,0,0.25);border-radius:12px;border:1px solid var(--border);">
            <div style="font-family:'Syne',sans-serif;font-size:28px;font-weight:800;color:var(--green)">${totalSalesCount}</div>
            <div style="font-size:11px;color:var(--text-faint);margin-top:3px;">Vendus (30 jours)</div>
          </div>
          <div style="text-align:center;padding:16px 22px;background:rgba(0,0,0,0.25);border-radius:12px;border:1px solid var(--border);">
            <div style="font-family:'Syne',sans-serif;font-size:20px;font-weight:800;color:var(--accent)">${fmt.currency(totalSales)}</div>
            <div style="font-size:11px;color:var(--text-faint);margin-top:3px;">CA (30 jours)</div>
          </div>
          ${dash.pendingWarranties > 0 ? `
          <div style="text-align:center;padding:16px 22px;background:rgba(240,80,96,0.1);border-radius:12px;border:1px solid rgba(240,80,96,0.3);">
            <div style="font-family:'Syne',sans-serif;font-size:28px;font-weight:800;color:var(--red)">${dash.pendingWarranties}</div>
            <div style="font-size:11px;color:var(--red);margin-top:3px;">Garanties en attente</div>
          </div>` : ''}
        </div>
      </div>

      <!-- STAT CARDS cliquables -->
      <div class="stats-grid" style="margin-bottom:24px;">
        <div class="stat-card blue dash-nav-card" data-nav="atelier" style="cursor:pointer;">
          <div class="stat-label"><i class="fas fa-tools" style="float:right;font-size:18px;color:var(--blue);opacity:0.5;"></i>Atelier</div>
          <div class="stat-value">${stockMap.atelier||0}</div>
          <div style="font-size:11px;color:var(--blue);margin-top:6px;opacity:0.8;">Voir le stock →</div>
        </div>

        <div class="stat-card green dash-nav-card" data-nav="boutique" style="cursor:pointer;">
          <div class="stat-label"><i class="fas fa-store" style="float:right;font-size:18px;color:var(--green);opacity:0.5;"></i>Boutique</div>
          <div class="stat-value">${stockMap.boutique||0}</div>

          <div style="font-size:11px;color:var(--green);margin-top:4px;opacity:0.8;">Voir le stock →</div>
        </div>
        <div class="stat-card red dash-nav-card" data-nav="garantie" style="cursor:pointer;">
          <div class="stat-label"><i class="fas fa-shield-alt" style="float:right;font-size:18px;color:var(--red);opacity:0.5;"></i>Garantie</div>
          <div class="stat-value">${stockMap.garantie||0}</div>
          <div style="font-size:11px;color:var(--red);margin-top:6px;opacity:0.8;">Voir le stock →</div>
        </div>
        <div class="stat-card accent dash-nav-card" data-nav="vendu" style="cursor:pointer;">
          <div class="stat-label"><i class="fas fa-receipt" style="float:right;font-size:18px;color:var(--accent);opacity:0.5;"></i>Tous vendus</div>
          <div class="stat-value">${stockMap.vendu||0}</div>
          <div style="font-size:11px;color:var(--accent);margin-top:6px;opacity:0.8;">Voir l'historique →</div>
        </div>
        <div class="stat-card dash-nav-card" data-nav="mouvements" style="cursor:pointer;border-color:rgba(136,136,160,0.2);">
          <div class="stat-label"><i class="fas fa-exchange-alt" style="float:right;font-size:18px;color:var(--text-dim);opacity:0.5;"></i>Mouvements (7j)</div>
          <div class="stat-value" style="color:var(--text-dim)">${movements.length}</div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:6px;opacity:0.8;">Voir tout →</div>
        </div>
      </div>

      <!-- CHARTS -->
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px;">
        <div class="chart-box">
          <div style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;margin-bottom:14px;"><i class="fas fa-chart-pie" style="color:var(--accent);margin-right:6px;"></i>Répartition du stock</div>
          <canvas id="stockPieChart" style="max-height:220px;"></canvas>
        </div>
        <div class="chart-box">
          <div style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;margin-bottom:14px;"><i class="fas fa-chart-bar" style="color:var(--accent);margin-right:6px;"></i>Ventes — 30 derniers jours</div>
          <canvas id="salesBarChart" style="max-height:220px;"></canvas>
        </div>
      </div>

      <!-- MOUVEMENTS RÉCENTS -->
      <div class="chart-box">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
          <div style="font-family:'Syne',sans-serif;font-size:14px;font-weight:700;">
            <i class="fas fa-exchange-alt" style="color:var(--accent);margin-right:6px;"></i>Mouvements récents
          </div>
          <button class="btn btn-secondary btn-sm dash-nav-card" data-nav="mouvements">
            <i class="fas fa-arrow-right"></i> Voir tout
          </button>
        </div>
        ${renderMovementsTable(movements.slice(0,10), fmt, stockBadge)}
      </div>
    `;

    // ── Attacher les clics sur TOUTES les cartes .dash-nav-card ──
    document.querySelectorAll('.dash-nav-card[data-nav]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const page = el.getAttribute('data-nav');
        if (page) window.navigateTo(page);
      });
    });

    await buildCharts(dash, stockMap);

  } catch(err) {
    console.error('Dashboard error:', err);
    const msg = err.message || 'Erreur inconnue — vérifiez la console';
    document.getElementById('dashPage').innerHTML = `
      <div style="padding:40px;">
        <div class="empty-state">
          <i class="fas fa-exclamation-triangle" style="color:var(--red)"></i>
          <p>Erreur de chargement du dashboard</p>
          <small style="font-family:monospace;background:var(--surface2);padding:8px 12px;border-radius:6px;color:var(--text-dim);">${msg}</small>
          <button class="btn btn-secondary" onclick="window.navigateTo('dashboard')" style="margin-top:12px">
            <i class="fas fa-redo"></i> Réessayer
          </button>
        </div>
      </div>`;
  }
}

function renderMovementsTable(movements, fmt, stockBadge) {
  if (!movements.length) return `<div class="empty-state" style="padding:30px;"><i class="fas fa-exchange-alt"></i><p>Aucun mouvement récent</p></div>`;
  const esc = s => { const d=document.createElement('div');d.textContent=s||'';return d.innerHTML; };
  return `<div class="table-wrap"><table class="data-table">
    <thead><tr><th>Date</th><th>Produit</th><th>Fournisseur</th><th>Depuis</th><th></th><th>Vers</th><th>Par</th><th>Motif</th></tr></thead>
    <tbody>${movements.map(m=>`<tr>
      <td style="font-size:11px;white-space:nowrap">${fmt.datetime(m.created_at)}</td>
      <td><strong>${esc(m.brand)} ${esc(m.model)}</strong><br><span class="mono" style="font-size:10px;color:var(--text-faint)">${esc(m.internal_sn)}</span></td>
      <td>${esc(m.supplier_name||'—')}</td>
      <td>${m.from_stock ? stockBadge(m.from_stock) : '<span style="color:var(--text-faint);font-size:11px">—</span>'}</td>
      <td style="color:var(--text-faint)">→</td>
      <td>${stockBadge(m.to_stock)}</td>
      <td style="font-size:12px">${esc(m.performed_by_name||'—')}</td>
      <td style="font-size:12px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.reason||m.problem_description||'—')}</td>
    </tr>`).join('')}
    </tbody>
  </table></div>`;
}

async function buildCharts(dash, stockMap) {
  if (!window.Chart) {
    try {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js';
        s.onload = res;
        s.onerror = () => {
          // Fallback CDN
          const s2 = document.createElement('script');
          s2.src = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js';
          s2.onload = res; s2.onerror = rej;
          document.head.appendChild(s2);
        };
        document.head.appendChild(s);
      });
    } catch(e) {
      console.warn('Chart.js non chargé — graphiques désactivés');
      return;
    }
  }
  Chart.defaults.color='#8888a0';
  Chart.defaults.borderColor='rgba(255,255,255,0.07)';

  // Pie
  const pieCtx = document.getElementById('stockPieChart');
  if (pieCtx) {
    new Chart(pieCtx, {
      type: 'doughnut',
      data: {
        labels: ['Atelier','Installation','Boutique','Garantie','Vendu','Livré'],
        datasets: [{
          data: [stockMap.atelier||0, stockMap.installation||0, stockMap.boutique||0, stockMap.garantie||0, stockMap.vendu||0, stockMap.livre||0],
          backgroundColor: ['rgba(80,144,240,0.75)','rgba(240,144,48,0.75)','rgba(48,208,144,0.75)','rgba(240,80,96,0.75)','rgba(240,192,64,0.75)','rgba(136,136,160,0.5)'],
          borderColor: '#13131a',
          borderWidth: 3,
        }]
      },
      options: {
        responsive: true,
        cutout: '65%',
        plugins: {
          legend: { position:'right', labels:{ font:{family:'DM Sans',size:12}, padding:14 } },
          tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${ctx.parsed} produit(s)` } }
        }
      }
    });
  }

  // Bar
  const barCtx = document.getElementById('salesBarChart');
  if (barCtx && dash.salesByDay?.length) {
    const days = dash.salesByDay.slice(-15);
    new Chart(barCtx, {
      type: 'bar',
      data: {
        labels: days.map(d => d.day ? new Date(d.day).toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit'}) : ''),
        datasets: [{
          label: 'Unités vendues',
          data: days.map(d => parseInt(d.count||0)),
          backgroundColor: 'rgba(240,192,64,0.6)',
          borderColor: 'rgba(240,192,64,0.9)',
          borderWidth: 1,
          borderRadius: 4,
        }]
      },
      options: {
        responsive: true,
        plugins: { legend:{display:false} },
        scales: {
          x: { grid:{color:'rgba(255,255,255,0.04)'} },
          y: { beginAtZero:true, ticks:{stepSize:1}, grid:{color:'rgba(255,255,255,0.04)'} }
        }
      }
    });
  }
}
