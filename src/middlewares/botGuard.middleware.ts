import { NextFunction, Request, RequestHandler, Response } from "express";
import {
  BOT_MODE,
  BotReason,
  SignalOutcome,
  blockInfo,
  ipIsReliable,
  isAllowlisted,
  isHardReason,
  logBot,
  loginFailuresTooMany,
  noteBlockedRequest,
  recordSignal,
  submissionTooFast,
} from "../utils/botSignals";
import { audit } from "../utils/audit";
import { GuardedForm, releaseFormToken, verifyFormToken } from "../utils/formToken";

// Mode : voir BOT_MODE dans utils/botSignals.ts (monitor par défaut, on pour bloquer, off pour désactiver)
const MODE = BOT_MODE;

export const TOKEN_HEADER = "x-form-token";
export const HONEYPOT_HEADER = "x-form-hp";
// Champ piège : invisible pour un humain, un robot qui remplit tous les champs le remplit aussi.
// Son nom évite tout ce que l'autocomplétion des navigateurs sait deviner (email, nom, adresse, site...).
export const HONEYPOT_FIELD = "nickname_confirm";

const FAILED_CHECK = "La vérification du formulaire a échoué. Rechargez la page puis réessayez.";

type Detection = { reason: BotReason | "expired_token"; retryAfterMs?: number };

// Jeton consommé par une requête : permet de le rendre si la requête est refusée pour surcharge (503)
const consumedNonces = new WeakMap<Request, string>();

// Un 503 est émis AVANT toute écriture (file de hachage pleine, base saturée) et le front rejoue la requête avec le
// même jeton. S'il restait « consommé », ce rejeu serait refusé (jeton déjà utilisé) et compterait comme un signal.
function releaseTokenOnOverload(req: Request, res: Response) {
  if (!consumedNonces.has(req)) return;
  res.on("finish", () => {
    const nonce = consumedNonces.get(req);
    if (res.statusCode === 503 && nonce) releaseFormToken(nonce);
  });
}

function inspect(req: Request, form: GuardedForm): Detection | null {
  // Le champ piège voyage dans le corps (formulaire HTML classique) ou dans un en-tête (application JavaScript)
  const bodyValue = req.body && typeof req.body === "object" ? req.body[HONEYPOT_FIELD] : undefined;
  const headerValue = req.headers[HONEYPOT_HEADER];
  if (bodyValue !== undefined) delete req.body[HONEYPOT_FIELD]; // jamais transmis aux contrôleurs
  const trap = [bodyValue, headerValue].find((value) => typeof value === "string" && value.trim() !== "");
  if (trap !== undefined) return { reason: "honeypot" };

  const header = req.headers[TOKEN_HEADER];
  const verdict = verifyFormToken(Array.isArray(header) ? header[0] : header, form);
  if (verdict.ok) {
    consumedNonces.set(req, verdict.nonce);
    return null;
  }
  return verdict.reason === "too_fast"
    ? { reason: "too_fast", retryAfterMs: verdict.retryAfterMs }
    : { reason: verdict.reason };
}

function report(req: Request, form: GuardedForm, reason: BotReason, outcome: SignalOutcome) {
  const ip = req.ip ?? "inconnu";
  // Une fois l'IP bloquée, plus de ligne d'audit par tentative : un robot qui insiste ne doit pas remplir la base
  if (!outcome.alreadyBlocked) {
    void audit(req, `bot.${reason}`, { entityType: form });
    if (outcome.newlyBlocked) void audit(req, "bot.blocked", { entityType: form });
  }
  logBot(
    outcome.newlyBlocked
      ? `IP bloquée ${ip} (formulaire ${form}, dernier signal : ${reason})`
      : `Signal ${reason} sur le formulaire ${form} depuis ${ip}`,
    outcome.newlyBlocked
  );
}

