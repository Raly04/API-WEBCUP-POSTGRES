import { Router } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import {
  acknowledgeSignalement,
  cancelMySignalement,
  createSignalement,
  getMySignalement,
  getSignalement,
  listMySignalements,
  listSignalementTypes,
  listSignalements,
  signalementSummary,
  updateSignalement,
} from "../controllers/signalement.controller";
import { authenticate, requirePermission } from "../middlewares/auth.middleware";
import { sensitiveReadLimit } from "../middlewares/sensitiveAccess.middleware";
import { audit } from "../utils/audit";

const router = Router();

// Plafond d'envois PAR COMPTE (pas par adresse IP : plusieurs personnes peuvent partager un réseau, et une urgence ne doit
// jamais être refusée parce qu'un voisin vient d'en signaler une). Large : une personne qui signale plusieurs événements
// à la suite n'est pas gênée ; il ne sert qu'à arrêter un script qui inonderait le personnel de fausses alertes.
const sendLimit = Number(process.env.SIGNALEMENT_RATE_LIMIT_PER_10MIN) || 20;
const signalementLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: sendLimit,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `user:${req.user.sub}` : ipKeyGenerator(req.ip ?? "")),
  handler: (req, res) => {
    void audit(req, "rate.limited", { entityType: "signalements" });
    res.status(429).json({
      code: "RATE_LIMITED",
      message: "Vous avez envoyé beaucoup de signalements en peu de temps. Si c'est une urgence, contactez directement les secours.",
    });
  },
});

router.use(authenticate);

// Déclarant. VOLONTAIREMENT sans botGuard : une personne en détresse ne doit être arrêtée ni par un délai minimal de
// remplissage ni par un jeton de formulaire. Elle est authentifiée, plafonnée par compte, et chaque envoi est tracé.
router.get("/types", requirePermission("citizen.signalements.create"), listSignalementTypes);
router.post("/", requirePermission("citizen.signalements.create"), signalementLimiter, createSignalement);
router.get("/mine", requirePermission("citizen.signalements.view"), listMySignalements);
router.get("/mine/:id", requirePermission("citizen.signalements.view"), getMySignalement);
router.post("/mine/:id/cancel", requirePermission("citizen.signalements.view"), cancelMySignalement);

// Personnel : "/summary" avant "/:id"
router.get("/summary", requirePermission("agent.signalements.view"), signalementSummary);
router.get("/", requirePermission("agent.signalements.view"), sensitiveReadLimit, listSignalements);
router.get("/:id", requirePermission("agent.signalements.view"), sensitiveReadLimit, getSignalement);
router.post("/:id/acknowledge", requirePermission("agent.signalements.manage"), acknowledgeSignalement);
router.patch("/:id", requirePermission("agent.signalements.manage"), updateSignalement);

export default router;
