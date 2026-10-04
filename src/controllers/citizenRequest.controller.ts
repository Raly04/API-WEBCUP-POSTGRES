import { Request, Response } from "express";
import {
  CitizenRequestModel,
  RequestHistoryModel,
  REQUEST_STATUSES,
  REQUEST_PRIORITIES,
  canTransition,
  isRequestPriority,
  isRequestStatus,
  type RequestPriority,
  type CitizenRequestData,
  type RequestStatus,
} from "../models/citizenRequest.model";
import { MunicipalServiceModel } from "../models/municipalService.model";
import { audit } from "../utils/audit";
import { parseId, parsePagination } from "../utils/http";
import { invalidate } from "../utils/responseCache";
import { SIMILARITY_THRESHOLD, sharedTokenCount, tokenize } from "../utils/textSimilarity";
import {
  agentRequestView,
  citizenRequestView,
  requestHistoryView,
  similarRequestView,
} from "../views/citizenRequest.view";

function parseSubject(value: unknown): string | null {
  const subject = typeof value === "string" ? value.trim() : "";
  return subject.length > 0 && subject.length <= 255 ? subject : null;
}

function parseDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const description = typeof value === "string" ? value.trim() : "";
  if (description.length === 0) return null;
  return description.length <= 5000 ? description : null;
}

function parseNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const note = typeof value === "string" ? value.trim() : "";
  if (note.length === 0) return null;
  return note.length <= 2000 ? note : null;
}

// Recherche libre : absente si vide, bornée pour éviter une requête LIKE démesurée
function parseSearch(req: Request): string | undefined {
  const raw = typeof req.query.q === "string" ? req.query.q.trim() : "";
  return raw ? raw.slice(0, 200) : undefined;
}

// Mots significatifs de l'objet + description, utilisés pour repérer les demandes similaires
function requestTokens(request: Pick<CitizenRequestData, "subject" | "description">) {
  return tokenize(`${request.subject} ${request.description ?? ""}`);
}

function parseServiceId(req: Request): number | null | "invalid" {
  if (req.body?.serviceId === undefined || req.body?.serviceId === null) return null;
  const id = parseId(req.body.serviceId);
  return id === null ? "invalid" : id;
}

// Un rejet sans motif est inexploitable pour le citoyen : la note devient obligatoire
// sur les transitions finales.
// undefined = pas de filtre ; null = filtre invalide (400)
function parseStatusFilters(req: Request): RequestStatus[] | null | undefined {
  const raw = typeof req.query.status === "string" ? req.query.status : undefined;
  if (!raw) return undefined;
  if (raw === "all") return [...REQUEST_STATUSES];
  const statuses = raw.split(",").map((value) => value.trim());
  return statuses.every(isRequestStatus) ? (statuses as RequestStatus[]) : null;
}

// undefined = pas de filtre ; null = filtre invalide (400). Valeurs séparées par des virgules : ?priority=urgent,high
function parsePriorityFilters(req: Request): RequestPriority[] | null | undefined {
  const raw = typeof req.query.priority === "string" ? req.query.priority : undefined;
  if (!raw) return undefined;
  if (raw === "all") return [...REQUEST_PRIORITIES];
  const priorities = raw.split(",").map((value) => value.trim());
  return priorities.every(isRequestPriority) ? (priorities as RequestPriority[]) : null;
}

// undefined = pas de filtre ; null = date invalide (400). Le front envoie un "YYYY-MM-DD" (input date natif)
function parseDateParam(value: unknown): Date | null | undefined {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Une date seule vaut minuit UTC : pour que la journée de fin soit incluse en entier, on la
// borne à sa dernière milliseconde plutôt que de filtrer sur un instant qui exclurait tout le jour.
function endOfDayUTC(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));
}

// POST /api/requests  { serviceId?, subject, description? }
export async function createRequest(req: Request, res: Response) {
  const subject = parseSubject(req.body?.subject);
  if (!subject) return res.status(400).json({ message: "Objet requis (255 caractères max)" });

  const description = parseDescription(req.body?.description);
  if (description === null && req.body?.description !== undefined && req.body?.description !== null) {
    return res.status(400).json({ message: "Description invalide (5000 caractères max)" });
  }

  const serviceId = parseServiceId(req);
  if (serviceId === "invalid") return res.status(400).json({ message: "Service invalide" });
  if (serviceId !== null && !(await MunicipalServiceModel.findById(serviceId))) {
    return res.status(400).json({ message: "Service introuvable" });
  }

  const request = await CitizenRequestModel.create({
    userId: req.user!.sub,
    serviceId,
    subject,
    description,
  });
  // Une nouvelle demande change le classement "les plus utilisés" des services
  invalidate("services:usage");
  await audit(req, "request.create", { entityType: "citizen_requests", entityId: request.id });
  res.status(201).json(citizenRequestView(request));
}

