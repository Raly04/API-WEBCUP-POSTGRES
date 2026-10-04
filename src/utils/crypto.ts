import crypto from "crypto";
import { authConfig } from "../config/auth";

// Chiffrement au repos du secret TOTP (table users) : un accès en lecture seule à la base ne doit
// jamais suffire à produire les codes à la place du citoyen. Clé dérivée de JWT_ACCESS_SECRET (déjà
// validé au démarrage, voir config/auth.ts) via SHA-256, sauf si TWO_FACTOR_ENC_KEY est fourni : pas
// de nouvelle variable d'environnement obligatoire, mais une clé dédiée reste possible en production.
const key = crypto.createHash("sha256").update(process.env.TWO_FACTOR_ENC_KEY || `${authConfig.accessSecret}:2fa`).digest();

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

// Format stocké : iv:authTag:ciphertext, tout en hexadécimal
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptSecret(stored: string): string {
  const [ivHex, tagHex, dataHex] = stored.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("Secret 2FA chiffré invalide");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}