function blocked(res: Response, seconds: number) {
  res.locals.skipAudit = true; // tentative d'un robot déjà identifié : comptée en mémoire, pas écrite en base
  res.set("Retry-After", String(seconds));
  return res.status(429).json({
    code: "bot_blocked",
    message: `Trop de tentatives suspectes depuis votre connexion. Réessayez dans ${Math.max(1, Math.ceil(seconds / 60))} minute(s).`,
    retryAfterSeconds: seconds,
  });
}

/**
 * Protège un formulaire contre l'envoi automatique, sans rien demander à l'humain :
 *   1. champ piège invisible rempli  -> robot ;
 *   2. jeton de formulaire absent, falsifié, rejoué ou envoyé trop vite -> requête postée sans passer par la page ;
 *   3. envois en rafale (plus que ce qu'une personne peut faire) ;
 *   4. connexion : trop d'échecs depuis la même IP, tous comptes confondus.
 * Chaque signal rapporte des points à l'adresse IP ; passé un seuil elle est bloquée quelques minutes (429).
 * À placer APRÈS authenticate/requirePermission pour que l'audit connaisse l'utilisateur.
 */
export function botGuard(form: GuardedForm): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (MODE === "off") return next();
    const ip = req.ip ?? "inconnu";
    if (isAllowlisted(ip)) return next();

    // Adresse non fiable : contrôles sans état seulement (jeton, champ piège), rien n'est retenu contre une adresse
    if (!ipIsReliable(req)) {
      const detection = inspect(req, form);
      if (detection && MODE === "on") {
        if (detection.reason === "too_fast") {
          return res.status(400).json({ code: "form_too_fast", message: "Un instant, vérification en cours…", retryAfterMs: detection.retryAfterMs });
        }
        return res.status(400).json({
          code: detection.reason === "honeypot" ? "form_check_failed" : "form_token_invalid",
          message: FAILED_CHECK,
        });
      }
      releaseTokenOnOverload(req, res);
      return next();
    }

    const block = blockInfo(ip);
    const blockedNow = block.seconds > 0;
    if (blockedNow) noteBlockedRequest();
    // Blocage dur (signal inhumain) : tout est refusé, sans même examiner la requête
    if (blockedNow && block.hard && MODE === "on") return blocked(res, block.seconds);

    const detection = inspect(req, form);
    if (detection && blockedNow && MODE === "on") {
      // Blocage souple : l'adresse est suspecte, mais une personne qui la partage (mairie, Wi-Fi public) passe avec
      // un formulaire en règle. Ici la requête ne l'est pas : refus immédiat, sans nouvelle ligne d'audit.
      // Un signal inhumain pendant un blocage souple le rend dur.
      if (detection.reason !== "expired_token" && isHardReason(detection.reason)) {
        recordSignal(ip, form, detection.reason);
      }
      return blocked(res, block.seconds);
    }
    if (detection) {
      // Un jeton périmé (page laissée ouverte des heures) est normal : on demande de recharger, sans pénalité
      if (detection.reason !== "expired_token") {
        report(req, form, detection.reason, recordSignal(ip, form, detection.reason));
      }
      if (MODE === "on") {
        if (detection.reason === "too_fast") {
          return res.status(400).json({
            code: "form_too_fast",
            message: "Un instant, vérification en cours…",
            retryAfterMs: detection.retryAfterMs,
          });
        }
        return res.status(400).json({
          code: detection.reason === "honeypot" ? "form_check_failed" : "form_token_invalid",
          message: FAILED_CHECK,
        });
      }
    } else if (form !== "login" && submissionTooFast(ip, form)) {
      report(req, form, "velocity", recordSignal(ip, form, "velocity"));
      if (MODE === "on") return blocked(res, blockInfo(ip).seconds || 60);
    }

    if (form === "login") {
      res.on("finish", () => {
        if (res.statusCode === 401 && loginFailuresTooMany(ip)) {
          report(req, form, "login_failures", recordSignal(ip, form, "login_failures"));
        }
      });
    }
    releaseTokenOnOverload(req, res);
    next();
  };
}
