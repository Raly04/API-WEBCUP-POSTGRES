import { CookieOptions, Request, Response } from "express";
import { authConfig } from "../config/auth";
import sequelize from "../config/database";
import { AppointmentModel } from "../models/appointment.model";
import { AuthTokenModel } from "../models/authToken.model";
import { PermissionModel } from "../models/permission.model";
import { CITIZEN_ROLE, RbacModel } from "../models/rbac.model";
import { PublicUser, UserModel, UserUpdate } from "../models/user.model";
import { applyTwoFactorVerification, recordDeviceLogin, verifyTwoFactorCode } from "./accountSecurity.controller";
import { invalidateUser } from "../utils/accessCache";
import { audit } from "../utils/audit";
import { logger } from "../utils/logger";
import { maskEmail } from "../utils/mask";
import { DUMMY_HASH_PROMISE, hashPassword, verifyPassword } from "../utils/password";
import {
  generateRefreshToken,
  hashToken,
  refreshTokenExpiry,
  signAccessToken,
  signTwoFactorChallenge,
  verifyTwoFactorChallenge,
} from "../utils/token";

// Rôles choisissables à l'inscription : citoyen ou agent (l'inscription libre en agent est un choix de produit).
// Un compte agent voit des données de citoyens : c'est pourquoi ces données sont protégées autrement (champs
// personnels réduits, accès journalisés et visibles par le citoyen concerné, plafond de lecture par minute).
// ALLOW_AGENT_SELF_SIGNUP=false refuse l'inscription en agent : les agents sont alors nommés par un administrateur
// (POST /api/users/:id/roles). « admin » ne s'obtient jamais par auto-inscription.
const ALLOW_AGENT_SELF_SIGNUP = process.env.ALLOW_AGENT_SELF_SIGNUP !== "false";
const SELF_SIGNUP_ROLES = ALLOW_AGENT_SELF_SIGNUP ? [CITIZEN_ROLE, "agent"] : [CITIZEN_ROLE];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const refreshCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/api/auth",
};

function parseEmail(value: unknown): string | null {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return EMAIL_REGEX.test(email) && email.length <= 255 ? email : null;
}

function parsePassword(value: unknown): string | null {
  const password = typeof value === "string" ? value : "";
  // Plafond : évite d'envoyer des mots de passe géants au hachage
  return password.length >= 8 && password.length <= 128 ? password : null;
}

// Texte trimé et borné ; undefined si absent ou vide
function parseText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 ? text.slice(0, max) : undefined;
}

// Champ absent -> inchangé ; null ou "" -> effacé
function parseNullableText(value: unknown, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  return parseText(value, max) ?? null;
}

// Le refresh token est lu depuis le cookie httpOnly, ou depuis le body (Postman, mobile)
function readRefreshToken(req: Request): string | null {
  const token = req.cookies?.[authConfig.refreshCookieName] ?? req.body?.refreshToken;
  return typeof token === "string" && token.length > 0 ? token : null;
}

async function issueTokens(req: Request, res: Response, userId: number) {
  const accessToken = signAccessToken({ sub: userId });
  const refreshToken = generateRefreshToken();
  const expiresAt = refreshTokenExpiry();

  await AuthTokenModel.create({
    userId,
    tokenHash: hashToken(refreshToken),
    expiresAt,
    userAgent: req.headers["user-agent"]?.slice(0, 255),
    ipAddress: req.ip?.slice(0, 45),
  });
  res.cookie(authConfig.refreshCookieName, refreshToken, { ...refreshCookieOptions, expires: expiresAt });

  return { accessToken };
}

// Utilisateur + rôles + permissions : ce que le front utilise pour afficher les bonnes pages
async function withAccess(user: PublicUser) {
  const [roles, permissions] = await Promise.all([
    RbacModel.roleCodesForUser(user.id),
    PermissionModel.codesForUser(user.id),
  ]);
  return { ...user, roles, permissions };
}

