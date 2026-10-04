import { Request, Response } from "express";
import { AlertModel, ALL_ZONES, ZONES, type AlertData } from "../models/alert.model";
import {
  ALTERNATIVE_KINDS,
  DISRUPTION_KINDS,
  TransportModel,
  isAlternativeKind,
  isDisruptionKind,
  type Alternative,
  type DisruptionData,
  type DisruptionKind,
  type LineData,
} from "../models/transport.model";
import { ALERT_PUBLISHED_EVENT, ALERT_UPDATED_EVENT, ALERT_ENDED_EVENT, broadcastAlert, broadcastTransport } from "../realtime/alertChannel";
import { audit } from "../utils/audit";
import { parseId, parsePagination } from "../utils/http";
import { invalidate } from "../utils/responseCache";
import { resilientCached, staleHeaders } from "../utils/resilience";
import { NOT_VALIDATED_RESPONSE, isUnvalidatedAgent } from "../utils/staffAccess";
import { JourneyPlanner, normalizeStop, sectionOf } from "../utils/transport/journey";
import { localClock, nextDepartures } from "../utils/transport/schedule";
import { withTransport } from "../utils/transport/alertLink";
import { publicAlertView, staffAlertView } from "../views/alert.view";
import { disruptionHeadline, disruptionView, lineView, timetableView } from "../views/transport.view";

const MAX_ITEMS = 10;
const MAX_ALTERNATIVES = 5;
const DEFAULT_ALERT_MINUTES = 12 * 60;

const text = (value: unknown, min: number, max: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed.length >= min && trimmed.length <= max ? trimmed : null;
};

// Lecture en base, à jour : pour le personnel (déclarer, modifier)
async function network() {
  const [lines, active] = await Promise.all([TransportModel.listLines(), TransportModel.listActiveDisruptions()]);
  return { lines, active };
}

// Lecture publique : si la base est injoignable, le réseau tel qu'il était connu en dernier (horaires compris) permet
// encore de consulter les prochains passages et de calculer un trajet. La réponse le signale (stale, savedAt).
async function publicNetwork() {
  const result = await resilientCached("transport:network", 3000, network, { persist: true });
  return { ...result.data, result };
}

// ── Public : lisible par tous, sans compte ──────────────────────────────────────────────────

// GET /api/public/transport?lines=S1,T1 -> état de chaque ligne, les lignes touchées d'abord
export async function transportStatus(req: Request, res: Response) {
  const result = await resilientCached("transport:status", 5000, async () => {
    const { lines, active } = await network();
    const views = lines.map((line) => lineView(line, lines, active));
    const order = { interrupted: 0, delayed: 1, normal: 2 } as const;
    return {
      summary: {
        interrupted: views.filter((line) => line.state === "interrupted").length,
        delayed: views.filter((line) => line.state === "delayed").length,
        normal: views.filter((line) => line.state === "normal").length,
      },
      lines: [...views].sort((a, b) => order[a.state] - order[b.state]),
    };
  }, { persist: true });
  const payload = { ...result.data, stale: result.stale, savedAt: result.savedAt };
  // « Mes lignes » : le client garde les lignes de l'habitant et ne demande que celles-ci
  const wanted = typeof req.query.lines === "string" ? new Set(req.query.lines.split(",").map((code) => code.trim().toUpperCase())) : null;
  res.set("Cache-Control", "no-cache");
  staleHeaders(res, result);
  res.json(wanted ? { ...payload, lines: payload.lines.filter((line) => wanted.has(line.code)) } : payload);
}

