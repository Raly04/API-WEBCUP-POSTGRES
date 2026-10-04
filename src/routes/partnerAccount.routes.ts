import { Router } from "express";
import {
  createPartnerAccount,
  listPartnerAccounts,
  setPartnerAccountStatus,
} from "../controllers/partnerAccount.controller";
import { authenticate, requirePermission } from "../middlewares/auth.middleware";

const router = Router();

router.use(authenticate, requirePermission("admin.partners.manage"));

router.get("/", listPartnerAccounts);
router.post("/", createPartnerAccount);
router.patch("/:id/status", setPartnerAccountStatus);

export default router;
