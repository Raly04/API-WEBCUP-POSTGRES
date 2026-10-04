import { Request, Response } from "express";
import {
  ANNOUNCEMENT_PRIORITIES,
  ANNOUNCEMENT_STATUSES,
  AnnouncementModel,
  AnnouncementPriority,
  AnnouncementStatus,
  AnnouncementUpdate,
} from "../models/announcement.model";
import { broadcastAnnouncement } from "../realtime/announcementChannel";
import { audit } from "../utils/audit";
import { cached, invalidate } from "../utils/responseCache";
import { parseId, parsePagination } from "../utils/http";
import { announcementView, publicAnnouncementView } from "../views/announcement.view";
import type { AnnouncementData } from "../models/announcement.model";

const MANAGE_PERMISSION = "agent.announcements.manage";
// MAX signifie « annonce du Haut Conseil » : elle déclenche une alerte rouge, donc elle est
// réservée à l'administration. Un agent peut gérer les annonces, pas imiter le Haut Conseil.
const URGENT_PERMISSION = "admin.announcements.urgent";
const LIST_TTL_MS = 15_000;

function canManage(req: Request): boolean {
  return req.user?.permissions?.includes(MANAGE_PERMISSION) === true;
}

function canPublishUrgent(req: Request): boolean {
  return req.user?.permissions?.includes(URGENT_PERMISSION) === true;
}

function parseTitle(value: unknown): string | null {
  const title = typeof value === "string" ? value.trim() : "";
  return title.length > 0 && title.length <= 255 ? title : null;
}

function parseContent(value: unknown): string | null {
  const content = typeof value === "string" ? value.trim() : "";
  return content.length > 0 && content.length <= 65000 ? content : null;
}

function parseStatus(value: unknown): AnnouncementStatus | null {
  return (ANNOUNCEMENT_STATUSES as readonly unknown[]).includes(value) ? (value as AnnouncementStatus) : null;
}

function parsePriority(value: unknown): AnnouncementPriority | null {
  return (ANNOUNCEMENT_PRIORITIES as readonly unknown[]).includes(value) ? (value as AnnouncementPriority) : null;
}

// Priorité demandée, en distinguant « absent » de « invalide » pour ne pas casser les
// appels existants qui ne l'envoient pas. Un refus de droit renvoie 403, une valeur
// mal formée 400 : les deux causes ne se confondent pas.
function readPriority(req: Request): { value?: AnnouncementPriority; error?: string; status?: 400 | 403 } {
  if (req.body?.priority === undefined) return {};
  const priority = parsePriority(req.body.priority);
  if (!priority) return { error: "priorité invalide (default, medium ou max)", status: 400 };
  if (priority === "max" && !canPublishUrgent(req)) {
    return {
      error: "Seul un administrateur peut publier une annonce prioritaire du Haut Conseil",
      status: 403,
    };
  }
  return { value: priority };
}

// Une annonce qui devient publique est diffusée immédiatement à tous les clients connectés.
function publish(announcement: AnnouncementData) {
  invalidate("announcements:");
  broadcastAnnouncement(publicAnnouncementView(announcement));
}

// GET /api/announcements?q=&status=&page=&limit=
// Un citoyen ne voit que les annonces publiées. Un gestionnaire peut filtrer : status=draft|published|archived|all
export async function listAnnouncements(req: Request, res: Response) {
  const { page, limit, offset } = parsePagination(req);
  const search = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim().slice(0, 100) : undefined;

  let statuses: AnnouncementStatus[] = ["published"];
  if (canManage(req) && req.query.status !== undefined) {
    if (req.query.status === "all") statuses = [...ANNOUNCEMENT_STATUSES];
    else {
      const status = parseStatus(req.query.status);
      if (!status) return res.status(400).json({ message: "status invalide (draft, published, archived ou all)" });
      statuses = [status];
    }
  }

  const load = async () => {
    const { announcements, total } = await AnnouncementModel.list({ statuses, search, limit, offset });
    return { announcements: announcements.map(announcementView), page, limit, total };
  };

  // Le contenu est le même pour tous les utilisateurs : mis en cache serveur, sauf recherche libre (clés illimitées).
  const payload = search
    ? await load()
    : await cached(`announcements:list:${statuses.join(",")}:${page}:${limit}`, LIST_TTL_MS, load);

  // Les gestionnaires voient leurs modifications tout de suite : pas de cache navigateur pour eux. Pour les
  // autres, le navigateur peut resservir la liste pendant qu'il la revalide (utile si le réseau est lent).
  if (!canManage(req)) res.set("Cache-Control", "private, max-age=15, stale-while-revalidate=60");
  res.json(payload);
}

