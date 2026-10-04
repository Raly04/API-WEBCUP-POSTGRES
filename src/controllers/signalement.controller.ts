import { Request, Response } from "express";
import { AlertModel, ZONES, isZone, type Zone } from "../models/alert.model";
import { resolveLocale } from "../models/notification.model";
import { PermissionModel } from "../models/permission.model";
import {
  CLOSED_STATUSES,
  OPEN_STATUSES,
  SIGNALEMENT_PRIORITIES,
  SIGNALEMENT_STATUSES,
  SIGNALEMENT_TYPES,
  SLA_MINUTES,
  SignalementModel,
  TYPE_RULES,
  isSignalementPriority,
  isSignalementStatus,
  isSignalementType,
  type SignalementPriority,
  type SignalementStatus,
  type SignalementType,
} from "../models/signalement.model";
import { SIGNALEMENT_NEW_EVENT, SIGNALEMENT_UPDATED_EVENT, notifyStaff } from "../realtime/staffChannel";
import { audit } from "../utils/audit";
import { parseId, parsePagination } from "../utils/http";
import { isUnvalidatedAgent } from "../utils/staffAccess";
import { publicAlertView } from "../views/alert.view";
import {
  citizenSignalementView,
  citizenTimelineView,
  realtimeSignalementPayload,
  staffHistoryView,
  staffSignalementView,
} from "../views/signalement.view";

const EMERGENCY_NUMBER = process.env.EMERGENCY_NUMBER?.trim();
const MANAGE_PERMISSION = "agent.signalements.manage";

const parseText = (value: unknown, min: number, max: number): string | null | "invalid" => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "invalid";
  const text = value.trim();
  if (text === "") return null;
  return text.length >= min && text.length <= max ? text : "invalid";
};

function guidance(type: SignalementType, lang: "fr" | "en"): string {
  const rule = TYPE_RULES[type];
  const number = EMERGENCY_NUMBER ? ` (${EMERGENCY_NUMBER})` : "";
  if (lang === "en") {
    return rule.emergency
      ? `Your alert has been sent to the response teams. If a life is in immediate danger, also contact the emergency services${number}.`
      : "Your report has been sent to the teams. You can follow its handling on this page.";
  }
  return rule.emergency
    ? `Votre alerte a été transmise aux équipes d'intervention. Si une vie est en danger immédiat, contactez aussi les secours${number}.`
    : "Votre signalement a été transmis aux équipes. Vous pouvez suivre sa prise en charge sur cette page.";
}

// ── Déclarant ────────────────────────────────────────────────────────────────────────────

// GET /api/signalements/types : les types proposés, avec leur priorité automatique
export function listSignalementTypes(_req: Request, res: Response) {
  res.json(
    SIGNALEMENT_TYPES.map((code) => ({
      code,
      label: TYPE_RULES[code].label,
      defaultPriority: TYPE_RULES[code].defaultPriority,
      emergency: TYPE_RULES[code].emergency,
    }))
  );
}

