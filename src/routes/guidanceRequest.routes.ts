import { Router } from "express";
import {
  createGuidanceRequest,
  depositGuidanceRequest,
  listGuidanceRequests,
} from "../controllers/guidanceRequest.controller";
import { authenticate, requirePermission } from "../middlewares/auth.middleware";
import { guidanceLimiter } from "../middlewares/rateLimit.middleware";

const router = Router();

router.use(authenticate);

// Citoyen : décrire son problème et être orienté vers le service compétent.
// Limitation de débit propre à cette route : chaque appel part vers un fournisseur externe, et
// le quota gratuit du modèle est le premier goulot d'étranglement de la démo.
router.post("/", guidanceLimiter, requirePermission("citizen.guidance.create"), createGuidanceRequest);
// Déposer la demande dans le service désigné par l'orientation
router.post(
  "/:id/deposit",
  guidanceLimiter,
  requirePermission("citizen.guidance.create"),
  depositGuidanceRequest
);

// Administration : juger la pertinence du routage sur l'ensemble des orientations
router.get("/", requirePermission("admin.guidance.manage"), listGuidanceRequests);

export default router;