export async function register(req: Request, res: Response) {
  const email = parseEmail(req.body?.email);
  if (!email) return res.status(400).json({ message: "Email invalide" });
  const password = parsePassword(req.body?.password);
  if (!password) return res.status(400).json({ message: "Le mot de passe doit contenir au moins 8 caractères" });
  const firstName = parseText(req.body?.firstName, 100);
  const lastName = parseText(req.body?.lastName, 100);
  if (!firstName || !lastName) return res.status(400).json({ message: "Prénom et nom requis" });

  const requestedRole = req.body?.role === undefined ? CITIZEN_ROLE : req.body.role;
  if (requestedRole === "agent" && !ALLOW_AGENT_SELF_SIGNUP) {
    // Tentative d'élévation de privilèges : tracée (le client légitime n'envoie plus jamais ce champ)
    void audit(req, "bot.role_escalation", { entityType: "register" });
    return res.status(403).json({
      code: "agent_signup_disabled",
      message: "Les comptes agent sont créés par un administrateur.",
    });
  }
  if (typeof requestedRole !== "string" || !SELF_SIGNUP_ROLES.includes(requestedRole)) {
    return res.status(400).json({ message: `Rôle invalide (${SELF_SIGNUP_ROLES.join(", ")})` });
  }

  // Indépendants : lancés ensemble. Le hachage (le plus lent) démarre aussi tout de suite.
  const [citizenRole, existing, passwordHash] = await Promise.all([
    RbacModel.findRoleByCode(requestedRole),
    UserModel.findByEmail(email),
    hashPassword(password),
  ]);
  if (!citizenRole) {
    logger.error("AUTH", `Rôle "${requestedRole}" absent de la table roles : exécuter le script d'insertion des rôles`);
    return res.status(500).json({ message: "Erreur serveur" });
  }
  if (existing) {
    return res.status(409).json({ message: "Cet email est déjà utilisé" });
  }

  // Utilisateur + rôle citoyen dans la même transaction : jamais de compte sans rôle
  const user = await sequelize.transaction(async (transaction) => {
    const created = await UserModel.create(
      {
        email,
        passwordHash,
        firstName,
        lastName,
        phone: parseText(req.body?.phone, 30),
        address: parseText(req.body?.address, 255),
      },
      transaction
    );
    await RbacModel.assignRole(created.id, citizenRole.id, null, transaction);
    return created;
  });

  void audit(req, "user.register", { userId: user.id, entityType: "users", entityId: user.id });
  // notify=false : le tout premier appareil d'un compte qui vient d'être créé n'a rien d'une alerte
  void recordDeviceLogin(req, user.id, false);
  const [tokens, access] = await Promise.all([issueTokens(req, res, user.id), withAccess(user)]);
  res.status(201).json({ user: access, ...tokens });
}

// Connexion complète : jetons, accès, horodatage, purge des sessions expirées, détection de nouvel
// appareil. Commun à une connexion directe (login) et à une connexion achevée après double
// authentification (loginTwoFactor) : le reste de la procédure ne dépend pas de la façon dont le
// mot de passe (et le cas échéant le code) ont été vérifiés.
async function completeLogin(req: Request, res: Response, user: PublicUser) {
  void audit(req, "login", { userId: user.id, entityType: "users", entityId: user.id });
  void recordDeviceLogin(req, user.id, true);
  const [tokens, access] = await Promise.all([
    issueTokens(req, res, user.id),
    withAccess(user),
    UserModel.touchLogin(user.id),
    AuthTokenModel.deleteExpiredForUser(user.id),
  ]);
  res.json({ user: access, ...tokens });
}

export async function login(req: Request, res: Response) {
  const email = parseEmail(req.body?.email);
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!email || !password) return res.status(400).json({ message: "Email et mot de passe requis" });

  const user = await UserModel.findByEmail(email);
  const valid = await verifyPassword(password, user?.passwordHash ?? (await DUMMY_HASH_PROMISE));
  if (!user || !valid) {
    logger.warn("AUTH", `Échec de connexion pour ${maskEmail(email)} (${user ? "mot de passe incorrect" : "email inconnu"})`);
    void audit(req, "login.failed", { userId: user?.id ?? null, entityType: "users", entityId: user?.id });
    return res.status(401).json({ message: "Identifiants incorrects" });
  }
  if (!user.isActive) {
    void audit(req, "login.blocked", { userId: user.id, entityType: "users", entityId: user.id });
    return res.status(403).json({ message: "Compte désactivé" });
  }

  const { passwordHash: _passwordHash, ...publicUser } = user;

  // Le mot de passe est le bon, mais ne suffit pas : un deuxième facteur est attendu avant
  // d'émettre des jetons. Le client repasse par POST /auth/login/2fa avec ce jeton + son code.
  if (user.twoFactorEnabled) {
    return res.json({ twoFactorRequired: true, challengeToken: signTwoFactorChallenge({ sub: user.id }) });
  }

  await completeLogin(req, res, publicUser);
}