// POST /api/signalements  { type, location, title?, description?, contactPhone?, lifeThreatening? }
// La priorité n'est JAMAIS lue dans la requête : elle découle du type (médical et incendie sont urgents d'office), et le
// déclarant ne peut que l'ÉLEVER en indiquant qu'une personne est en danger immédiat.
export async function createSignalement(req: Request, res: Response) {
  const type = req.body?.type;
  if (!isSignalementType(type)) return res.status(400).json({ message: `Type invalide (${SIGNALEMENT_TYPES.join(", ")})` });

  const location = parseText(req.body?.location, 2, 255);
  if (location === null || location === "invalid") {
    return res.status(400).json({ message: "Indiquez où se trouve le problème (2 à 255 caractères)" });
  }
  const title = parseText(req.body?.title, 3, 200);
  const description = parseText(req.body?.description, 1, 5000);
  const phone = parseText(req.body?.contactPhone, 5, 30);
  if (title === "invalid") return res.status(400).json({ message: "Titre invalide (3 à 200 caractères)" });
  if (description === "invalid") return res.status(400).json({ message: "Description invalide (5000 caractères max)" });
  if (phone === "invalid" || (phone && !/^[+0-9 ().-]{5,30}$/.test(phone))) {
    return res.status(400).json({ message: "Numéro de téléphone invalide" });
  }
  // Quartier (facultatif) : permet de regrouper les signalements d'un même secteur et de montrer les alertes qui le concernent
  const zone: Zone | null = req.body?.zone === undefined || req.body.zone === null ? null : isZone(req.body.zone) ? req.body.zone : null;
  if (req.body?.zone !== undefined && req.body.zone !== null && zone === null) {
    return res.status(400).json({ message: `Quartier inconnu (${ZONES.join(", ")})` });
  }
  if (req.body?.lifeThreatening !== undefined && typeof req.body.lifeThreatening !== "boolean") {
    return res.status(400).json({ message: "lifeThreatening doit être un booléen" });
  }
  // Préparé hors ligne : `clientRef` (identifiant unique choisi par l'appareil) rend le renvoi sans risque de doublon,
  // `reportedAt` garde l'heure réelle du constat (24 h au plus dans le passé)
  const clientRef = req.body?.clientRef ?? null;
  if (clientRef !== null && (typeof clientRef !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(clientRef))) {
    return res.status(400).json({ message: "clientRef invalide (8 à 64 caractères : lettres, chiffres, - et _)" });
  }
  let reportedAt: Date | null = null;
  if (req.body?.reportedAt !== undefined && req.body.reportedAt !== null) {
    reportedAt = typeof req.body.reportedAt === "string" ? new Date(req.body.reportedAt) : null;
    const age = reportedAt ? Date.now() - reportedAt.getTime() : NaN;
    if (!reportedAt || Number.isNaN(age) || age < -2 * 60_000 || age > 24 * 3_600_000) {
      return res.status(400).json({ message: "reportedAt : date ISO des dernières 24 heures" });
    }
  }

  const lang = resolveLocale(req.headers["accept-language"]);
  const userId = req.user!.sub;

  // Double envoi (double-clic, réseau instable) : on rend le signalement déjà ouvert au lieu de créer une seconde alerte
  // Les consignes en vigueur dans son quartier : quelqu'un qui signale une montée des eaux doit voir tout de suite ce que la
  // ville demande de faire (se mettre en hauteur, éviter telle rue...)
  const activeAlerts = (await AlertModel.listActive(zone ?? undefined, 1)).map(publicAlertView);

  const duplicate =
    (clientRef ? await SignalementModel.findByClientRef(userId, clientRef) : null) ??
    (await SignalementModel.findRecentDuplicate(userId, type, location));
  if (duplicate) {
    return res.status(200).json({ ...citizenSignalementView(duplicate), duplicate: true, guidance: guidance(type, lang), activeAlerts });
  }

  const priority: SignalementPriority = req.body?.lifeThreatening === true ? "urgent" : TYPE_RULES[type].defaultPriority;
  const created = await SignalementModel.create({
    userId,
    type,
    priority,
    title: title ?? TYPE_RULES[type].label[lang],
    description,
    location,
    zone,
    contactPhone: phone,
    clientRef,
    reportedAt,
  }).catch(async (error) => {
    // Deux renvois simultanés du même clientRef : l'index unique en refuse un, on rend celui qui existe
    if (clientRef && error?.name === "SequelizeUniqueConstraintError") return SignalementModel.findByClientRef(userId, clientRef);
    throw error;
  });
  if (!created) return res.status(500).json({ message: "Signalement introuvable après création" });

  void audit(req, "signalement.create", { entityType: "signalements", entityId: created.id });
  // L'alerte part immédiatement vers le personnel connecté pour tout ce qui est urgent ou important
  if (priority === "urgent" || priority === "high") notifyStaff(SIGNALEMENT_NEW_EVENT, realtimeSignalementPayload(created));

  res.status(201).json({
    ...citizenSignalementView(created),
    duplicate: false,
    urgent: priority === "urgent",
    acknowledgeTargetMinutes: SLA_MINUTES[priority],
    guidance: guidance(type, lang),
    activeAlerts,
  });
}

// GET /api/signalements/mine?status=open|closed|all&page=&limit=
export async function listMySignalements(req: Request, res: Response) {
  const { page, limit, offset } = parsePagination(req);
  const filter = req.query.status;
  const statuses = filter === "open" ? OPEN_STATUSES : filter === "closed" ? CLOSED_STATUSES : undefined;
  const { signalements, total } = await SignalementModel.list({
    userId: req.user!.sub,
    statuses,
    // Les signalements encore ouverts d'abord, puis les plus récents
    sort: "attention",
    limit,
    offset,
  });
  res.json({ signalements: signalements.map(citizenSignalementView), page, limit, total });
}

// GET /api/signalements/mine/:id : le signalement et son déroulé
export async function getMySignalement(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const item = await SignalementModel.findOwnedById(id, req.user!.sub);
  if (!item) return res.status(404).json({ message: "Signalement introuvable" });
  res.json({ ...citizenSignalementView(item), timeline: citizenTimelineView(await SignalementModel.history(id)) });
}

