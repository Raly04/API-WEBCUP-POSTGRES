import { NextFunction, Request, Response } from "express";
import { enqueueAudit } from "../utils/auditQueue";

// AUDIT_REQUESTS : "all" (défaut) = toutes les requêtes ; "writes" = POST/PUT/PATCH/DELETE et refus 401/403 ; "off" = désactivé
type AuditMode = "all" | "writes" | "off";
const rawMode = (process.env.AUDIT_REQUESTS || "all").toLowerCase();
const MODE: AuditMode = rawMode === "off" || rawMode === "writes" ? rawMode : "all";

const IGNORED_PATHS = new Set(["/api/health", "/api/health/ready", "/api/forms/token"]);
const MAX_ACTION_LENGTH = 100; // taille de la colonne audit_logs.action

// /api/roles/12/permissions/citizen.home.view -> segments, avec l'id numérique remplacé par ":id" pour garder
// peu de valeurs distinctes (filtrable) et ne jamais stocker de données variables ou sensibles.
function describePath(originalUrl: string) {
  const path = originalUrl.split("?")[0]; // jamais la query string : elle peut contenir des recherches de l'utilisateur
  const segments = path.split("/").filter(Boolean);
  const entityType = segments[0] === "api" ? segments[1] : segments[0];
  const idSegment = segments.find((segment, index) => index > 1 && /^\d+$/.test(segment));
  return {
    pattern: "/" + segments.map((segment) => (/^\d+$/.test(segment) ? ":id" : segment)).join("/"),
    entityType: entityType?.slice(0, 100),
    entityId: idSegment ? Number(idSegment) : undefined,
  };
}

// Enregistre chaque requête (qui, quoi, résultat, IP) une fois la réponse envoyée.
// Complète les audit() des contrôleurs, qui consignent des événements métier précis (login, role.assign...) :
// les lignes de ce middleware ont une action de la forme "METHOD /chemin statut".
export function auditRequests(req: Request, res: Response, next: NextFunction) {
  if (MODE === "off" || req.method === "OPTIONS") return next();

  const startedAt = new Date();
  res.on("finish", () => {
    const path = req.originalUrl.split("?")[0];
    if (IGNORED_PATHS.has(path)) return;
    // Tentative d'un robot déjà identifié (429 bot_blocked) : comptée en mémoire, jamais écrite en base,
    // pour qu'un robot qui insiste ne puisse pas remplir la table d'audit
    if (res.locals.skipAudit) return;

    const { statusCode } = res;
    const denied = statusCode === 401 || statusCode === 403;
    if (MODE === "writes" && req.method === "GET" && !denied) return;

    // Un 404 sans utilisateur identifié est du bruit (robots, scanners) : pas d'audit
    if (statusCode === 404 && !req.user) return;

    const { pattern, entityType, entityId } = describePath(req.originalUrl);
    const action = `${req.method} ${pattern} ${statusCode}`;
    enqueueAudit({
      // Posé par authenticate ; absent pour les routes publiques et les requêtes refusées avant authentification
      userId: req.user?.sub ?? null,
      action: action.length > MAX_ACTION_LENGTH ? action.slice(0, MAX_ACTION_LENGTH - 1) + "…" : action,
      entityType,
      entityId,
      ipAddress: req.ip?.slice(0, 45),
      createdAt: startedAt,
    });
  });
  next();
}
