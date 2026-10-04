import type { MunicipalServiceData } from "../models/municipalService.model";

export interface ReviewSummary {
  // Avis des citoyens : nombre, moyenne (1 décimale, null sans avis) et avis déjà laissé par l'utilisateur connecté
  reviewsCount: number;
  averageRating: number | null;
  reviewedByMe: boolean;
}

export type MunicipalServiceView = MunicipalServiceData & ReviewSummary & { requestsCount?: number };

const NO_REVIEWS: ReviewSummary = { reviewsCount: 0, averageRating: null, reviewedByMe: false };

// requestsCount n'est porté que lorsqu'il a été calculé (tri "les plus utilisés") : absent sinon,
// plutôt que 0 par défaut, pour ne pas laisser croire qu'un service n'a aucune demande.
export function municipalServiceView(
  service: MunicipalServiceData,
  reviews: ReviewSummary = NO_REVIEWS,
  requestsCount?: number
): MunicipalServiceView {
  const { id, code, name, description, icon, isActive, sortOrder, createdAt, updatedAt } = service;
  return {
    id,
    code,
    name,
    description,
    icon,
    isActive,
    sortOrder,
    createdAt,
    updatedAt,
    ...reviews,
    ...(requestsCount !== undefined ? { requestsCount } : {}),
  };
}

// Catalogue public : les champs de gestion (isActive, sortOrder, horodatages) sont
// absents par construction, pas filtrés après coup
export interface PublicMunicipalServiceView {
  id: number;
  code: string;
  name: string;
  description: string | null;
  icon: string | null;
}

export function publicMunicipalServiceView(service: MunicipalServiceData): PublicMunicipalServiceView {
  const { id, code, name, description, icon } = service;
  return { id, code, name, description, icon };
}
