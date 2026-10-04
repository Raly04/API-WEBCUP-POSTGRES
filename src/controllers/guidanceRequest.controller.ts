import { Request, Response } from "express";
import { GuidanceRequestModel, type GuidanceSource } from "../models/guidanceRequest.model";
import { CitizenRequestModel } from "../models/citizenRequest.model";
import { MunicipalServiceModel } from "../models/municipalService.model";
import { askModelForGuidance, llmModelName } from "../utils/guidance/llm.client";
import { matchServiceByKeywords } from "../utils/guidance/keywordMatcher";
import { audit } from "../utils/audit";
import { parseId, parsePagination } from "../utils/http";
import { invalidate } from "../utils/responseCache";
import { guidanceRequestView, guidanceStaffView } from "../views/guidanceRequest.view";

const MIN_PROBLEM_LENGTH = 10;
const MAX_PROBLEM_LENGTH = 2000;

function parseProblem(value: unknown): string | null {
  const problem = typeof value === "string" ? value.trim() : "";
  return problem.length >= MIN_PROBLEM_LENGTH && problem.length <= MAX_PROBLEM_LENGTH ? problem : null;
}

// POST /api/guidance-requests  { problem }
// L'habitant décrit son problème et reçoit le service compétent et la démarche. Le modèle est
// essayé d'abord ; en cas d'échec, de délai dépassé ou de réponse inexploitable, le routage par
// mots-clés prend le relais. Aucun service n'est retenu quand aucun recoupement n'est crédible :
// proposer le premier de la liste serait un mensonge, et l'interface invite alors l'habitant à
// déposer une demande sans service.
export async function createGuidanceRequest(req: Request, res: Response) {
  const problem = parseProblem(req.body?.problem);
  if (!problem) {
    return res.status(400).json({
      message: `Votre problème doit contenir entre ${MIN_PROBLEM_LENGTH} et ${MAX_PROBLEM_LENGTH} caractères`,
    });
  }

  const services = await MunicipalServiceModel.list({ includeInactive: false });
  const answer = await askModelForGuidance(problem, services);

  let serviceId: number | null = null;
  let summary: string | null = null;
  let steps: string[] = [];
  let source: GuidanceSource = "fallback";
  let model: string | null = null;

  if (answer && answer.serviceCode) {
    const service = services.find((candidate) => candidate.code === answer.serviceCode) ?? null;
    if (service) {
      serviceId = service.id;
      summary = answer.summary;
      steps = answer.steps;
      source = "llm";
      model = llmModelName();
    }
  }

  // Le repli sait désigner un service, pas rédiger une démarche : steps reste vide et l'interface
  // le signale à l'habitant plutôt que de faire croire à une réponse rédigée.
if (source === "fallback") {
    const { service } = matchServiceByKeywords(problem, services);
    serviceId = service ? service.id : null;
  }

  const guidance = await GuidanceRequestModel.create({
    userId: req.user!.sub,
    problem,
    serviceId,
    summary,
    steps,
    source,
    model,
  });
  void audit(req, "guidance.create", { entityType: "guidance_requests", entityId: guidance.id });

  res.status(201).json({ guidance: guidanceRequestView(guidance) });
}

// POST /api/guidance-requests/:id/deposit
// L'habitant suit la démarche proposée : la demande part dans le service que l'orientation a
// désigné, avec le problème décrit en objet et la démarche en description. Déposer deux fois la
// même orientation est refusé : le bouton disparaît côté client après le premier dépôt.
export async function depositGuidanceRequest(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant d'orientation invalide" });

  const guidance = await GuidanceRequestModel.findOwnedBy(id, req.user!.sub);
  if (!guidance) return res.status(404).json({ message: "Orientation introuvable" });
  if (guidance.requestId) {
    return res.status(409).json({ message: "Cette orientation a déjà donné lieu à une demande" });
  }
  if (!guidance.serviceId) {
    return res.status(422).json({
      message: "Aucun service n'a été identifié pour cette orientation : déposez une demande sans service",
    });
  }

  const request = await CitizenRequestModel.create({
    userId: req.user!.sub,
    serviceId: guidance.serviceId,
    subject: guidance.summary ?? guidance.problem.slice(0, 255),
    description: guidance.problem,
  });
  const updated = await GuidanceRequestModel.attachRequest(id, req.user!.sub, request.id);
  if (!updated) {
    return res.status(409).json({ message: "Cette orientation a déjà donné lieu à une demande" });
  }
  // Une nouvelle demande change le classement "les plus utilisés" des services
  invalidate("services:usage");
  void audit(req, "request.create", { entityType: "citizen_requests", entityId: request.id });

  res.status(201).json({
    guidance: guidanceRequestView(updated),
    request: { reference: `DEM-${request.id}`, subject: request.subject },
  });
}

// GET /api/guidance-requests?page=&limit= : file des orientations, réservée à l'administration.
// C'est le seul endroit où l'on peut juger si le routage est pertinent : `source` dit combien de
// réponses ont été produites sans le modèle.
export async function listGuidanceRequests(req: Request, res: Response) {
  const { page, limit, offset } = parsePagination(req);
  const { guidance, total } = await GuidanceRequestModel.listAll({ limit, offset });
  res.json({
    guidance: guidance.map(guidanceStaffView),
    page,
    limit,
    total,
  });
}

