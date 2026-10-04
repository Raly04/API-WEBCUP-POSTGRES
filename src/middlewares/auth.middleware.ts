import { NextFunction, Request, Response } from "express";
import { PermissionModel } from "../models/permission.model";
import { RbacModel } from "../models/rbac.model";
import { UserModel } from "../models/user.model";
import { Access, getCachedAccess, setCachedAccess } from "../utils/accessCache";
import { logger } from "../utils/logger";
import { verifyAccessToken } from "../utils/token";

// Compte actif + permissions + agent validé : cache mémoire, sinon requêtes en parallèle
async function loadAccess(userId: number): Promise<Access> {
  const cached = getCachedAccess(userId);
  if (cached) return cached;
  const [isActive, permissions] = await Promise.all([UserModel.isActive(userId), PermissionModel.codesForUser(userId)]);
  // Seul le personnel est concerné : un citoyen n'a pas de rôle agent à valider (pas de requête en plus pour lui)
  const isStaff = permissions.some((permission) => permission.startsWith("agent.") || permission.startsWith("admin."));
  const validatedStaff = isStaff ? await RbacModel.isValidatedStaff(userId) : true;
  const access = { isActive, permissions, validatedStaff };
  setCachedAccess(userId, access);
  return access;
}

// Vérifie le header "Authorization: Bearer <accessToken>" et expose req.user.
// Refuse aussi les comptes désactivés, même si leur access token n'a pas encore expiré.
export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Token d'accès manquant" });
  }
  let sub: number;
  try {
    ({ sub } = verifyAccessToken(header.slice(7)));
  } catch (err) {
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    logger.warn("AUTH", `Access token refusé sur ${req.method} ${req.originalUrl} (${reason})`);
    return res.status(401).json({ message: "Token d'accès invalide ou expiré" });
  }
  const access = await loadAccess(sub);
  if (!access.isActive) {
    return res.status(401).json({ message: "Compte introuvable ou désactivé" });
  }
  req.user = { sub, permissions: access.permissions, validatedStaff: access.validatedStaff };
  next();
}

// À utiliser après authenticate (tous les codes demandés sont requis) :
// router.get("/", authenticate, requirePermission("admin.users.manage"), handler)
export function requirePermission(...codes: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ message: "Non authentifié" });
    const granted = req.user.permissions ?? (await loadAccess(req.user.sub)).permissions;
    const missing = codes.filter((code) => !granted.includes(code));
    if (missing.length > 0) {
      logger.warn("AUTH", `Permission refusée (${missing.join(", ")}) à l'utilisateur ${req.user.sub} sur ${req.method} ${req.originalUrl}`);
      return res.status(403).json({ message: "Accès refusé" });
    }
    next();
  };
}
