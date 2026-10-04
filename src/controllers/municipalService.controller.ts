import { Request, Response } from "express";
import { MunicipalServiceModel, MunicipalServiceUpdate } from "../models/municipalService.model";
import { CitizenRequestModel } from "../models/citizenRequest.model";
import { audit } from "../utils/audit";
import { cached, invalidate } from "../utils/responseCache";
import { parseId } from "../utils/http";
import { ServiceReviewModel } from "../models/serviceReview.model";
import { municipalServiceView, type ReviewSummary } from "../views/municipalService.view";

const MANAGE_PERMISSION = "admin.services.manage";
// Catalogue vu par tous les habitants : lu en base une fois par fenêtre, et invalidé à chaque modification
const LIST_TTL_MS = 30_000;
const CODE_REGEX = /^[a-z][a-z0-9_-]{1,49}$/;

// Les gestionnaires voient aussi les services désactivés ; les autres uniquement les services actifs
function canManage(req: Request): boolean {
  return req.user?.permissions?.includes(MANAGE_PERMISSION) === true;
}

function parseName(value: unknown): string | null {
  const name = typeof value === "string" ? value.trim() : "";
  return name.length > 0 && name.length <= 150 ? name : null;
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

function parseSortOrder(value: unknown): number | null {
  return Number.isInteger(value) && Math.abs(value as number) <= 100000 ? (value as number) : null;
}

// Filtres de liste tolérants : une valeur absente ou mal formée retombe sur le comportement par défaut
// plutôt que de faire échouer un simple affichage.
function parseLimit(value: unknown): number | null {
  const limit = Number(value);
  return typeof value === "string" && Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : null;
}

// GET /api/services?all=true&sort=mostUsed&limit=3
// all : réservé aux gestionnaires, inclut les services désactivés
// sort=mostUsed : classe par nombre de demandes reçues (les plus demandés d'abord)
// limit : tronque la liste déjà triée (mise en avant des services prioritaires sur un tableau de bord)
export async function listServices(req: Request, res: Response) {
  const includeInactive = req.query.all === "true" && canManage(req);
  const sortByUsage = req.query.sort === "mostUsed";
  const limit = parseLimit(req.query.limit);

  const services = await cached(`services:list:${includeInactive}`, LIST_TTL_MS, () =>
    MunicipalServiceModel.list({ includeInactive })
  );
  const summaries = await reviewSummaries(
    services.map((service) => service.id),
    req.user!.sub,
    `services:stats:${includeInactive}`
  );

  let ordered = services;
  let usage: Map<number, number> | undefined;
  if (sortByUsage) {
    usage = await cached(`services:usage:${includeInactive}`, LIST_TTL_MS, () =>
      CitizenRequestModel.usageCounts(services.map((service) => service.id))
    );
    const counts = usage;
    ordered = [...services].sort((a, b) => {
      const diff = (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0);
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    });
  }
  if (limit !== null) ordered = ordered.slice(0, limit);

  res.json(
    ordered.map((service) => {
      const requestsCount = usage ? usage.get(service.id) ?? 0 : undefined;
      return municipalServiceView(service, summaries.get(service.id), requestsCount);
    })
  );
}

// Nombre d'avis, moyenne et avis du demandeur pour une liste de services : 2 requêtes quelle que soit la taille.
// Les moyennes sont les mêmes pour tout le monde (mises en cache si `statsCacheKey` est fourni) ;
// « avis du demandeur » est propre à chaque utilisateur et n'est jamais mis en cache.
async function reviewSummaries(
  serviceIds: number[],
  userId: number,
  statsCacheKey?: string
): Promise<Map<number, ReviewSummary>> {
  const [stats, mine] = await Promise.all([
    statsCacheKey
      ? cached(statsCacheKey, LIST_TTL_MS, () => ServiceReviewModel.statsForServices(serviceIds))
      : ServiceReviewModel.statsForServices(serviceIds),
    ServiceReviewModel.listByUser(userId),
  ]);
  const reviewed = new Set(mine.map((review) => Number(review.serviceId)));
  return new Map(
    serviceIds.map((id) => [
      id,
      { reviewsCount: stats.get(id)?.reviewsCount ?? 0, averageRating: stats.get(id)?.averageRating ?? null, reviewedByMe: reviewed.has(id) },
    ])
  );
}

// GET /api/services/:id
export async function getService(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const service = await MunicipalServiceModel.findById(id);
  // Un service désactivé est "introuvable" pour un non-gestionnaire
  if (!service || (!service.isActive && !canManage(req))) return res.status(404).json({ message: "Service introuvable" });
  const related = await relatedServices(service.id);
  const summaries = await reviewSummaries([service.id, ...related.map((item) => item.service.id)], req.user!.sub);
  res.json({
    ...municipalServiceView(service, summaries.get(service.id)),
    // 3 cartes « Autres services » sous le détail
    related: related.map(({ service: other, reason }) => ({ ...municipalServiceView(other, summaries.get(other.id)), reason })),
  });
}

const RELATED_COUNT = 3;

// Les 3 services à proposer sous un service : d'abord ceux que les mêmes habitants ont aussi sollicités
// (« often_together »), complétés par les plus demandés (« popular »), puis par l'ordre du catalogue (« catalog »).
// Toujours 3 dès que le catalogue compte au moins 4 services actifs, jamais le service lui-même ni un service désactivé.
async function relatedServices(serviceId: number) {
  return cached(`services:related:${serviceId}`, LIST_TTL_MS, async () => {
    const active = await cached("services:list:false", LIST_TTL_MS, () => MunicipalServiceModel.list({ includeInactive: false }));
    const byId = new Map(active.map((service) => [service.id, service]));
    const [together, usage] = await Promise.all([
      CitizenRequestModel.coUsage(serviceId, RELATED_COUNT),
      CitizenRequestModel.usageCounts(active.map((service) => service.id)),
    ]);
    const picked: { service: (typeof active)[number]; reason: "often_together" | "popular" | "catalog" }[] = [];
    const take = (id: number, reason: "often_together" | "popular" | "catalog") => {
      const service = byId.get(id);
      if (!service || id === serviceId || picked.some((item) => item.service.id === id) || picked.length >= RELATED_COUNT) return;
      picked.push({ service, reason });
    };
    for (const item of together) take(item.serviceId, "often_together");
    [...usage.entries()].filter(([, total]) => total > 0).sort((a, b) => b[1] - a[1]).forEach(([id]) => take(id, "popular"));
    active.forEach((service) => take(service.id, "catalog")); // déjà triés par ordre d'affichage
    return picked;
  });
}

// POST /api/services  { code, name, description?, icon?, isActive?, sortOrder? }
export async function createService(req: Request, res: Response) {
  const code = typeof req.body?.code === "string" ? req.body.code.trim().toLowerCase() : "";
  if (!CODE_REGEX.test(code)) {
    return res.status(400).json({ message: "Code invalide (minuscules, chiffres, - et _, 2 à 50 caractères, commence par une lettre)" });
  }
  const name = parseName(req.body?.name);
  if (!name) return res.status(400).json({ message: "Nom requis (150 caractères max)" });
  const description = parseNullableText(req.body?.description, 65000);
  const icon = parseNullableText(req.body?.icon, 255);
  if (description === "invalid") return res.status(400).json({ message: "Description invalide" });
  if (icon === "invalid") return res.status(400).json({ message: "Icône invalide (255 caractères max)" });
  if (req.body?.isActive !== undefined && typeof req.body.isActive !== "boolean") {
    return res.status(400).json({ message: "isActive doit être un booléen" });
  }
  const sortOrder = req.body?.sortOrder === undefined ? undefined : parseSortOrder(req.body.sortOrder);
  if (sortOrder === null) return res.status(400).json({ message: "sortOrder doit être un entier" });

  if (await MunicipalServiceModel.findByCode(code)) return res.status(409).json({ message: "Ce code de service existe déjà" });

  const service = await MunicipalServiceModel.create({ code, name, description, icon, isActive: req.body?.isActive, sortOrder });
  invalidate("services:");
  invalidate("essentials"); // le kit essentiel liste les services
  await audit(req, "service.create", { entityType: "municipal_services", entityId: service.id });
  res.status(201).json(municipalServiceView(service));
}

// PATCH /api/services/:id : le code n'est pas modifiable
export async function updateService(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });

  const data: MunicipalServiceUpdate = {};
  if (req.body?.name !== undefined) {
    const name = parseName(req.body.name);
    if (!name) return res.status(400).json({ message: "Nom invalide (150 caractères max)" });
    data.name = name;
  }
  const description = parseNullableText(req.body?.description, 65000);
  if (description === "invalid") return res.status(400).json({ message: "Description invalide" });
  if (description !== undefined) data.description = description;
  const icon = parseNullableText(req.body?.icon, 255);
  if (icon === "invalid") return res.status(400).json({ message: "Icône invalide (255 caractères max)" });
  if (icon !== undefined) data.icon = icon;
  if (req.body?.isActive !== undefined) {
    if (typeof req.body.isActive !== "boolean") return res.status(400).json({ message: "isActive doit être un booléen" });
    data.isActive = req.body.isActive;
  }
  if (req.body?.sortOrder !== undefined) {
    const sortOrder = parseSortOrder(req.body.sortOrder);
    if (sortOrder === null) return res.status(400).json({ message: "sortOrder doit être un entier" });
    data.sortOrder = sortOrder;
  }
  if (Object.keys(data).length === 0) {
    return res.status(400).json({ message: "Aucun champ à modifier (name, description, icon, isActive, sortOrder)" });
  }

  const service = await MunicipalServiceModel.update(id, data);
  invalidate("services:");
  invalidate("essentials"); // le kit essentiel liste les services
  if (!service) return res.status(404).json({ message: "Service introuvable" });
  await audit(req, "service.update", { entityType: "municipal_services", entityId: id });
  res.json(municipalServiceView(service));
}

// DELETE /api/services/:id
export async function deleteService(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  if (!(await MunicipalServiceModel.delete(id))) return res.status(404).json({ message: "Service introuvable" });
  invalidate("services:");
  invalidate("essentials"); // le kit essentiel liste les services
  await audit(req, "service.delete", { entityType: "municipal_services", entityId: id });
  res.status(204).send();
}