// GET /api/requests/mine?status=&from=&to=
export async function listMyRequests(req: Request, res: Response) {
  const statuses = parseStatusFilters(req);
  if (statuses === null) {
    return res.status(400).json({ message: "Statut invalide (pending, in_progress, resolved, rejected ou all)" });
  }
  const createdFrom = parseDateParam(req.query.from);
  if (createdFrom === null) return res.status(400).json({ message: "Date de début invalide" });
  const createdToDay = parseDateParam(req.query.to);
  if (createdToDay === null) return res.status(400).json({ message: "Date de fin invalide" });

  const { limit, offset } = parsePagination(req);
  const { requests, total } = await CitizenRequestModel.list({
    userId: req.user!.sub,
    statuses,
    createdFrom,
    createdTo: createdToDay ? endOfDayUTC(createdToDay) : undefined,
    limit,
    offset,
  });
  res.json({ requests: requests.map(citizenRequestView), limit, offset, total });
}

// GET /api/requests/mine/:id  — demande + historique des transitions
export async function getMyRequest(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });

  const owned = await CitizenRequestModel.findOwnedById(id, req.user!.sub);
  if (!owned) return res.status(404).json({ message: "Demande introuvable" });

  const history = await RequestHistoryModel.listByRequest(id);
  res.json({ ...citizenRequestView(owned), history: history.map(requestHistoryView) });
}

// GET /api/requests?status=&priority=&sort=&assignedTo=&mine=
export async function listRequests(req: Request, res: Response) {
  const statuses = parseStatusFilters(req);
  if (statuses === null) {
    return res.status(400).json({ message: "Statut invalide (pending, in_progress, resolved, rejected ou all)" });
  }
  const priorities = parsePriorityFilters(req);
  if (priorities === null) {
    return res.status(400).json({ message: "Priorité invalide (low, medium, high, urgent ou all)" });
  }
  if (req.query.sort !== undefined && req.query.sort !== "priority") {
    return res.status(400).json({ message: "Tri invalide (priority)" });
  }

  // mine=true : file personally suivie par l'agent connecté
  const mine = req.query.mine === "true";
  const assignedTo = mine ? req.user!.sub : parseId(req.query.assignedTo);
  if (req.query.assignedTo !== undefined && !mine && assignedTo === null) {
    return res.status(400).json({ message: "Agent invalide" });
  }

  const { limit, offset } = parsePagination(req);
  const { requests, total } = await CitizenRequestModel.list({
    statuses,
    priorities,
    sort: req.query.sort === "priority" ? "priority" : undefined,
    assignedTo: mine || req.query.assignedTo !== undefined ? assignedTo : undefined,
    q: parseSearch(req),
    limit,
    offset,
  });

  // Repérage de demandes similaires : un candidat par groupe présent sur la page (un service,
  // ou le groupe "sans service" — null est un groupe comme un autre), mots significatifs
  // pré-calculés une seule fois (évite de retokeniser à chaque comparaison).
  const serviceGroups = [...new Set(requests.map((r) => r.serviceId))];
  const candidatesByService = new Map<number | null, { request: CitizenRequestData; tokens: Set<string> }[]>();
  await Promise.all(
    serviceGroups.map(async (serviceId) => {
      const candidates = await CitizenRequestModel.listCandidatesByService(serviceId);
      candidatesByService.set(
        serviceId,
        candidates.map((candidate) => ({ request: candidate, tokens: requestTokens(candidate) }))
      );
    })
  );

  const views = requests.map((request) => {
    const candidates = candidatesByService.get(request.serviceId) ?? [];
    const tokens = requestTokens(request);
    const similarCount = candidates.filter(
      (candidate) => candidate.request.id !== request.id && sharedTokenCount(tokens, candidate.tokens) >= SIMILARITY_THRESHOLD
    ).length;
    return agentRequestView(request, { similarCount });
  });

  res.json({ requests: views, limit, offset, total });
}

// GET /api/requests/:id/similar  — demandes qui parlent probablement du même problème
export async function getSimilarRequests(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });

  const request = await CitizenRequestModel.findById(id);
  if (!request) return res.status(404).json({ message: "Demande introuvable" });

  const candidates = await CitizenRequestModel.listCandidatesByService(request.serviceId, { excludeId: id });
  const tokens = requestTokens(request);
  const similar = candidates
    .map((candidate) => ({ candidate, score: sharedTokenCount(tokens, requestTokens(candidate)) }))
    .filter(({ score }) => score >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ candidate }) => similarRequestView(candidate));

  res.json(similar);
}

