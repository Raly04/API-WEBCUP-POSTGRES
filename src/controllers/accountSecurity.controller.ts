import { Request, Response } from "express";
import QRCode from "qrcode";
import { QueryTypes } from "sequelize";
import { authConfig } from "../config/auth";
import sequelize from "../config/database";
import { AuthTokenModel } from "../models/authToken.model";
import { KnownDeviceModel } from "../models/knownDevice.model";
import { NotificationModel, resolveLocale } from "../models/notification.model";
import { RbacModel } from "../models/rbac.model";
import { UserModel } from "../models/user.model";
import { audit } from "../utils/audit";
import { decryptSecret, encryptSecret } from "../utils/crypto";
import { parseId } from "../utils/http";
import { logger } from "../utils/logger";
import { describeDevice, maskIp } from "../utils/mask";
import { hashPassword, verifyPassword } from "../utils/password";
import { hashToken } from "../utils/token";
import { buildOtpauthUrl, generateBase32Secret, generateRecoveryCodes, verifyTotp } from "../utils/totp";

const ISSUER = "Terra Nova";

// Ce que l'utilisateur lui-même peut voir de la sécurité de son compte : où il est connecté, et ce qui s'est passé.
// Un compte piraté se remarque d'abord par une connexion inconnue ou des échecs répétés : on les lui montre.
const SECURITY_ACTIONS = [
  "user.register",
  "login",
  "login.failed",
  "login.blocked",
  "password.change",
  "profile.update",
  "logout.all",
  "session.revoke",
  "2fa.enabled",
  "2fa.disabled",
  "login.new_device",
];

// Qui, parmi le personnel, a ouvert une de MES données (une de mes demandes, un de mes messages, mon compte) :
// lu dans le journal d'audit, donc fiable (le personnel ne peut pas l'effacer). Seules les consultations de dossier
// précis sont visibles (pas les listes). Nécessite AUDIT_REQUESTS=all (valeur par défaut).
const RESOURCE_LABEL: Record<string, string> = {
  requests: "request",
  "contact-messages": "message",
  "citizen-accounts": "account",
  users: "account",
  signalements: "report",
};

async function staffAccessToMyData(userId: number) {
  const rows = await sequelize.query<{ at: Date; actorId: number; firstName: string; lastName: string; resource: string }>(
    `SELECT a.created_at AS at, a.user_id AS "actorId", u.first_name AS "firstName", u.last_name AS "lastName", a.entity_type AS resource
     FROM audit_logs a JOIN users u ON u.id = a.user_id
     WHERE a.user_id <> :userId AND a.action LIKE 'GET %' AND a.action LIKE '% 200'
       AND ( (a.entity_type = 'requests' AND a.entity_id IN (SELECT id FROM citizen_requests WHERE user_id = :userId))
          OR (a.entity_type = 'contact-messages' AND a.entity_id IN (SELECT id FROM contact_messages WHERE user_id = :userId))
          OR (a.entity_type = 'signalements' AND a.entity_id IN (SELECT id FROM signalements WHERE user_id = :userId))
          OR (a.entity_type IN ('citizen-accounts', 'users') AND a.entity_id = :userId) )
     ORDER BY a.id DESC LIMIT 20`,
    { replacements: { userId }, type: QueryTypes.SELECT }
  );
  const roles = await RbacModel.roleCodesForUsers([...new Set(rows.map((row) => Number(row.actorId)))]);
  return rows.map((row) => ({
    at: row.at,
    // « Awa D. » : de quoi reconnaître la personne, sans exposer son nom complet
    by: `${row.firstName} ${row.lastName.slice(0, 1)}.`,
    role: (roles[Number(row.actorId)] ?? []).includes("admin") ? "admin" : "agent",
    resource: RESOURCE_LABEL[row.resource] ?? "account",
  }));
}