// POST /api/signalements/mine/:id/cancel : annuler SON signalement (alerte envoyée par erreur) tant qu'il n'est pas en cours
export async function cancelMySignalement(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const item = await SignalementModel.findOwnedById(id, req.user!.sub);
  if (!item) return res.status(404).json({ message: "Signalement introuvable" });
  if (item.status !== "new" && item.status !== "acknowledged") {
    return res.status(409).json({
      code: "signalement_not_cancellable",
      message: "Ce signalement est déjà en cours de traitement ou clos : il ne peut plus être annulé ici.",
    });
  }
  const updated = await SignalementModel.applyChange(id, { status: "cancelled" }, {
    action: "cancelled_by_reporter",
    changedBy: req.user!.sub,
    note: "Annulé par le déclarant",
  });
  void audit(req, "signalement.cancel", { entityType: "signalements", entityId: id });
  notifyStaff(SIGNALEMENT_UPDATED_EVENT, realtimeSignalementPayload(updated!));
  res.json(citizenSignalementView(updated!));
}

// ── Personnel ────────────────────────────────────────────────────────────────────────────

function parseList<T extends string>(raw: unknown, valid: (value: unknown) => value is T): T[] | null | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const values = raw.split(",").map((value) => value.trim());
  return values.every(valid) ? (values as T[]) : null;
}

// GET /api/signalements?status=open|closed|all|new,in_progress&priority=&type=&assigned=me|none|<id>&overdue=true&q=&sort=attention|recent|oldest
// Par défaut : les signalements OUVERTS, triés par ce qui demande le plus d'attention.
export async function listSignalements(req: Request, res: Response) {
  const { page, limit, offset } = parsePagination(req);

  let statuses: SignalementStatus[] | undefined = OPEN_STATUSES;
  const rawStatus = req.query.status;
  if (rawStatus === "all") statuses = undefined;
  else if (rawStatus === "closed") statuses = CLOSED_STATUSES;
  else if (rawStatus !== undefined && rawStatus !== "open") {
    const parsed = parseList(rawStatus, isSignalementStatus);
    if (parsed === null) return res.status(400).json({ message: `status invalide (open, closed, all ou ${SIGNALEMENT_STATUSES.join(", ")})` });
    statuses = parsed;
  }
  const priorities = parseList(req.query.priority, isSignalementPriority);
  if (priorities === null) return res.status(400).json({ message: `priority invalide (${SIGNALEMENT_PRIORITIES.join(", ")})` });
  const types = parseList(req.query.type, isSignalementType);
  if (types === null) return res.status(400).json({ message: `type invalide (${SIGNALEMENT_TYPES.join(", ")})` });

  let assignedTo: number | "none" | undefined;
  if (req.query.assigned === "me") assignedTo = req.user!.sub;
  else if (req.query.assigned === "none") assignedTo = "none";
  else if (req.query.assigned !== undefined) {
    const id = parseId(req.query.assigned);
    if (!id) return res.status(400).json({ message: "assigned invalide (me, none ou un identifiant)" });
    assignedTo = id;
  }
  const sort = req.query.sort;
  if (sort !== undefined && sort !== "attention" && sort !== "recent" && sort !== "oldest") {
    return res.status(400).json({ message: "sort invalide (attention, recent, oldest)" });
  }
  const search = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim().slice(0, 100) : undefined;
  if (req.query.zone !== undefined && !isZone(req.query.zone)) return res.status(400).json({ message: `zone invalide (${ZONES.join(", ")})` });
  const zone = req.query.zone as Zone | undefined;

  const { signalements, total } = await SignalementModel.list({
    statuses,
    priorities,
    types,
    zone,
    assignedTo,
    overdueOnly: req.query.overdue === "true",
    search,
    sort: sort ?? "attention",
    limit,
    offset,
  });
  const maskPhone = isUnvalidatedAgent(req);
  res.json({ signalements: signalements.map((item) => staffSignalementView(item, { maskPhone })), page, limit, total });
}

// GET /api/signalements/summary : de quoi savoir en un coup d'œil s'il y a quelque chose à faire (pastilles, bandeau d'alerte)
export async function signalementSummary(req: Request, res: Response) {
  const [summary, activeAlerts] = await Promise.all([SignalementModel.summary(req.user!.sub), AlertModel.listActive(undefined, 0)]);
  // Pour chaque point chaud : une alerte couvre-t-elle déjà ce quartier pour ce danger ? Sinon, c'est peut-être le moment d'en publier une.
  const HAZARD_OF: Record<string, string> = { flood: "flood", heavy_rain: "heavy_rain", cyclone: "cyclone", fire: "fire" };
  const hotspots = summary.hotspots.map((spot) => ({
    ...spot,
    alertActive: activeAlerts.some(
      (alert) => alert.hazard === HAZARD_OF[spot.type] && (alert.zones === "all" || alert.zones.split(",").includes(spot.zone))
    ),
  }));
  res.json({ ...summary, hotspots, activeAlerts: activeAlerts.length });
}

