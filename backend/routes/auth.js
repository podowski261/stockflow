const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { signToken, requireAuth, requireRole } = require('../middleware/auth');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Champs requis' });

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1 AND is_active = true', [username]
    );
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Identifiants incorrects' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Identifiants incorrects' });

    const token = signToken(user);
    res.json({
      token,
      user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// POST /api/auth/change-password (user lui-même ou admin)
router.post('/change-password', requireAuth, async (req, res) => {
  const { old_password, new_password, user_id } = req.body;

  try {
    // Admin peut changer le mdp de n'importe qui sans old_password
    if (req.user.role === 'admin' && user_id && user_id !== req.user.id) {
      const hash = await bcrypt.hash(new_password, 10);
      await pool.query('UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2', [hash, user_id]);
      return res.json({ success: true });
    }

    // Sinon vérifier l'ancien mdp
    const result = await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
    const valid = await bcrypt.compare(old_password, result.rows[0].password_hash);
    if (!valid) return res.status(400).json({ error: 'Ancien mot de passe incorrect' });

    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2', [hash, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