// GET /api/public/transport/stops -> arrêts (pour l'autocomplétion « départ » / « arrivée »)
export async function listStops(_req: Request, res: Response) {
  const result = await resilientCached("transport:stops", 5000, async () => {
    const { lines, active } = await network();
    const unserved = new Map<string, Set<string>>();
    for (const line of lines) {
      for (const view of lineView(line, lines, active).disruptions) {
        for (const stop of view.unservedStops) unserved.set(stop, new Set([...(unserved.get(stop) ?? []), line.code]));
      }
    }
    const stops = new Map<string, string[]>();
    for (const line of lines) for (const stop of line.stops) stops.set(stop, [...(stops.get(stop) ?? []), line.code]);
    return [...stops.entries()]
      .map(([name, codes]) => {
        const cut = unserved.get(name) ?? new Set<string>();
        return { name, lines: codes, unservedBy: codes.filter((code) => cut.has(code)), served: codes.some((code) => !cut.has(code)) };
      })
      .sort((a, b) => a.name.localeCompare(b.name, "fr"));
  }, { persist: true });
  res.set("Cache-Control", "no-cache");
  staleHeaders(res, result);
  res.json(result.data);
}

// GET /api/public/transport/stops/:name -> la fiche d'un arrêt, tout sur un écran : prochains passages de chaque
// ligne dans chaque sens, ligne coupée et quoi prendre à la place, et une phrase qui dit quoi faire maintenant.
export async function stopCard(req: Request, res: Response) {
  const { lines, active, result } = await publicNetwork();
  const wanted = normalizeStop(String(req.params.name ?? ""));
  const name = lines.flatMap((line) => line.stops).find((stop) => normalizeStop(stop) === wanted);
  if (!name) {
    const planner = new JourneyPlanner(lines, active);
    return res.status(404).json({ code: "unknown_stop", message: "Arrêt inconnu", suggestions: planner.suggestStops(String(req.params.name ?? "")) });
  }

  const now = localClock();
  const cards = lines
    .filter((line) => line.stops.includes(name))
    .map((line) => {
      const index = line.stops.indexOf(name);
      const own = active.filter((d) => d.line.code === line.code);
      // Le véhicule part-il d'ici dans ce sens ? Non si le tronçon suivant est dans une section interrompue
      const cut = (from: number, to: number, kind: "interrupted" | "delayed") =>
        own.some((d) => {
          const section = d.kind === kind ? sectionOf(line, d) : null;
          return !!section && Math.max(Math.min(from, to), section[0]) < Math.min(Math.max(from, to), section[1]);
        });
      const directions = [
        { forward: true, towards: line.stops[line.stops.length - 1], next: index + 1, exists: index < line.stops.length - 1 },
        { forward: false, towards: line.stops[0], next: index - 1, exists: index > 0 },
      ]
        .filter((direction) => direction.exists)
        .map((direction) => {
          const served = !cut(index, direction.next, "interrupted");
          return {
            towards: direction.towards,
            served,
            delayed: served && cut(index, direction.next, "delayed"),
            departures: served ? nextDepartures(line, index, direction.forward, 3, now) : [],
          };
        });
      const disruption = own[0] ? disruptionView(own[0], lines, active) : null;
      return { line: { code: line.code, name: line.name, mode: line.mode, color: line.color }, directions, disruption };
    });

  // Ce qu'il faut faire maintenant, en une phrase : d'abord la ligne coupée et sa solution, puis le prochain départ
  const advice: string[] = [];
  for (const card of cards) {
    if (card.disruption && card.directions.every((direction) => !direction.served)) {
      const solution =
        card.disruption.alternatives[0]?.text ??
        (card.disruption.suggestedLines[0] ? `prenez la ligne ${card.disruption.suggestedLines[0].code}` : "prévoyez un autre moyen de déplacement");
      advice.push(`La ligne ${card.line.code} ne passe plus ici (${card.disruption.reason.replace(/\.$/, "")}) : ${solution.charAt(0).toLowerCase()}${solution.slice(1)}.`);
    }
  }
  const soonest = cards
    .flatMap((card) => card.directions.map((direction) => ({ card, direction, departure: direction.departures[0] })))
    .filter((item) => item.departure)
    .sort((a, b) => a.departure!.inMinutes - b.departure!.inMinutes)[0];
  if (soonest) {
    const { time, inMinutes, dayOffset } = soonest.departure!;
    const dayNames = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
    const when = dayOffset > 0
      ? `${dayOffset === 1 ? "demain" : dayNames[(now.weekday - 1 + dayOffset) % 7]} à ${time}`
      : inMinutes === 0
        ? `à ${time} (à l'approche)`
        : `à ${time} (dans ${inMinutes} min)`;
    advice.push(`Prochain départ : ligne ${soonest.card.line.code} direction ${soonest.direction.towards}, ${when}.`);
  } else {
    advice.push("Plus aucun départ prévu depuis cet arrêt pour le moment.");
  }

  res.set("Cache-Control", "no-cache");
  staleHeaders(res, result);
  res.json({ stop: name, now: now.minute, nowLabel: `${String(Math.floor(now.minute / 60)).padStart(2, "0")}:${String(now.minute % 60).padStart(2, "0")}`, advice: advice.join(" "), lines: cards });
}

