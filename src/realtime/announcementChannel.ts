import type { IncomingMessage, Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { logger } from "../utils/logger";
import type { PublicAnnouncementView } from "../views/announcement.view";

// Nom de l'événement observé par le front (components/realtime/announcement-alerts.tsx)
export const ANNOUNCEMENT_PUBLISHED_EVENT = "announcement:published";

// Le canal est public : un visiteur ouvre une connexion sans session. Sans plafond, une seule adresse IP peut épuiser
// les descripteurs du serveur. Mais une même adresse est souvent PARTAGÉE (box familiale, école, réseau mobile en
// CGNAT) : le plafond par adresse doit rester large, sinon des habitants ne reçoivent plus les alertes.
// Un onglet = UNE connexion, quel que soit le nombre de canaux (public, /staff) : on compte les connexions réelles.
const MAX_CONNECTIONS_PER_IP = Number(process.env.REALTIME_MAX_CONNECTIONS_PER_IP) || 50;
const MAX_CONNECTIONS = Number(process.env.REALTIME_MAX_CONNECTIONS) || 5000;
const TRUST_PROXY = Number(process.env.TRUST_PROXY) || 0;

let io: Server | null = null;

// Adresse réelle du visiteur, avec la même règle que req.ip d'Express (app.ts) : derrière TRUST_PROXY proxys, on lit
// X-Forwarded-For en partant de la droite. Sans TRUST_PROXY mais avec un proxy devant, l'adresse vue est celle du
// proxy, commune à tous : on renvoie null et le plafond par adresse ne s'applique pas (seul le plafond global reste).
function clientAddress(req: IncomingMessage): string | null {
  const direct = req.socket.remoteAddress ?? "inconnu";
  const header = req.headers["x-forwarded-for"];
  const forwarded = (Array.isArray(header) ? header.join(",") : header ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!forwarded.length) return direct;
  if (!TRUST_PROXY) return null;
  const chain = [direct, ...forwarded.reverse()];
  return chain[Math.min(TRUST_PROXY, chain.length - 1)];
}

// Socket.io se greffe sur le serveur HTTP existant plutôt que d'en créer un second.
// Aucune authentification : une alerte du Haut Conseil doit atteindre tous les clients,
// connectés ou non. Le canal ne diffuse que des annonces déjà publiées, via leur vue publique.
export function attachRealtime(server: HttpServer, allowedOrigins: string[]) {
  const connectionsPerIp = new Map<string, number>();
  let total = 0;
  let warnedNoProxy = false;

  io = new Server(server, {
    cors: { origin: allowedOrigins, credentials: true },
    // Les messages sont de la taille d'une annonce : inutile d'accepter de gros payloads
    maxHttpBufferSize: 64 * 1024,
    pingTimeout: 20_000,
    // Vérifié une seule fois, à l'ouverture de la connexion (avant tout canal) : un refus ne coûte presque rien
    allowRequest: (req, callback) => {
      if (total >= MAX_CONNECTIONS) {
        logger.warn("REALTIME", `Connexion refusée : ${total} connexions ouvertes (plafond global)`);
        return callback("Serveur temps réel saturé", false);
      }
      const address = clientAddress(req);
      if (address === null && !warnedNoProxy) {
        warnedNoProxy = true;
        logger.warn("REALTIME", "Proxy détecté (X-Forwarded-For) sans TRUST_PROXY : plafond par adresse désactivé, réglez TRUST_PROXY");
      }
      const current = address === null ? 0 : connectionsPerIp.get(address) ?? 0;
      if (current >= MAX_CONNECTIONS_PER_IP) {
        logger.warn("REALTIME", `Connexion refusée pour ${address} : ${current} connexion(s) déjà ouvertes`);
        return callback("Trop de connexions temps réel", false);
      }
      callback(null, true);
    },
  });

  // Comptage sur la connexion réelle (engine.io), décomptée quoi qu'il arrive à la fermeture
  io.engine.on("connection", (raw: { request: IncomingMessage; once: (event: "close", fn: () => void) => void }) => {
    const address = clientAddress(raw.request);
    total++;
    if (address !== null) connectionsPerIp.set(address, (connectionsPerIp.get(address) ?? 0) + 1);
    raw.once("close", () => {
      total = Math.max(0, total - 1);
      if (address === null) return;
      const left = (connectionsPerIp.get(address) ?? 1) - 1;
      if (left <= 0) connectionsPerIp.delete(address);
      else connectionsPerIp.set(address, left);
    });
  });

  io.on("connection", (socket) => logger.info("REALTIME", `Client temps réel connecté : ${socket.id}`));
  logger.info("REALTIME", "Canal d'annonces temps réel ouvert");
  return io;
}

// Émet une annonce publiée. Silencieux si le canal n'est pas encore ouvert (tests, scripts).
export function broadcastAnnouncement(announcement: PublicAnnouncementView) {
  if (!io) return;
  io.emit(ANNOUNCEMENT_PUBLISHED_EVENT, announcement);
  logger.info("REALTIME", `Annonce #${announcement.id} diffusée (priorité ${announcement.priority})`);
}