// GET /api/auth/me/security
export async function securityOverview(req: Request, res: Response) {
  const userId = req.user!.sub;
  const cookie = req.cookies?.[authConfig.refreshCookieName];
  const currentHash = typeof cookie === "string" && cookie ? hashToken(cookie) : null;

  const [sessions, events, dataAccess] = await Promise.all([
    AuthTokenModel.listActiveForUser(userId),
    sequelize.query<{ action: string; ip: string | null; at: Date }>(
      `SELECT action, ip_address AS ip, created_at AS at FROM audit_logs
       WHERE user_id = :userId AND action IN (:actions) ORDER BY id DESC LIMIT 30`,
      { replacements: { userId, actions: SECURITY_ACTIONS }, type: QueryTypes.SELECT }
    ),
    staffAccessToMyData(userId),
  ]);

  res.json({
    sessions: sessions.map((session) => ({
      id: session.id,
      device: describeDevice(session.userAgent),
      // Dernière partie de l'adresse masquée : de quoi reconnaître son réseau sans l'exposer
      ip: maskIp(session.ipAddress),
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      expiresAt: session.expiresAt,
      current: currentHash !== null && session.tokenHash === currentHash,
    })),
    events: events.map((event) => ({ action: event.action, at: event.at, ip: maskIp(event.ip) })),
    dataAccess,
  });
}

// DELETE /api/auth/me/sessions/:id : ferme une de SES sessions (un appareil perdu, une connexion inconnue)
export async function revokeSession(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });

  // Le propriétaire fait partie de la condition : on ne peut pas fermer la session d'autrui, ni savoir qu'elle existe
  const revoked = await AuthTokenModel.deleteOwned(id, req.user!.sub);
  if (!revoked) return res.status(404).json({ message: "Session introuvable" });
  void audit(req, "session.revoke", { entityType: "auth_tokens", entityId: id });
  res.status(204).send();
}

// Appelée à chaque connexion réussie (mot de passe seul, ou après double authentification). Ne doit
// jamais faire échouer la connexion : comme audit(), les erreurs sont seulement journalisées.
// notify=false à l'inscription (le premier appareil d'un compte tout neuf n'a rien d'alarmant).
export async function recordDeviceLogin(req: Request, userId: number, notify: boolean): Promise<void> {
  try {
    const userAgent = req.headers["user-agent"];
    const { isNew } = await KnownDeviceModel.registerLogin(userId, userAgent, describeDevice(userAgent));
    if (isNew && notify) {
      const locale = resolveLocale(req.headers["accept-language"]);
      const at = new Date();
      await Promise.all([
        NotificationModel.notifyNewDeviceLogin(userId, { device: describeDevice(userAgent), ip: maskIp(req.ip), at }, locale),
        audit(req, "login.new_device", { userId, entityType: "users", entityId: userId }),
      ]);
    }
  } catch (err) {
    logger.error("SECURITY", "Échec de la détection de nouvel appareil", err instanceof Error ? err.message : err);
  }
}

// Un code TOTP valide (fenêtre ±30 s, jamais rejoué) OU un code de secours non encore consommé.
// Les deux protègent la même connexion, voir utils/totp.ts pour le détail des garanties.
export async function verifyTwoFactorCode(
  user: { twoFactorSecret: string | null; twoFactorLastCounter: number | null; twoFactorRecoveryCodes: string | null },
  code: string
): Promise<{ valid: boolean; counter?: number; remainingRecoveryCodes?: string }> {
  if (user.twoFactorSecret) {
    const { valid, counter } = verifyTotp(decryptSecret(user.twoFactorSecret), code, user.twoFactorLastCounter);
    if (valid) return { valid: true, counter };
  }
  if (user.twoFactorRecoveryCodes) {
    const hashes: string[] = JSON.parse(user.twoFactorRecoveryCodes);
    const candidate = code.trim().toUpperCase();
    for (let i = 0; i < hashes.length; i++) {
      // Séquentiel et non Promise.all : on s'arrête au premier code qui correspond, inutile de
      // hacher (coûteux, voir utils/password.ts) les candidats suivants.
      if (await verifyPassword(candidate, hashes[i])) {
        return { valid: true, remainingRecoveryCodes: JSON.stringify([...hashes.slice(0, i), ...hashes.slice(i + 1)]) };
      }
    }
  }
  return { valid: false };
}

