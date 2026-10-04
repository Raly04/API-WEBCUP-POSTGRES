import { Request, Response } from "express";
import { Op } from "sequelize";
import { AuditLogModel } from "../models/auditLog.model";
import { User } from "../models/user.model";
import { parseId, parsePagination } from "../utils/http";
import { auditLogView, platformActivityView } from "../views/auditLog.view";

// GET /api/audit-logs?userId=&action=&entityType=&entityId=&page=&limit=
// entityType + entityId : tout ce qui a touché un dossier précis (« qui a consulté le compte n° 12 ? »)
export async function listAuditLogs(req: Request, res: Response) {
  const { page, limit, offset } = parsePagination(req);
  const userId = req.query.userId !== undefined ? (parseId(req.query.userId) ?? undefined) : undefined;
  const action = typeof req.query.action === "string" && req.query.action ? req.query.action.slice(0, 100) : undefined;
  const entityType = typeof req.query.entityType === "string" && req.query.entityType ? req.query.entityType.slice(0, 100) : undefined;
  const entityId = req.query.entityId !== undefined ? (parseId(req.query.entityId) ?? undefined) : undefined;
  const { logs, total } = await AuditLogModel.list({ limit, offset, userId, action, entityType, entityId });
  res.json({ logs: logs.map(auditLogView), page, limit, total });
}

// Permission qui ouvre le journal complet sur GET /api/audit-logs ; c'est donc elle qui distingue
// l'administration d'un simple agent, req.user ne portant que l'id et les permissions.
const FULL_AUDIT_PERMISSION = "admin.users.manage";

// GET /api/audit-logs/activity?action=&technical=&page=&limit= — flux d'activité de la console agent,
// sans IP (contrairement à listAuditLogs, réservé aux admins).
// Un agent ne justifie que ses propres opérations : le userId est imposé par le serveur et jamais
// lu dans la requête, donc un client ne peut pas élargir sa fenêtre en forgeant le paramètre.
// Par défaut seules les décisions métier sont renvoyées : 9 traces de navigation sur 10 dans ce
// journal rendent l'historique illisible. ?technical=include les réintroduit.
export async function listPlatformActivity(req: Request, res: Response) {
  const { page, limit, offset } = parsePagination(req);
  const action = typeof req.query.action === "string" && req.query.action ? req.query.action.slice(0, 100) : undefined;
  const technical = req.query.technical === "include" ? "include" : "exclude";
  const isAdminViewer = req.user?.permissions?.includes(FULL_AUDIT_PERMISSION) === true;
  const userId = isAdminViewer ? undefined : req.user!.sub;
  const { logs, total } = await AuditLogModel.list({ limit, offset, action, userId, technical });
  // Colonne « dossier » : quand l'opération vise un compte, on affiche son e-mail plutôt qu'un numéro.
  // Une seule requête pour toute la page. Le journal d'un agent ne contient que ses propres opérations.
  const targetIds = [...new Set(logs.filter((log) => log.entityType === "users" && log.entityId).map((log) => log.entityId as number))];
  const targets = targetIds.length
    ? await User.findAll({ where: { id: { [Op.in]: targetIds } }, attributes: ["id", "email"] })
    : [];
  const emailById = new Map(targets.map((target) => [Number(target.id), target.email]));

  res.json({
    logs: logs.map((log) => platformActivityView(log, log.entityType === "users" ? (emailById.get(Number(log.entityId)) ?? null) : null)),
    page,
    limit,
    total,
  });
}
