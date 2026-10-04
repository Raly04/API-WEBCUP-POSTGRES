import { Request, Response } from "express";
import { PermissionModel } from "../models/permission.model";
import { audit } from "../utils/audit";
import { clearAccessCache } from "../utils/accessCache";
import { parseId } from "../utils/http";
import { permissionView, permissionsByModuleView } from "../views/permission.view";

// Format "module.ressource.action" : au moins deux segments en minuscules, ex. citizen.services.view
const PERMISSION_CODE_REGEX = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const MODULE_REGEX = /^[a-z][a-z0-9_]{0,49}$/;

function parseLabel(value: unknown): string | null {
  const label = typeof value === "string" ? value.trim() : "";
  return label.length > 0 && label.length <= 150 ? label : null;
}

// GET /api/permissions?module=citizen&grouped=true
export async function listPermissions(req: Request, res: Response) {
  const module = typeof req.query.module === "string" && req.query.module ? req.query.module.slice(0, 50) : undefined;
  const permissions = await PermissionModel.list(module);
  res.json(req.query.grouped === "true" ? permissionsByModuleView(permissions) : permissions.map((permission) => permissionView(permission)));
}

// GET /api/permissions/:id : avec les rôles qui la possèdent
export async function getPermission(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const permission = await PermissionModel.findById(id);
  if (!permission) return res.status(404).json({ message: "Permission introuvable" });
  res.json(permissionView(permission, await PermissionModel.roleCodesUsing(id)));
}

// POST /api/permissions  { code, label, module? }  : module déduit du code si absent
export async function createPermission(req: Request, res: Response) {
  const code = typeof req.body?.code === "string" ? req.body.code.trim().toLowerCase() : "";
  if (!PERMISSION_CODE_REGEX.test(code) || code.length > 100) {
    return res.status(400).json({ message: "Code invalide (format module.ressource.action en minuscules, 100 caractères max)" });
  }
  const label = parseLabel(req.body?.label);
  if (!label) return res.status(400).json({ message: "Libellé requis (150 caractères max)" });
  const module = req.body?.module === undefined ? code.split(".")[0] : String(req.body.module).trim().toLowerCase();
  if (!MODULE_REGEX.test(module)) return res.status(400).json({ message: "Module invalide (minuscules, chiffres et _, 50 max)" });

  if (await PermissionModel.findByCode(code)) return res.status(409).json({ message: "Ce code de permission existe déjà" });

  const permission = await PermissionModel.create({ code, label, module });
  await audit(req, "permission.create", { entityType: "permissions", entityId: permission.id });
  res.status(201).json(permissionView(permission, []));
}

// PATCH /api/permissions/:id  { label?, module? } : le code n'est jamais modifiable
export async function updatePermission(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });

  const data: { label?: string; module?: string } = {};
  if (req.body?.label !== undefined) {
    const label = parseLabel(req.body.label);
    if (!label) return res.status(400).json({ message: "Libellé invalide (150 caractères max)" });
    data.label = label;
  }
  if (req.body?.module !== undefined) {
    const module = String(req.body.module).trim().toLowerCase();
    if (!MODULE_REGEX.test(module)) return res.status(400).json({ message: "Module invalide (minuscules, chiffres et _, 50 max)" });
    data.module = module;
  }
  if (Object.keys(data).length === 0) return res.status(400).json({ message: "Aucun champ à modifier (label, module)" });

  const permission = await PermissionModel.update(id, data);
  if (!permission) return res.status(404).json({ message: "Permission introuvable" });
  await audit(req, "permission.update", { entityType: "permissions", entityId: id });
  res.json(permissionView(permission));
}

// DELETE /api/permissions/:id : refusé si elle est attribuée à un rôle, sauf ?force=true (détache puis supprime)
export async function deletePermission(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const permission = await PermissionModel.findById(id);
  if (!permission) return res.status(404).json({ message: "Permission introuvable" });

  const roles = await PermissionModel.roleCodesUsing(id);
  if (roles.length > 0 && req.query.force !== "true") {
    return res.status(409).json({
      message: `Permission attribuée aux rôles : ${roles.join(", ")}. Retirez-la d'abord, ou utilisez ?force=true`,
      roles,
    });
  }

  await PermissionModel.delete(id); // role_permission est nettoyée par ON DELETE CASCADE
  clearAccessCache();
  await audit(req, "permission.delete", { entityType: "permissions", entityId: id });
  res.status(204).send();
}
