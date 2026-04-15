require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDB } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── MIDDLEWARES ─────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ─── STATIC FILES ────────────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));
app.use(express.static(path.join(__dirname, '../frontend/dist')));

// ─── API ROUTES ──────────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/products', require('./routes/products'));
app.use('/api', require('./routes/api'));
app.use('/api/public', require('./routes/public'));

// ─── SPA FALLBACK ────────────────────────────────────────
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Route non trouvée' });
  }
  res.sendFile(path.join(__dirname, '../frontend/dist/index.html'));
});

// ─── ERROR HANDLER ───────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Erreur non gérée:', err);
  res.status(500).json({ error: 'Erreur interne du serveur' });
});

// ─── START ───────────────────────────────────────────────
async function start() {
  try {
    await initDB();
    // Démarrer le checker de notifications
    const { startNotificationChecker } = require('./utils/notificationChecker');
    startNotificationChecker();

    app.listen(PORT, () => {
      console.log(`🚀 StockFlow démarré sur le port ${PORT}`);
      console.log(`   Mode: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (err) {
    console.error('Erreur au démarrage:', err);
    process.exit(1);
  }
}

start();
