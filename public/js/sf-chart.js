/* ============================================================
   Graphique « Évolution des ventes » PARTAGÉ (tableau de bord, trésorerie).
   Courbe CA (dégradé accent) + barres nombre de ventes (jaune), jours sans
   vente comptés à 0, récap de la période (6 tuiles) sous le graphique.
   SF.SalesChart.load({ canvas, recap, range, prev }) → instance Chart.
   Générique (tableaux de bord des rôles) : rows (série déjà chargée [{d, ca, n}]),
   labels { a, b }, moneyA (série A en Ariary, sinon quantité + unitA).
   ============================================================ */
SF.SalesChart = {
    async load({ canvas, recap, range = '7d', prev = null, rows = null, labels = { a: "Chiffre d'affaires", b: 'Ventes' }, moneyA = true, unitA = '' }) {
        const [raw] = await Promise.all([rows || SF.api('/api/treasury/chart?range=' + range), SF.needChart()]);
        const fmtA = v => moneyA ? SF.fmt.ar(v) : `${SF.fmt.int(v)}${unitA ? ' ' + unitA : ''}`;
        const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
        const accent = css('--accent') || '#0f6b5f', accent2 = css('--accent-2') || '#f9c440', muted = css('--text-muted') || '#7f8783', grid = css('--border-light') || '#eee';
        // Jours sans vente comptés à 0 (sinon la courbe « saute » les jours vides).
        const days = { '7d': 7, '1m': 30, '3m': 90, '6m': 180 }[range];
        let data = raw;
        if (days) {
            const byD = new Map(raw.map(r => [r.d, r]));
            const end = new Date(SF.fmt.today() + 'T12:00:00');
            data = [];
            for (let i = days - 1; i >= 0; i--) {
                const d = new Date(end); d.setDate(end.getDate() - i);
                const k = d.toISOString().slice(0, 10);
                data.push(byD.get(k) || { d: k, ca: 0, n: 0 });
            }
        }
        const MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
        const lbl = k => k.length === 7 ? `${MOIS[+k.slice(5, 7) - 1]} ${k.slice(2, 4)}` : `${+k.slice(8, 10)} ${MOIS[+k.slice(5, 7) - 1]}`;
        if (prev) prev.destroy();
        // Clic (ou toucher) sur le graphique → CA et nombre de ventes du jour / mois choisi, affichés
        // dans un bandeau juste sous le graphique (le survol garde l'infobulle).
        const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
        const longLbl = k => k.length === 7 ? `${['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'][+k.slice(5, 7) - 1]} ${k.slice(0, 4)}`
            : `${JOURS[new Date(k + 'T12:00:00').getDay()]} ${SF.fmt.date(k)}`;
        // Téléphone : beaucoup de points → graphique plus large que l'écran, à faire glisser (gauche / droite).
        const host = canvas.parentElement;
        let scroller = host.parentElement.classList.contains('cscroll') ? host.parentElement : null;
        if (!scroller) { scroller = document.createElement('div'); scroller.className = 'cscroll'; host.parentNode.insertBefore(scroller, host); scroller.appendChild(host); }
        const narrow = scroller.clientWidth > 0 && scroller.clientWidth < 640 && data.length > 12;
        host.style.width = narrow ? Math.max(scroller.clientWidth, data.length * 28) + 'px' : '';
        scroller.classList.toggle('wide', narrow);
        let pick = scroller.parentElement.querySelector(':scope > .cpick');
        if (!pick) { pick = document.createElement('div'); pick.className = 'cpick'; scroller.insertAdjacentElement('afterend', pick); }
        const showPick = i => {
            const d = data[i];
            if (!d) { pick.innerHTML = `<i class="fas fa-hand-pointer"></i> ${narrow ? 'Touchez' : 'Cliquez sur'} le graphique pour voir le ${moneyA ? "chiffre d'affaires" : labels.a.toLowerCase()} d'un ${range === 'global' ? 'mois' : 'jour'}.${narrow ? ' Glissez à gauche / à droite pour parcourir la période.' : ''}`; pick.classList.remove('on'); return; }
            pick.classList.add('on');
            pick.innerHTML = `<span class="pd"><i class="fas fa-calendar-day"></i> ${longLbl(d.d)}</span>
                <span class="pv">${labels.a} : <b>${fmtA(d.ca || 0)}</b></span>
                <span class="pv">${labels.b} : <b>${d.n || 0}</b></span>
                ${moneyA && d.n ? `<span class="pv">Panier moyen : <b>${SF.fmt.ar(Math.round((d.ca || 0) / d.n))}</b></span>` : ''}`;
        };
        showPick(-1);
        const fill = c => { const { ctx: g, chartArea: a } = c.chart; if (!a) return accent + '22';
            const gr = g.createLinearGradient(0, a.top, 0, a.bottom); gr.addColorStop(0, accent + '55'); gr.addColorStop(1, accent + '03'); return gr; };
        const chart = new Chart(canvas, {
            data: { labels: data.map(d => lbl(d.d)), datasets: [
                { type: 'line', label: labels.a, data: data.map(d => d.ca || 0), yAxisID: 'y', borderColor: accent, backgroundColor: fill, fill: true,
                  tension: .35, cubicInterpolationMode: 'monotone', borderWidth: 2.5, pointRadius: data.length > 40 ? 0 : 3, pointHoverRadius: 6, pointBackgroundColor: '#fff', pointBorderColor: accent, pointBorderWidth: 2, order: 1 },
                { type: 'bar', label: labels.b, data: data.map(d => d.n || 0), yAxisID: 'y1', backgroundColor: accent2 + 'b3', hoverBackgroundColor: accent2,
                  borderRadius: 5, maxBarThickness: 18, order: 2 } ] },
            options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
                onClick: (e, els, ch) => { const pts = ch.getElementsAtEventForMode(e, 'index', { intersect: false }, false); if (pts.length) showPick(pts[0].index); },
                onHover: (e, els) => { if (e.native && e.native.target) e.native.target.style.cursor = els.length ? 'pointer' : 'default'; },
                plugins: { legend: { display: false },
                    tooltip: { backgroundColor: '#1d2826', padding: 10, cornerRadius: 10, displayColors: true, boxPadding: 4,
                        callbacks: { label: c => c.dataset.yAxisID === 'y' ? ` ${labels.a} : ${fmtA(c.raw)}` : ` ${labels.b} : ${c.raw}` } } },
                scales: {
                    x: { grid: { display: false }, border: { display: false }, ticks: { color: muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 8, font: { size: 11 } } },
                    y: { beginAtZero: true, border: { display: false }, grid: { color: grid, borderDash: [4, 4] },
                        ticks: { color: muted, font: { size: 11 }, maxTicksLimit: 5, callback: v => v >= 1e6 ? (v / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' M' : v >= 1e3 ? Math.round(v / 1e3) + ' k' : v } },
                    y1: { beginAtZero: true, position: 'right', border: { display: false }, grid: { display: false },
                        ticks: { color: muted, font: { size: 11 }, precision: 0, maxTicksLimit: 5 } } } } });
        if (narrow) requestAnimationFrame(() => { scroller.scrollLeft = scroller.scrollWidth; });   // jours les plus récents visibles
        if (recap) this.recap(recap, data, range, { labels, moneyA, fmtA });
        return chart;
    },
    recap(box, data, range, { labels = { a: "Chiffre d'affaires", b: 'Ventes' }, moneyA = true, fmtA = SF.fmt.ar } = {}) {
        const monthly = range === 'global';
        const ca = data.reduce((t, d) => t + (d.ca || 0), 0), n = data.reduce((t, d) => t + (d.n || 0), 0);
        // Jour (ou mois) actif = au moins un mouvement (vente ou encaissement) : les jours sans activité
        // (dimanche, jour férié…) n'entrent pas dans les moyennes.
        const active = data.filter(d => (d.n || 0) > 0 || (d.ca || 0) !== 0).length;
        const base = Math.max(1, active);
        const best = data.reduce((b, d) => (d.ca || 0) > (b ? b.ca : -1) ? d : b, null);
        const half = Math.floor(data.length / 2);
        const sum = a => a.reduce((t, d) => t + (d.ca || 0), 0);
        const prev = sum(data.slice(0, half)), last = sum(data.slice(data.length - half));
        const trend = prev > 0 ? Math.round((last - prev) / prev * 100) : null;
        const unit = monthly ? 'mois' : 'jour';
        const fmtD = k => !k ? '—' : k.length === 7 ? k.slice(5, 7) + '/' + k.slice(0, 4) : SF.fmt.date(k);
        const tile = (icon, tint, l, v, sub) => `<div class="ct"><span class="sf-ico t-${tint}"><i class="fas ${icon}"></i></span><div><div class="cl">${l}</div><div class="cv">${v}</div>${sub ? `<div class="cs">${sub}</div>` : ''}</div></div>`;
        box.innerHTML =
            tile(moneyA ? 'fa-sack-dollar' : 'fa-layer-group', 'teal', moneyA ? (labels.a === "Chiffre d'affaires" ? 'CA de la période' : labels.a) : `${labels.a} (période)`, fmtA(ca), `${n} ${labels.b.toLowerCase()}`) +
            tile('fa-calendar-day', 'blue', `Moyenne / ${unit}`, fmtA(Math.round(ca / base)), `sur ${active} ${unit}(s) avec activité / ${data.length}`) +
            (moneyA ? tile('fa-basket-shopping', 'yellow', 'Panier moyen', SF.fmt.ar(n ? Math.round(ca / n) : 0), `par ${labels.b.toLowerCase().replace(/s$/, '')}`)
                    : tile('fa-percent', 'yellow', 'Jours actifs', `${active} / ${data.length}`, unit === 'mois' ? 'mois' : 'jours')) +
            tile('fa-trophy', 'violet', `Meilleur ${unit}`, best && best.ca ? fmtA(best.ca) : '—', best && best.ca ? fmtD(best.d) : '') +
            tile('fa-receipt', 'green', labels.b, n, `${(n / base).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} / ${unit} actif`) +
            tile(trend == null || trend >= 0 ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down', trend == null || trend >= 0 ? 'green' : 'coral', 'Tendance',
                trend == null ? '—' : `<span class="${trend >= 0 ? 'up' : 'down'}">${trend >= 0 ? '+' : ''}${trend} %</span>`, '2e moitié vs 1re');
    }
};
