import type { DisruptionData, LineData, TransportMode } from "../../models/transport.model";
import { localClock, nextDepartureAfter, toClock } from "./schedule";

// Recherche d'itinéraire « malgré les interruptions » : l'habitant dit d'où il part et où il va, on lui rend jusqu'à
// 3 trajets qui évitent les sections coupées, en comptant les bus de remplacement déclarés par les services.
// Le réseau est petit (une dizaine de lignes) : on énumère les trajets directs, avec 1 puis 2 correspondances.

export const normalizeStop = (value: string) =>
  value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Ligne utilisable dans le calcul : une vraie ligne ou un bus de remplacement
interface PlanLine {
  code: string;
  name: string;
  mode: TransportMode;
  color: string;
  stops: string[];
  replacement: boolean;
  data: LineData; // horaires (pour un bus de remplacement : ceux de la ligne remplacée, moins fréquents et plus lents)
}

const TRANSFER_MINUTES = 2;

export interface Leg {
  line: { code: string; name: string; mode: TransportMode; color: string; replacement: boolean };
  from: string;
  to: string;
  direction: string; // terminus dans le sens du trajet : ce qui est écrit sur le véhicule
  stops: number;
  delayed: boolean;
  departure: string | null; // « 14:32 » : prochain passage à l'arrêt de montée
  arrival: string | null;
}

export interface JourneyOption {
  summary: { fr: string; en: string };
  legs: Leg[];
  transfers: number;
  stops: number;
  delayed: boolean;
  usesReplacement: boolean;
  departure: string | null; // heure de départ du premier véhicule
  arrival: string | null; // heure d'arrivée estimée
  waitMinutes: number | null; // attente avant le premier départ
  durationMinutes: number | null; // de maintenant à l'arrivée
  tomorrow: boolean; // plus de service aujourd'hui : départ demain
}

// Section [a, b] (indices d'arrêts) touchée par une interruption sur une ligne. Toute la ligne si aucun arrêt n'est précisé.
export function sectionOf(line: { stops: string[] }, disruption: Pick<DisruptionData, "fromStop" | "toStop">): [number, number] | null {
  if (!disruption.fromStop || !disruption.toStop) return [0, line.stops.length - 1];
  const a = line.stops.indexOf(disruption.fromStop);
  const b = line.stops.indexOf(disruption.toStop);
  if (a === -1 || b === -1) return null;
  return [Math.min(a, b), Math.max(a, b)];
}

// Arrêts qui ne sont plus desservis : ceux de la section interrompue. Les deux bouts restent desservis quand la coupure
// est partielle (le véhicule fait demi-tour au dernier arrêt atteignable).
export function unservedStops(line: { stops: string[] }, disruption: Pick<DisruptionData, "fromStop" | "toStop" | "kind">): string[] {
  if (disruption.kind !== "interrupted") return [];
  const section = sectionOf(line, disruption);
  if (!section) return [];
  const [a, b] = section;
  const whole = !disruption.fromStop || !disruption.toStop;
  return line.stops.slice(whole ? a : a + 1, whole ? b + 1 : b);
}

// Un trajet de p à q sur la ligne passe-t-il par la section [a, b] ? (au moins un tronçon en commun)
const overlaps = (p: number, q: number, [a, b]: [number, number]) => Math.max(Math.min(p, q), a) < Math.min(Math.max(p, q), b);

export class JourneyPlanner {
  private readonly lines: PlanLine[];
  private readonly blocked = new Map<string, [number, number][]>();
  private readonly slowed = new Map<string, [number, number][]>();
  private readonly stopNames = new Map<string, string>(); // forme normalisée -> nom affiché