// GET /api/requests/:id — vue agent, avec l'historique
export async function getRequest(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });

  const request = await CitizenRequestModel.findById(id);
  if (!request) return res.status(404).json({ message: "Demande introuvable" });

  const history = await RequestHistoryModel.listByRequest(id);
  res.json({ ...agentRequestView(request), history: history.map(requestHistoryView) });
}

// PATCH /api/requests/:id  { status?, assignedTo?, priority?, note? }
export async function updateRequest(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });

  const current = await CitizenRequestModel.findById(id);
  if (!current) return res.status(404).json({ message: "Demande introuvable" });

  const note = parseNote(req.body?.note);
  if (note === null && req.body?.note !== undefined && req.body?.note !== null) {
    return res.status(400).json({ message: "Note invalide (2000 caractères max)" });
  }

  const wantsStatus = req.body?.status !== undefined;
  const wantsAssignation = req.body?.assignedTo !== undefined;

  // Validée avant toute écriture : une priorité invalide ne doit pas laisser une modification à moitié faite.
  let priority: RequestPriority | undefined;
  if (req.body?.priority !== undefined) {
    if (!isRequestPriority(req.body.priority)) {
      return res.status(400).json({ message: "Priorité invalide (low, medium, high, urgent)" });
    }
    priority = req.body.priority;
  }

  if (!wantsStatus && !wantsAssignation && priority === undefined) {
    return res.status(400).json({ message: "Aucun champ à modifier (status, assignedTo, priority, note)" });
  }

  // Classer seulement : pas de changement d'état, donc pas de ligne d'historique des statuts
  if (!wantsStatus && !wantsAssignation) {
    if (priority === current.priority) {
      return res.status(400).json({ message: `La demande a déjà la priorité ${current.priority}` });
    }
    const updated = await CitizenRequestModel.setPriority(id, priority!);
    await audit(req, "request.priority", { entityType: "citizen_requests", entityId: id });
    const history = await RequestHistoryModel.listByRequest(id);
    return res.json({ ...agentRequestView(updated!), history: history.map(requestHistoryView) });
  }

  // Combinée à un changement de statut ou d'assignation : appliquée dans la même transaction, seulement si elle change
  const newPriority = priority !== undefined && priority !== current.priority ? priority : undefined;

  let assignedTo = current.assignedTo;
  if (wantsAssignation) {
    if (req.body.assignedTo === null) {
      assignedTo = null;
    } else {
      const agentId = parseId(req.body.assignedTo);
      if (!agentId) return res.status(400).json({ message: "Agent invalide" });
      assignedTo = agentId;
    }
  }

  // Une simple assignation ne change pas le statut : le dépôt serait un changement
  // d'état sans ligne d'historique.
  if (!wantsStatus) {
    if (assignedTo === current.assignedTo) {
      return res.status(400).json({ message: "La demande est déjà assignée à cet agent" });
    }
    const updated = await CitizenRequestModel.transition(
      id,
      { status: current.status, assignedTo, priority: newPriority },
      req.user!.sub,
      note
    );
    await audit(req, "request.assign", { entityType: "citizen_requests", entityId: id });
    if (newPriority) await audit(req, "request.priority", { entityType: "citizen_requests", entityId: id });
    const history = await RequestHistoryModel.listByRequest(id);
    return res.json({ ...agentRequestView(updated!), history: history.map(requestHistoryView) });
  }

  if (!isRequestStatus(req.body.status)) {
    return res.status(400).json({ message: "Statut invalide (pending, in_progress, resolved, rejected)" });
  }
  const nextStatus = req.body.status;
  if (nextStatus === current.status) {
    return res.status(400).json({ message: `La demande est déjà au statut ${current.status}` });
  }
  if (!canTransition(current.status, nextStatus)) {
    return res.status(409).json({
      message: `Transition impossible de ${current.status} vers ${nextStatus}`,
    });
  }
  if ((nextStatus === "resolved" || nextStatus === "rejected") && !note) {
    return res.status(400).json({ message: "Un motif est obligatoire pour clôturer la demande" });
  }

  const updated = await CitizenRequestModel.transition(
    id,
    { status: nextStatus, assignedTo: wantsAssignation ? assignedTo : undefined, priority: newPriority },
    req.user!.sub,
    note
  );
  await audit(req, `request.${nextStatus}`, { entityType: "citizen_requests", entityId: id });
  if (newPriority) await audit(req, "request.priority", { entityType: "citizen_requests", entityId: id });

  // Pas de notification ici : la transition est décidée par un agent, dont la langue n'est pas celle
  // du citoyen. Le texte est figé en base, donc il est produit plus tard, à la lecture par le
  // citoyen (ensureRequestStatusNotifications), dans sa langue.
  const history = await RequestHistoryModel.listByRequest(id);
  res.json({ ...agentRequestView(updated!), history: history.map(requestHistoryView) });
}
