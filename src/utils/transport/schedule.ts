import type { LineData, LineSchedule } from "../../models/transport.model";

// Horaires calculés à partir de la grille de chaque ligne (premier et dernier départ, fréquence, heures de pointe).
// Heure locale de Terra Nova : TRANSPORT_TIMEZONE (ex. « Indian/Antananarivo »), sinon le fuseau du serveur.
export const TIMEZONE = process.env.TRANSPORT_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
const DAY = 24 * 60;

export const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
};
export const toClock = (minutes: number) => {
  const value = ((minutes % DAY) + DAY) % DAY;
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
};

// Minute de la journée et jour ISO (1 = lundi) à Terra Nova, maintenant ou à un instant donné
export function localClock(at = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((part) => [part.type, part.value])
  );
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday) + 1;
  return { minute: Number(parts.hour) * 60 + Number(parts.minute), weekday, timezone: TIMEZONE };
}

const every = (schedule: LineSchedule, fallback: number, minute: number) =>
  schedule.peaks.find((peak) => minute >= toMinutes(peak.from) && minute < toMinutes(peak.to))?.every ?? fallback;

// Départs des terminus sur une journée de service
export function terminusDepartures(line: LineData): number[] {
  if (!line.schedule) return [];
  const result: number[] = [];
  const last = toMinutes(line.schedule.last);
  for (let t = toMinutes(line.schedule.first); t <= last; t += Math.max(2, every(line.schedule, line.frequencyMinutes ?? 15, t))) result.push(t);
  return result;
}

export interface Departure {
  time: string; // « 14:32 », heure locale
  inMinutes: number; // dans combien de minutes
  tomorrow: boolean; // pas aujourd'hui : service terminé, ou ligne qui ne roule pas ce jour-là
  dayOffset: number; // 0 aujourd'hui, 1 demain, 2 après-demain...
}

/**
 * Prochains passages à l'arrêt `stopIndex`, dans le sens « vers la fin de la ligne » (forward) ou « vers le début ».
 * Prend en compte les jours de service ; regarde jusqu'à 7 jours plus loin (ligne qui ne roule pas le dimanche).
 */
export function nextDepartures(line: LineData, stopIndex: number, forward: boolean, count = 3, now = localClock()): Departure[] {
  if (!line.schedule || stopIndex < 0) return [];
  const offset = (forward ? stopIndex : line.stops.length - 1 - stopIndex) * line.minutesBetweenStops;
  const base = terminusDepartures(line).map((t) => t + offset);
  const result: Departure[] = [];
  for (let day = 0; day < 8 && result.length < count; day++) {
    const weekday = ((now.weekday - 1 + day) % 7) + 1;
    if (!line.schedule.days.includes(weekday)) continue;
    for (const t of base) {
      const absolute = day * DAY + t;
      if (absolute < now.minute) continue;
      result.push({ time: toClock(t), inMinutes: absolute - now.minute, tomorrow: day > 0, dayOffset: day });
      if (result.length >= count) break;
    }
  }
  return result;
}

// Prochain départ après une minute donnée (pour enchaîner les correspondances d'un trajet). null : plus de service.
export function nextDepartureAfter(line: LineData, stopIndex: number, forward: boolean, minute: number, now = localClock()): number | null {
  // Un trajet commencé avant minuit peut se poursuivre le lendemain
  const days = Math.floor(minute / DAY);
  const shifted = { ...now, minute: minute - days * DAY, weekday: ((now.weekday - 1 + days) % 7) + 1 };
  const [first] = nextDepartures(line, stopIndex, forward, 1, shifted);
  return first ? minute + first.inMinutes : null;
}