// Applique le résultat d'une vérification réussie : mémorise le pas TOTP utilisé (anti-rejeu) ou
// retire le code de secours consommé, pour que l'un et l'autre ne servent plus une seconde fois.
export async function applyTwoFactorVerification(
  userId: number,
  result: { counter?: number; remainingRecoveryCodes?: string }
): Promise<void> {
  if (result.counter !== undefined) await UserModel.updateTwoFactorState(userId, { lastCounter: result.counter });
  if (result.remainingRecoveryCodes !== undefined) {
    await UserModel.updateTwoFactorState(userId, { recoveryCodes: result.remainingRecoveryCodes });
  }
}

// POST /api/auth/me/2fa/setup { password } -> { secret, otpauthUrl, qrCodeDataUrl }
// Démarre (ou recommence) une configuration ; rien n'est actif tant que twoFactorVerify n'a pas
// prouvé que le code généré par l'application d'authentification est le bon.
export async function twoFactorSetup(req: Request, res: Response) {
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!password) return res.status(400).json({ message: "Mot de passe actuel requis" });

  const user = await UserModel.findById(req.user!.sub);
  if (!user) return res.status(404).json({ message: "Utilisateur introuvable" });
  if (user.twoFactorEnabled) {
    return res.status(409).json({ message: "La double authentification est déjà activée. Désactivez-la avant de la reconfigurer." });
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).json({ message: "Mot de passe actuel incorrect" });
  }

  const secret = generateBase32Secret();
  await UserModel.setPendingTwoFactorSecret(user.id, encryptSecret(secret));
  const otpauthUrl = buildOtpauthUrl(secret, user.email, ISSUER);
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);
  res.json({ secret, otpauthUrl, qrCodeDataUrl });
}

// POST /api/auth/me/2fa/verify { code } -> { recoveryCodes }
// Confirme que le citoyen a bien enregistré le secret généré par twoFactorSetup, et active la
// double authentification. Les codes de secours ne sont montrés qu'à cet instant : à relire,
// pas à retrouver plus tard (seul leur hachage reste en base).
export async function twoFactorVerify(req: Request, res: Response) {
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  const user = await UserModel.findById(req.user!.sub);
  if (!user) return res.status(404).json({ message: "Utilisateur introuvable" });
  if (user.twoFactorEnabled) return res.status(409).json({ message: "La double authentification est déjà activée." });
  if (!user.twoFactorSecret) {
    return res.status(400).json({ message: "Aucune configuration en attente. Démarrez l'activation." });
  }

  const { valid, counter } = verifyTotp(decryptSecret(user.twoFactorSecret), code, null);
  if (!valid) return res.status(401).json({ message: "Code invalide" });

  const recoveryCodes = generateRecoveryCodes();
  const hashes = await Promise.all(recoveryCodes.map((recoveryCode) => hashPassword(recoveryCode)));
  await UserModel.enableTwoFactor(user.id, JSON.stringify(hashes), counter);
  await audit(req, "2fa.enabled", { entityType: "users", entityId: user.id });
  res.json({ recoveryCodes });
}

// POST /api/auth/me/2fa/disable { password, code } : code = TOTP ou code de secours
export async function twoFactorDisable(req: Request, res: Response) {
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  if (!password || !code) return res.status(400).json({ message: "Mot de passe et code requis" });

  const user = await UserModel.findById(req.user!.sub);
  if (!user) return res.status(404).json({ message: "Utilisateur introuvable" });
  if (!user.twoFactorEnabled) return res.status(400).json({ message: "La double authentification n'est pas activée." });
  if (!(await verifyPassword(password, user.passwordHash))) {
    return res.status(401).json({ message: "Mot de passe actuel incorrect" });
  }
  if (!(await verifyTwoFactorCode(user, code)).valid) return res.status(401).json({ message: "Code invalide" });

  await UserModel.disableTwoFactor(user.id);
  await audit(req, "2fa.disabled", { entityType: "users", entityId: user.id });
  res.status(204).send();
}