// POST /api/auth/login/2fa { challengeToken, code } : achève une connexion dont le mot de passe a
// déjà été vérifié par login(), une fois le second facteur (TOTP ou code de secours) confirmé.
export async function loginTwoFactor(req: Request, res: Response) {
  const challengeToken = typeof req.body?.challengeToken === "string" ? req.body.challengeToken : "";
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  if (!challengeToken || !code) return res.status(400).json({ message: "Jeton et code requis" });

  let userId: number;
  try {
    ({ sub: userId } = verifyTwoFactorChallenge(challengeToken));
  } catch {
    return res.status(401).json({ message: "Jeton invalide ou expiré, reconnectez-vous" });
  }

  const user = await UserModel.findById(userId);
  if (!user || !user.isActive || !user.twoFactorEnabled) {
    return res.status(401).json({ message: "Connexion invalide, reconnectez-vous" });
  }

  const result = await verifyTwoFactorCode(user, code);
  if (!result.valid) {
    void audit(req, "login.failed", { userId: user.id, entityType: "users", entityId: user.id });
    return res.status(401).json({ message: "Code invalide" });
  }
  await applyTwoFactorVerification(user.id, result);

  const { passwordHash: _passwordHash, twoFactorSecret: _s, twoFactorRecoveryCodes: _r, twoFactorLastCounter: _c, ...publicUser } = user;
  await completeLogin(req, res, publicUser);
}

export async function refresh(req: Request, res: Response) {
  const token = readRefreshToken(req);
  if (!token) return res.status(401).json({ message: "Refresh token manquant" });

  const stored = await AuthTokenModel.findByHash(hashToken(token));
  if (!stored || stored.expiresAt < new Date()) {
    if (stored) await AuthTokenModel.consume(stored.id);
    res.clearCookie(authConfig.refreshCookieName, refreshCookieOptions);
    return res.status(401).json({ message: "Refresh token invalide ou expiré" });
  }

  // Rotation : le token est supprimé à l'usage. Si deux requêtes arrivent en même temps, une seule gagne.
  if (!(await AuthTokenModel.consume(stored.id))) {
    res.clearCookie(authConfig.refreshCookieName, refreshCookieOptions);
    return res.status(401).json({ message: "Refresh token déjà utilisé, veuillez vous reconnecter" });
  }

  const user = await UserModel.findPublicById(stored.userId);
  if (!user || !user.isActive) {
    res.clearCookie(authConfig.refreshCookieName, refreshCookieOptions);
    return res.status(401).json({ message: "Compte introuvable ou désactivé" });
  }

  const tokens = await issueTokens(req, res, user.id);
  res.json({ user: await withAccess(user), ...tokens });
}

export async function logout(req: Request, res: Response) {
  const token = readRefreshToken(req);
  if (token) await AuthTokenModel.deleteByHash(hashToken(token));
  res.clearCookie(authConfig.refreshCookieName, refreshCookieOptions);
  res.status(204).send();
}

export async function logoutAll(req: Request, res: Response) {
  await AuthTokenModel.deleteAllForUser(req.user!.sub);
  await audit(req, "logout.all", { entityType: "users", entityId: req.user!.sub });
  res.clearCookie(authConfig.refreshCookieName, refreshCookieOptions);
  res.status(204).send();
}

// L'accueil (modale de bienvenue) n'est proposé que tant que l'utilisateur a moins de 2 sessions ouvertes.
const WELCOME_MAX_SESSIONS = 2;

// GET /api/auth/me/welcome -> { showWelcome, sessionCount }
export async function welcomeStatus(req: Request, res: Response) {
  const sessionCount = await AuthTokenModel.countActiveForUser(req.user!.sub);
  res.json({ showWelcome: sessionCount < WELCOME_MAX_SESSIONS, sessionCount });
}

export async function me(req: Request, res: Response) {
  const user = await UserModel.findPublicById(req.user!.sub);
  if (!user) return res.status(404).json({ message: "Utilisateur introuvable" });
  res.json(await withAccess(user));
}

