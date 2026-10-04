import { Router } from "express";
import {
  createService,
  deleteService,
  getService,
  listServices,
  updateService,
} from "../controllers/municipalService.controller";
import { createServiceReview, listMyReviews, listServiceReviews } from "../controllers/serviceReview.controller";
import { writeLimiter } from "../middlewares/rateLimit.middleware";
import { authenticate, requirePermission } from "../middlewares/auth.middleware";
import { botGuard } from "../middlewares/botGuard.middleware";

const router = Router();

router.use(authenticate);

// Lecture : tout citoyen connecté
router.get("/", requirePermission("citizen.services.view"), listServices);
// Avis : "/reviews/mine" doit précéder "/:id"
router.get("/reviews/mine", requirePermission("citizen.services.view"), listMyReviews);
router.get("/:id", requirePermission("citizen.services.view"), getService);
router.get("/:id/reviews", requirePermission("citizen.services.view"), listServiceReviews);
router.post("/:id/reviews", requirePermission("citizen.requests.create"), botGuard("review"), writeLimiter, createServiceReview);

// Gestion : administrateur
router.post("/", requirePermission("admin.services.manage"), createService);
router.patch("/:id", requirePermission("admin.services.manage"), updateService);
router.delete("/:id", requirePermission("admin.services.manage"), deleteService);

export default router;
