import type { ServiceReviewData } from "../models/serviceReview.model";

export interface ServiceReviewView {
  id: number;
  serviceId: number;
  rating: number;
  comment: string;
  // Prénom et initiale du nom : les avis sont visibles de tous les citoyens
  authorName: string;
  createdAt: Date;
}

export function serviceReviewView(review: ServiceReviewData): ServiceReviewView {
  const { id, serviceId, rating, comment, createdAt, author } = review;
  const initial = author?.lastName ? `${author.lastName[0].toUpperCase()}.` : "";
  return { id, serviceId, rating, comment, authorName: author ? `${author.firstName} ${initial}`.trim() : "—", createdAt };
}

// Avis du citoyen connecté : sans nom d'auteur, c'est le sien
export function myReviewView(review: ServiceReviewData) {
  const { id, serviceId, rating, comment, createdAt } = review;
  return { id, serviceId, rating, comment, createdAt };
}
