import { Request, Response } from "express";
import { AuthTokenModel } from "../models/authToken.model";
import { PermissionModel } from "../models/permission.model";
import { RbacModel } from "../models/rbac.model";
import { UserModel } from "../models/user.model";
import { audit } from "../utils/audit";
import { invalidateUser } from "../utils/accessCache";
import { parseId, parsePagination } from "../utils/http";
import { userListView, userView } from "../views/user.view";

const ADMIN_ROLE = "admin";

// GET /api/users?q=&page=&limit=
export async function listUsers(req: Request, res: Response) {
  const { page, limit, offset } = parsePagination(req);
  const search = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim().slice(0, 100) : undefined;
  const { users, total } = await UserModel.list({ search, limit, offset });
  const roles = await RbacModel.roleCodesForUsers(users.map((user) => user.id));
  res.json({ users: userListView(users, roles), page, limit, total });
}

// GET /api/users/:id
export async function getUser(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const user = await UserModel.findPublicById(id);
  if (!user) return res.status(404).json({ message: "Utilisateur introuvable" });
  const [roles, permissions] = await Promise.all([RbacModel.roleCodesForUser(id), PermissionModel.codesForUser(id)]);
  res.json(userView(user, { roles, permissions }));
}

// PATCH /api/users/:id/status  { isActive }  : désactiver coupe aussi toutes les sessions
export async function setUserStatus(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  if (typeof req.body?.isActive !== "boolean") return res.status(400).json({ message: "isActive (booléen) requis" });
  if (id === req.user!.sub && !req.body.isActive) {
    return res.status(400).json({ message: "Vous ne pouvez pas désactiver votre propre compte" });
  }

  const user = await UserModel.update(id, { isActive: req.body.isActive });
  if (!user) return res.status(404).json({ message: "Utilisateur introuvable" });
  invalidateUser(id);
  if (!user.isActive) await AuthTokenModel.deleteAllForUser(id);
  await audit(req, user.isActive ? "user.activate" : "user.deactivate", { entityType: "users", entityId: id });
  res.json(userView(user));
}

// POST /api/users/:id/roles  { role: "agent" }
export async function assignRole(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const code = typeof req.body?.role === "string" ? req.body.role : "";
  const role = await RbacModel.findRoleByCode(code);
  if (!role) return res.status(400).json({ message: `Rôle inconnu : "${code}"` });
  if (!(await UserModel.findPublicById(id))) return res.status(404).json({ message: "Utilisateur introuvable" });

  const created = await RbacModel.assignRole(id, role.id, req.user!.sub);
  // Rôle déjà porté (typiquement un agent inscrit seul) : l'attribuer à nouveau le VALIDE
  const validated = !created && (await RbacModel.validateRole(id, role.id, req.user!.sub));
  invalidateUser(id);
  if (created) await audit(req, "role.assign", { entityType: "users", entityId: id });
  else if (validated) await audit(req, "agent.validate", { entityType: "users", entityId: id });
  res.status(created ? 201 : 200).json({ roles: await RbacModel.roleCodesForUser(id) });
}

// POST /api/users/:id/validate-agent : confirme qu'un agent inscrit seul est de confiance (données citoyens complètes)
export async function validateAgent(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const agentRole = await RbacModel.findRoleByCode("agent");
  if (!agentRole) return res.status(500).json({ message: "Erreur serveur" });
  if (!(await RbacModel.roleCodesForUser(id)).includes("agent")) {
    return res.status(404).json({ message: "Cet utilisateur n'est pas agent" });
  }
  const validated = await RbacModel.validateRole(id, agentRole.id, req.user!.sub);
  invalidateUser(id);
  if (!validated) return res.status(200).json({ validated: false, message: "Agent déjà validé" });
  await audit(req, "agent.validate", { entityType: "users", entityId: id });
  res.json({ validated: true });
}

// GET /api/users/pending-agents
export async function listPendingAgents(_req: Request, res: Response) {
  res.json({ users: await RbacModel.listPendingAgents() });
}

// DELETE /api/users/:id/roles/:code
export async function removeRole(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const code = String(req.params.code);
  const role = await RbacModel.findRoleByCode(code);
  if (!role) return res.status(404).json({ message: `Rôle inconnu : "${code}"` });

  // Garde-fou : on ne retire pas le dernier administrateur actif
  if (code === ADMIN_ROLE && (await RbacModel.countActiveUsersWithRole(role.id)) <= 1) {
    return res.status(400).json({ message: "Impossible de retirer le dernier administrateur" });
  }

  if (!(await RbacModel.removeRole(id, role.id))) {
    return res.status(404).json({ message: "Cet utilisateur n'a pas ce rôle" });
  }
  invalidateUser(id);
  await audit(req, "role.remove", { entityType: "users", entityId: id });
  res.json({ roles: await RbacModel.roleCodesForUser(id) });
}
