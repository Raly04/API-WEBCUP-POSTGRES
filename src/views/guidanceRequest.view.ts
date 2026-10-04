import type { GuidanceRequestData, GuidanceSource } from "../models/guidanceRequest.model";

// Vue habitant : il voit le service proposé, la démarche, et la demande eventualmente déposée.
// Ni le modèle ayant répondu ni le mode de production ne le concernent : c'est de l'internal.
export interface GuidanceRequestView {
  id: number;
  problem: string;
  summary: string | null;
  steps: string[];
  service: { id: number; code: string; name: string } | null;
  // null tant que l'habitant n'a pas déposé de demande à partir de cette orientation
  request: { reference: string; subject: string; depositedAt: Date } | null;
  // Le repli par mots-clés est annoncé honnêtement : l'habitant doit savoir sur quoi repose l'orientation
  automatic: boolean;
  createdAt: Date;
}

export function guidanceRequestView(guidance: GuidanceRequestData): GuidanceRequestView {
  const { id, problem, summary, steps, service, request, source, createdAt } = guidance;
  return {
    id,
    problem,
    summary,
    // Une étape vide ou dupliquée n'aide pas : la projection filtre ce que le modèle a pu bavarder
    steps: (steps ?? []).filter((step) => step.trim().length > 0),
    service: service ? { id: service.id, code: service.code, name: service.name } : null,
    request: request
      ? { reference: `DEM-${request.id}`, subject: request.subject, depositedAt: request.createdAt }
      : null,
    automatic: source !== "llm",
    createdAt,
  };
}

// Vue administrateur : l'auteur et le mode de production, pour juger la qualité du routage
export interface GuidanceStaffView extends GuidanceRequestView {
  author: { id: number; name: string } | null;
  source: GuidanceSource;
  model: string | null;
}

export function guidanceStaffView(guidance: GuidanceRequestData): GuidanceStaffView {
  const { author, source, model } = guidance;
  return {
    ...guidanceRequestView(guidance),
    // null si le compte de l'auteur a été supprimé (FK ON DELETE CASCADE : la ligne disparaît aussi)
    author: author ? { id: author.id, name: `${author.firstName} ${author.lastName}`.trim() } : null,
    source,
    model,
  };
}