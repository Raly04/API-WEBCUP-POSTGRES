import type { Server } from "socket.io";
import { logger } from "../utils/logger";

// Alertes à la population en temps réel, sur le canal PUBLIC (le même que les annonces) : une montée des eaux doit
// apparaître immédiatement chez tous les habitants connectés, avec ou sans compte. Le client affiche le bandeau si
// l'alerte concerne le quartier de l'habitant (champ `zones`) ou toute la ville. Contenu public uniquement.
export const ALERT_PUBLISHED_EVENT = "alert:published";
export const ALERT_UPDATED_EVENT = "alert:updated";
export const ALERT_ENDED_EVENT = "alert:ended";

let io: Server | null = null;

export function attachAlertChannel(server: Server) {
  io = server;
  logger.info("REALTIME", "Alertes à la population : diffusion temps réel active");
}

// Silencieux si le canal n'est pas ouvert (tests, scripts)
export function broadcastAlert(
  event: typeof ALERT_PUBLISHED_EVENT | typeof ALERT_UPDATED_EVENT | typeof ALERT_ENDED_EVENT,
  payload: { id: number; zones: string[] }
) {
  if (!io) return;
  io.emit(event, payload);
  logger.info("REALTIME", `Alerte #${payload.id} diffusée (${event}, zones : ${payload.zones.join(", ")})`);
}

// État du réseau de transport (lignes touchées, rétablies) : le client rafraîchit la page « Transports » sans recharger
export const TRANSPORT_UPDATED_EVENT = "transport:updated";

export function broadcastTransport(payload: { lines: { code: string; state: string }[] }) {
  if (!io) return;
  io.emit(TRANSPORT_UPDATED_EVENT, payload);
  logger.info("REALTIME", `Transports mis à jour (${payload.lines.map((line) => `${line.code} ${line.state}`).join(", ")})`);
}
