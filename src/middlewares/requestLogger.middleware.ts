import { NextFunction, Request, Response } from "express";
import { logger } from "../utils/logger";

// LOG_REQUESTS : "all" (défaut en développement) journalise chaque requête ; "errors" (défaut en production)
// ne garde que les statuts >= 400 et les requêtes lentes. Une ligne de journal par requête à plusieurs
// centaines de requêtes par seconde coûte cher (écriture synchrone sur la sortie standard) et noie l'essentiel.
const MODE = (process.env.LOG_REQUESTS || (process.env.NODE_ENV === "production" ? "errors" : "all")).toLowerCase();
const SLOW_MS = Number(process.env.LOG_SLOW_MS) || 1000;

// Log de chaque requête une fois la réponse envoyée : méthode, URL, statut, durée, origine
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  if (MODE === "off") return next();
  const start = Date.now();
  res.on("finish", () => {
    if (MODE === "errors" && res.statusCode < 400 && Date.now() - start < SLOW_MS) return;
    const origin = req.headers.origin ? ` origin=${req.headers.origin}` : "";
    // Les paramètres d'adresse peuvent contenir une recherche (un nom, un e-mail) : jamais écrits dans les journaux
    const path = req.originalUrl.includes("?") ? `${req.originalUrl.split("?")[0]}?…` : req.originalUrl;
    const line = `${req.method} ${path} -> ${res.statusCode} (${Date.now() - start}ms)${origin}`;
    if (res.statusCode >= 500) logger.error("HTTP", line);
    else if (res.statusCode >= 400) logger.warn("HTTP", line);
    else logger.info("HTTP", line);
  });
  next();
}
