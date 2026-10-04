import { randomUUID } from "crypto";
import { mkdirSync } from "fs";
import path from "path";
import multer from "multer";

export const UPLOADS_DIR = path.join(__dirname, "..", "..", "uploads");
const PROJECTS_DIR = path.join(UPLOADS_DIR, "projects");

// Créé au démarrage : multer n'écrit jamais dans un dossier qui n'existe pas encore
mkdirSync(PROJECTS_DIR, { recursive: true });

const ALLOWED_MIME_TYPES: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const storage = multer.diskStorage({
  destination: PROJECTS_DIR,
  filename(_req, file, callback) {
    const extension = ALLOWED_MIME_TYPES[file.mimetype] ?? path.extname(file.originalname);
    callback(null, `${randomUUID()}${extension}`);
  },
});

export const uploadProjectImage = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(_req, file, callback) {
    callback(null, file.mimetype in ALLOWED_MIME_TYPES);
  },
}).single("image");
