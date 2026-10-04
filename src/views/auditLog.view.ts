import { isTechnicalAction, type AuditLogData } from "../models/auditLog.model";

export type AuditLogView = AuditLogData;

export function auditLogView(log: AuditLogView): AuditLogView {
  const { id, userId, action, entityType, entityId, ipAddress, createdAt, user } = log;
  return {
    id,
    userId,
    action,
    entityType,
    entityId,
    ipAddress,
    createdAt,
    user: user ? { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName } : null,
  };
}

// Vue console agent : l'auteur est nommé — un agent doit pouvoir dire qui a fait quoi — mais sur le
// modèle de agentRequestView, sans e-mail ni adresse IP, qui restent réservés à l'investigation admin.
// `technical` porte le classement des traces : le client l'affiche au lieu de le recalculer.
export type PlatformActivityView = Omit<AuditLogView, "ipAddress" | "user"> & {
  user: { id: number; firstName: string; lastName: string } | null;
  technical: boolean;
  // E-mail du compte visé quand entityType vaut "users" (sinon, ou compte supprimé : null)
  targetEmail: string | null;
};

export function platformActivityView(log: AuditLogView, targetEmail: string | null = null): PlatformActivityView {
  const { id, userId, action, entityType, entityId, createdAt, user } = log;
  return {
    id,
    userId,
    action,
    entityType,
    entityId,
    createdAt,
    user: user ? { id: user.id, firstName: user.firstName, lastName: user.lastName } : null,
    technical: isTechnicalAction(action),
    targetEmail,
  };
}
