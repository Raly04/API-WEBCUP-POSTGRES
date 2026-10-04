import crypto from "crypto";
import { authConfig } from "../config/auth";

// Jeton de formulaire : preuve qu'un formulaire a été réellement chargé puis rempli, pas posté en direct sur l'API.
//  - signé (HMAC) : impossible à fabriquer sans le secret du serveur ;
//  - lié à UN formulaire : un jeton d'inscription ne sert pas à poster un message de contact ;
//  - délai minimal : un robot poste en quelques millisecondes, un humain met plusieurs secondes à remplir ;
//  - à usage unique : un jeton ne peut pas être rejoué des milliers de fois.
// Il n'identifie personne et n'est pas un secret : le client le demande à chaque affichage de formulaire.

export const GUARDED_FORMS = [
  "register",
  "login",
  "contact",
  "request",
  "appointment",
  "review",
  "comment",
  "partner_request",
] as const;
export type GuardedForm = (typeof GUARDED_FORMS)[number];

export function isGuardedForm(value: unknown): value is GuardedForm {
  return (GUARDED_FORMS as readonly unknown[]).includes(value);
}

// Délai minimal entre l'affichage du formulaire et son envoi. Court pour la connexion (un gestionnaire de mots
// de passe remplit et valide en moins d'une seconde), plus long pour les formulaires qu'on rédige à la main.
export const MIN_AGE_MS: Record<GuardedForm, number> = {
  register: 3000,
  login: 700,
  contact: 3000,
  request: 3000,
  appointment: 1500,
  review: 2500,
  comment: 2000,
  partner_request: 2500,
};

const MAX_AGE_MS = 2 * 60 * 60 * 1000; // une page restée ouverte plus de 2 h doit être rechargée
const MAX_USED = 200_000; // garde-fou mémoire

// Clé distincte de celle des JWT : même racine, usage différent, donc un jeton ne peut jamais servir de JWT
const KEY = crypto.createHmac("sha256", authConfig.accessSecret).update("form-token-v1").digest();

const sign = (payload: string) => crypto.createHmac("sha256", KEY).update(payload).digest("base64url");

export function issueFormToken(form: GuardedForm): { token: string; minDelayMs: number; expiresInMs: number } {
  const payload = `${form}.${Date.now()}.${crypto.randomBytes(12).toString("base64url")}`;
  return { token: `${payload}.${sign(payload)}`, minDelayMs: MIN_AGE_MS[form], expiresInMs: MAX_AGE_MS };
}

export type TokenVerdict =
  | { ok: true; nonce: string }
  | { ok: false; reason: "missing_token" | "bad_token" | "expired_token" | "reused_token" }
  // Trop rapide : le jeton n'est PAS consommé, le client peut le rejouer après `retryAfterMs`
  | { ok: false; reason: "too_fast"; retryAfterMs: number };

const used = new Map<string, number>(); // nonce -> date d'expiration
setInterval(() => {
  const now = Date.now();
  for (const [nonce, expiresAt] of used) if (expiresAt <= now) used.delete(nonce);
}, 60_000).unref();

export function verifyFormToken(token: unknown, form: GuardedForm): TokenVerdict {
  if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "missing_token" };
  if (token.length > 200) return { ok: false, reason: "bad_token" };

  const cut = token.lastIndexOf(".");
  if (cut < 1) return { ok: false, reason: "bad_token" };
  const payload = token.slice(0, cut);
  const given = Buffer.from(token.slice(cut + 1));
  const expected = Buffer.from(sign(payload));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return { ok: false, reason: "bad_token" };

  const [tokenForm, issuedAt, nonce] = payload.split(".");
  const age = Date.now() - Number(issuedAt);
  if (tokenForm !== form || !nonce || !Number.isFinite(age)) return { ok: false, reason: "bad_token" };
  if (age < MIN_AGE_MS[form]) return { ok: false, reason: "too_fast", retryAfterMs: MIN_AGE_MS[form] - age + 100 };
  if (age > MAX_AGE_MS) return { ok: false, reason: "expired_token" };
  if (used.has(nonce)) return { ok: false, reason: "reused_token" };

  if (used.size >= MAX_USED) used.clear(); // jamais de croissance illimitée ; au pire quelques rejeux possibles
  used.set(nonce, Date.now() + MAX_AGE_MS);
  return { ok: true, nonce };
}

// Rend un jeton utilisable à nouveau. Réservé au cas où le serveur a refusé la requête pour cause de surcharge
// (503), AVANT toute écriture : le client rejoue alors la même requête avec le même jeton, sans pénalité.
export function releaseFormToken(nonce: string) {
  used.delete(nonce);
}
