import { Request, Response } from "express";
import {
  ALERT_HAZARDS,
  ALERT_SEVERITIES,
  ALL_ZONES,
  AlertModel,
  SEVERITY_INFO,
  ZONES,
  isAlertHazard,
  isAlertSeverity,
  isZone,
  type AlertSeverity,
  type Zone,
} from "../models/alert.model";
import { ALERT_ENDED_EVENT, ALERT_PUBLISHED_EVENT, ALERT_UPDATED_EVENT, broadcastAlert } from "../realtime/alertChannel";
import { draftAlert } from "../utils/ai/alertDraft";
import { withTransport } from "../utils/transport/alertLink";
import { audit } from "../utils/audit";
import { parseId, parsePagination } from "../utils/http";
import { cached, invalidate } from "../utils/responseCache";
import { resilientCached, staleHeaders } from "../utils/resilience";
import { NOT_VALIDATED_RESPONSE, isUnvalidatedAgent } from "../utils/staffAccess";
import { publicAlertView, staffAlertView, zonesView } from "../views/alert.view";

const MIN_DURATION = 15;
const MAX_DURATION = 72 * 60;

const text = (value: unknown, min: number, max: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= min && trimmed.length <= max ? trimmed : null;
};

// Consignes : 1 à 6 phrases courtes. Une consigne longue n'est pas lue en situation de stress.
function parseInstructions(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 6) return null;
  const items = value.map((item) => text(item, 3, 160));
  return items.every((item): item is string => item !== null) ? items : null;
}

function parseZones(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (value.includes(ALL_ZONES)) return value.length === 1 ? ALL_ZONES : null;
  if (!value.every(isZone)) return null;
  return [...new Set(value as Zone[])].join(",");
}

function parseDuration(value: unknown, severity: AlertSeverity): number | null {
  if (value === undefined) return SEVERITY_INFO[severity].defaultMinutes;
  return Number.isInteger(value) && (value as number) >= MIN_DURATION && (value as number) <= MAX_DURATION ? (value as number) : null;
}

const notify = (event: typeof ALERT_PUBLISHED_EVENT | typeof ALERT_UPDATED_EVENT | typeof ALERT_ENDED_EVENT, view: ReturnType<typeof publicAlertView>) => {
  invalidate("alerts:");
  invalidate("essentials"); // le kit essentiel contient les alertes en cours
  void withTransport([view]).then(([withLines]) => broadcastAlert(event, withLines));
};

// ── Public : lisible par tous, sans compte ──────────────────────────────────────────────────

// GET /api/public/alerts?zone=south -> { active, recentlyEnded }
// Sans quartier : toutes les alertes en vigueur. Avec : celles du quartier ET celles de toute la ville.
export async function listPublicAlerts(req: Request, res: Response) {
  const zone = req.query.zone;
  if (zone !== undefined && !isZone(zone)) return res.status(400).json({ message: `Quartier inconnu (${ZONES.join(", ")})` });
  // Base injoignable : on sert la dernière version connue (stale: true) plutôt qu'une erreur. Une alerte doit rester lisible.
  const result = await resilientCached(
    `alerts:public:${zone ?? "all"}`,
    5000,
    async () => {
      const [active, recentlyEnded] = await Promise.all([AlertModel.listActive(zone), AlertModel.listRecentlyEnded(zone)]);
      return { zone: zone ?? null, active: await withTransport(active.map(publicAlertView)), recentlyEnded: await withTransport(recentlyEnded.map(publicAlertView)) };
    },
    { persist: true }
  );
  // Toujours revalider : une alerte change vite (le navigateur réutilise sa copie seulement si elle n'a pas bougé)
  res.set("Cache-Control", "no-cache");
  staleHeaders(res, result);
  res.json({ ...result.data, stale: result.stale, savedAt: result.savedAt });
}

// GET /api/public/alerts/zones
export function listZones(_req: Request, res: Response) {
  res.set("Cache-Control", "public, max-age=3600");
  res.json(zonesView());
}

// GET /api/public/alerts/:id (en vigueur ou terminée)
export async function getPublicAlert(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const alert = await AlertModel.findById(id);
  if (!alert) return res.status(404).json({ message: "Alerte introuvable" });
  res.set("Cache-Control", "no-cache");
  res.json((await withTransport([publicAlertView(alert)]))[0]);
}

