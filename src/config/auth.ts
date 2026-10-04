import "dotenv/config";
import type { SignOptions } from "jsonwebtoken";

const accessSecret = process.env.JWT_ACCESS_SECRET;
if (!accessSecret) {
  throw new Error("JWT_ACCESS_SECRET manquant dans le .env");
}

// Le secret signe tous les jetons de connexion : qui le devine peut fabriquer un jeton d'administrateur.
// Générer : node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
const PLACEHOLDER = /^(secret|changeme|change[-_]?me|password|jwt[-_]?secret|your[-_]?secret|test|dev|default|example)/i;
if (accessSecret.length < 32 || PLACEHOLDER.test(accessSecret)) {
  const problem = `JWT_ACCESS_SECRET trop faible (${accessSecret.length} caractères, 32 aléatoires minimum) : un jeton d'administrateur peut être fabriqué`;
  // En production : refus de démarrer si le secret est manifestement un exemple ou très court
  if (process.env.NODE_ENV === "production" && (accessSecret.length < 16 || PLACEHOLDER.test(accessSecret))) {
    throw new Error(problem);
  }
  console.error(`[SECURITY] ${problem}`);
}

export const authConfig = {
  accessSecret,
  accessExpiresIn: (process.env.JWT_ACCESS_EXPIRES_IN || "15m") as SignOptions["expiresIn"],
  refreshExpiresDays: Number(process.env.REFRESH_TOKEN_EXPIRES_DAYS) || 7,
  refreshCookieName: "refreshToken",
};