  constructor(lines: LineData[], disruptions: DisruptionData[], options: { ignoreDisruptions?: boolean } = {}) {
    this.lines = lines.map((line) => ({ ...line, replacement: false, data: line }));
    for (const line of lines) for (const stop of line.stops) this.stopNames.set(normalizeStop(stop), stop);
    if (options.ignoreDisruptions) return;

    for (const disruption of disruptions) {
      const line = lines.find((item) => item.code === disruption.line.code);
      if (!line) continue;
      const section = sectionOf(line, disruption);
      if (!section) continue;
      const target = disruption.kind === "interrupted" ? this.blocked : this.slowed;
      target.set(line.code, [...(target.get(line.code) ?? []), section]);

      // Bus de remplacement : une ligne de plus, qui dessert les arrêts de la section entre ses deux bouts
      disruption.alternatives.forEach((alternative, index) => {
        if (alternative.kind !== "replacement_bus" || !alternative.from || !alternative.to) return;
        const a = line.stops.indexOf(alternative.from);
        const b = line.stops.indexOf(alternative.to);
        const stops =
          a !== -1 && b !== -1 ? (a <= b ? line.stops.slice(a, b + 1) : line.stops.slice(b, a + 1).reverse()) : [alternative.from, alternative.to];
        const code = `R${disruption.id}${index ? `-${index}` : ""}`;
        const name = `Bus de remplacement ${line.code}`;
        this.lines.push({
          code,
          name,
          mode: "bus",
          color: line.color,
          stops,
          replacement: true,
          data: {
            ...line,
            code,
            name,
            stops,
            frequencyMinutes: Math.max(15, line.frequencyMinutes ?? 15),
            minutesBetweenStops: line.minutesBetweenStops + 2,
            schedule: line.schedule ? { ...line.schedule, peaks: [] } : null,
          },
        });
      });
    }
  }

  resolveStop(input: string): string | null {
    return this.stopNames.get(normalizeStop(input)) ?? null;
  }

  suggestStops(input: string, limit = 5): string[] {
    const needle = normalizeStop(input);
    if (!needle) return [];
    return [...this.stopNames.entries()].filter(([key]) => key.includes(needle) || needle.includes(key)).map(([, name]) => name).slice(0, limit);
  }

  private ride(line: PlanLine, from: string, to: string): Leg | null {
    const p = line.stops.indexOf(from);
    const q = line.stops.indexOf(to);
    if (p === -1 || q === -1 || p === q) return null;
    if ((this.blocked.get(line.code) ?? []).some((section) => overlaps(p, q, section))) return null;
    return {
      line: { code: line.code, name: line.name, mode: line.mode, color: line.color, replacement: line.replacement },
      from,
      to,
      direction: q > p ? line.stops[line.stops.length - 1] : line.stops[0],
      stops: Math.abs(q - p),
      delayed: (this.slowed.get(line.code) ?? []).some((section) => overlaps(p, q, section)),
      departure: null,
      arrival: null,
    };
  }

  // Enchaîne les horaires réels : prochain passage à la montée, arrivée, correspondance (2 min), etc.
  private timed(option: JourneyOption, now: ReturnType<typeof localClock>): JourneyOption {
    let minute = now.minute;
    const legs: Leg[] = [];
    let firstDeparture: number | null = null;
    for (const [index, leg] of option.legs.entries()) {
      const line = this.lines.find((item) => item.code === leg.line.code)!;
      const p = line.stops.indexOf(leg.from);
      const q = line.stops.indexOf(leg.to);
      const departure = nextDepartureAfter(line.data, p, q > p, minute + (index ? TRANSFER_MINUTES : 0), now);
      if (departure === null) return { ...option, legs: option.legs, departure: null, arrival: null, waitMinutes: null, durationMinutes: null, tomorrow: false };
      firstDeparture ??= departure;
      // Section perturbée : on compte une minute de plus par arrêt
      const arrival = departure + leg.stops * (line.data.minutesBetweenStops + (leg.delayed ? 1 : 0));
      legs.push({ ...leg, departure: toClock(departure), arrival: toClock(arrival) });
      minute = arrival;
    }
    return {
      ...option,
      legs,
      departure: legs[0].departure,
      arrival: legs[legs.length - 1].arrival,
      waitMinutes: firstDeparture! - now.minute,
      durationMinutes: minute - now.minute,
      tomorrow: firstDeparture! >= 24 * 60,
    };
  }