// ── Personnel ───────────────────────────────────────────────────────────────────────────────

// Publier une alerte à toute une population est grave (une fausse alerte d'évacuation sème la panique) : il faut la
// permission ET un compte validé par un administrateur. Un agent inscrit librement ne peut pas.
function refuseIfNotValidated(req: Request, res: Response): boolean {
  if (!isUnvalidatedAgent(req)) return false;
  res.status(403).json(NOT_VALIDATED_RESPONSE);
  return true;
}

// GET /api/alerts?status=active|ended&page=&limit=
export async function listAlerts(req: Request, res: Response) {
  const { page, limit, offset } = parsePagination(req);
  const status = req.query.status === "active" || req.query.status === "ended" ? req.query.status : undefined;
  const { alerts, total } = await AlertModel.listAll({ status, limit, offset });
  res.json({ alerts: alerts.map(staffAlertView), page, limit, total });
}

// GET /api/alerts/:id
export async function getAlert(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const alert = await AlertModel.findById(id);
  if (!alert) return res.status(404).json({ message: "Alerte introuvable" });
  res.json(staffAlertView(alert));
}

// POST /api/alerts  { title, hazard, severity, zones[], message, instructions[], expiresInMinutes? }
export async function publishAlert(req: Request, res: Response) {
  if (refuseIfNotValidated(req, res)) return;
  const title = text(req.body?.title, 5, 120);
  if (!title) return res.status(400).json({ message: "Titre requis, court et clair (5 à 120 caractères)" });
  if (!isAlertHazard(req.body?.hazard)) return res.status(400).json({ message: `Danger invalide (${ALERT_HAZARDS.join(", ")})` });
  if (!isAlertSeverity(req.body?.severity)) return res.status(400).json({ message: `Gravité invalide (${ALERT_SEVERITIES.join(", ")})` });
  const severity = req.body.severity as AlertSeverity;
  const zones = parseZones(req.body?.zones);
  if (!zones) return res.status(400).json({ message: `Quartiers invalides : une liste parmi ${ZONES.join(", ")}, ou ["all"]` });
  const message = text(req.body?.message, 10, 1000);
  if (!message) return res.status(400).json({ message: "Message requis : ce qui se passe, en 10 à 1000 caractères" });
  const instructions = req.body?.instructions === undefined ? [] : parseInstructions(req.body.instructions);
  if (!instructions) return res.status(400).json({ message: "Consignes invalides : 6 au plus, de 3 à 160 caractères chacune" });
  // Dès qu'il faut agir, l'alerte DOIT dire quoi faire : c'est ce que la personne cherche en premier
  if (SEVERITY_INFO[severity].actionRequired && instructions.length === 0) {
    return res.status(400).json({ message: "Une alerte « alerte » ou « urgence » doit contenir au moins une consigne (que faire ?)" });
  }
  const minutes = parseDuration(req.body?.expiresInMinutes, severity);
  if (minutes === null) return res.status(400).json({ message: `Durée invalide (${MIN_DURATION} min à ${MAX_DURATION / 60} h)` });

  const alert = await AlertModel.create({
    title,
    hazard: req.body.hazard,
    severity,
    zones,
    message,
    instructions,
    expiresAt: new Date(Date.now() + minutes * 60_000),
    createdBy: req.user!.sub,
  });
  void audit(req, "alert.publish", { entityType: "alerts", entityId: alert.id });
  notify(ALERT_PUBLISHED_EVENT, publicAlertView(alert));
  res.status(201).json(staffAlertView(alert));
}

