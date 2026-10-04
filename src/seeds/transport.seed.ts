import { TransportLine } from "../models/transport.model";

// Réseau de départ de Terra Nova. Les arrêts communs (Gare Centrale, Dôme Nord, Porte Ouest...) permettent les
// correspondances : c'est ce qui rend possible un trajet de remplacement quand une ligne est coupée.
const TICKET = "Ticket : 1 crédit, valable 1 h correspondances comprises.";
const RUSH = [
  { from: "07:00", to: "09:30", every: 5 },
  { from: "17:00", to: "19:30", every: 5 },
];
const EVERY_DAY = [1, 2, 3, 4, 5, 6, 7];

const LINES = [
  {
    code: "N1", name: "Navette Nord", mode: "shuttle" as const, color: "#2563EB", zones: "north,center", frequencyMinutes: 10, minutesBetweenStops: 3,
    stops: ["Dôme Nord", "Serres Nord", "Place des Pionniers", "Gare Centrale"],
    schedule: { days: EVERY_DAY, first: "05:30", last: "23:00", peaks: RUSH }, wheelchairAccessible: true, notes: `${TICKET} Accessible en fauteuil roulant.`,
  },
  {
    code: "S1", name: "Navette Sud", mode: "shuttle" as const, color: "#16A34A", zones: "center,south", frequencyMinutes: 10, minutesBetweenStops: 3,
    stops: ["Gare Centrale", "Marché", "Rue des Serres", "Canal Sud", "Dôme Sud"],
    schedule: { days: EVERY_DAY, first: "05:30", last: "23:00", peaks: RUSH }, wheelchairAccessible: true, notes: `${TICKET} Accessible en fauteuil roulant.`,
  },
  {
    code: "T1", name: "Tram Est–Ouest", mode: "tram" as const, color: "#DC2626", zones: "west,center,east", frequencyMinutes: 8, minutesBetweenStops: 2,
    stops: ["Porte Ouest", "Hôpital", "Gare Centrale", "Place des Pionniers", "Université", "Porte Est"],
    schedule: { days: EVERY_DAY, first: "05:00", last: "23:45", peaks: RUSH.map((peak) => ({ ...peak, every: 4 })) },
    wheelchairAccessible: true, notes: `${TICKET} Plancher bas, vélos acceptés hors heures de pointe.`,
  },
  {
    code: "T2", name: "Tram des Dômes", mode: "tram" as const, color: "#9333EA", zones: "north,east,south", frequencyMinutes: 12, minutesBetweenStops: 4,
    stops: ["Dôme Nord", "Université", "Porte Est", "Dôme Sud"],
    schedule: { days: EVERY_DAY, first: "05:15", last: "23:30", peaks: RUSH.map((peak) => ({ ...peak, every: 6 })) }, wheelchairAccessible: true, notes: TICKET,
  },
  {
    code: "B3", name: "Bus des Serres", mode: "bus" as const, color: "#EA580C", zones: "north,west", frequencyMinutes: 15, minutesBetweenStops: 4,
    stops: ["Dôme Nord", "Serres Nord", "Hôpital", "Porte Ouest"],
    schedule: { days: [1, 2, 3, 4, 5, 6], first: "06:00", last: "21:00", peaks: [] }, wheelchairAccessible: false, notes: `${TICKET} Ne circule pas le dimanche.`,
  },
  {
    code: "C1", name: "Téléphérique du Canal", mode: "cable" as const, color: "#0891B2", zones: "west,south", frequencyMinutes: 6, minutesBetweenStops: 6,
    stops: ["Porte Ouest", "Canal Sud"],
    schedule: { days: EVERY_DAY, first: "07:00", last: "22:00", peaks: [] }, wheelchairAccessible: true, notes: `${TICKET} Fermé en cas de vent fort.`,
  },
];

// Ne sème que sur une table vide : une ligne modifiée par les services n'est jamais écrasée.
export async function seedTransport() {
  if ((await TransportLine.count()) > 0) return { inserted: 0 };
  await TransportLine.bulkCreate(
    LINES.map((line, index) => ({ ...line, stops: JSON.stringify(line.stops), schedule: JSON.stringify(line.schedule), sortOrder: (index + 1) * 10 }))
  );
  return { inserted: LINES.length };
}
