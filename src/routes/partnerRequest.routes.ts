import { Router } from "express";
import { listPartnerRequests, updatePartnerRequestStatus } from "../controllers/partnerServiceRequest.controller";
import { authenticate, requirePermission } from "../middlewares/auth.middleware";

const router = Router();

router.use(authenticate, requirePermission("partner.requests.view"));

router.get("/", listPartnerRequests);
router.patch("/:id", requirePermission("partner.requests.manage"), updatePartnerRequestStatus);

export default router;
