import jwt from "jsonwebtoken";
import type { Server } from "socket.io";
import { PermissionModel } from "../models/permission.model";
import { UserModel } from "../models/user.model";
import { logger } from "../utils/logger";
import { verifyAccessToken } from "../utils/token";

// Canal temps réel RÉSERVÉ AU PERSONNEL : une urgence signalée apparaît chez les agents sans qu'ils aient à rafraîchir.
// Contrairement au canal des annonces (public), celui-ci exige un jeton de connexion valide ET la permission de
// traiter les signalements, vérifiés à la connexion. Il ne diffuse jamais de donnée personnelle ou de santé : seulement
// de quoi réagir (type, priorité, lieu). Le détail s'ouvre ensuite par l'API, qui contrôle les droits et trace l'accès.
export const STAFF_NAMESPACE = "/staff";
export const SIGNALEMENT_NEW_EVENT = "signalement:new";
export const SIGNALEMENT_UPDATED_EVENT = "signalement:updated";
const REQUIRED_PERMISSION = "agent.signalements.view";
const MAX_SOCKETS_PER_USER = 4;

let staff: ReturnType<Server["of"]> | null = null;

export function attachStaffChannel(io: Server) {
  staff = io.of(STAFF_NAMESPACE);
  const perUser = new Map<number, number>();

  staff.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== "string" || !token) return next(new Error("unauthorized"));
      const { sub } = verifyAccessToken(token);
      const [active, permissions] = await Promise.all([UserModel.isActive(sub), PermissionModel.codesForUser(sub)]);
      if (!active || !permissions.includes(REQUIRED_PERMISSION)) return next(new Error("forbidden"));

      const open = perUser.get(sub) ?? 0;
      if (open >= MAX_SOCKETS_PER_USER) return next(new Error("too_many_connections"));
      perUser.set(sub, open + 1);

      // Le droit est vérifié à la connexion : on coupe donc la connexion à l'expiration du jeton, pour qu'un compte
      // désactivé ou retiré du personnel ne continue pas à recevoir des alertes pendant des heures. Le client se reconnecte
      // avec un jeton rafraîchi.
      const exp = (jwt.decode(token) as { exp?: number } | null)?.exp;
      const expiry = exp ? setTimeout(() => socket.disconnect(true), Math.max(1000, exp * 1000 - Date.now())) : null;
      expiry?.unref();
      socket.on("disconnect", () => {
        if (expiry) clearTimeout(expiry);
        const left = (perUser.get(sub) ?? 1) - 1;
        if (left <= 0) perUser.delete(sub);
        else perUser.set(sub, left);
      });
      socket.data.userId = sub;
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });

  staff.on("connection", (socket) => logger.info("REALTIME", `Agent connecté au canal des signalements (compte ${socket.data.userId})`));
  logger.info("REALTIME", "Canal temps réel des signalements (personnel) ouvert");
}

// Silencieux si le canal n'est pas ouvert (tests, scripts)
export function notifyStaff(event: typeof SIGNALEMENT_NEW_EVENT | typeof SIGNALEMENT_UPDATED_EVENT, payload: unknown) {
  staff?.emit(event, payload);
}
