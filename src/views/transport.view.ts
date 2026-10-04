import { ZONE_LABELS } from "../models/alert.model";
import {
  ALTERNATIVE_LABELS,
  KIND_LABELS,
  MODE_LABELS,
  type DisruptionData,
  type LineData,
} from "../models/transport.model";
import { sectionOf, unservedStops } from "../utils/transport/journey";
import { toMinutes } from "../utils/transport/schedule";

const DAY_NAMES = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];

// « Tous les jours », « Du lundi au samedi », « Lundi, mercredi, vendredi »
export function daysLabel(days: number[]) {
  const sorted = [...new Set(days)].filter((day) => day >= 1 && day <= 7).sort();
  if (sorted.length === 7) return { fr: "Tous les jours", en: "Every day" };
  const consecutive = sorted.length > 2 && sorted.every((day, index) => index === 0 || day === sorted[index - 1] + 1);
  if (consecutive) return { fr: `Du ${DAY_NAMES[sorted[0] - 1]} au ${DAY_NAMES[sorted[sorted.length - 1] - 1]}`, en: `Days ${sorted.join(", ")}` };
  const list = sorted.map((day) => DAY_NAMES[day - 1]).join(", ");
  return { fr: list.charAt(0).toUpperCase() + list.slice(1), en: `Days ${sorted.join(", ")}` };
}

// Infos pratiques d'une ligne : quand elle roule, à quelle fréquence, combien de temps de bout en bout
export function lineInfo(line: LineData) {
  const schedule = line.schedule;
  return {
    days: schedule ? daysLabel(schedule.days) : null,
    first: schedule?.first ?? null,
    last: schedule?.last ?? null,
    frequencyMinutes: line.frequencyMinutes,
    peaks: schedule?.peaks ?? [],
    travelMinutes: (line.stops.length - 1) * line.minutesBetweenStops,
    accessible: line.accessible,
    notes: line.notes,
  };
}

// Grille complète : temps de parcours depuis chaque terminus, pour afficher un horaire « à l'arrêt »
export function timetableView(line: LineData) {
  const last = line.stops.length - 1;
  return {
    ...lineInfo(line),
    directions: [
      { towards: line.stops[last], stops: line.stops.map((name, index) => ({ name, minutesFromStart: index * line.minutesBetweenStops })) },
      {
        towards: line.stops[0],
        stops: [...line.stops].reverse().map((name, index) => ({ name, minutesFromStart: index * line.minutesBetweenStops })),
      },
    ],
    firstMinute: line.schedule ? toMinutes(line.schedule.first) : null,
  };
}

const lineRef = (line: LineData) => ({ code: line.code, name: line.name, mode: line.mode, color: line.color });

// « Ligne S1 interrompue entre Marché et Dôme Sud » : la phrase qu'un habitant comprend sans explication
export function disruptionHeadline(d: Pick<DisruptionData, "line" | "kind" | "fromStop" | "toStop">) {
  const where = d.fromStop && d.toStop;
  const verb = d.kind === "interrupted" ? { fr: "interrompue", en: "interrupted" } : { fr: "perturbée", en: "delayed" };
  return {
    fr: `Ligne ${d.line.code} ${verb.fr} ${where ? `entre ${d.fromStop} et ${d.toStop}` : "sur toute la ligne"}`,
    en: `Line ${d.line.code} ${verb.en} ${where ? `between ${d.fromStop} and ${d.toStop}` : "along the whole line"}`,
  };
}

// Lignes qui desservent encore les arrêts touchés : proposées automatiquement, même si l'agent n'a rien saisi
function suggestedLines(d: DisruptionData, lines: LineData[], active: DisruptionData[]) {
  const section = sectionOf(d.line, d);
  if (!section) return [];
  const touched = d.line.stops.slice(section[0], section[1] + 1);
  // Une ligne voisine n'est proposée que pour les arrêts qu'ELLE dessert encore (elle peut être coupée aussi)
  const stillServed = (line: LineData, stop: string) =>
    line.stops.includes(stop) && !active.some((x) => x.line.code === line.code && unservedStops(line, x).includes(stop));
  return lines
    .filter((line) => line.code !== d.line.code)
    .map((line) => ({ ...lineRef(line), servesStops: touched.filter((stop) => stillServed(line, stop)) }))
    .filter((line) => line.servesStops.length > 0)
    .sort((a, b) => b.servesStops.length - a.servesStops.length);
}

export function disruptionView(d: DisruptionData, lines: LineData[], active: DisruptionData[]) {
  return {
    id: d.id,
    status: d.status,
    line: lineRef(d.line),
    kind: d.kind,
    kindLabel: KIND_LABELS[d.kind],
    headline: disruptionHeadline(d),
    section: d.fromStop && d.toStop ? { from: d.fromStop, to: d.toStop } : null,
    // Arrêts où plus rien ne passe : à mettre en évidence sur le plan de la ligne
    unservedStops: unservedStops(d.line, d),
    reason: d.reason,
    // Ce que les services conseillent, dans leur ordre
    alternatives: d.alternatives.map((alternative) => ({ ...alternative, kindLabel: ALTERNATIVE_LABELS[alternative.kind] })),
    // Ce que le réseau permet encore (calculé)
    suggestedLines: d.status === "active" ? suggestedLines(d, lines, active) : [],
    startsAt: d.startsAt,
    expectedEndAt: d.expectedEndAt,
    endedAt: d.endedAt,
    alertId: d.alertId,
    updatedAt: d.updatedAt ?? d.startsAt,
  };
}

export type PublicDisruptionView = ReturnType<typeof disruptionView>;

const STATE_LABELS = {
  normal: { fr: "Trafic normal", en: "Running normally" },
  delayed: { fr: "Trafic perturbé", en: "Delays" },
  interrupted: { fr: "Trafic interrompu", en: "Interrupted" },
} as const;

export function lineView(line: LineData, lines: LineData[], active: DisruptionData[]) {
  const own = active.filter((d) => d.line.code === line.code);
  const state: keyof typeof STATE_LABELS = own.some((d) => d.kind === "interrupted") ? "interrupted" : own.length ? "delayed" : "normal";
  return {
    ...lineRef(line),
    modeLabel: MODE_LABELS[line.mode],
    stops: line.stops,
    zones: line.zones,
    zoneLabels: { fr: line.zones.map((zone) => ZONE_LABELS[zone]?.fr ?? zone), en: line.zones.map((zone) => ZONE_LABELS[zone]?.en ?? zone) },
    frequencyMinutes: line.frequencyMinutes,
    info: lineInfo(line),
    state,
    stateLabel: STATE_LABELS[state],
    disruptions: own.map((d) => disruptionView(d, lines, active)),
  };
}

// Vue courte jointe à une alerte « transport » : quelles lignes, et le lien vers les solutions
export function alertTransportView(disruptions: DisruptionData[]) {
  return disruptions.map((d) => ({
    disruptionId: d.id,
    line: lineRef(d.line),
    kind: d.kind,
    status: d.status,
    headline: disruptionHeadline(d),
  }));
}
