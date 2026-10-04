import { Router } from "express";
import {
  createRequest,
  getMyRequest,
  getRequest,
  getSimilarRequests,
  listMyRequests,
  listRequests,
  updateRequest,
} from "../controllers/citizenRequest.controller";
import { writeLimiter } from "../middlewares/rateLimit.middleware";
import { authenticate, requirePermission } from "../middlewares/auth.middleware";
import { sensitiveReadLimit } from "../middlewares/sensitiveAccess.middleware";
import { botGuard } from "../middlewares/botGuard.middleware";

const router = Router();

router.use(authenticate);

// Citoyen : uniquement ses propres demandes, filtrées par userId côté modèle
router.post("/", requirePermission("citizen.requests.create"), botGuard("request"), writeLimiter, createRequest);
router.get("/mine", requirePermission("citizen.requests.view"), listMyRequests);
router.get("/mine/:id", requirePermission("citizen.requests.view"), getMyRequest);

// Agent : file complete et traitement
router.get("/", requirePermission("agent.requests.view"), sensitiveReadLimit, listRequests);
router.get("/:id", requirePermission("agent.requests.view"), sensitiveReadLimit, getRequest);
router.get("/:id/similar", requirePermission("agent.requests.view"), sensitiveReadLimit, getSimilarRequests);
router.patch("/:id", requirePermission("agent.requests.manage"), updateRequest);

export default router;