// GET /api/public/transport/lines/:code -> une ligne : état, infos pratiques et grille horaire
export async function lineDetail(req: Request, res: Response) {
  const { lines, active, result } = await publicNetwork();
  const line = lines.find((item) => item.code === String(req.params.code ?? "").toUpperCase());
  if (!line) return res.status(404).json({ message: "Ligne inconnue" });
  const now = localClock();
  res.set("Cache-Control", "no-cache");
  staleHeaders(res, result);
  res.json({
    ...lineView(line, lines, active),
    timetable: timetableView(line),
    // Prochains départs des deux terminus
    nextFromTermini: [
      { from: line.stops[0], towards: line.stops[line.stops.length - 1], departures: nextDepartures(line, 0, true, 3, now) },
      { from: line.stops[line.stops.length - 1], towards: line.stops[0], departures: nextDepartures(line, line.stops.length - 1, false, 3, now) },
    ],
  });
}

// GET /api/public/transport/journey?from=Marché&to=Dôme Sud -> trajets qui évitent les interruptions
export async function planJourney(req: Request, res: Response) {
  const fromInput = text(req.query.from, 2, 120);
  const toInput = text(req.query.to, 2, 120);
  if (!fromInput || !toInput) return res.status(400).json({ message: "Indiquez un arrêt de départ (from) et un arrêt d'arrivée (to)" });

  const { lines, active, result } = await publicNetwork();
  const planner = new JourneyPlanner(lines, active);
  const from = planner.resolveStop(fromInput);
  const to = planner.resolveStop(toInput);
  for (const [field, input, resolved] of [["from", fromInput, from], ["to", toInput, to]] as const) {
    if (!resolved) {
      return res.status(400).json({
        code: "unknown_stop",
        field,
        message: `Arrêt inconnu : « ${input} »`,
        suggestions: planner.suggestStops(input),
      });
    }
  }
  if (from === to) return res.status(400).json({ message: "Le départ et l'arrivée sont le même arrêt" });

  const options = planner.plan(from!, to!);
  // Le trajet que l'habitant fait d'habitude (réseau sans interruption) : est-il touché ?
  const usual = new JourneyPlanner(lines, [], { ignoreDisruptions: true }).plan(from!, to!, 1)[0] ?? null;
  const usualLines = new Set(usual?.legs.map((leg) => leg.line.code) ?? []);
  const affecting = active.filter((d) => {
    if (!usualLines.has(d.line.code)) return false;
    const leg = usual!.legs.find((item) => item.line.code === d.line.code)!;
    const section = sectionOf(d.line, d);
    const p = d.line.stops.indexOf(leg.from);
    const q = d.line.stops.indexOf(leg.to);
    return !!section && Math.max(Math.min(p, q), section[0]) < Math.min(Math.max(p, q), section[1]);
  });

  res.set("Cache-Control", "no-cache");
  staleHeaders(res, result);
  res.json({
    from,
    to,
    usual: usual
      ? {
          summary: usual.summary,
          affected: affecting.length > 0,
          disruptions: affecting.map((d) => ({ id: d.id, kind: d.kind, headline: disruptionHeadline(d), reason: d.reason, expectedEndAt: d.expectedEndAt })),
        }
      : null,
    options,
    // Rien en transport : ce que les services ont prévu d'autre (navette à la demande, à pied...)
    otherSolutions: options.length
      ? []
      : affecting.flatMap((d) => d.alternatives.filter((alternative) => alternative.kind !== "line" && alternative.kind !== "replacement_bus")),
    message: options.length
      ? null
      : { fr: "Aucun trajet en transport en commun pour le moment.", en: "No public transport route at the moment." },
  });
}

