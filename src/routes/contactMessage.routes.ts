import { Router } from "express";
import {
  getContactMessage,
  listContactInbox,
  listMyContactMessages,
  sendContactMessage,
  setContactMessageStatus,
} from "../controllers/contactMessage.controller";
import { writeLimiter } from "../middlewares/rateLimit.middleware";
import { authenticate, requirePermission } from "../middlewares/auth.middleware";
import { sensitiveReadLimit } from "../middlewares/sensitiveAccess.middleware";
import { botGuard } from "../middlewares/botGuard.middleware";

const router = Router();

router.use(authenticate);

// Citoyen : envoyer un message et suivre ses envois
router.post("/", requirePermission("citizen.message.send"), botGuard("contact"), writeLimiter, sendContactMessage);
router.get("/mine", requirePermission("citizen.message.send"), listMyContactMessages);

// Agent / administrateur : boîte de réception et traitement
router.get("/", requirePermission("agent.messages.manage"), sensitiveReadLimit, listContactInbox);
router.patch("/:id/status", requirePermission("agent.messages.manage"), setContactMessageStatus);

// Détail : un agent voit tout, un citoyen uniquement ses propres messages (vérifié dans le contrôleur)
// Le plafond ne compte que le personnel : un citoyen qui relit son propre message n'est jamais limité
router.get("/:id", requirePermission("citizen.message.send"), sensitiveReadLimit, getContactMessage);

export default router;
