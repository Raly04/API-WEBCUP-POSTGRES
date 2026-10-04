import { NextFunction, Request, Response } from "express";
import { describeError } from "../utils/describeError";
import { OverloadedError } from "../utils/overload";
import { logger } from "../utils/logger";

// Base momentanément injoignable ou saturée (pool de connexions épuisé, trop de connexions
// PostgreSQL...) : c'est un état passager, pas un bug. On répond 503 pour que le client réessaie,
// au lieu d'un 500 opaque.
// Codes réseau : ceux de Node, plus ceux du pilote pg (53300 too_many_connections,
// 08006 connection_failure, 08003 cannot_connect_now, 57P01 admin_shutdown).
function isDatabaseUnavailable(err: any): boolean {
  const text = `${err?.name} ${err?.parent?.code ?? err?.original?.code ?? err?.code ?? ""}`;
  return /ConnectionAcquireTimeout|ConnectionRefused|ConnectionTimedOut|ConnectionError|PROTOCOL_CONNECTION_LOST|ECONNREFUSED|ETIMEDOUT|53300|08006|08003|08001|57P01|57P02|57P03/i.test(text);
}

// Un journal par seconde au plus : une rafale de refus ne doit pas noyer les logs ni coûter plus que le refus lui-même
let lastShedLog = 0;
function logShed(where: string, reason: string) {
  const now = Date.now();
  if (now - lastShedLog < 1000) return;
  lastShedLog = now;
  logger.warn("LOAD", `Requête différée (503) sur ${where} : ${reason}`);
}

export function notFound(req: Request, res: Response) {
  res.status(404).json({ message: `Route introuvable : ${req.method} ${req.originalUrl}` });
}

// Gestionnaire d'erreurs global : Express 5 y envoie aussi les erreurs des contrôleurs async
export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  const where = `${req.method} ${req.originalUrl}`;

  // Body JSON mal formé (express.json)
  if (err?.type === "entity.parse.failed") {
    logger.warn("REQUEST", `JSON invalide sur ${where} : ${err.message}`);
    return res.status(400).json({ message: "Corps de requête JSON invalide" });
  }
  if (err?.type === "entity.too.large") {
    logger.warn("REQUEST", `Corps trop volumineux sur ${where}`);
    return res.status(413).json({ message: "Corps de requête trop volumineux" });
  }

  if (err instanceof OverloadedError) {
    logShed(where, "file d'attente du hachage pleine ou délai dépassé");
    res.set("Retry-After", String(err.retryAfterSeconds));
    return res.status(503).json({ message: err.message, retryAfterSeconds: err.retryAfterSeconds });
  }
  if (isDatabaseUnavailable(err)) {
    logShed(where, "base de données indisponible ou saturée");
    res.set("Retry-After", "3");
    return res
      .status(503)
      .json({ message: "Service momentanément indisponible, réessayez dans quelques secondes", retryAfterSeconds: 3 });
  }

  // Contrainte d'unicité (ex : deux inscriptions simultanées avec le même email)
  if (err?.name === "SequelizeUniqueConstraintError") {
    logger.warn("DB", `Doublon sur ${where}`, err.fields);
    return res.status(409).json({ message: "Cette valeur existe déjà" });
  }

  const { summary, hint, detail, known } = describeError(err);
  logger.error("SERVER", `${where} -> ${summary}${hint ? `\n  Piste : ${hint}` : ""}\n  Détail : ${detail}`);
  // Stack complète uniquement pour les erreurs non reconnues
  if (!known && err?.stack) console.error(err.stack);

  if (res.headersSent) return;
  // EXPOSE_ERRORS=true : renvoie la cause au client pour déboguer un déploiement. Ne pas laisser activé.
  if (process.env.EXPOSE_ERRORS === "true") {
    return res.status(500).json({ message: `Erreur serveur ${summary} et detail ${detail}`, error: summary, hint, detail });
  }
  res.status(500).json({ message: "Erreur serveur" });
}
