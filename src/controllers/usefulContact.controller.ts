import { Request, Response } from "express";
import { ZONES, isZone } from "../models/alert.model";
import { MunicipalServiceModel } from "../models/municipalService.model";
import { CONTACT_CATEGORIES, UsefulContactModel, isContactCategory, type UsefulContactInput } from "../models/usefulContact.model";
import { audit } from "../utils/audit";
import { parseId } from "../utils/http";
import { resilientCached, staleHeaders } from "../utils/resilience";
import { invalidate } from "../utils/responseCache";
import { NOT_VALIDATED_RESPONSE, isUnvalidatedAgent } from "../utils/staffAccess";
import { groupedContactsView, staffContactView } from "../views/usefulContact.view";

// GET /api/public/contacts?zone=south -> coordonnées utiles regroupées par catégorie (urgences d'abord), sans compte.
// Base injoignable : dernière version connue (stale: true).
export async function listPublicContacts(req: Request, res: Response) {
  const zone = req.query.zone;
  if (zone !== undefined && !isZone(zone)) return res.status(400).json({ message: `Quartier inconnu (${ZONES.join(", ")})` });
  const result = await resilientCached(`contacts:public:${zone ?? "all"}`, 10_000, async () => groupedContactsView(await UsefulContactModel.listPublic(zone)), {
    persist: true,
  });
  res.set("Cache-Control", "no-cache");
  staleHeaders(res, result);
  res.json({ zone: zone ?? null, categories: result.data, stale: result.stale, savedAt: result.savedAt });
}

// ── Personnel ───────────────────────────────────────────────────────────────────────────────

// Des coordonnées officielles, publiées à toute la ville : seul un agent validé les modifie
function refuseIfNotValidated(req: Request, res: Response): boolean {
  if (!isUnvalidatedAgent(req)) return false;
  res.status(403).json(NOT_VALIDATED_RESPONSE);
  return true;
}

class InputError extends Error {}

// undefined : champ absent ; null ou "" : à effacer
function optionalText(value: unknown, max: number, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new InputError(`${field} invalide`);
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length > max) throw new InputError(`${field} : ${max} caractères au plus`);
  return text === "" ? null : text;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new InputError(`${field} doit être un booléen`);
  return value;
}

async function parseContact(body: any, partial: boolean): Promise<Partial<UsefulContactInput>> {
  const data: Partial<UsefulContactInput> = {};
  if (!partial || body.label !== undefined) {
    const label = optionalText(body.label, 150, "Libellé");
    if (!label || label.length < 2) throw new InputError("Libellé requis (2 à 150 caractères) : « Centre médical du Dôme Nord »");
    data.label = label;
  }
  if (!partial || body.category !== undefined) {
    if (!isContactCategory(body.category)) throw new InputError(`Catégorie parmi ${CONTACT_CATEGORIES.join(", ")}`);
    data.category = body.category;
  }
  const phone = optionalText(body.phone, 30, "Téléphone");
  if (phone && !/^[+0-9 ().-]{3,30}$/.test(phone)) throw new InputError("Téléphone invalide (chiffres, +, espaces, . - ( ))");
  if (phone !== undefined) data.phone = phone;
  const email = optionalText(body.email, 150, "E-mail");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new InputError("E-mail invalide");
  if (email !== undefined) data.email = email?.toLowerCase() ?? null;
  const address = optionalText(body.address, 255, "Adresse");
  if (address !== undefined) data.address = address;
  if (body.zone !== undefined) {
    if (body.zone !== null && !isZone(body.zone)) throw new InputError(`Quartier parmi ${ZONES.join(", ")}, ou null pour toute la ville`);
    data.zone = body.zone;
  }
  const openingHours = optionalText(body.openingHours, 150, "Horaires");
  if (openingHours !== undefined) data.openingHours = openingHours;
  const description = optionalText(body.description, 300, "Description");
  if (description !== undefined) data.description = description;
  const statusNote = optionalText(body.statusNote, 255, "État");
  if (statusNote !== undefined) data.statusNote = statusNote;
  for (const field of ["available24h", "isOpen", "isActive"] as const) {
    const value = optionalBoolean(body[field], field);
    if (value !== undefined) data[field] = value;
  }
  if (body.sortOrder !== undefined) {
    if (!Number.isInteger(body.sortOrder)) throw new InputError("sortOrder doit être un entier");
    data.sortOrder = body.sortOrder;
  }
  if (body.serviceId !== undefined) {
    if (body.serviceId === null) data.serviceId = null;
    else {
      const id = parseId(body.serviceId);
      if (!id || !(await MunicipalServiceModel.findById(id))) throw new InputError("Service introuvable");
      data.serviceId = id;
    }
  }
  return data;
}

// Un contact sans aucun moyen de joindre ou de trouver n'aide personne
function ensureReachable(contact: { phone?: string | null; email?: string | null; address?: string | null }) {
  if (!contact.phone && !contact.email && !contact.address) throw new InputError("Indiquez au moins un téléphone, un e-mail ou une adresse");
}

const changed = () => {
  invalidate("contacts:");
  invalidate("essentials");
};

// GET /api/contacts -> tous, y compris désactivés
export async function listContacts(_req: Request, res: Response) {
  res.json((await UsefulContactModel.listAll()).map(staffContactView));
}

// POST /api/contacts
export async function createContact(req: Request, res: Response) {
  if (refuseIfNotValidated(req, res)) return;
  try {
    const data = await parseContact(req.body ?? {}, false);
    ensureReachable(data);
    const contact = await UsefulContactModel.create(data as UsefulContactInput);
    void audit(req, "contact.create", { entityType: "useful_contacts", entityId: contact.id });
    changed();
    res.status(201).json(staffContactView(contact));
  } catch (error) {
    if (error instanceof InputError) return res.status(400).json({ message: error.message });
    throw error;
  }
}

// PATCH /api/contacts/:id  (ex. en pleine crise : { "isOpen": false, "statusNote": "Complet, allez au gymnase du centre" })
export async function updateContact(req: Request, res: Response) {
  if (refuseIfNotValidated(req, res)) return;
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const current = await UsefulContactModel.findById(id);
  if (!current) return res.status(404).json({ message: "Contact introuvable" });
  try {
    const data = await parseContact(req.body ?? {}, true);
    if (!Object.keys(data).length) throw new InputError("Aucun champ à modifier");
    ensureReachable({ ...current, ...data });
    const contact = await UsefulContactModel.update(id, data);
    void audit(req, "contact.update", { entityType: "useful_contacts", entityId: id });
    changed();
    res.json(staffContactView(contact!));
  } catch (error) {
    if (error instanceof InputError) return res.status(400).json({ message: error.message });
    throw error;
  }
}

// DELETE /api/contacts/:id
export async function deleteContact(req: Request, res: Response) {
  if (refuseIfNotValidated(req, res)) return;
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  if (!(await UsefulContactModel.delete(id))) return res.status(404).json({ message: "Contact introuvable" });
  void audit(req, "contact.delete", { entityType: "useful_contacts", entityId: id });
  changed();
  res.status(204).send();
}
