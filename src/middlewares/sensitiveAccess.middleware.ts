import { NextFunction, Request, Response } from "express";
import { audit } from "../utils/audit";
import { READ_LIMIT_UNVALIDATED, READ_LIMIT_VALIDATED, isUnvalidatedAgent } from "../utils/staffAccess";

// Plafond de consultations de dossiers de citoyens, par compte du personnel. Un agent qui traite des demandes en
// consulte quelques-unes à la minute ; en lire des centaines, c'est copier la base. Le plafond ne gêne donc pas le
// travail normal, il rend l'aspiration de données lente, bruyante et visible (ligne d'audit `security.bulk_access`).
const WINDOW_MS = 60_000;
const hits = new Map<number, { count: number; resetAt: number; audited: boolean }>();

setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of hits) if (entry.resetAt <= now) hits.delete(userId);
}, WINDOW_MS).unref();

// Permissions qui ouvrent des données de citoyens : seuls ces comptes sont comptés (un citoyen qui lit SES données
// via la même route n'est jamais limité par ceci)
const STAFF_DATA_PERMISSIONS = ["agent.messages.manage", "agent.requests.view", "agent.citizens.manage", "agent.signalements.view"];

export function sensitiveReadLimit(req: Request, res: Response, next: NextFunction) {
  if (req.method !== "GET" || !req.user) return next();
  if (!req.user.permissions?.some((permission) => STAFF_DATA_PERMISSIONS.includes(permission))) return next();

  const now = Date.now();
  let entry = hits.get(req.user.sub);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + WINDOW_MS, audited: false };
    hits.set(req.user.sub, entry);
  }
  entry.count++;

  const limit = isUnvalidatedAgent(req) ? READ_LIMIT_UNVALIDATED : READ_LIMIT_VALIDATED;
  if (entry.count <= limit) return next();

  const wait = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  // Une seule ligne d'audit par fenêtre : la trace existe, sans que l'insistance remplisse la table
  if (!entry.audited) {
    entry.audited = true;
    void audit(req, "security.bulk_access", { entityType: "personal_data" });
  }
  res.locals.skipAudit = true;
  res.set("Retry-After", String(wait));
  return res.status(429).json({
    code: "sensitive_rate_limited",
    message: "Trop de consultations de dossiers en peu de temps. Patientez un instant.",
    retryAfterSeconds: wait,
  });
}
