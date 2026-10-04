import { Request, Response } from "express";
import { AuthTokenModel } from "../models/authToken.model";
import { PermissionModel } from "../models/permission.model";
import { CITIZEN_ROLE, RbacModel } from "../models/rbac.model";
import { UserModel, UserUpdate } from "../models/user.model";
import { audit } from "../utils/audit";
import { invalidateUser } from "../utils/accessCache";
import { parseId, parsePagination } from "../utils/http";
import { NOT_VALIDATED_RESPONSE, isUnvalidatedAgent, maskContactDetails } from "../utils/staffAccess";
import { userListView, userView } from "../views/user.view";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseEmail(value: unknown): string | null {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return EMAIL_REGEX.test(email) && email.length <= 255 ? email : null;
}

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

// Un agent ne doit administrer que des comptes purement citoyens : jamais un compte qui
// porte aussi un rôle agent/admin, pour ne jamais ouvrir de porte vers un accès non autorisé
// à un espace agent/admin via cette route.
async function isManageableCitizen(id: number) {
  const roles = await RbacModel.roleCodesForUser(id);
  return roles.length === 1 && roles[0] === CITIZEN_ROLE;
}

// GET /api/citizen-accounts?q=&page=&limit=
export async function listCitizenAccounts(req: Request, res: Response) {
  const { page, limit, offset } = parsePagination(req);
  const search = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim().slice(0, 100) : undefined;
  const { users, total } = await UserModel.list({ search, limit, offset, roleCode: CITIZEN_ROLE });
  const roles = Object.fromEntries(users.map((user) => [user.id, [CITIZEN_ROLE]]));
  const view = userListView(users, roles);
  // Agent non validé : coordonnées des citoyens masquées (nom conservé pour reconnaître le dossier)
  res.json({ users: isUnvalidatedAgent(req) ? view.map(maskContactDetails) : view, page, limit, total });
}

// GET /api/citizen-accounts/:id
export async function getCitizenAccount(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id || !(await isManageableCitizen(id))) return res.status(404).json({ message: "Compte citoyen introuvable" });
  const user = await UserModel.findPublicById(id);
  if (!user) return res.status(404).json({ message: "Compte citoyen introuvable" });
  const permissions = await PermissionModel.codesForUser(id);
  const view = userView(user, { roles: [CITIZEN_ROLE], permissions });
  res.json(isUnvalidatedAgent(req) ? maskContactDetails(view) : view);
}

// PATCH /api/citizen-accounts/:id  { firstName?, lastName?, email?, phone?, address? }
export async function updateCitizenAccount(req: Request, res: Response) {
  // Modifier les données personnelles d'un citoyen : réservé aux agents validés par un administrateur
  if (isUnvalidatedAgent(req)) return res.status(403).json(NOT_VALIDATED_RESPONSE);
  const id = parseId(req.params.id);
  if (!id || !(await isManageableCitizen(id))) return res.status(404).json({ message: "Compte citoyen introuvable" });

  const data: UserUpdate = {};
  const firstName = parseNullableText(req.body?.firstName, 100);
  const lastName = parseNullableText(req.body?.lastName, 100);
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
    if (existing && existing.id !== id) {
      return res.status(409).json({ message: "Cet email est déjà utilisé" });
    }
    data.email = email;
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ message: "Aucun champ à modifier (email, firstName, lastName, phone, address)" });
  }

  const user = await UserModel.update(id, data);
  if (!user) return res.status(404).json({ message: "Compte citoyen introuvable" });
  invalidateUser(id);
  await audit(req, "citizen.account.update", { entityType: "users", entityId: id });
  res.json(userView(user, { roles: [CITIZEN_ROLE] }));
}

// PATCH /api/citizen-accounts/:id/status  { isActive }  : désactiver coupe aussi toutes les sessions,
// ce qui empêche immédiatement tout accès non autorisé à l'espace du citoyen
export async function setCitizenAccountStatus(req: Request, res: Response) {
  // Désactiver le compte d'un citoyen : réservé aux agents validés
  if (isUnvalidatedAgent(req)) return res.status(403).json(NOT_VALIDATED_RESPONSE);
  const id = parseId(req.params.id);
  if (!id || !(await isManageableCitizen(id))) return res.status(404).json({ message: "Compte citoyen introuvable" });
  if (typeof req.body?.isActive !== "boolean") return res.status(400).json({ message: "isActive (booléen) requis" });

  const user = await UserModel.update(id, { isActive: req.body.isActive });
  if (!user) return res.status(404).json({ message: "Compte citoyen introuvable" });
  invalidateUser(id);
  if (!user.isActive) await AuthTokenModel.deleteAllForUser(id);
  await audit(req, user.isActive ? "citizen.account.activate" : "citizen.account.deactivate", {
    entityType: "users",
    entityId: id,
  });
  res.json(userView(user, { roles: [CITIZEN_ROLE] }));
}
