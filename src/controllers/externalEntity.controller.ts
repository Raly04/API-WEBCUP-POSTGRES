import { Request, Response } from "express";
import { ExternalEntityModel } from "../models/externalEntity.model";
import { audit } from "../utils/audit";
import { parseId } from "../utils/http";
import { externalEntityView } from "../views/externalEntity.view";

function parseName(value: unknown): string | null {
  const name = typeof value === "string" ? value.trim() : "";
  return name.length > 0 && name.length <= 150 ? name : null;
}

function parseType(value: unknown): string | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "invalid";
  const type = value.trim();
  if (type.length > 100) return "invalid";
  return type === "" ? null : type;
}

// GET /api/external-entities
export async function listExternalEntities(_req: Request, res: Response) {
  res.json((await ExternalEntityModel.list()).map(externalEntityView));
}

// POST /api/external-entities  { name, type? }  : "ajout rapide", idempotent sur le nom
export async function createExternalEntity(req: Request, res: Response) {
  const name = parseName(req.body?.name);
  if (!name) return res.status(400).json({ message: "Nom requis (150 caractères max)" });
  const type = parseType(req.body?.type);
  if (type === "invalid") return res.status(400).json({ message: "Type invalide (100 caractères max)" });

  const entity = await ExternalEntityModel.findOrCreate(name, type);
  await audit(req, "external_entity.create", { entityType: "external_entities", entityId: entity.id });
  res.status(201).json(externalEntityView(entity));
}

// DELETE /api/external-entities/:id
export async function deleteExternalEntity(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  if (!(await ExternalEntityModel.delete(id))) return res.status(404).json({ message: "Entité introuvable" });
  await audit(req, "external_entity.delete", { entityType: "external_entities", entityId: id });
  res.status(204).send();
}
