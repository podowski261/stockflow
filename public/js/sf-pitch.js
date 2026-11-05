// ============================================================
//  SFPitch — argumentaire commercial automatique d'un produit (texte « accrocheur »)
//  Partagé par la proforma et la Commande en ligne (fiche à envoyer au client).
//  Les méthodes utilisent `this` : on les étale dans un objet (…SFPitch) ou on les
//  appelle via SFPitch.buildPitch(p).
// ============================================================
window.SFPitch = {
        buildDetail(p) {
            if (p.is_accessory) return [p.category, p.subcategory].filter(Boolean).join(' · ') || (p.description || '');
            const parts = [];
            if (p.cpu) parts.push('Processeur ' + p.cpu);
            if (p.ram) parts.push('RAM ' + p.ram);
            if (p.storage) parts.push('Stockage ' + p.storage + (p.storage_type ? ' ' + p.storage_type : ''));
            if (p.screen_size) parts.push('Écran ' + String(p.screen_size).replace(/"$/, '') + '"' + (p.touchscreen ? ' tactile' : ''));
            if (p.gpu) parts.push('Carte graphique ' + p.gpu);
            return parts.join(' · ');
        },
        // ── Argumentaire commercial (« pitch ») déduit de la configuration ──
        // Objectif : un texte professionnel et VARIÉ. Le produit est classé dans un
        // profil (gaming, créateur, pro, bureautique, essentiel), et chaque profil
        // dispose de plusieurs modèles d'ouverture / de conclusion. Le choix est
        // déterministe : un même produit garde toujours le même texte, mais deux
        // produits différents d'un même devis sont formulés différemment.
        pitchTpl: {
            gaming: {
                open: [
                    c => `Une véritable machine de jeu, propulsée par ${c.cpuName}${c.gpuName ? ` et ${c.gpuName}` : ''}.`,
                    c => `Pensé pour les joueurs exigeants : ${c.cpuName} épaulé par ${c.gpuName}.`,
                    c => `Prêt pour le gaming et le streaming, il associe ${c.cpuName} à ${c.gpuName}.`,
                    c => `Des performances de jeu au rendez-vous grâce à ${c.gpuName} et ${c.cpuName}.`
                ],
                close: [
                    `Fluidité et images détaillées, même sur les titres les plus gourmands.`,
                    `De quoi jouer dans d'excellentes conditions durant des années.`,
                    `Le compagnon idéal des joueurs comme des créateurs de contenu.`,
                    `Un choix solide pour le jeu haute performance.`
                ]
            },
            creator: {
                open: [
                    c => `Une station de travail taillée pour la création, animée par ${c.cpuName}${c.gpuName ? ` et ${c.gpuName}` : ''}.`,
                    c => `Pensé pour les créateurs, ce poste combine ${c.cpuName} et ${c.gpuName}.`,
                    c => `Puissance professionnelle assurée par ${c.cpuName}${c.gpuName ? ` et ${c.gpuName}` : ''}.`,
                    c => `Conçu pour les usages intensifs, il repose sur ${c.cpuName} et ${c.gpuName}.`
                ],
                close: [
                    `Idéal pour le montage vidéo, la 3D et le graphisme exigeant.`,
                    `Vos logiciels créatifs et de calcul tournent sans ralentissement.`,
                    `La productivité au service de vos projets les plus ambitieux.`,
                    `Un véritable outil de travail pour les professionnels de la création.`
                ]
            },
            pro: {
                open: [
                    c => `Un ordinateur professionnel fiable, propulsé par ${c.cpuName}.`,
                    c => `Pensé pour le travail exigeant, il s'appuie sur ${c.cpuName}.`,
                    c => `Performance et sérieux, au bureau comme en déplacement, avec ${c.cpuName}.`,
                    c => `Une configuration robuste pour les professionnels, animée par ${c.cpuName}.`
                ],
                close: [
                    `Idéal pour le multitâche professionnel et les applications lourdes.`,
                    `Une productivité assurée tout au long de la journée.`,
                    `Un allié de confiance pour votre activité.`,
                    `La réactivité qu'exige un usage professionnel intensif.`
                ]
            },
            office: {
                open: [
                    c => `Un ordinateur polyvalent et réactif, animé par ${c.cpuName}.`,
                    c => `Parfait pour un usage quotidien, il embarque ${c.cpuName}.`,
                    c => `Simple, rapide et fiable, propulsé par ${c.cpuName}.`,
                    c => `Le bon équilibre entre performance et budget, avec ${c.cpuName}.`
                ],
                close: [
                    `Idéal pour la bureautique, la navigation et le divertissement.`,
                    `Un confort d'utilisation garanti au quotidien.`,
                    `Tout ce qu'il faut pour travailler et se divertir sereinement.`,
                    `Un compagnon fiable pour la maison comme pour l'étude.`
                ]
            },
            essential: {
                open: [
                    c => `Un ordinateur accessible et fonctionnel${c.cpu ? `, avec ${c.cpuName}` : ''}.`,
                    c => `L'essentiel à petit prix${c.cpu ? ` : ${c.cpuName}` : ''}.`,
                    c => `Une solution économique pour bien démarrer${c.cpu ? `, animée par ${c.cpuName}` : ''}.`,
                    c => `Une base fiable pour l'essentiel${c.cpu ? `, avec ${c.cpuName}` : ''}.`
                ],
                close: [
                    `Parfait pour la bureautique, Internet et les tâches courantes.`,
                    `Un excellent premier prix, sans compromis sur l'utile.`,
                    `Le bon choix pour un budget maîtrisé.`,
                    `Idéal pour débuter ou comme poste d'appoint.`
                ]
            }
        },
        // Argument de marque : met en avant ce qui distingue chaque fabricant.
        // Plusieurs variantes par marque ; repli générique pour les marques inconnues.
        pitchBrandTpl: {
            asus:      [`La fiabilité et l'innovation ASUS en prime.`, `ASUS, reconnu pour sa robustesse et ses performances.`, `Le savoir-faire ASUS, gage de durabilité.`],
            lenovo:    [`La robustesse Lenovo, plébiscitée par les professionnels.`, `Lenovo, une référence en fiabilité et en confort de frappe.`, `La qualité Lenovo, pensée pour durer.`],
            thinkpad:  [`La légendaire robustesse des ThinkPad, pour les pros exigeants.`, `ThinkPad, la fiabilité qui a fait ses preuves en entreprise.`],
            hp:        [`La qualité HP, une référence en entreprise.`, `HP, un standard de fiabilité et de service.`, `Le sérieux HP, apprécié des professionnels.`],
            dell:      [`Le sérieux Dell, plébiscité par les entreprises.`, `Dell, synonyme de fiabilité et d'un support de qualité.`, `La robustesse Dell, pensée pour un usage intensif.`],
            acer:      [`Acer, l'excellent rapport qualité-prix.`, `La marque Acer, accessible et polyvalente.`, `Acer, un bon équilibre entre prix et performances.`],
            apple:     [`La finition et l'écosystème Apple, sans compromis.`, `Apple, une expérience fluide et une autonomie remarquable.`, `Le raffinement Apple, pour les plus exigeants.`],
            msi:       [`MSI, l'expertise dédiée au gaming et à la création.`, `La marque MSI, taillée pour la performance.`, `MSI, pensé pour les joueurs et créateurs exigeants.`],
            microsoft: [`La qualité Microsoft Surface, élégante et polyvalente.`, `Surface, le raffinement au service de la productivité.`],
            surface:   [`Surface, l'élégance Microsoft au service de la productivité.`, `La finition premium des Surface, sans compromis.`],
            huawei:    [`Huawei, un design soigné et un écran de qualité.`, `La finition Huawei, moderne et élégante.`],
            samsung:   [`Samsung, l'excellence des écrans et un design premium.`, `La qualité d'affichage Samsung, mondialement reconnue.`],
            toshiba:   [`Toshiba, la fiabilité japonaise éprouvée.`, `La robustesse Toshiba, éprouvée dans le temps.`],
            dynabook:  [`Dynabook, l'héritage de fiabilité de Toshiba.`, `La robustesse Dynabook, éprouvée dans le temps.`],
            gigabyte:  [`Gigabyte, la performance au service du gaming.`, `Gigabyte, un savoir-faire matériel reconnu.`],
            razer:     [`Razer, l'excellence du gaming haut de gamme.`, `Le design premium Razer, pour les joueurs passionnés.`],
            lg:        [`LG, l'excellence des écrans et une grande légèreté.`, `La qualité d'affichage LG, reconnue.`],
            fujitsu:   [`Fujitsu, la fiabilité professionnelle japonaise.`],
            // ── Marques d'accessoires ──
            logitech:  [`Logitech, la référence mondiale des périphériques.`, `Logitech, fiabilité et confort éprouvés.`, `La qualité Logitech, plébiscitée depuis des années.`],
            hikvision: [`Hikvision, leader mondial de la vidéosurveillance.`, `Hikvision, une image et une fiabilité de niveau professionnel.`],
            dahua:     [`Dahua, une référence en vidéosurveillance professionnelle.`, `Dahua, fiabilité et qualité d'image reconnues.`],
            ezviz:     [`EZVIZ, la vidéosurveillance connectée simple et fiable.`],
            canon:     [`Canon, l'excellence de l'impression et de l'image.`, `Canon, une qualité d'impression reconnue.`],
            epson:     [`Epson, la fiabilité et des coûts d'impression maîtrisés.`, `Epson, une référence pour l'impression économique.`],
            brother:   [`Brother, robustesse et faible coût par page.`, `Brother, l'imprimante fiable du bureau.`],
            kingston:  [`Kingston, une référence fiable pour le stockage et la mémoire.`],
            sandisk:   [`SanDisk, la fiabilité reconnue pour vos données.`],
            seagate:   [`Seagate, un stockage éprouvé et durable.`],
            westerndigital: [`Western Digital, la fiabilité du stockage reconnue.`],
            wd:        [`WD, la fiabilité du stockage reconnue.`],
            crucial:   [`Crucial, mémoire et SSD de confiance.`],
            transcend: [`Transcend, un stockage fiable et abordable.`],
            tplink:    [`TP-Link, une connectivité fiable et accessible.`, `TP-Link, la référence du réseau grand public.`],
            mercusys:  [`Mercusys, une solution réseau simple et abordable.`],
            tenda:     [`Tenda, un réseau accessible et fiable.`],
            dlink:     [`D-Link, une connectivité réseau éprouvée.`],
            cisco:     [`Cisco, le standard professionnel du réseau.`],
            anker:     [`Anker, la référence en charge et accessoires nomades.`],
            ugreen:    [`UGREEN, une connectique fiable et bien conçue.`],
            baseus:    [`Baseus, des accessoires modernes et fiables.`],
            apc:       [`APC, la référence des onduleurs pour protéger vos équipements.`],
            eaton:     [`Eaton, une protection électrique de niveau professionnel.`],
            redragon:  [`Redragon, l'équipement gaming au bon rapport qualité-prix.`],
            corsair:   [`Corsair, du matériel gaming haut de gamme.`],
            jbl:       [`JBL, un son puissant et de qualité.`],
            sony:      [`Sony, l'excellence audio et vidéo.`],
            xiaomi:    [`Xiaomi, une technologie moderne au meilleur prix.`],
            rapoo:     [`Rapoo, des périphériques fiables et abordables.`],
            a4tech:    [`A4Tech, un bon rapport qualité-prix au quotidien.`],
            genius:    [`Genius, l'accessoire simple et économique.`]
        },
        // Signature numérique stable d'un produit → index de modèle reproductible.
        pitchSeed(p) {
            const s = `${p.id != null ? p.id : ''}|${p.model || p.name || ''}|${p.cpu || ''}`;
            let h = 0;
            for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
            return h;
        },
        pick(arr, seed) { return arr[(seed >>> 0) % arr.length]; },
        frJoin(arr) { return arr.length <= 1 ? (arr[0] || '') : arr.slice(0, -1).join(', ') + ' et ' + arr[arr.length - 1]; },
        // Analyse de la configuration → profil + libellés prêts à l'emploi.
        pitchConfig(p) {
            const gpu = String(p.gpu || '');
            const cpu = String(p.cpu || '');
            const ram = parseInt(String(p.ram || '').replace(/\D/g, ''), 10) || 0;
            const storeStr = (String(p.storage_type || '') + ' ' + String(p.storage || '')).trim();
            const isNVMe = /nvme/i.test(storeStr);
            const isSSD = isNVMe || /ssd/i.test(storeStr);
            const gpuGaming = /rtx|gtx|geforce|radeon\s*rx|\brx\s?\d|\barc\b/i.test(gpu);
            const gpuPro = /quadro|rtx\s*a\d|firepro|radeon\s*pro|\bt\d{3,4}\b/i.test(gpu);
            const dedic = !!gpu && !/intel|uhd|iris|integr|vega|radeon graphics|amd graphics|adreno/i.test(gpu);
            const cpuHigh = /i7|i9|ryzen\s*[79]|ultra\s*[79]|m[1-4]\s*(pro|max|ultra)/i.test(cpu);
            const cpuMid = /i5|ryzen\s*5|ultra\s*5|\bm[1-4]\b/i.test(cpu);
            const screen = p.screen_size ? String(p.screen_size).replace(/"$/, '') : '';
            const touch = !!p.touchscreen;
            let segment;
            if (gpuGaming && !gpuPro) segment = 'gaming';
            else if (gpuPro || (dedic && ram >= 32)) segment = 'creator';
            else if (!dedic && (cpuHigh || (cpuMid && ram >= 16)) && ram >= 16) segment = 'pro';
            else if (ram >= 8 && isSSD) segment = 'office';
            else segment = 'essential';
            return {
                cpu, ram, isSSD, isNVMe, dedic, gpu, screen, touch, segment,
                store: String(p.storage || ''),
                cpuName: cpu ? `le processeur ${cpu}` : 'un processeur fiable',
                gpuName: dedic && gpu ? `la ${gpu}` : ''
            };
        },
        // Atouts matériels (stockage / RAM / écran) formulés avec des amorces variées.
        pitchStrengths(c, seed) {
            const f = [];
            if (c.isNVMe) f.push('un SSD NVMe ultra-rapide');
            else if (c.isSSD) f.push('un SSD rapide');
            else if (c.store) f.push(`${c.store} de stockage`);
            if (c.ram >= 32) f.push(`${c.ram} Go de RAM pour les charges les plus lourdes`);
            else if (c.ram >= 16) f.push(`${c.ram} Go de RAM pour un multitâche intensif`);
            else if (c.ram >= 8) f.push(`${c.ram} Go de RAM pour un travail fluide`);
            if (c.touch) f.push(`un écran tactile${c.screen ? ` ${c.screen}"` : ''}`);
            if (!f.length) return '';
            const leads = ['Il embarque', 'On y trouve', 'Il mise sur', 'Au programme :'];
            return ` ${this.pick(leads, seed >>> 4)} ${this.frJoin(f)}.`;
        },
        // Argument de marque, choisi de façon stable et varié d'un produit à l'autre.
        pitchBrand(p, seed) {
            const raw = String(p.brand || '').trim();
            if (!raw) return '';
            const key = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
            const pool = this.pitchBrandTpl[key];
            if (pool) return this.pick(pool, seed);
            const name = raw.charAt(0).toUpperCase() + raw.slice(1);
            return this.pick([
                `Un produit ${name}, sélectionné pour sa qualité.`,
                `${name}, une marque choisie pour sa fiabilité.`
            ], seed);
        },
        // Accessoires : modèles adaptés au type de produit (souris, écran, stockage…).
        pitchAccessory(p) {
            const t = `${p.subcategory || ''} ${p.category || ''} ${p.name || ''} ${p.model || ''}`.toLowerCase();
            const seed = this.pitchSeed(p);
            const brand = this.pitchBrand(p, seed >>> 6);
            const tail = brand ? ' ' + brand : '';
            const map = [
                { re: /tapis|mousepad/, v: ['Une surface idéale pour un glissement précis de la souris.', 'Confort et précision pour votre poste de travail.', 'Un accessoire simple qui améliore le confort au quotidien.'] },
                { re: /souris|mouse/, v: ['Souris ergonomique et précise, pour un confort d\'utilisation au quotidien.', 'Une souris réactive et fiable, prête à l\'emploi.', 'Précision et prise en main agréable pour tous vos usages.'] },
                { re: /clavier|keyboard/, v: ['Clavier confortable et durable, pensé pour une frappe agréable.', 'Une frappe précise et silencieuse, jour après jour.', 'Robuste et ergonomique, idéal pour un usage intensif.'] },
                { re: /casque|écouteur|ecouteur|audio|headset|micro/, v: ['Un son clair et immersif pour le travail comme pour le loisir.', 'Confort d\'écoute et bonne restitution audio au quotidien.', 'Idéal pour les appels, la musique et le multimédia.'] },
                { re: /écran|ecran|moniteur|monitor|dalle/, v: ['Un affichage net et confortable pour les yeux, idéal en bureautique.', 'Des couleurs fidèles et une image stable pour travailler sereinement.', 'Plus d\'espace de travail pour gagner en productivité.'] },
                { re: /disque|ssd|stockage|hdd|clé usb|cle usb|flash|externe/, v: ['Un stockage rapide et fiable pour vos données et sauvegardes.', 'De l\'espace supplémentaire, transportable partout avec vous.', 'Sécurisez et emportez vos fichiers en toute simplicité.'] },
                { re: /imprimante|scanner|printer/, v: ['Des impressions nettes et fiables pour le bureau ou la maison.', 'Un équipement pratique pour tous vos documents au quotidien.', 'Simple à utiliser, prêt à imprimer dès l\'installation.'] },
                { re: /onduleur|ups|batterie|chargeur|adaptateur|alimentation/, v: ['Protège vos appareils et assure une alimentation stable.', 'La tranquillité d\'esprit face aux coupures de courant.', 'Un accessoire essentiel pour préserver votre matériel.'] },
                { re: /sacoche|sac|housse|backpack/, v: ['Transportez et protégez votre ordinateur avec style.', 'Une protection au quotidien contre les chocs et rayures.', 'Pratique et robuste pour vos déplacements.'] },
                { re: /surveillance|vidéosurveillance|videosurveillance|caméra ip|camera ip|cctv|dôme|\bdome\b|bullet|\bnvr\b|\bdvr\b/, v: ['Une surveillance fiable pour sécuriser vos locaux jour et nuit.', 'Gardez un œil sur vos biens en toute tranquillité.', 'Une image nette au service de votre sécurité.'] },
                { re: /webcam|caméra|camera/, v: ['Une image nette pour vos visioconférences et appels.', 'Idéale pour le télétravail et les réunions à distance.', 'Installation simple et rendu professionnel.'] },
                { re: /câble|cable|hub|dock|répartiteur/, v: ['Une connectique fiable pour relier tous vos appareils.', 'Étendez les possibilités de connexion de votre poste.', 'Un accessoire pratique et durable au quotidien.'] },
                { re: /routeur|wifi|réseau|reseau|switch/, v: ['Une connexion stable et rapide pour toute la maison ou le bureau.', 'Améliorez votre couverture réseau en toute simplicité.', 'Fiabilité et débit pour un usage intensif d\'Internet.'] }
            ];
            for (const m of map) if (m.re.test(t)) return this.pick(m.v, seed) + tail;
            return this.pick([
                'Accessoire de qualité, sélectionné pour sa fiabilité.',
                'Un complément idéal pour votre équipement informatique.',
                'Produit fiable et pratique, prêt à l\'emploi.'
            ], seed) + tail;
        },
        buildPitch(p) {
            if (p.is_accessory) return this.pitchAccessory(p);
            const c = this.pitchConfig(p);
            const seed = this.pitchSeed(p);
            const tpl = this.pitchTpl[c.segment] || this.pitchTpl.office;
            const open = this.pick(tpl.open, seed)(c);
            const strengths = this.pitchStrengths(c, seed);
            const brand = this.pitchBrand(p, seed >>> 6);
            const close = this.pick(tpl.close, seed >>> 2);
            return `${open}${strengths} ${brand ? brand + ' ' : ''}${close}`.replace(/\s+/g, ' ').trim();
        }
};