// GET /api/public/transport/disruptions/:id
export async function getPublicDisruption(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const { lines, active, result } = await publicNetwork();
  const disruption = active.find((d) => d.id === id) ?? (result.stale ? null : await TransportModel.findById(id));
  if (!disruption) return res.status(404).json({ message: "Interruption introuvable" });
  res.set("Cache-Control", "no-cache");
  staleHeaders(res, result);
  res.json(disruptionView(disruption, lines, active));
}

// ── Personnel ───────────────────────────────────────────────────────────────────────────────

function refuseIfNotValidated(req: Request, res: Response): boolean {
  if (!isUnvalidatedAgent(req)) return false;
  res.status(403).json(NOT_VALIDATED_RESPONSE);
  return true;
}

class InputError extends Error {}

function parseSection(line: LineData, from: unknown, to: unknown): { fromStop: string | null; toStop: string | null } {
  if ((from === undefined || from === null) && (to === undefined || to === null)) return { fromStop: null, toStop: null };
  if (typeof from !== "string" || typeof to !== "string" || !line.stops.includes(from) || !line.stops.includes(to) || from === to) {
    throw new InputError(`Ligne ${line.code} : fromStop et toStop doivent être deux arrêts différents de la ligne (${line.stops.join(", ")}), ou absents pour toute la ligne`);
  }
  return { fromStop: from, toStop: to };
}

function parseAlternatives(value: unknown, line: LineData, known: Map<string, LineData>): Alternative[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ALTERNATIVES) throw new InputError(`Ligne ${line.code} : au plus ${MAX_ALTERNATIVES} solutions de remplacement`);
  return value.map((raw, index) => {
    const label = `Ligne ${line.code}, solution ${index + 1}`;
    if (!raw || typeof raw !== "object" || !isAlternativeKind(raw.kind)) throw new InputError(`${label} : kind parmi ${ALTERNATIVE_KINDS.join(", ")}`);
    const sentence = text(raw.text, 3, 160);
    if (!sentence) throw new InputError(`${label} : texte requis, une phrase courte (3 à 160 caractères)`);
    const alternative: Alternative = { kind: raw.kind, text: sentence };
    if (raw.kind === "line") {
      const other = typeof raw.line === "string" ? known.get(raw.line.toUpperCase()) : undefined;
      if (!other || other.code === line.code) throw new InputError(`${label} : « line » doit être le code d'une autre ligne`);
      alternative.line = other.code;
    }
    if (raw.kind === "replacement_bus") {
      if (!line.stops.includes(raw.from) || !line.stops.includes(raw.to) || raw.from === raw.to) {
        throw new InputError(`${label} : un bus de remplacement relie deux arrêts de la ligne (from, to)`);
      }
      alternative.from = raw.from;
      alternative.to = raw.to;
    }
    if (raw.extraMinutes !== undefined) {
      if (!Number.isInteger(raw.extraMinutes) || raw.extraMinutes < 0 || raw.extraMinutes > 240) throw new InputError(`${label} : extraMinutes entre 0 et 240`);
      alternative.extraMinutes = raw.extraMinutes;
    }
    return alternative;
  });
}

