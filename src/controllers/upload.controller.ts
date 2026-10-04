import { promises as fs } from "fs";
import { Request, Response } from "express";
import multer from "multer";
import { uploadProjectImage } from "../config/upload";

// Le type annoncé par le navigateur (« image/png ») est écrit par le client : un pirate y met ce qu'il veut. On lit donc
// les premiers octets du fichier pour vérifier qu'il s'agit réellement de ce format.
function detectImageType(head: Buffer): string | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  const text = head.toString("latin1");
  if (text.startsWith("GIF87a") || text.startsWith("GIF89a")) return "image/gif";
  if (head.length >= 12 && text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") return "image/webp";
  return null;
}

async function isGenuineImage(filePath: string, declared: string): Promise<boolean> {
  const handle = await fs.open(filePath, "r");
  try {
    const head = Buffer.alloc(16);
    const { bytesRead } = await handle.read(head, 0, 16, 0);
    return detectImageType(head.subarray(0, bytesRead)) === declared;
  } finally {
    await handle.close();
  }
}

// POST /api/uploads/project-image  (multipart/form-data, champ "image")
export function uploadProjectImageHandler(req: Request, res: Response) {
  uploadProjectImage(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      const message = err.code === "LIMIT_FILE_SIZE" ? "Image trop volumineuse (5 Mo maximum)" : "Fichier invalide";
      return res.status(400).json({ message });
    }
    if (err) return res.status(400).json({ message: "Fichier invalide" });
    if (!req.file) {
      return res.status(400).json({ message: "Image requise (jpeg, png, webp ou gif)" });
    }
    // Contenu qui n'est pas l'image annoncée (page HTML, script, exécutable déguisé) : supprimé, jamais servi
    if (!(await isGenuineImage(req.file.path, req.file.mimetype).catch(() => false))) {
      await fs.unlink(req.file.path).catch(() => undefined);
      return res.status(400).json({ message: "Le contenu du fichier ne correspond pas à une image valide" });
    }
    res.status(201).json({ url: `/uploads/projects/${req.file.filename}` });
  });
}
