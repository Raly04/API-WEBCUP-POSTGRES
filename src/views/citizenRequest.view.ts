import type { CitizenRequestData, RequestPriority, RequestStatus } from "../models/citizenRequest.model";

// Vue citoyen : ni identifiant interne d'un agent, ni horodatage de gestion.
// Le citoyen voit l'avancement de sa demande, pas le circuit interne du service.
export interface CitizenRequestView {
  id: number;
  subject: string;
  description: string | null;
  status: RequestStatus;
  service: { id: number; code: string; name: string } | null;
  createdAt: Date;
  updatedAt: Date | null;
}

export function citizenRequestView(request: CitizenRequestData): CitizenRequestView {
  const { id, subject, description, status, service, createdAt, updatedAt } = request;
  return {
    id,
    subject,
    description,
    status,
    service: service ? { id: service.id, code: service.code, name: service.name } : null,
    createdAt,
    updatedAt,
  };
}

// Vue agent : ajoute le propriétaire et l'agent assigné, nécessaires au traitement
export interface AgentRequestView extends CitizenRequestView {
  priority: RequestPriority;
  userId: number;
  assignedTo: number | null;
  owner: { id: number; firstName: string; lastName: string } | null;
  assignee: { id: number; firstName: string; lastName: string } | null;
  // Nombre d'autres demandes qui parlent probablement du même problème (même service,
  // vocabulaire proche) ; absent quand non calculé (ex. demande sans service)
  similarCount?: number;
}

export function agentRequestView(request: CitizenRequestData, extra: { similarCount?: number } = {}): AgentRequestView {
  return {
    ...citizenRequestView(request),
    priority: request.priority,
    userId: request.userId,
    assignedTo: request.assignedTo,
    owner: request.owner
      ? { id: request.owner.id, firstName: request.owner.firstName, lastName: request.owner.lastName }
      : null,
    assignee: request.assignee
      ? { id: request.assignee.id, firstName: request.assignee.firstName, lastName: request.assignee.lastName }
      : null,
    ...(extra.similarCount !== undefined ? { similarCount: extra.similarCount } : {}),
  };
}

// Vue allégée pour la liste "demandes similaires" : pas besoin du circuit de traitement
export interface SimilarRequestView {
  id: number;
  subject: string;
  status: RequestStatus;
  owner: { id: number; firstName: string; lastName: string } | null;
  createdAt: Date;
}

export function similarRequestView(request: CitizenRequestData): SimilarRequestView {
  const { id, subject, status, owner, createdAt } = request;
  return {
    id,
    subject,
    status,
    owner: owner ? { id: owner.id, firstName: owner.firstName, lastName: owner.lastName } : null,
    createdAt,
  };
}

export interface RequestHistoryView {
  oldStatus: RequestStatus | null;
  newStatus: RequestStatus;
  note: string | null;
  changedAt: Date;
  author: { id: number; firstName: string; lastName: string } | null;
}

export function requestHistoryView(
  entry: {
    oldStatus: RequestStatus | null;
    newStatus: RequestStatus;
    note: string | null;
    changedAt: Date;
    author?: { id: number; firstName: string; lastName: string } | null;
  }
): RequestHistoryView {
  const { oldStatus, newStatus, note, changedAt, author } = entry;
  return {
    oldStatus,
    newStatus,
    note,
    changedAt,
    author: author ? { id: author.id, firstName: author.firstName, lastName: author.lastName } : null,
  };
}