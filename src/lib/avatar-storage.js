// Stockage local sur disque des avatars uploadés. Volume monté côté docker-compose.
// Pour passer à S3 / R2 plus tard : remplacer ce module, garder la même surface.

import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// /app/src/lib → ../../uploads = /app/uploads (côté conteneur)
export const UPLOAD_ROOT = path.resolve(__dirname, '..', '..', 'uploads');
export const AVATARS_DIR = path.join(UPLOAD_ROOT, 'avatars');
// Préfixe URL servi par express.static — ne pas changer sans modifier app.js.
export const AVATAR_URL_PREFIX = '/uploads/avatars';

export const ALLOWED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
// Pas de plafond strict côté serveur. On garde une variable pour la cohérence
// d'API (le route Multer s'en sert), mais on la met à une valeur très haute
// pour ne pas refuser l'upload. Si tu veux durcir : surcharge via AVATAR_MAX_BYTES
// dans l'env (utile en prod pour éviter qu'un utilisateur balance un fichier de 5 Go).
export const MAX_BYTES = Number(process.env.AVATAR_MAX_BYTES) || Number.MAX_SAFE_INTEGER;

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function extForMime(mime) {
  return EXT_BY_MIME[mime] || 'bin';
}

export async function ensureAvatarsDir() {
  await mkdir(AVATARS_DIR, { recursive: true });
}

export function publicUrlForFilename(filename) {
  return `${AVATAR_URL_PREFIX}/${filename}`;
}
