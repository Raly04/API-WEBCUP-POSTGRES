import { Request, Response } from "express";
import { AnnouncementModel } from "../models/announcement.model";
import { MunicipalServiceModel } from "../models/municipalService.model";
import { ProjectModel } from "../models/project.model";
import { parsePagination } from "../utils/http";
import { publicAnnouncementView } from "../views/announcement.view";
import { publicMunicipalServiceView } from "../views/municipalService.view";
import { publicProjectView } from "../views/project.view";

// GET /api/public/services
// Catalogue des services actif, destiné à la page d'accueil publique.
// `includeInactive: false` : un service désactivé par la ville disparaît du catalogue.
export async function listPublicServices(_req: Request, res: Response) {
  const services = await MunicipalServiceModel.list({ includeInactive: false });
  res.json(services.map(publicMunicipalServiceView));
}

// GET /api/public/announcements?page=&limit=
// Annonces publiées uniquement (jamais brouillons ni archives), sans l'auteur.
export async function listPublicAnnouncements(req: Request, res: Response) {
  const { page, limit, offset } = parsePagination(req);
  const { announcements, total } = await AnnouncementModel.list({ statuses: ["published"], limit, offset });
  res.json({ announcements: announcements.map(publicAnnouncementView), page, limit, total });
}

// GET /api/public/projects
// Les 3 projets les plus récents, destinés à la page d'accueil publique.
export async function listPublicProjects(_req: Request, res: Response) {
  res.json((await ProjectModel.listLatest(3)).map(publicProjectView));
}
