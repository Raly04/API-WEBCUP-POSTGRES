import crypto from "crypto";
import jwt from "jsonwebtoken";
import { authConfig } from "../config/auth";

export interface AccessTokenPayload {
  sub: number;
}

// Le token ne contient que l'id : rôles et permissions sont relus en base à chaque requête protégée,
// donc un changement de rôle ou une désactivation prend effet immédiatement.
export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign({ sub: String(payload.sub) }, authConfig.accessSecret, {
    algorithm: "HS256",
    expiresIn: authConfig.accessExpiresIn,
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  // Algorithme imposé : on n'accepte jamais « none » ni un autre algorithme annoncé par le jeton lui-même
  const { sub } = jwt.verify(token, authConfig.accessSecret, { algorithms: ["HS256"] }) as { sub?: string };
  const id = Number(sub);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Subject invalide");
  return { sub: id };
}

// Jeton intermédiaire entre un mot de passe validé et une connexion complète, quand le compte a la
// double authentification activée : il ne prouve que "ce mot de passe est le bon", pas "cette personne
// est connectée" (pas de rôles/permissions dedans, durée de vie courte). Un jeton d'accès ne doit
// jamais être accepté ici (et réciproquement) : le claim "purpose" sépare les deux usages.
const TWO_FACTOR_CHALLENGE_EXPIRES_IN = "5m";

export function signTwoFactorChallenge(payload: AccessTokenPayload): string {
  return jwt.sign({ sub: String(payload.sub), purpose: "2fa" }, authConfig.accessSecret, {
    algorithm: "HS256",
    expiresIn: TWO_FACTOR_CHALLENGE_EXPIRES_IN,
  });
}

export function verifyTwoFactorChallenge(token: string): AccessTokenPayload {
  const { sub, purpose } = jwt.verify(token, authConfig.accessSecret, { algorithms: ["HS256"] }) as {
    sub?: string;
    purpose?: string;
  };
  if (purpose !== "2fa") throw new Error("Jeton invalide pour cet usage");
  const id = Number(sub);
  if (!Number.isInteger(id) || id <= 0) throw new Error("Subject invalide");
  return { sub: id };
}

// Le refresh token est une valeur opaque aléatoire : seul son hash SHA-256 est stocké en base
export function generateRefreshToken(): string {
  return crypto.randomBytes(48).toString("base64url");
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function refreshTokenExpiry(): Date {
  return new Date(Date.now() + authConfig.refreshExpiresDays * 24 * 60 * 60 * 1000);
}