// GET /api/signalements/:id
export async function getSignalement(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const item = await SignalementModel.findById(id);
  if (!item) return res.status(404).json({ message: "Signalement introuvable" });
  res.json({ ...staffSignalementView(item, { maskPhone: isUnvalidatedAgent(req) }), history: staffHistoryView(await SignalementModel.history(id)) });
}

// POST /api/signalements/:id/acknowledge  { note? } : « je m'en occupe » en un geste. Mesure le délai de prise en charge.
export async function acknowledgeSignalement(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const note = parseText(req.body?.note, 1, 2000);
  if (note === "invalid") return res.status(400).json({ message: "Note invalide (2000 caractères max)" });

  const item = await SignalementModel.findById(id);
  if (!item) return res.status(404).json({ message: "Signalement introuvable" });
  if (item.status !== "new") {
    return res.status(409).json({ code: "already_acknowledged", message: "Ce signalement est déjà pris en compte." });
  }
  const updated = await SignalementModel.applyChange(
    id,
    { status: "acknowledged", ...(item.assignedTo ? {} : { assignedTo: req.user!.sub }) },
    { action: "acknowledged", changedBy: req.user!.sub, note }
  );
  void audit(req, "signalement.acknowledge", { entityType: "signalements", entityId: id });
  notifyStaff(SIGNALEMENT_UPDATED_EVENT, realtimeSignalementPayload(updated!));
  res.json(staffSignalementView(updated!, { maskPhone: isUnvalidatedAgent(req) }));
}

// PATCH /api/signalements/:id  { status?, priority?, assignedTo?, note? }
export async function updateSignalement(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const item = await SignalementModel.findById(id);
  if (!item) return res.status(404).json({ message: "Signalement introuvable" });

  const note = parseText(req.body?.note, 1, 2000);
  if (note === "invalid") return res.status(400).json({ message: "Note invalide (2000 caractères max)" });

  const changes: { status?: SignalementStatus; priority?: SignalementPriority; assignedTo?: number | null } = {};
  if (req.body?.status !== undefined) {
    if (!isSignalementStatus(req.body.status)) {
      return res.status(400).json({ message: `Statut invalide (${SIGNALEMENT_STATUSES.join(", ")})` });
    }
    if (req.body.status === item.status) return res.status(400).json({ message: `Le signalement est déjà au statut ${item.status}` });
    // Une annulation (fausse alerte...) doit s'expliquer : c'est la trace qui permet de repérer les abus
    if (req.body.status === "cancelled" && !note) return res.status(400).json({ message: "Un motif est obligatoire pour annuler un signalement" });
    changes.status = req.body.status;
  }
  if (req.body?.priority !== undefined) {
    if (!isSignalementPriority(req.body.priority)) {
      return res.status(400).json({ message: `Priorité invalide (${SIGNALEMENT_PRIORITIES.join(", ")})` });
    }
    if (req.body.priority !== item.priority) changes.priority = req.body.priority;
  }
  if (req.body?.assignedTo !== undefined) {
    if (req.body.assignedTo === null) changes.assignedTo = null;
    else {
      const assigneeId = parseId(req.body.assignedTo);
      if (!assigneeId) return res.status(400).json({ message: "Agent invalide" });
      // On n'assigne qu'à quelqu'un qui peut réellement traiter les signalements
      if (!(await PermissionModel.codesForUser(assigneeId)).includes(MANAGE_PERMISSION)) {
        return res.status(400).json({ message: "Cet utilisateur ne peut pas traiter les signalements" });
      }
      if (assigneeId !== item.assignedTo) changes.assignedTo = assigneeId;
    }
  }
  if (Object.keys(changes).length === 0) {
    return res.status(400).json({ message: "Aucun changement (status, priority, assignedTo)" });
  }

  const kinds = [changes.status && "status", changes.priority && "priority", changes.assignedTo !== undefined && "assigned"].filter(Boolean);
  const action = kinds.length === 1 ? (kinds[0] as string) : "update";
  const updated = await SignalementModel.applyChange(id, changes, { action, changedBy: req.user!.sub, note });

  void audit(req, `signalement.${action}`, { entityType: "signalements", entityId: id });
  notifyStaff(SIGNALEMENT_UPDATED_EVENT, realtimeSignalementPayload(updated!));
  res.json({ ...staffSignalementView(updated!, { maskPhone: isUnvalidatedAgent(req) }), history: staffHistoryView(await SignalementModel.history(id)) });
}
