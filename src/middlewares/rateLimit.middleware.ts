import { RequestHandler } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import { audit } from "../utils/audit";

// Limitation de débit, désactivée par défaut : derrière un proxy, req.ip est l'adresse du proxy tant que
// TRUST_PROXY n'est pas réglé (voir app.ts), et tous les habitants partageraient alors le même quota.
// À activer en production, une fois TRUST_PROXY correct :
//   RATE_LIMIT_PER_MINUTE=600        requêtes par minute et par adresse IP, sur toute l'API
//   LOGIN_RATE_LIMIT_PER_15MIN=30    tentatives de connexion/inscription par 15 min et par IP
const passthrough: RequestHandler = (_req, _res, next) => next();

function positiveInt(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function limiter(limit: number, windowMs: number, message: string): RequestHandler {
  if (limit === 0) return passthrough;
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7", // RateLimit-* et Retry-After : le client sait quand réessayer
    legacyHeaders: false,
    message: { message },
  });
}

export const apiLimiter = limiter(
  positiveInt(process.env.RATE_LIMIT_PER_MINUTE),
  60_000,
  "Trop de requêtes, veuillez réessayer dans un instant"
);

export const authLimiter = limiter(
  positiveInt(process.env.LOGIN_RATE_LIMIT_PER_15MIN),
  15 * 60_000,
  "Trop de tentatives, veuillez réessayer plus tard"
);

// Orientation par modèle : beaucoup plus rare que le reste de l'API, et chaque appel consomme un
// quota externe. 10 par minute laisse un jury enchaîner plusieurs essais sans être bloqué.
export const guidanceLimiter = limiter(
  positiveInt(process.env.GUIDANCE_RATE_LIMIT_PER_MINUTE) || 10,
  60_000,
  "Trop de demandes d'orientation, veuillez patienter un instant"
);

// Écritures d'un citoyen connecté (déposer une demande, écrire aux services, laisser un avis) : au-delà de
// quelques envois en 10 minutes, c'est un script, pas une personne. Clé = compte, pas adresse IP : actif par
// défaut même derrière un proxy, et deux habitants du même réseau ne se gênent pas.
// WRITE_RATE_LIMIT_PER_10MIN=0 le désactive.
const writeLimit = process.env.WRITE_RATE_LIMIT_PER_10MIN === undefined ? 10 : positiveInt(process.env.WRITE_RATE_LIMIT_PER_10MIN);

export const writeLimiter: RequestHandler =
  writeLimit === 0
    ? passthrough
    : rateLimit({
        windowMs: 10 * 60_000,
        limit: writeLimit,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        keyGenerator: (req) => (req.user ? `user:${req.user.sub}` : ipKeyGenerator(req.ip ?? "")),
        handler: (req, res) => {
          void audit(req, "rate.limited", { entityType: "forms" });
          res.status(429).json({
            message: "Vous envoyez trop de demandes en peu de temps. Patientez quelques minutes avant de réessayer.",
            code: "RATE_LIMITED",
          });
        },
      });

// Brouillons d'alerte rédigés par l'IA : chaque appel consomme un quota externe. Clé = compte. AI_DRAFT_RATE_LIMIT_PER_MINUTE=0 le désactive.
const aiDraftLimit = process.env.AI_DRAFT_RATE_LIMIT_PER_MINUTE === undefined ? 10 : positiveInt(process.env.AI_DRAFT_RATE_LIMIT_PER_MINUTE);

export const aiDraftLimiter: RequestHandler =
  aiDraftLimit === 0
    ? passthrough
    : rateLimit({
        windowMs: 60_000,
        limit: aiDraftLimit,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        keyGenerator: (req) => (req.user ? `user:${req.user.sub}` : ipKeyGenerator(req.ip ?? "")),
        message: { message: "Trop de brouillons demandés, patientez une minute", code: "RATE_LIMITED" },
      });
