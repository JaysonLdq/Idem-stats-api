import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { prisma } from '../db/prisma.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../middleware/error.js';
import {
  ALLOWED_MIMES,
  AVATARS_DIR,
  MAX_BYTES,
  ensureAvatarsDir,
  extForMime,
  publicUrlForFilename,
} from '../lib/avatar-storage.js';

const router = Router();

// Multer en mémoire : pas de fichier temporaire (la requête fait ≤ 2 MB),
// on contrôle nous-mêmes le nommage avant d'écrire sur disque.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    if (!ALLOWED_MIMES.has(file.mimetype)) {
      cb(new HttpError(400, 'unsupported_image_type', 'bad_request'));
      return;
    }
    cb(null, true);
  },
});

router.get('/', requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { id: true, pseudo: true, avatarUrl: true, createdAt: true },
  });
  if (!user) throw new HttpError(401, 'user_gone', 'unauthorized');
  res.json(user);
});

// Upload d'un avatar. Le client envoie un multipart/form-data avec champ "file".
// Le fichier est sauvegardé sous /app/uploads/avatars/${userId}-${ts}.${ext} et
// l'URL relative est stockée dans user.avatarUrl. Pas de retouche d'image ici
// pour rester sans dépendance native (sharp/jimp viendront si besoin).
router.post('/avatar', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'missing_file', 'bad_request');
  await ensureAvatarsDir();
  const ext = extForMime(req.file.mimetype);
  const filename = `${req.userId}-${Date.now()}.${ext}`;
  const filepath = path.join(AVATARS_DIR, filename);
  await writeFile(filepath, req.file.buffer);
  const avatarUrl = publicUrlForFilename(filename);
  const user = await prisma.user.update({
    where: { id: req.userId },
    data: { avatarUrl },
    select: { id: true, pseudo: true, avatarUrl: true, createdAt: true },
  });
  res.json(user);
});

// Permet de revenir aux initiales (avatarUrl null).
router.delete('/avatar', requireAuth, async (req, res) => {
  const user = await prisma.user.update({
    where: { id: req.userId },
    data: { avatarUrl: null },
    select: { id: true, pseudo: true, avatarUrl: true, createdAt: true },
  });
  res.json(user);
});

export default router;
