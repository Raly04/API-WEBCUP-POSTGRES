import { Request, Response } from "express";
import {
  PartnerServiceModel,
  PartnerServiceUpdate,
  isNextActionType,
  type NextActionType,
} from "../models/partnerService.model";
import { audit } from "../utils/audit";
import { parseId } from "../utils/http";
import { partnerServiceView } from "../views/partnerService.view";

function isOwner(req: Request, partnerId: number): boolean {
  return req.user!.sub === partnerId;
}

function parseName(value: unknown): string | null {
  const name = typeof value === "string" ? value.trim() : "";
  return name.length > 0 && name.length <= 150 ? name : null;
}

// Texte optionnel borné : undefined = absent (inchangé en update), null (ou "") = à effacer
function parseNullableText(value: unknown, max: number): string | null | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return "invalid";
  const text = value.trim();
  if (text.length > max) return "invalid";
  return text === "" ? null : text;
}

function parseNextActionType(value: unknown): NextActionType | null | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return isNextActionType(value) ? value : "invalid";
}

// La valeur de la prochaine action est affichée comme lien cliquable (tel:, mailto:, ou lien externe)
// côté habitant : un schéma non http(s) (ex. javascript:) exécuterait du code dans son navigateur.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isSafeNextActionValue(type: NextActionType | null, value: string | null): boolean {
  if (!value || !type) return true;
  if (type === "link") return /^https?:\/\//i.test(value);
  if (type === "phone") return /^[0-9+()\-.\s]{1,30}$/.test(value);
  if (type === "email") return EMAIL_REGEX.test(value);
  return true;
}

// GET /api/partner-services : catalogue public, offres actives uniquement
export async function listPartnerServices(_req: Request, res: Response) {
  const services = await PartnerServiceModel.list({ includeInactive: false });
  res.json(services.map(partnerServiceView));
}

// GET /api/partner-services/mine : les offres du partenaire connecté, actives ou non
export async function listMyPartnerServices(req: Request, res: Response) {
  const services = await PartnerServiceModel.listByPartner(req.user!.sub);
  res.json(services.map(partnerServiceView));
}

// GET /api/partner-services/:id
export async function getPartnerService(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const service = await PartnerServiceModel.findById(id);
  // Une offre désactivée n'est visible que par le partenaire qui la possède
  if (!service || (!service.isActive && !isOwner(req, service.partnerId))) {
    return res.status(404).json({ message: "Offre introuvable" });
  }
  res.json(partnerServiceView(service));
}

// POST /api/partner-services  { name, description?, category?, address?, openingHours?,
//   contactPhone?, contactEmail?, isAvailable?, availabilityNote?, nextActionLabel?, nextActionType?, nextActionValue? }
export async function createPartnerService(req: Request, res: Response) {
  const name = parseName(req.body?.name);
  if (!name) return res.status(400).json({ message: "Nom requis (150 caractères max)" });

  const description = parseNullableText(req.body?.description, 65000);
  const category = parseNullableText(req.body?.category, 100);
  const address = parseNullableText(req.body?.address, 255);
  const openingHours = parseNullableText(req.body?.openingHours, 255);
  const contactPhone = parseNullableText(req.body?.contactPhone, 30);
  const contactEmail = parseNullableText(req.body?.contactEmail, 255);
  const availabilityNote = parseNullableText(req.body?.availabilityNote, 255);
  const nextActionLabel = parseNullableText(req.body?.nextActionLabel, 100);
  const nextActionValue = parseNullableText(req.body?.nextActionValue, 255);
  const nextActionType = parseNextActionType(req.body?.nextActionType);

  if (description === "invalid") return res.status(400).json({ message: "Description invalide" });
  if (category === "invalid") return res.status(400).json({ message: "Catégorie invalide (100 caractères max)" });
  if (address === "invalid") return res.status(400).json({ message: "Adresse invalide (255 caractères max)" });
  if (openingHours === "invalid") return res.status(400).json({ message: "Horaires invalides (255 caractères max)" });
  if (contactPhone === "invalid") return res.status(400).json({ message: "Téléphone invalide (30 caractères max)" });
  if (contactEmail === "invalid") return res.status(400).json({ message: "E-mail invalide (255 caractères max)" });
  if (availabilityNote === "invalid") return res.status(400).json({ message: "Note de disponibilité invalide" });
  if (nextActionLabel === "invalid") return res.status(400).json({ message: "Libellé d'action invalide" });
  if (nextActionValue === "invalid") return res.status(400).json({ message: "Valeur d'action invalide" });
  if (nextActionType === "invalid") {
    return res.status(400).json({ message: "Type d'action invalide (phone, email, visit, link)" });
  }
  if (req.body?.isAvailable !== undefined && typeof req.body.isAvailable !== "boolean") {
    return res.status(400).json({ message: "isAvailable doit être un booléen" });
  }
  if (!isSafeNextActionValue(nextActionType ?? null, nextActionValue ?? null)) {
    return res.status(400).json({
      message:
        "Valeur d'action incohérente avec son type (lien http(s), téléphone ou e-mail valide attendu)",
    });
  }

  const service = await PartnerServiceModel.create(req.user!.sub, {
    name,
    description,
    category,
    address,
    openingHours,
    contactPhone,
    contactEmail,
    availabilityNote,
    nextActionLabel,
    nextActionType,
    nextActionValue,
    isAvailable: req.body?.isAvailable,
  });
  await audit(req, "partner_service.create", { entityType: "partner_services", entityId: service.id });
  res.status(201).json(partnerServiceView(service));
}