// POST /api/alerts/:id/updates  { message, severity?, instructions?, expiresInMinutes? }
export async function updateAlert(req: Request, res: Response) {
  if (refuseIfNotValidated(req, res)) return;
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const current = await AlertModel.findById(id);
  if (!current) return res.status(404).json({ message: "Alerte introuvable" });
  if (current.status !== "active") return res.status(409).json({ code: "alert_ended", message: "Cette alerte est terminée : publiez-en une nouvelle." });

  const message = text(req.body?.message, 5, 1000);
  if (!message) return res.status(400).json({ message: "Message de mise à jour requis (5 à 1000 caractères)" });
  let severity: AlertSeverity | undefined;
  if (req.body?.severity !== undefined) {
    if (!isAlertSeverity(req.body.severity)) return res.status(400).json({ message: `Gravité invalide (${ALERT_SEVERITIES.join(", ")})` });
    severity = req.body.severity;
  }
  let instructions: string[] | undefined;
  if (req.body?.instructions !== undefined) {
    const parsed = parseInstructions(req.body.instructions);
    if (!parsed) return res.status(400).json({ message: "Consignes invalides : 6 au plus, de 3 à 160 caractères chacune" });
    instructions = parsed;
  }
  const finalSeverity = severity ?? current.severity;
  const finalInstructions = instructions ?? JSON.parse(current.instructions ?? "[]");
  if (SEVERITY_INFO[finalSeverity].actionRequired && finalInstructions.length === 0) {
    return res.status(400).json({ message: "Une alerte « alerte » ou « urgence » doit contenir au moins une consigne (que faire ?)" });
  }
  let expiresAt: Date | undefined;
  if (req.body?.expiresInMinutes !== undefined) {
    const minutes = parseDuration(req.body.expiresInMinutes, finalSeverity);
    if (minutes === null) return res.status(400).json({ message: `Durée invalide (${MIN_DURATION} min à ${MAX_DURATION / 60} h)` });
    expiresAt = new Date(Date.now() + minutes * 60_000);
  }

  const alert = await AlertModel.addUpdate(id, { message, severity, instructions, expiresAt, createdBy: req.user!.sub });
  void audit(req, "alert.update", { entityType: "alerts", entityId: id });
  notify(ALERT_UPDATED_EVENT, publicAlertView(alert!));
  res.json(staffAlertView(alert!));
}

// POST /api/alerts/:id/end  { endMessage } : fin d'alerte. Dire que le danger est passé fait partie de l'information.
export async function endAlert(req: Request, res: Response) {
  if (refuseIfNotValidated(req, res)) return;
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const endMessage = text(req.body?.endMessage, 5, 1000);
  if (!endMessage) return res.status(400).json({ message: "Message de fin d'alerte requis (ex. « Le niveau de l'eau est redescendu »)" });
  const current = await AlertModel.findById(id);
  if (!current) return res.status(404).json({ message: "Alerte introuvable" });
  if (current.status === "ended") return res.status(409).json({ code: "alert_ended", message: "Cette alerte est déjà terminée." });

  const alert = await AlertModel.end(id, endMessage, req.user!.sub);
  void audit(req, "alert.end", { entityType: "alerts", entityId: id });
  notify(ALERT_ENDED_EVENT, publicAlertView(alert!));
  res.json(staffAlertView(alert!));
}

// POST /api/alerts/draft { zone, hazard?, notes? } -> brouillon rédigé par l'IA à partir des signalements récents.
// Rien n'est publié : l'agent relit, corrige, puis envoie le brouillon à POST /api/alerts.
export async function draftAlertWithAi(req: Request, res: Response) {
  if (refuseIfNotValidated(req, res)) return;
  const zone = req.body?.zone;
  if (zone !== ALL_ZONES && !isZone(zone)) return res.status(400).json({ message: `Quartier requis (${ZONES.join(", ")}, ou all)` });
  const hazard = req.body?.hazard;
  if (hazard !== undefined && !isAlertHazard(hazard)) return res.status(400).json({ message: `Danger invalide (${ALERT_HAZARDS.join(", ")})` });
  const notes = req.body?.notes === undefined || req.body.notes === "" ? undefined : text(req.body.notes, 3, 1000);
  if (notes === null) return res.status(400).json({ message: "Note invalide (3 à 1000 caractères)" });

  const result = await draftAlert({ zone, hazard, notes });
  if (!result) {
    return res.status(422).json({
      code: "nothing_to_draft",
      message: `Aucun signalement ouvert dans ce quartier depuis 3 h : décrivez la situation dans « notes » pour obtenir un brouillon.`,
    });
  }
  void audit(req, "alert.draft", { entityType: "alerts" });
  res.json({
    ...result,
    notice: "Brouillon à relire : vérifiez les faits, le quartier et les consignes avant de publier.",
  });
}
