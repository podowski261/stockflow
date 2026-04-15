const jwt = require('jsonwebtoken');
const { pool } = require('../db');

const SECRET = process.env.JWT_SECRET || 'stockflow_secret_change_in_prod';

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, full_name: user.full_name },
    SECRET,
    { expiresIn: '12h' }
  );
}

function requireAuth(req, res, next) {
  // Accepte le token soit dans Authorization header, soit dans ?token= (pour window.open / PDF)
  const auth = req.headers.authorization;
  const queryToken = req.query.token;
  const raw = auth?.startsWith('Bearer ') ? auth.slice(7) : queryToken;

  if (!raw) {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  try {
    req.user = jwt.verify(raw, SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Non authentifié' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    next();
  };
}

module.exports = { signToken, requireAuth, requireRole, SECRET };
