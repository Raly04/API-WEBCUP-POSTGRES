import { Router } from "express";
import {
  getCitizenAccount,
  listCitizenAccounts,
  setCitizenAccountStatus,
  updateCitizenAccount,
} from "../controllers/citizenAccount.controller";
import { authenticate, requirePermission } from "../middlewares/auth.middleware";
import { sensitiveReadLimit } from "../middlewares/sensitiveAccess.middleware";

const router = Router();

router.use(authenticate, requirePermission("agent.citizens.manage"), sensitiveReadLimit);

router.get("/", listCitizenAccounts);
router.get("/:id", getCitizenAccount);
router.patch("/:id", updateCitizenAccount);
router.patch("/:id/status", setCitizenAccountStatus);

export default router;
