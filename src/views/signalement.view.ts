import { ZONE_LABELS, type Zone } from "../models/alert.model";
import {
  SLA_MINUTES,
  TYPE_RULES,
  isOverdue,
  minutesSince,
  type SignalementData,
  type SignalementHistoryData,
  type SignalementPriority,
  type SignalementStatus,
  type SignalementType,
} from "../models/signalement.model";

// « Marie D. » : de quoi rassurer le déclarant (« pris en charge par ») sans exposer le nom complet d'un agent
const shortName = (person?: { firstName: string; lastName: string } | null) =>
  person ? `${person.firstName} ${person.lastName.slice(0, 1)}.` : null;

export interface CitizenSignalementView {
  id: number;
  type: SignalementType;
  label: { fr: string; en: string };
  priority: SignalementPriority;
  status: SignalementStatus;
  title: string;
  description: string | null;
  location: string;
  zone: Zone | null;
  zoneLabel: { fr: string; en: string } | null;
  contactPhone: string | null;
  createdAt: Date;
  // Heure du constat quand le signalement a été préparé hors ligne puis envoyé plus tard (sinon null)
  reportedAt: Date | null;
  // Pris en compte par l'équipe ? Quand, et par qui : c'est ce que veut savoir une personne qui a signalé une urgence
  acknowledged: boolean;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  handledBy: string | null;
}

// Vue du déclarant : son signalement et sa prise en charge. Pas de notes internes du personnel, pas d'identité complète.
export function citizenSignalementView(s: SignalementData): CitizenSignalementView {
  return {
    id: s.id,
    type: s.type,
    label: TYPE_RULES[s.type].label,
    priority: s.priority,
    status: s.status,
    title: s.title,
    description: s.description ?? null,
    location: s.location,
    zone: s.zone ?? null,
    zoneLabel: s.zone ? ZONE_LABELS[s.zone as Zone] : null,
    contactPhone: s.contactPhone ?? null,
    createdAt: s.createdAt,
    reportedAt: s.reportedAt ?? null,
    acknowledged: s.status !== "new",
    acknowledgedAt: s.acknowledgedAt ?? null,
    resolvedAt: s.resolvedAt ?? null,
    handledBy: s.status === "new" ? null : shortName(s.assignee),
  };
}

// Déroulé pour le déclarant : uniquement les changements d'état, sans notes internes ni identité de l'agent
export function citizenTimelineView(history: SignalementHistoryData[]) {
  return history
    .filter((entry) => entry.newStatus)
    .map((entry) => ({ at: entry.changedAt, status: entry.newStatus as SignalementStatus, action: entry.action }));
}

export interface StaffSignalementView extends CitizenSignalementView {
  emergency: boolean;
  reporter: { id: number; firstName: string; lastName: string } | null;
  assignedTo: number | null;
  assignee: { id: number; firstName: string; lastName: string } | null;
  // Aide au tri : depuis combien de temps il attend, son délai visé, et s'il est en retard
  ageMinutes: number;
  slaMinutes: number;
  overdue: boolean;
}

// Vue du personnel. `maskPhone` : un agent non validé ne voit pas le téléphone de rappel, sauf pour une URGENCE (voir
// utils/staffAccess) : joindre une personne en détresse ne doit jamais être retardé par une formalité.
export function staffSignalementView(s: SignalementData, options: { maskPhone?: boolean } = {}): StaffSignalementView {
  const base = citizenSignalementView(s);
  return {
    ...base,
    handledBy: shortName(s.assignee),
    contactPhone: options.maskPhone && s.priority !== "urgent" ? null : base.contactPhone,
    emergency: TYPE_RULES[s.type].emergency,
    reporter: s.reporter ? { id: s.reporter.id, firstName: s.reporter.firstName, lastName: s.reporter.lastName } : null,
    assignedTo: s.assignedTo ?? null,
    assignee: s.assignee ? { id: s.assignee.id, firstName: s.assignee.firstName, lastName: s.assignee.lastName } : null,
    ageMinutes: minutesSince(s.createdAt),
    slaMinutes: SLA_MINUTES[s.priority],
    overdue: isOverdue(s),
  };
}

export function staffHistoryView(history: SignalementHistoryData[]) {
  return history.map((entry) => ({
    at: entry.changedAt,
    action: entry.action,
    oldStatus: entry.oldStatus ?? null,
    newStatus: entry.newStatus ?? null,
    oldPriority: entry.oldPriority ?? null,
    newPriority: entry.newPriority ?? null,
    assignedTo: entry.assignedTo ?? null,
    note: entry.note ?? null,
    author: entry.author ? { id: entry.author.id, firstName: entry.author.firstName, lastName: entry.author.lastName } : null,
  }));
}

// Contenu minimal diffusé en temps réel au personnel : de quoi réagir, JAMAIS de donnée personnelle ni de santé
// (ni description, ni téléphone, ni identité du déclarant)
export function realtimeSignalementPayload(s: SignalementData) {
  return {
    id: s.id,
    type: s.type,
    priority: s.priority,
    status: s.status,
    title: s.title,
    location: s.location,
    zone: s.zone ?? null,
    createdAt: s.createdAt,
    assignedTo: s.assignedTo ?? null,
  };
}
