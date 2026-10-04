import { Request, Response } from "express";
import { PermissionModel } from "../models/permission.model";
import { RbacModel } from "../models/rbac.model";
import { RoleModel, RoleUpdate } from "../models/role.model";
import { audit } from "../utils/audit";
import { clearAccessCache } from "../utils/accessCache";
import { parseId } from "../utils/http";
import { permissionView } from "../views/permission.view";
import { roleListView, roleView } from "../views/role.view";

const ROLE_CODE_REGEX = /^[a-z][a-z0-9_]{1,49}$/;

function parseLabel(value: unknown): string | null {
  const label = typeof value === "string" ? value.trim() : "";
  return label.length > 0 && label.length <= 100 ? label : null;
}

function parseLevel(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 1000 ? (value as number) : null;
}

// GET /api/roles
export async function listRoles(_req: Request, res: Response) {
  const [roles, permissions] = await Promise.all([RoleModel.list(), RoleModel.permissionCodesByRole()]);
  res.json(roleListView(roles, permissions));
}

// GET /api/roles/:id
export async function getRole(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const role = await RoleModel.findById(id);
  if (!role) return res.status(404).json({ message: "Rôle introuvable" });

  const [permissions, usersCount] = await Promise.all([RoleModel.permissionCodesByRole(), RoleModel.countUsers(id)]);
  res.json(roleView(role, { permissions: permissions[id] ?? [], usersCount }));
}

// POST /api/roles  { code, label, level? }
export async function createRole(req: Request, res: Response) {
  const code = typeof req.body?.code === "string" ? req.body.code.trim().toLowerCase() : "";
  if (!ROLE_CODE_REGEX.test(code)) {
    return res.status(400).json({ message: "Code invalide (minuscules, chiffres et _, 2 à 50 caractères, commence par une lettre)" });
  }
  const label = parseLabel(req.body?.label);
  if (!label) return res.status(400).json({ message: "Libellé requis (100 caractères max)" });
  const level = req.body?.level === undefined ? 0 : parseLevel(req.body.level);
  if (level === null) return res.status(400).json({ message: "Niveau invalide (entier entre 0 et 1000)" });

  if (await RoleModel.findByCode(code)) return res.status(409).json({ message: "Ce code de rôle existe déjà" });

  const role = await RoleModel.create({ code, label, level });
  await audit(req, "role.create", { entityType: "roles", entityId: role.id });
  res.status(201).json(roleView(role, { permissions: [], usersCount: 0 }));
}

// PATCH /api/roles/:id  { label?, level? }  : le code n'est jamais modifiable
export async function updateRole(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });

  const data: RoleUpdate = {};
  if (req.body?.label !== undefined) {
    const label = parseLabel(req.body.label);
    if (!label) return res.status(400).json({ message: "Libellé invalide (100 caractères max)" });
    data.label = label;
  }
  if (req.body?.level !== undefined) {
    const level = parseLevel(req.body.level);
    if (level === null) return res.status(400).json({ message: "Niveau invalide (entier entre 0 et 1000)" });
    data.level = level;
  }
  if (Object.keys(data).length === 0) return res.status(400).json({ message: "Aucun champ à modifier (label, level)" });

  const role = await RoleModel.update(id, data);
  if (!role) return res.status(404).json({ message: "Rôle introuvable" });
  await audit(req, "role.update", { entityType: "roles", entityId: id });
  res.json(roleView(role));
}

// DELETE /api/roles/:id : interdit pour un rôle système ou encore attribué
export async function deleteRole(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const role = await RoleModel.findById(id);
  if (!role) return res.status(404).json({ message: "Rôle introuvable" });

  if (role.isSystem) return res.status(403).json({ message: "Un rôle système ne peut pas être supprimé" });
  const usersCount = await RoleModel.countUsers(id);
  if (usersCount > 0) {
    return res.status(409).json({ message: `Ce rôle est encore attribué à ${usersCount} utilisateur(s)` });
  }

  await RoleModel.delete(id);
  clearAccessCache();
  await audit(req, "role.delete", { entityType: "roles", entityId: id });
  res.status(204).send();
}

// ── Permissions d'un rôle ────────────────────────────────────

// Sans cette permission, plus aucun administrateur ne pourrait gérer les droits
const ADMIN_ROLE = "admin";
const LOCKOUT_PERMISSION = "admin.users.manage";