// GET /api/announcements/:id
export async function getAnnouncement(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const announcement = await AnnouncementModel.findById(id);
  // Brouillons et archives : "introuvables" pour un non-gestionnaire
  if (!announcement || (announcement.status !== "published" && !canManage(req))) {
    return res.status(404).json({ message: "Annonce introuvable" });
  }
  res.json(announcementView(announcement));
}

// POST /api/announcements  { title, content, status?, priority? }  : brouillon par défaut
export async function createAnnouncement(req: Request, res: Response) {
  const title = parseTitle(req.body?.title);
  if (!title) return res.status(400).json({ message: "Titre requis (255 caractères max)" });
  const content = parseContent(req.body?.content);
  if (!content) return res.status(400).json({ message: "Contenu requis (65000 caractères max)" });
  const status = req.body?.status === undefined ? "draft" : parseStatus(req.body.status);
  if (!status) return res.status(400).json({ message: "status invalide (draft, published ou archived)" });
  const priority = readPriority(req);
  if (priority.error) return res.status(priority.status!).json({ message: priority.error });

  const announcement = await AnnouncementModel.create({
    title,
    content,
    status,
    priority: priority.value ?? "default",
    authorId: req.user!.sub,
  });
  // Une annonce publiée à la création est diffusée comme une annonce publiée par mise à jour
  if (status === "published") publish(announcement);
  else invalidate("announcements:");
  await audit(req, "announcement.create", { entityType: "announcements", entityId: announcement.id });
  res.status(201).json(announcementView(announcement));
}

// PATCH /api/announcements/:id  { title?, content?, status?, priority? }
// Règles de publication : published -> published_at = maintenant (si jamais publiée) ; draft -> published_at effacé ;
// archived -> la date de publication est conservée.
export async function updateAnnouncement(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });

  const data: AnnouncementUpdate = {};
  if (req.body?.title !== undefined) {
    const title = parseTitle(req.body.title);
    if (!title) return res.status(400).json({ message: "Titre invalide (255 caractères max)" });
    data.title = title;
  }
  if (req.body?.content !== undefined) {
    const content = parseContent(req.body.content);
    if (!content) return res.status(400).json({ message: "Contenu invalide (65000 caractères max)" });
    data.content = content;
  }
  if (req.body?.status !== undefined) {
    const status = parseStatus(req.body.status);
    if (!status) return res.status(400).json({ message: "status invalide (draft, published ou archived)" });
    data.status = status;
  }
  const priority = readPriority(req);
  if (priority.error) return res.status(priority.status!).json({ message: priority.error });
  if (priority.value) data.priority = priority.value;
  if (Object.keys(data).length === 0) {
    return res.status(400).json({ message: "Aucun champ à modifier (title, content, status, priority)" });
  }

  const current = await AnnouncementModel.findById(id);
  if (!current) return res.status(404).json({ message: "Annonce introuvable" });

  if (data.status === "published" && !current.publishedAt) data.publishedAt = new Date();
  if (data.status === "draft") data.publishedAt = null;

  const announcement = await AnnouncementModel.update(id, data);
  // Diffusion au moment où l'annonce devient visible : c'est le seul instant utile au client
  if (data.status === "published" && current.status !== "published") publish(announcement!);
  else invalidate("announcements:");
  const action = data.status && data.status !== current.status ? `announcement.${data.status}` : "announcement.update";
  await audit(req, action, { entityType: "announcements", entityId: id });
  res.json(announcementView(announcement!));
}

// DELETE /api/announcements/:id
export async function deleteAnnouncement(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  if (!(await AnnouncementModel.delete(id))) return res.status(404).json({ message: "Annonce introuvable" });
  invalidate("announcements:");
  await audit(req, "announcement.delete", { entityType: "announcements", entityId: id });
  res.status(204).send();
}
