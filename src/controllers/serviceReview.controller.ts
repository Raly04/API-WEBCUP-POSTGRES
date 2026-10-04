import { Request, Response } from "express";
import { MunicipalServiceModel } from "../models/municipalService.model";
import { ServiceReviewModel } from "../models/serviceReview.model";
import { audit } from "../utils/audit";
import { parseId, parsePagination } from "../utils/http";
import { myReviewView, serviceReviewView } from "../views/serviceReview.view";
import { invalidate } from "../utils/responseCache";

const MAX_COMMENT_LENGTH = 2000;

// GET /api/services/:id/reviews?page=&limit=
export async function listServiceReviews(req: Request, res: Response) {
  const serviceId = parseId(req.params.id);
  if (!serviceId) return res.status(400).json({ message: "Identifiant invalide" });
  const service = await MunicipalServiceModel.findById(serviceId);
  if (!service || !service.isActive) return res.status(404).json({ message: "Service introuvable" });

  const { page, limit, offset } = parsePagination(req);
  const [{ reviews, total }, stats] = await Promise.all([
    ServiceReviewModel.list(serviceId, { limit, offset }),
    ServiceReviewModel.statsForServices([serviceId]),
  ]);
  const summary = stats.get(serviceId) ?? { reviewsCount: 0, averageRating: null };
  res.json({ reviews: reviews.map(serviceReviewView), ...summary, page, limit, total });
}

// GET /api/services/reviews/mine : avis déposés par le citoyen connecté
export async function listMyReviews(req: Request, res: Response) {
  const reviews = await ServiceReviewModel.listByUser(req.user!.sub);
  res.json(reviews.map(myReviewView));
}

// POST /api/services/:id/reviews  { rating: 1..5, comment }
// Réservé au citoyen dont une demande a été traitée sur ce service, une seule fois par service.
export async function createServiceReview(req: Request, res: Response) {
  const serviceId = parseId(req.params.id);
  if (!serviceId) return res.status(400).json({ message: "Identifiant invalide" });
  const userId = req.user!.sub;

  const rating = req.body?.rating;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ message: "La note doit être un entier de 1 à 5" });
  }
  const comment = typeof req.body?.comment === "string" ? req.body.comment.trim() : "";
  if (comment.length < 3 || comment.length > MAX_COMMENT_LENGTH) {
    return res.status(400).json({ message: `Le commentaire doit contenir entre 3 et ${MAX_COMMENT_LENGTH} caractères` });
  }

  const service = await MunicipalServiceModel.findById(serviceId);
  if (!service || !service.isActive) return res.status(404).json({ message: "Service introuvable" });
  if (!(await ServiceReviewModel.hasResolvedRequest(serviceId, userId))) {
    return res.status(403).json({ message: "Vous pouvez donner votre avis une fois une de vos demandes traitée sur ce service" });
  }
  if (await ServiceReviewModel.findByUser(serviceId, userId)) {
    return res.status(409).json({ message: "Vous avez déjà donné votre avis sur ce service" });
  }

  const review = await ServiceReviewModel.create({ serviceId, userId, rating, comment });
  invalidate("services:stats");
  await audit(req, "review.create", { entityType: "municipal_services", entityId: serviceId });
  res.status(201).json(myReviewView(review));
}