// PATCH /api/partner-services/:id : réservé au partenaire propriétaire de l'offre
export async function updatePartnerService(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const existing = await PartnerServiceModel.findById(id);
  if (!existing || !isOwner(req, existing.partnerId)) return res.status(404).json({ message: "Offre introuvable" });

  const data: PartnerServiceUpdate = {};
  if (req.body?.name !== undefined) {
    const name = parseName(req.body.name);
    if (!name) return res.status(400).json({ message: "Nom invalide (150 caractères max)" });
    data.name = name;
  }

  const description = parseNullableText(req.body?.description, 65000);
  if (description === "invalid") return res.status(400).json({ message: "Description invalide" });
  if (description !== undefined) data.description = description;

  const category = parseNullableText(req.body?.category, 100);
  if (category === "invalid") return res.status(400).json({ message: "Catégorie invalide (100 caractères max)" });
  if (category !== undefined) data.category = category;

  const address = parseNullableText(req.body?.address, 255);
  if (address === "invalid") return res.status(400).json({ message: "Adresse invalide (255 caractères max)" });
  if (address !== undefined) data.address = address;

  const openingHours = parseNullableText(req.body?.openingHours, 255);
  if (openingHours === "invalid") return res.status(400).json({ message: "Horaires invalides (255 caractères max)" });
  if (openingHours !== undefined) data.openingHours = openingHours;

  const contactPhone = parseNullableText(req.body?.contactPhone, 30);
  if (contactPhone === "invalid") return res.status(400).json({ message: "Téléphone invalide (30 caractères max)" });
  if (contactPhone !== undefined) data.contactPhone = contactPhone;

  const contactEmail = parseNullableText(req.body?.contactEmail, 255);
  if (contactEmail === "invalid") return res.status(400).json({ message: "E-mail invalide (255 caractères max)" });
  if (contactEmail !== undefined) data.contactEmail = contactEmail;

  const availabilityNote = parseNullableText(req.body?.availabilityNote, 255);
  if (availabilityNote === "invalid") return res.status(400).json({ message: "Note de disponibilité invalide" });
  if (availabilityNote !== undefined) data.availabilityNote = availabilityNote;

  const nextActionLabel = parseNullableText(req.body?.nextActionLabel, 100);
  if (nextActionLabel === "invalid") return res.status(400).json({ message: "Libellé d'action invalide" });
  if (nextActionLabel !== undefined) data.nextActionLabel = nextActionLabel;

  const nextActionValue = parseNullableText(req.body?.nextActionValue, 255);
  if (nextActionValue === "invalid") return res.status(400).json({ message: "Valeur d'action invalide" });
  if (nextActionValue !== undefined) data.nextActionValue = nextActionValue;

  const nextActionType = parseNextActionType(req.body?.nextActionType);
  if (nextActionType === "invalid") {
    return res.status(400).json({ message: "Type d'action invalide (phone, email, visit, link)" });
  }
  if (nextActionType !== undefined) data.nextActionType = nextActionType;

  if (req.body?.isAvailable !== undefined) {
    if (typeof req.body.isAvailable !== "boolean") return res.status(400).json({ message: "isAvailable doit être un booléen" });
    data.isAvailable = req.body.isAvailable;
  }
  if (req.body?.isActive !== undefined) {
    if (typeof req.body.isActive !== "boolean") return res.status(400).json({ message: "isActive doit être un booléen" });
    data.isActive = req.body.isActive;
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ message: "Aucun champ à modifier" });
  }

  const effectiveType = data.nextActionType !== undefined ? data.nextActionType : existing.nextActionType;
  const effectiveValue = data.nextActionValue !== undefined ? data.nextActionValue : existing.nextActionValue;
  if (!isSafeNextActionValue(effectiveType, effectiveValue)) {
    return res.status(400).json({
      message:
        "Valeur d'action incohérente avec son type (lien http(s), téléphone ou e-mail valide attendu)",
    });
  }

  const service = await PartnerServiceModel.update(id, data);
  if (!service) return res.status(404).json({ message: "Offre introuvable" });
  await audit(req, "partner_service.update", { entityType: "partner_services", entityId: id });
  res.json(partnerServiceView(service));
}

// DELETE /api/partner-services/:id : réservé au partenaire propriétaire de l'offre
export async function deletePartnerService(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const existing = await PartnerServiceModel.findById(id);
  if (!existing || !isOwner(req, existing.partnerId)) return res.status(404).json({ message: "Offre introuvable" });

  await PartnerServiceModel.delete(id);
  await audit(req, "partner_service.delete", { entityType: "partner_services", entityId: id });
  res.status(204).send();
}