// Liste de codes : { permissions: ["a.b.c", ...] } ou { permission: "a.b.c" } ; dédoublonnée, 100 max
function parsePermissionCodes(body: any): string[] | null {
  const raw = Array.isArray(body?.permissions) ? body.permissions : body?.permission !== undefined ? [body.permission] : null;
  if (!raw || raw.length > 100 || !raw.every((code: unknown) => typeof code === "string" && code.trim() !== "")) return null;
  return [...new Set(raw.map((code: string) => code.trim()))] as string[];
}

// Codes -> permissions existantes ; renvoie les codes inconnus pour un message d'erreur précis
async function resolvePermissions(codes: string[]) {
  const found = await PermissionModel.findByCodes(codes);
  const known = new Set(found.map((permission) => permission.code));
  return { found, unknown: codes.filter((code) => !known.has(code)) };
}

async function rolePermissionsResponse(roleId: number) {
  return (await PermissionModel.listForRole(roleId)).map((permission) => permissionView(permission));
}

// GET /api/roles/:id/permissions
export async function listRolePermissions(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const role = await RoleModel.findById(id);
  if (!role) return res.status(404).json({ message: "Rôle introuvable" });
  res.json({ role: roleView(role), permissions: await rolePermissionsResponse(id) });
}

// POST /api/roles/:id/permissions  { permissions: [codes] }  : ajoute (idempotent)
export async function grantRolePermissions(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const codes = parsePermissionCodes(req.body);
  if (!codes) return res.status(400).json({ message: "permissions (tableau de codes, 100 max) ou permission (code) requis" });
  const role = await RoleModel.findById(id);
  if (!role) return res.status(404).json({ message: "Rôle introuvable" });

  const { found, unknown } = await resolvePermissions(codes);
  if (unknown.length > 0) return res.status(400).json({ message: `Permissions inconnues : ${unknown.join(", ")}` });

  const added = await RbacModel.grantPermissions(id, found.map((permission) => permission.id));
  clearAccessCache();
  if (added > 0) await audit(req, "role.permission.grant", { entityType: "roles", entityId: id });
  res.status(added > 0 ? 201 : 200).json({ added, permissions: await rolePermissionsResponse(id) });
}

// PUT /api/roles/:id/permissions  { permissions: [codes] }  : remplace tout (liste vide = tout retirer)
export async function setRolePermissions(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  if (!Array.isArray(req.body?.permissions)) return res.status(400).json({ message: "permissions (tableau de codes) requis" });
  const codes = parsePermissionCodes(req.body);
  if (!codes) return res.status(400).json({ message: "permissions doit contenir des codes (100 max)" });
  const role = await RoleModel.findById(id);
  if (!role) return res.status(404).json({ message: "Rôle introuvable" });

  if (role.code === ADMIN_ROLE && !codes.includes(LOCKOUT_PERMISSION)) {
    return res.status(400).json({ message: `Le rôle ${ADMIN_ROLE} doit garder la permission ${LOCKOUT_PERMISSION}` });
  }
  const { found, unknown } = await resolvePermissions(codes);
  if (unknown.length > 0) return res.status(400).json({ message: `Permissions inconnues : ${unknown.join(", ")}` });

  await RbacModel.syncPermissions(id, found.map((permission) => permission.id));
  clearAccessCache();
  await audit(req, "role.permission.sync", { entityType: "roles", entityId: id });
  res.json({ permissions: await rolePermissionsResponse(id) });
}

// DELETE /api/roles/:id/permissions/:code  : retire une permission
export async function revokeRolePermission(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const code = String(req.params.code);
  const role = await RoleModel.findById(id);
  if (!role) return res.status(404).json({ message: "Rôle introuvable" });
  const permission = await PermissionModel.findByCode(code);
  if (!permission) return res.status(404).json({ message: `Permission inconnue : "${code}"` });

  if (role.code === ADMIN_ROLE && code === LOCKOUT_PERMISSION) {
    return res.status(400).json({ message: `Le rôle ${ADMIN_ROLE} doit garder la permission ${LOCKOUT_PERMISSION}` });
  }
  if (!(await RbacModel.revokePermission(id, permission.id))) {
    return res.status(404).json({ message: "Ce rôle n'a pas cette permission" });
  }
  clearAccessCache();
  await audit(req, "role.permission.revoke", { entityType: "roles", entityId: id });
  res.json({ permissions: await rolePermissionsResponse(id) });
}
