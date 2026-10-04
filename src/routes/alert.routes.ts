import { Router } from "express";
import { draftAlertWithAi, endAlert, getAlert, listAlerts, publishAlert, updateAlert } from "../controllers/alert.controller";
import { authenticate, requirePermission } from "../middlewares/auth.middleware";
import { aiDraftLimiter } from "../middlewares/rateLimit.middleware";

// Alertes à la population, côté personnel (la lecture publique est sous /api/public/alerts)
const router = Router();

router.use(authenticate, requirePermission("agent.alerts.manage"));

router.get("/", listAlerts);
router.get("/:id", getAlert);
router.post("/", publishAlert);
router.post("/draft", aiDraftLimiter, draftAlertWithAi); // brouillon rédigé par l'IA, jamais publié seul
router.post("/:id/updates", updateAlert);
router.post("/:id/end", endAlert);

export default router;