export async function updateProfile(req: Request, res: Response) {
  const userId = req.user!.sub;
  const data: UserUpdate = {};

  const firstName = parseNullableText(req.body?.firstName, 100);
  const lastName = parseNullableText(req.body?.lastName, 100);
  // Prénom et nom sont obligatoires en base : on ne peut pas les effacer
  if (firstName === null || lastName === null) {
    return res.status(400).json({ message: "Le prénom et le nom ne peuvent pas être vides" });
  }
  if (firstName !== undefined) data.firstName = firstName;
  if (lastName !== undefined) data.lastName = lastName;

  const phone = parseNullableText(req.body?.phone, 30);
  const address = parseNullableText(req.body?.address, 255);
  if (phone !== undefined) data.phone = phone;
  if (address !== undefined) data.address = address;

  if (req.body?.email !== undefined) {
    const email = parseEmail(req.body.email);
    if (!email) return res.status(400).json({ message: "Email invalide" });
    const existing = await UserModel.findByEmail(email);
    if (existing && existing.id !== userId) {
      return res.status(409).json({ message: "Cet email est déjà utilisé" });
    }
    data.email = email;
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ message: "Aucun champ à modifier (email, firstName, lastName, phone, address)" });
  }

  const user = await UserModel.update(userId, data);
  if (!user) return res.status(404).json({ message: "Utilisateur introuvable" });
  await audit(req, "profile.update", { entityType: "users", entityId: userId });
  res.json(await withAccess(user));
}

// DELETE /api/auth/me  { password }  : suppression définitive du compte et de ses données.
// Exiger le mot de passe actuel : un access token laissé en mémoire sur un poste partagé
// ne doit pas suffire à effacer un compte.
export async function deleteAccount(req: Request, res: Response) {
  const userId = req.user!.sub;
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!password) return res.status(400).json({ message: "Mot de passe actuel requis" });

  const user = await UserModel.findById(userId);
  if (!user) return res.status(404).json({ message: "Utilisateur introuvable" });
  if (!(await verifyPassword(password, user.passwordHash))) {
    logger.warn("AUTH", `Suppression de compte refusée pour ${maskEmail(user.email)} (mot de passe actuel incorrect)`);
    return res.status(401).json({ message: "Mot de passe actuel incorrect" });
  }

  // Un compte agent/admin ne se supprime pas depuis cet espace : appointments.agent_id est en
  // RESTRICT, et un administrateur doit rester administrable via /api/users.
  const roles = await RbacModel.roleCodesForUser(userId);
  if (roles.some((code) => code !== CITIZEN_ROLE)) {
    return res.status(403).json({ message: "Seul un compte citoyen peut être supprimé depuis cet espace" });
  }
  if ((await AppointmentModel.countAgentSlots(userId)) > 0) {
    return res.status(409).json({ message: "Des créneaux de rendez-vous vous sont encore attribués, contactez un administrateur" });
  }

  // Une seule transaction : l'email est unique, on ne veut pas qu'un compte subsiste sans
  // session si la suppression de la ligne échoue (l'utilisateur perdrait son accès).
  await sequelize.transaction(async (transaction) => {
    await AuthTokenModel.deleteAllForUser(userId, transaction);
    await RbacModel.removeAllRoles(userId, transaction);
    const deleted = await UserModel.remove(userId, transaction);
    if (!deleted) throw new Error("Utilisateur introuvable");
  });
  // L'utilisateur n'existe plus : sans invalidation, authenticate() servirait encore le
  // cache isActive=true pendant 30 s et accepterait un access token déjà expiré.
  invalidateUser(userId);
  await audit(req, "account.delete", { userId, entityType: "users", entityId: userId });
  res.clearCookie(authConfig.refreshCookieName, refreshCookieOptions);
  res.status(204).send();
}

export async function changePassword(req: Request, res: Response) {
  const currentPassword = typeof req.body?.currentPassword === "string" ? req.body.currentPassword : "";
  if (!currentPassword) return res.status(400).json({ message: "Mot de passe actuel requis" });
  const newPassword = parsePassword(req.body?.newPassword);
  if (!newPassword) {
    return res.status(400).json({ message: "Le nouveau mot de passe doit contenir au moins 8 caractères" });
  }

  const user = await UserModel.findById(req.user!.sub);
  if (!user) return res.status(404).json({ message: "Utilisateur introuvable" });
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    logger.warn("AUTH", `Changement de mot de passe refusé pour ${maskEmail(user.email)} (mot de passe actuel incorrect)`);
    return res.status(401).json({ message: "Mot de passe actuel incorrect" });
  }

  const publicUser = await UserModel.update(user.id, {
    passwordHash: await hashPassword(newPassword),
  });
  // Déconnecte toutes les autres sessions, puis renvoie de nouveaux tokens pour la session courante
  await AuthTokenModel.deleteAllForUser(user.id);
  await audit(req, "password.change", { entityType: "users", entityId: user.id });
  const tokens = await issueTokens(req, res, user.id);
  res.json({ user: await withAccess(publicUser!), ...tokens });
}
