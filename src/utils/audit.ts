import { Request } from "express";
import { AuditLogModel } from "../models/auditLog.model";
import { logger } from "./logger";

// Écrit une ligne d'audit. Ne doit jamais faire échouer la requête : l'erreur est seulement loggée.
export async function audit(
  req: Request,
  action: string,
  options: { userId?: number | null; entityType?: string; entityId?: number } = {}
) {
  try {
    await AuditLogModel.create({
      userId: options.userId === undefined ? (req.user?.sub ?? null) : options.userId,
      action,
      entityType: options.entityType,
      entityId: options.entityId,
      ipAddress: req.ip?.slice(0, 45),
    });
  } catch (err) {
    logger.error("AUDIT", `Impossible d'écrire le log "${action}"`, err instanceof Error ? err.message : err);
  }
}