function parseExpectedEnd(value: unknown): Date | null {
  if (value === undefined || value === null) return null;
  const date = typeof value === "string" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime()) || date.getTime() < Date.now() || date.getTime() > Date.now() + 72 * 3_600_000) {
    throw new InputError("expectedEndAt : date ISO dans les 72 prochaines heures");
  }
  return date;
}

// Le contenu de l'alerte est écrit à partir des interruptions : l'agent déclare des faits, l'habitant lit des consignes
function alertContent(disruptions: DisruptionData[], lines: LineData[], active: DisruptionData[], reason: string) {
  const live = disruptions.filter((d) => d.status === "active");
  const interrupted = live.filter((d) => d.kind === "interrupted").length;
  const title =
    live.length === 1
      ? disruptionHeadline(live[0]).fr.replace(/ (entre|sur) .*/, "")
      : `Transports : ${live.length} lignes ${interrupted === live.length ? "interrompues" : interrupted ? "interrompues ou perturbées" : "perturbées"}`;
  const message = `${live.map((d) => disruptionHeadline(d).fr).join(" ; ")}. Cause : ${reason.replace(/\.$/, "")}.`;
  const instructions = live.map((d) => {
    const advice = d.alternatives[0]?.text;
    if (advice) return `${d.line.code} : ${advice}`;
    // Ligne seulement perturbée : elle roule encore, inutile d'envoyer les gens ailleurs
    if (d.kind === "delayed") return `${d.line.code} : circulation ralentie, prévoyez plus de temps`;
    const other = disruptionView(d, lines, active).suggestedLines[0];
    return other
      ? `${d.line.code} : prenez la ligne ${other.code} (${other.servesStops.slice(0, 3).join(", ")})`
      : `${d.line.code} : prévoyez un autre moyen de déplacement`;
  });
  const capped = instructions.slice(0, 5).map((item) => item.slice(0, 160));
  capped.push("Votre trajet de remplacement : rubrique Transports");
  const zones = [...new Set(live.flatMap((d) => d.line.zones))];
  const latestEnd = live.map((d) => d.expectedEndAt?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
  return {
    title: title.slice(0, 120),
    message: message.slice(0, 1000),
    instructions: capped,
    zones: zones.length === ZONES.length ? ALL_ZONES : zones.join(","),
    // L'alerte reste affichée jusqu'à la reprise prévue (+1 h de marge), 12 h si aucune heure n'est annoncée
    expiresAt: new Date(latestEnd ? latestEnd + 3_600_000 : Date.now() + DEFAULT_ALERT_MINUTES * 60_000),
  };
}

async function publishChanges(alert: AlertData | null, event: typeof ALERT_PUBLISHED_EVENT | typeof ALERT_UPDATED_EVENT | typeof ALERT_ENDED_EVENT | null) {
  invalidate("transport:");
  invalidate("alerts:");
  invalidate("essentials"); // le kit essentiel contient l'état des lignes
  const { lines, active } = await network();
  broadcastTransport({ lines: lines.map((line) => ({ code: line.code, state: lineView(line, lines, active).state })) });
  if (alert && event) broadcastAlert(event, (await withTransport([publicAlertView(alert)]))[0]);
}

// Après une modification ou une fin d'interruption : l'alerte liée suit (mise à jour, ou fin quand tout est rétabli)
async function syncAlert(alertId: number | null, userId: number, note: string, reason: string) {
  if (!alertId) return null;
  const alert = await AlertModel.findById(alertId);
  if (!alert || alert.status !== "active") return null;
  const all = await TransportModel.listByAlert([alertId]);
  if (!all.some((d) => d.status === "active")) {
    const lines = all.map((d) => d.line.code).join(", ");
    const ended = await AlertModel.end(alertId, `Trafic rétabli sur ${all.length > 1 ? "les lignes" : "la ligne"} ${lines}.`, userId);
    return { alert: ended, event: ALERT_ENDED_EVENT } as const;
  }
  const { lines, active } = await network();
  const content = alertContent(all, lines, active, reason);
  const updated = await AlertModel.addUpdate(alertId, { message: note, instructions: content.instructions, expiresAt: content.expiresAt, createdBy: userId });
  return { alert: updated, event: ALERT_UPDATED_EVENT } as const;
}

// GET /api/transport/disruptions?status=active|ended
export async function listDisruptions(req: Request, res: Response) {
  const { page, limit, offset } = parsePagination(req);
  const status = req.query.status === "active" || req.query.status === "ended" ? req.query.status : undefined;
  const [{ disruptions, total }, { lines, active }] = await Promise.all([TransportModel.listDisruptions({ status, limit, offset }), network()]);
  res.json({ disruptions: disruptions.map((d) => ({ ...disruptionView(d, lines, active), createdBy: d.createdBy })), page, limit, total });
}

// GET /api/transport/lines -> lignes et arrêts, pour le formulaire de déclaration
export async function listLinesForStaff(_req: Request, res: Response) {
  const { lines, active } = await network();
  res.json(lines.map((line) => lineView(line, lines, active)));
}

// POST /api/transport/disruptions { reason, expectedEndAt?, publishAlert?, items: [{ line, kind, fromStop?, toStop?, alternatives? }] }
export async function declareDisruptions(req: Request, res: Response) {
  if (refuseIfNotValidated(req, res)) return;
  try {
    const reason = text(req.body?.reason, 5, 200);
    if (!reason) throw new InputError("Cause requise, en une phrase (5 à 200 caractères) : « Panne d'alimentation du tram »");
    const expectedEndAt = parseExpectedEnd(req.body?.expectedEndAt);
    const items = req.body?.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ITEMS) throw new InputError(`items : 1 à ${MAX_ITEMS} lignes touchées`);

    const { lines, active } = await network();
    const known = new Map(lines.map((line) => [line.code, line]));
    const seen = new Set<string>();
    const parsed = items.map((item: Record<string, unknown>) => {
      const line = typeof item?.line === "string" ? known.get(item.line.toUpperCase()) : undefined;
      if (!line) throw new InputError(`Ligne inconnue : ${String(item?.line)} (${[...known.keys()].join(", ")})`);
      if (seen.has(line.code)) throw new InputError(`Ligne ${line.code} citée deux fois`);
      seen.add(line.code);
      if (!isDisruptionKind(item.kind)) throw new InputError(`Ligne ${line.code} : kind parmi ${DISRUPTION_KINDS.join(", ")}`);
      if (active.some((d) => d.line.code === line.code)) {
        throw Object.assign(new InputError(`Ligne ${line.code} : une interruption est déjà en cours, modifiez-la plutôt`), { status: 409 });
      }
      return { lineId: line.id, kind: item.kind as DisruptionKind, ...parseSection(line, item.fromStop, item.toStop), alternatives: parseAlternatives(item.alternatives, line, known) };
    });

    const ids = await TransportModel.createMany(parsed, { reason, expectedEndAt, createdBy: req.user!.sub });
    for (const id of ids) void audit(req, "transport.disruption.create", { entityType: "transport_disruptions", entityId: id });

    // Une seule alerte pour toutes les lignes déclarées ensemble, envoyée aux quartiers qu'elles desservent
    let alert: AlertData | null = null;
    if (req.body?.publishAlert !== false) {
      const created = (await Promise.all(ids.map((id) => TransportModel.findById(id)))).filter((d): d is DisruptionData => !!d);
      const after = await TransportModel.listActiveDisruptions();
      const content = alertContent(created, lines, after, reason);
      alert = await AlertModel.create({ ...content, hazard: "transport", severity: "watch", createdBy: req.user!.sub });
      await TransportModel.linkAlert(ids, alert.id);
      void audit(req, "alert.publish", { entityType: "alerts", entityId: alert.id });
    }
    await publishChanges(alert, ALERT_PUBLISHED_EVENT);

    const fresh = await network();
    const disruptions = (await Promise.all(ids.map((id) => TransportModel.findById(id)))).filter((d): d is DisruptionData => !!d);
    res.status(201).json({
      disruptions: disruptions.map((d) => disruptionView(d, fresh.lines, fresh.active)),
      alert: alert ? (await withTransport([staffAlertView(alert)]))[0] : null,
    });
  } catch (error) {
    if (error instanceof InputError) return res.status((error as InputError & { status?: number }).status ?? 400).json({ message: error.message });
    throw error;
  }
}

