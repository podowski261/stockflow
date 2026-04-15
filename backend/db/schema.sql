-- ╔══════════════════════════════════════════════════════╗
-- ║              STOCKFLOW — SCHÉMA BASE DE DONNÉES       ║
-- ╚══════════════════════════════════════════════════════╝

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── CONFIGURATION ENTREPRISE ───────────────────────────
CREATE TABLE IF NOT EXISTS company_config (
  id SERIAL PRIMARY KEY,
  name VARCHAR(200) NOT NULL DEFAULT 'StockFlow',
  logo_url TEXT,
  header_text TEXT,
  footer_text TEXT,
  address TEXT,
  phone VARCHAR(50),
  email VARCHAR(100),
  website VARCHAR(200),
  updated_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO company_config (name, header_text, footer_text)
VALUES ('Mon Entreprise', 'StockFlow — Gestion de Stock', 'Confidentiel — Document interne')
ON CONFLICT DO NOTHING;

-- ─── UTILISATEURS ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(100) NOT NULL,
  role VARCHAR(30) NOT NULL CHECK (role IN ('admin','atelier','boutique','garantie')),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Admin par défaut : admin / admin_26
-- Hash bcrypt de "admin_26"
INSERT INTO users (username, password_hash, full_name, role)
VALUES ('admin', '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lh8i', 'Administrateur', 'admin')
ON CONFLICT (username) DO NOTHING;

-- ─── FOURNISSEURS ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  contact VARCHAR(100),
  phone VARCHAR(50),
  email VARCHAR(100),
  address TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ─── PRODUITS ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  internal_sn VARCHAR(100) UNIQUE NOT NULL,   -- SN généré automatiquement
  real_sn VARCHAR(100),                        -- SN réel (optionnel)
  type VARCHAR(50) NOT NULL CHECK (type IN ('UC','Mini-UC','PC Tablette','Portable')),
  brand VARCHAR(50) NOT NULL,                  -- Marque
  model VARCHAR(100) NOT NULL,                 -- Modèle
  processor VARCHAR(100),
  ram VARCHAR(50),
  storage_size VARCHAR(50),
  storage_type VARCHAR(20) CHECK (storage_type IN ('HDD','SSD','eMMC','NVMe')),
  screen_size VARCHAR(20),
  condition VARCHAR(20) NOT NULL CHECK (condition IN ('sous_carton','occasion')),
  sale_price DECIMAL(15,2) DEFAULT 0,
  image_url TEXT,
  supplier_id INT REFERENCES suppliers(id),
  reception_date DATE NOT NULL,
  warranty_expiry DATE,
  warranty_duration VARCHAR(50),               -- ex: "3 mois", "1 mois"
  current_stock VARCHAR(30) NOT NULL DEFAULT 'atelier'
    CHECK (current_stock IN ('atelier','boutique','garantie','vendu','livre')),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ─── MOUVEMENTS DE STOCK ────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_movements (
  id SERIAL PRIMARY KEY,
  product_id INT NOT NULL REFERENCES products(id),
  from_stock VARCHAR(30),                      -- NULL si première entrée
  to_stock VARCHAR(30) NOT NULL,
  reason TEXT,                                 -- motif du mouvement
  problem_description TEXT,                    -- obligatoire si vers garantie
  performed_by INT REFERENCES users(id),
  performed_by_name VARCHAR(100),              -- snapshot du nom
  destination_detail TEXT,                     -- ex: nom du client, adresse installation
  created_at TIMESTAMP DEFAULT NOW()
);

-- ─── RÉCEPTIONS BOUTIQUE ────────────────────────────────
-- Confirmation de réception par la boutique
CREATE TABLE IF NOT EXISTS boutique_receptions (
  id SERIAL PRIMARY KEY,
  product_id INT NOT NULL REFERENCES products(id),
  received_by INT REFERENCES users(id),
  received_by_name VARCHAR(100),
  sent_by_name VARCHAR(100),                   -- nom de celui qui a envoyé depuis installation
  received_at TIMESTAMP DEFAULT NOW(),
  notes TEXT
);

-- ─── VENTES ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  product_id INT NOT NULL REFERENCES products(id),
  sold_by INT REFERENCES users(id),
  sold_by_name VARCHAR(100),
  sale_price DECIMAL(15,2),
  buyer_name VARCHAR(100),
  sale_type VARCHAR(20) DEFAULT 'vente' CHECK (sale_type IN ('vente','livraison')),
  sold_at TIMESTAMP DEFAULT NOW(),
  notes TEXT
);

