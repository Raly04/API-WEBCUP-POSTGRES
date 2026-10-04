import { Router } from "express";
import {
  createPartnerService,
  deletePartnerService,
  getPartnerService,
  listMyPartnerServices,
  listPartnerServices,
  updatePartnerService,
} from "../controllers/partnerService.controller";
import { createPartnerServiceRequest } from "../controllers/partnerServiceRequest.controller";
import { authenticate, requirePermission } from "../middlewares/auth.middleware";
import { botGuard } from "../middlewares/botGuard.middleware";
import { writeLimiter } from "../middlewares/rateLimit.middleware";

const router = Router();

router.use(authenticate);

// Catalogue public : tout habitant pouvant consulter les services
router.get("/", requirePermission("citizen.partners.view"), listPartnerServices);
// "/mine" doit précéder "/:id"
router.get("/mine", requirePermission("partner.services.manage"), listMyPartnerServices);
router.get("/:id", requirePermission("citizen.partners.view"), getPartnerService);

// Gestion : le partenaire propriétaire de l'offre
router.post("/", requirePermission("partner.services.manage"), createPartnerService);
router.patch("/:id", requirePermission("partner.services.manage"), updatePartnerService);
router.delete("/:id", requirePermission("partner.services.manage"), deletePartnerService);

// L'habitant contacte le partenaire au sujet d'une offre
router.post(
  "/:id/requests",
  requirePermission("citizen.partners.request"),
  botGuard("partner_request"),
  writeLimiter,
  createPartnerServiceRequest
);

export default router;
