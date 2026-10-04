import { Request, Response } from "express";
import { EstablishmentModel, EstablishmentUpdate } from "../models/establishment.model";
import { MunicipalServiceModel } from "../models/municipalService.model";
import { audit } from "../utils/audit";
import { parseId } from "../utils/http";
import { establishmentView, publicEstablishmentView } from "../views/establishment.view";

const MANAGE_PERMISSION = "agent.establishments.manage";

// Les gestionnaires voient aussi les lieux désactivés et les champs de gestion ; les autres
// n'ont que les lieux actifs, vue publique (pas de isActive)
function canManage(req: Request): boolean {
  return req.user?.permissions?.includes(MANAGE_PERMISSION) === true;
}

function parseName(value: unknown): string | null {
  const name = typeof value === "string" ? value.trim() : "";
  return name.length > 0 && name.length <= 150 ? name : null;
}

function parseAddress(value: unknown): string | null {
  const address = typeof value === "string" ? value.trim() : "";
  return address.length > 0 && address.length <= 255 ? address : null;
}

// undefined/null = pas de service ; sinon un identifiant à vérifier
function parseServiceId(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null) return null;
  const id = parseId(value);
  return id === null ? "invalid" : id;
}

// Texte optionnel : undefined = absent, null (ou "") = à effacer
function parseNullableText(value: unknown, max: number): string | null | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return "invalid";
  const text = value.trim();
  if (text.length > max) return "invalid";
  return text === "" ? null : text;
}

// GET /api/establishments?all=true  (all : réservé aux gestionnaires, inclut les lieux désactivés)
export async function listEstablishments(req: Request, res: Response) {
  const manage = canManage(req);
  const establishments = await EstablishmentModel.list({ includeInactive: req.query.all === "true" && manage });
  res.json(establishments.map(manage ? establishmentView : publicEstablishmentView));
}

// GET /api/establishments/:id
export async function getEstablishment(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const establishment = await EstablishmentModel.findById(id);
  const manage = canManage(req);
  // Un lieu désactivé est "introuvable" pour un non-gestionnaire
  if (!establishment || (!establishment.isActive && !manage)) {
    return res.status(404).json({ message: "Lieu introuvable" });
  }
  res.json(manage ? establishmentView(establishment) : publicEstablishmentView(establishment));
}

// POST /api/establishments  { name, address, serviceId?, description?, isOpen?, statusNote?, isActive? }
export async function createEstablishment(req: Request, res: Response) {
  const name = parseName(req.body?.name);
  if (!name) return res.status(400).json({ message: "Nom requis (150 caractères max)" });
  const address = parseAddress(req.body?.address);
  if (!address) return res.status(400).json({ message: "Adresse requise (255 caractères max)" });
  const serviceId = parseServiceId(req.body?.serviceId);
  if (serviceId === "invalid") return res.status(400).json({ message: "Service invalide" });
  if (serviceId !== null && !(await MunicipalServiceModel.findById(serviceId))) {
    return res.status(400).json({ message: "Service introuvable" });
  }
  const description = parseNullableText(req.body?.description, 65000);
  if (description === "invalid") return res.status(400).json({ message: "Description invalide" });
  const statusNote = parseNullableText(req.body?.statusNote, 255);
  if (statusNote === "invalid") return res.status(400).json({ message: "Statut invalide (255 caractères max)" });
  if (req.body?.isOpen !== undefined && typeof req.body.isOpen !== "boolean") {
    return res.status(400).json({ message: "isOpen doit être un booléen" });
  }
  if (req.body?.isActive !== undefined && typeof req.body.isActive !== "boolean") {
    return res.status(400).json({ message: "isActive doit être un booléen" });
  }

  const establishment = await EstablishmentModel.create({
    name,
    address,
    serviceId,
    description,
    statusNote,
    isOpen: req.body?.isOpen,
    isActive: req.body?.isActive,
  });
  await audit(req, "establishment.create", { entityType: "establishments", entityId: establishment.id });
  res.status(201).json(establishmentView(establishment));
}

// PATCH /api/establishments/:id
export async function updateEstablishment(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });

  const data: EstablishmentUpdate = {};
  if (req.body?.name !== undefined) {
    const name = parseName(req.body.name);
    if (!name) return res.status(400).json({ message: "Nom invalide (150 caractères max)" });
    data.name = name;
  }
  if (req.body?.address !== undefined) {
    const address = parseAddress(req.body.address);
    if (!address) return res.status(400).json({ message: "Adresse invalide (255 caractères max)" });
    data.address = address;
  }
  if (req.body?.serviceId !== undefined) {
    const serviceId = parseServiceId(req.body.serviceId);
    if (serviceId === "invalid") return res.status(400).json({ message: "Service invalide" });
    if (serviceId !== null && !(await MunicipalServiceModel.findById(serviceId))) {
      return res.status(400).json({ message: "Service introuvable" });
    }
    data.serviceId = serviceId;
  }
  const description = parseNullableText(req.body?.description, 65000);
  if (description === "invalid") return res.status(400).json({ message: "Description invalide" });
  if (description !== undefined) data.description = description;
  const statusNote = parseNullableText(req.body?.statusNote, 255);
  if (statusNote === "invalid") return res.status(400).json({ message: "Statut invalide (255 caractères max)" });
  if (statusNote !== undefined) data.statusNote = statusNote;
  if (req.body?.isOpen !== undefined) {
    if (typeof req.body.isOpen !== "boolean") return res.status(400).json({ message: "isOpen doit être un booléen" });
    data.isOpen = req.body.isOpen;
  }
  if (req.body?.isActive !== undefined) {
    if (typeof req.body.isActive !== "boolean") return res.status(400).json({ message: "isActive doit être un booléen" });
    data.isActive = req.body.isActive;
  }
  if (Object.keys(data).length === 0) {
    return res.status(400).json({ message: "Aucun champ à modifier" });
  }

  const establishment = await EstablishmentModel.update(id, data);
  if (!establishment) return res.status(404).json({ message: "Lieu introuvable" });
  await audit(req, "establishment.update", { entityType: "establishments", entityId: id });
  res.json(establishmentView(establishment));
}

// DELETE /api/establishments/:id
export async function deleteEstablishment(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  if (!(await EstablishmentModel.delete(id))) return res.status(404).json({ message: "Lieu introuvable" });
  await audit(req, "establishment.delete", { entityType: "establishments", entityId: id });
  res.status(204).send();
}
