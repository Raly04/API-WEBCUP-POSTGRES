import { HAZARD_LABELS, SEVERITY_INFO, ZONE_LABELS, type AlertData, type Zone } from "../models/alert.model";

const ISSUER = { fr: "Services municipaux de Terra Nova", en: "Terra Nova municipal services" };

function parseInstructions(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

const zoneList = (zones: string) => zones.split(",").map((zone) => zone.trim()).filter(Boolean) as (Zone | "all")[];

// Vue PUBLIQUE d'une alerte : tout ce qu'il faut pour comprendre en un coup d'œil, dans l'ordre de lecture d'une personne
// inquiète : quel danger, où, à quel point c'est grave, QUE FAIRE, depuis quand / jusqu'à quand. Aucune donnée personnelle
// (l'émetteur est « les services municipaux », jamais le nom d'un agent).
export function publicAlertView(alert: AlertData) {
  const severity = SEVERITY_INFO[alert.severity];
  const zones = zoneList(alert.zones);
  const zoneLabels = { fr: zones.map((zone) => ZONE_LABELS[zone]?.fr ?? zone), en: zones.map((zone) => ZONE_LABELS[zone]?.en ?? zone) };
  const instructions = parseInstructions(alert.instructions);
  const ended = alert.status === "ended";
  return {
    id: alert.id,
    status: alert.status,
    severity: alert.severity,
    severityLabel: { fr: severity.fr, en: severity.en },
    // Couleur universelle du niveau (bleu, jaune, orange, rouge) et « faut-il agir ? » : la première chose à afficher
    color: severity.color,
    actionRequired: !ended && severity.actionRequired,
    hazard: alert.hazard,
    hazardLabel: HAZARD_LABELS[alert.hazard],
    zones,
    zoneLabels,
    // Ligne prête à afficher dans un bandeau : « ALERTE : PROTÉGEZ-VOUS — Montée des eaux · Quartier sud »
    headline: ended
      ? { fr: `Fin d'alerte — ${alert.title}`, en: `Alert ended — ${alert.title}` }
      : {
          fr: `${severity.fr.toUpperCase()} — ${alert.title} · ${zoneLabels.fr.join(", ")}`,
          en: `${severity.en.toUpperCase()} — ${alert.title} · ${zoneLabels.en.join(", ")}`,
        },
    title: alert.title,
    message: alert.message,
    // Ce qu'il faut FAIRE, en phrases courtes, dans l'ordre
    instructions,
    endMessage: alert.endMessage ?? null,
    issuer: ISSUER,
    startsAt: alert.startsAt,
    expiresAt: alert.expiresAt,
    endedAt: alert.endedAt ?? null,
    updatedAt: alert.updatedAt ?? alert.createdAt,
    // Change à chaque mise à jour : le client sait qu'il doit ré-afficher l'alerte (même si elle était fermée)
    version: alert.version,
    // L'évolution de la situation, la plus récente d'abord
    updates: (alert.updates ?? []).map((update) => ({ at: update.createdAt, message: update.message, severity: update.severity ?? null })),
  };
}

// Vue du personnel : la vue publique + l'auteur
export function staffAlertView(alert: AlertData) {
  return {
    ...publicAlertView(alert),
    createdBy: alert.author ? { id: alert.author.id, firstName: alert.author.firstName, lastName: alert.author.lastName } : null,
    createdAt: alert.createdAt,
  };
}

export function zonesView() {
  return Object.entries(ZONE_LABELS).map(([code, label]) => ({ code, label }));
}