-- ─── GARANTIES ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS warranty_records (
  id SERIAL PRIMARY KEY,
  product_id INT NOT NULL REFERENCES products(id),
  sent_by INT REFERENCES users(id),
  sent_by_name VARCHAR(100),
  sent_from_stock VARCHAR(30),                 -- depuis quel stock
  problem_description TEXT NOT NULL,
  sent_at TIMESTAMP DEFAULT NOW(),
  treated_at TIMESTAMP,
  treated_by INT REFERENCES users(id),
  treated_by_name VARCHAR(100),
  treatment_notes TEXT,
  returned_to_supplier BOOLEAN DEFAULT FALSE,
  status VARCHAR(20) DEFAULT 'en_attente' CHECK (status IN ('en_attente','en_cours','traitee','retour_fournisseur'))
);

-- ─── ÉTIQUETTES / SN COUNTER ────────────────────────────
CREATE TABLE IF NOT EXISTS sn_counters (
  id SERIAL PRIMARY KEY,
  year_month VARCHAR(8) NOT NULL,              -- ex: "1026" pour oct 2026
  supplier_code VARCHAR(10) NOT NULL,
  brand_code VARCHAR(10) NOT NULL,
  model_code VARCHAR(20) NOT NULL,
  last_count INT DEFAULT 0,
  UNIQUE(year_month, supplier_code, brand_code, model_code)
);

-- ─── SSE EVENTS (pour temps réel) ───────────────────────
CREATE TABLE IF NOT EXISTS sse_events (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ─── MIGRATION: Champs catalogue public ────────────────
-- (ALTER TABLE safe — ignoré si déjà existants)
DO $$ BEGIN
  BEGIN ALTER TABLE products ADD COLUMN IF NOT EXISTS catalogue_description TEXT; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE products ADD COLUMN IF NOT EXISTS catalogue_accessories TEXT; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE products ADD COLUMN IF NOT EXISTS catalogue_remarks TEXT; EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE products ADD COLUMN IF NOT EXISTS original_price DECIMAL(15,2); EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE products ADD COLUMN IF NOT EXISTS discount_pct DECIMAL(5,2); EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN ALTER TABLE products ADD COLUMN IF NOT EXISTS show_in_catalogue BOOLEAN DEFAULT TRUE; EXCEPTION WHEN OTHERS THEN NULL; END;
END $$;

-- ─── INDEX ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_products_current_stock ON products(current_stock);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand);
CREATE INDEX IF NOT EXISTS idx_products_supplier ON products(supplier_id);
CREATE INDEX IF NOT EXISTS idx_movements_product ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_movements_created ON stock_movements(created_at);
CREATE INDEX IF NOT EXISTS idx_sales_sold_at ON sales(sold_at);
CREATE INDEX IF NOT EXISTS idx_warranty_status ON warranty_records(status);

-- ─── NOTIFICATIONS ───────────────────────────────────
-- Générées automatiquement par le système (cron/check)
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  -- Types: 'warranty_expiring', 'warranty_expired', 'stale_product'
  product_id INT REFERENCES products(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  -- Rôles ciblés (JSON array): ["admin","atelier"] ou ["admin","boutique"]
  target_roles JSONB NOT NULL DEFAULT '["admin"]',
  is_read BOOLEAN DEFAULT FALSE,
  read_by JSONB DEFAULT '{}',   -- { "userId": "timestamp" }
  snoozed_until TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  -- Eviter les doublons: une seule notif active par produit+type
  UNIQUE(product_id, type)
);

CREATE INDEX IF NOT EXISTS idx_notif_product ON notifications(product_id);
CREATE INDEX IF NOT EXISTS idx_notif_type ON notifications(type);
CREATE INDEX IF NOT EXISTS idx_notif_read ON notifications(is_read);