  plan(from: string, to: string, max = 3): JourneyOption[] {
    const found = new Map<string, JourneyOption>();
    const keep = (legs: (Leg | null)[]) => {
      if (legs.some((leg) => leg === null)) return;
      const option = buildOption(legs as Leg[]);
      const key = option.legs.map((leg) => leg.line.code).join(">");
      const current = found.get(key);
      if (!current || score(option) < score(current)) found.set(key, option);
    };
    const starting = this.lines.filter((line) => line.stops.includes(from));
    const ending = this.lines.filter((line) => line.stops.includes(to));

    for (const line of starting) keep([this.ride(line, from, to)]);
    for (const first of starting) {
      for (const last of ending) {
        if (first === last) continue;
        for (const transfer of first.stops) {
          if (transfer === from || transfer === to || !last.stops.includes(transfer)) continue;
          keep([this.ride(first, from, transfer), this.ride(last, transfer, to)]);
        }
      }
    }
    // Deux correspondances, seulement si l'on manque encore de solutions
    if (found.size < max) {
      for (const first of starting) {
        for (const last of ending) {
          for (const middle of this.lines) {
            if (middle === first || middle === last || first === last) continue;
            for (const t1 of first.stops) {
              if (t1 === from || !middle.stops.includes(t1)) continue;
              for (const t2 of middle.stops) {
                if (t2 === t1 || t2 === to || !last.stops.includes(t2)) continue;
                keep([this.ride(first, from, t1), this.ride(middle, t1, t2), this.ride(last, t2, to)]);
              }
            }
          }
        }
      }
    }
    // Les meilleurs candidats « sur le papier », puis classés par heure d'arrivée réelle selon les horaires
    const now = localClock();
    return [...found.values()]
      .sort((a, b) => score(a) - score(b))
      .slice(0, max * 2)
      .map((option) => this.timed(option, now))
      .sort((a, b) => (a.durationMinutes ?? Infinity) - (b.durationMinutes ?? Infinity) || score(a) - score(b))
      // Une correspondance de plus ne vaut la peine que si l'on arrive plus tôt
      .filter((option, _index, all) =>
        !all.some((other) => other.transfers < option.transfers && (other.durationMinutes ?? Infinity) <= (option.durationMinutes ?? Infinity))
      )
      .slice(0, max);
  }
}

// Une correspondance « coûte » 3 arrêts, une section perturbée 3, un bus de remplacement 2 (plus lent, moins fréquent)
const score = (option: JourneyOption) => option.stops + option.transfers * 3 + (option.delayed ? 3 : 0) + (option.usesReplacement ? 2 : 0);

// « la ligne S1 », « le bus de remplacement de la ligne S1 »
const replacedCode = (leg: Leg) => leg.line.name.split(" ").pop();
const lineName = (leg: Leg) => (leg.line.replacement ? `le bus de remplacement de la ligne ${replacedCode(leg)}` : `la ligne ${leg.line.code}`);
const lineNameEn = (leg: Leg) => (leg.line.replacement ? `the replacement bus for line ${replacedCode(leg)}` : `line ${leg.line.code}`);

function buildOption(legs: Leg[]): JourneyOption {
  const fr = legs.map((leg, index) => `${index === 0 ? "Prenez" : "puis"} ${lineName(leg)} (direction ${leg.direction}) jusqu'à ${leg.to}`).join(", ");
  const en = legs.map((leg, index) => `${index === 0 ? "Take" : "then"} ${lineNameEn(leg)} (towards ${leg.direction}) to ${leg.to}`).join(", ");
  return {
    summary: { fr: fr.charAt(0).toUpperCase() + fr.slice(1), en },
    legs,
    transfers: legs.length - 1,
    stops: legs.reduce((sum, leg) => sum + leg.stops, 0),
    delayed: legs.some((leg) => leg.delayed),
    usesReplacement: legs.some((leg) => leg.line.replacement),
    departure: null,
    arrival: null,
    waitMinutes: null,
    durationMinutes: null,
    tomorrow: false,
  };
}
