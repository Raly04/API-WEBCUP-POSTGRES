import { Router } from "express";
import { listAuditLogs, listPlatformActivity } from "../controllers/auditLog.controller";
import { authenticate, requirePermission } from "../middlewares/auth.middleware";

const router = Router();

router.get("/activity", authenticate, requirePermission("agent.activity.view"), listPlatformActivity);
router.get("/", authenticate, requirePermission("admin.users.manage"), listAuditLogs);

export default router;