// PATCH /api/transport/disruptions/:id { kind?, fromStop?, toStop?, reason?, alternatives?, expectedEndAt? }
export async function updateDisruption(req: Request, res: Response) {
  if (refuseIfNotValidated(req, res)) return;
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const current = await TransportModel.findById(id);
  if (!current) return res.status(404).json({ message: "Interruption introuvable" });
  if (current.status !== "active") return res.status(409).json({ code: "disruption_ended", message: "Cette interruption est terminée : déclarez-en une nouvelle." });

  try {
    const body = req.body ?? {};
    const lines = await TransportModel.listLines();
    const known = new Map(lines.map((line) => [line.code, line]));
    const changes: Parameters<typeof TransportModel.update>[1] = {};
    if (body.kind !== undefined) {
      if (!isDisruptionKind(body.kind)) throw new InputError(`kind parmi ${DISRUPTION_KINDS.join(", ")}`);
      changes.kind = body.kind;
    }
    if ("fromStop" in body || "toStop" in body) Object.assign(changes, parseSection(current.line, body.fromStop, body.toStop));
    if (body.reason !== undefined) {
      const reason = text(body.reason, 5, 200);
      if (!reason) throw new InputError("Cause : 5 à 200 caractères");
      changes.reason = reason;
    }
    if (body.alternatives !== undefined) changes.alternatives = parseAlternatives(body.alternatives, current.line, known);
    if ("expectedEndAt" in body) changes.expectedEndAt = parseExpectedEnd(body.expectedEndAt);
    if (!Object.keys(changes).length) throw new InputError("Rien à modifier");

    await TransportModel.update(id, changes);
    void audit(req, "transport.disruption.update", { entityType: "transport_disruptions", entityId: id });
    const updated = (await TransportModel.findById(id))!;
    const synced = await syncAlert(updated.alertId, req.user!.sub, `Mise à jour : ${disruptionHeadline(updated).fr}.`, updated.reason);
    await publishChanges(synced?.alert ?? null, synced?.event ?? null);
    const { lines: all, active } = await network();
    res.json(disruptionView(updated, all, active));
  } catch (error) {
    if (error instanceof InputError) return res.status(400).json({ message: error.message });
    throw error;
  }
}

// POST /api/transport/disruptions/:id/end -> ligne rétablie ; l'alerte se termine quand toutes ses lignes le sont
export async function endDisruption(req: Request, res: Response) {
  if (refuseIfNotValidated(req, res)) return;
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const current = await TransportModel.findById(id);
  if (!current) return res.status(404).json({ message: "Interruption introuvable" });
  if (current.status !== "active") return res.status(409).json({ code: "disruption_ended", message: "Cette interruption est déjà terminée." });

  await TransportModel.end(id);
  void audit(req, "transport.disruption.end", { entityType: "transport_disruptions", entityId: id });
  const synced = await syncAlert(current.alertId, req.user!.sub, `Ligne ${current.line.code} : trafic rétabli.`, current.reason);
  await publishChanges(synced?.alert ?? null, synced?.event ?? null);
  const { lines, active } = await network();
  res.json({ disruption: disruptionView((await TransportModel.findById(id))!, lines, active), alert: synced?.alert ? staffAlertView(synced.alert) : null });
}
