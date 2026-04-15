/**
 * Image Storage — Supabase Storage
 * 
 * Variables d'environnement requises:
 *   SUPABASE_URL=https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY=eyJ...  (service_role key, pas anon)
 *   SUPABASE_BUCKET=stockflow-images  (créer ce bucket dans Supabase > Storage)
 */

const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = process.env.SUPABASE_BUCKET || 'stockflow-images';

/**
 * Upload un fichier Buffer vers Supabase Storage
 * @param {Buffer} buffer - contenu du fichier
 * @param {string} filename - nom de fichier unique
 * @param {string} mimetype - ex: 'image/jpeg'
 * @returns {string} URL publique de l'image
 */
async function uploadImage(buffer, filename, mimetype) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('SUPABASE_URL et SUPABASE_SERVICE_KEY requis dans .env');
  }

  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${filename}`;

  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': mimetype,
      'x-upsert': 'true',
    },
    body: buffer,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase Storage upload failed: ${err}`);
  }

  // URL publique
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${filename}`;
}

/**
 * Supprimer une image de Supabase Storage
 */
async function deleteImage(imageUrl) {
  if (!imageUrl || !SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    const filename = imageUrl.split(`/public/${BUCKET}/`)[1];
    if (!filename) return;
    await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${filename}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${SUPABASE_KEY}` },
    });
  } catch { /* silencieux */ }
}

/**
 * Vérifie si Supabase Storage est configuré
 */
function isStorageConfigured() {
  return !!(SUPABASE_URL && SUPABASE_KEY);
}

module.exports = { uploadImage, deleteImage, isStorageConfigured, BUCKET };
