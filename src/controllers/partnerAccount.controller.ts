import { Request, Response } from "express";
import sequelize from "../config/database";
import { AuthTokenModel } from "../models/authToken.model";
import { RbacModel } from "../models/rbac.model";
import { UserModel } from "../models/user.model";
import { audit } from "../utils/audit";
import { invalidateUser } from "../utils/accessCache";
import { parseId, parsePagination } from "../utils/http";
import { hashPassword } from "../utils/password";
import { userListView, userView } from "../views/user.view";

const PARTNER_ROLE = "partner";
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseEmail(value: unknown): string | null {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return EMAIL_REGEX.test(email) && email.length <= 255 ? email : null;
}

function parsePassword(value: unknown): string | null {
  const password = typeof value === "string" ? value : "";
  return password.length >= 8 && password.length <= 128 ? password : null;
}

function parseText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 ? text.slice(0, max) : undefined;
}

// GET /api/partner-accounts?q=&page=&limit=
export async function listPartnerAccounts(req: Request, res: Response) {
  const { page, limit, offset } = parsePagination(req);
  const search = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim().slice(0, 100) : undefined;
  const { users, total } = await UserModel.list({ search, limit, offset, roleCode: PARTNER_ROLE });
  const roles = Object.fromEntries(users.map((user) => [user.id, [PARTNER_ROLE]]));
  res.json({ users: userListView(users, roles), page, limit, total });
}

// POST /api/partner-accounts  { email, password, firstName, lastName, phone?, address? }
// Créé directement par un administrateur : le partenaire ne s'inscrit pas lui-même.
export async function createPartnerAccount(req: Request, res: Response) {
  const email = parseEmail(req.body?.email);
  if (!email) return res.status(400).json({ message: "Email invalide" });
  const password = parsePassword(req.body?.password);
  if (!password) return res.status(400).json({ message: "Le mot de passe doit contenir au moins 8 caractères" });
  const firstName = parseText(req.body?.firstName, 100);
  const lastName = parseText(req.body?.lastName, 100);
  if (!firstName || !lastName) return res.status(400).json({ message: "Prénom et nom requis" });

  const [partnerRole, existing, passwordHash] = await Promise.all([
    RbacModel.findRoleByCode(PARTNER_ROLE),
    UserModel.findByEmail(email),
    hashPassword(password),
  ]);
  if (!partnerRole) return res.status(500).json({ message: "Erreur serveur" });
  if (existing) return res.status(409).json({ message: "Cet email est déjà utilisé" });

  // Compte + rôle dans la même transaction : jamais de compte partenaire sans son rôle
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
    // assignedBy renseigné : un compte créé par un administrateur est d'emblée validé
    await RbacModel.assignRole(created.id, partnerRole.id, req.user!.sub, transaction);
    return created;
  });

  await audit(req, "partner_account.create", { entityType: "users", entityId: user.id });
  res.status(201).json(userView(user, { roles: [PARTNER_ROLE] }));
}

// PATCH /api/partner-accounts/:id/status  { isActive }
export async function setPartnerAccountStatus(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  if (typeof req.body?.isActive !== "boolean") return res.status(400).json({ message: "isActive (booléen) requis" });
  if (!(await RbacModel.roleCodesForUser(id)).includes(PARTNER_ROLE)) {
    return res.status(404).json({ message: "Compte partenaire introuvable" });
  }

  const user = await UserModel.update(id, { isActive: req.body.isActive });
  if (!user) return res.status(404).json({ message: "Compte partenaire introuvable" });
  invalidateUser(id);
  if (!user.isActive) await AuthTokenModel.deleteAllForUser(id);
  await audit(req, user.isActive ? "partner_account.activate" : "partner_account.deactivate", {
    entityType: "users",
    entityId: id,
  });
  res.json(userView(user, { roles: [PARTNER_ROLE] }));
}
