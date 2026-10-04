import { Router } from "express";
import { deleteNotice, putNotice } from "../controllers/essentials.controller";
import { authenticate, requirePermission } from "../middlewares/auth.middleware";

// Avis d'incident sur la plateforme (lecture : GET /api/status, kit essentiel et page de secours)
const router = Router();

router.use(authenticate, requirePermission("admin.platform.manage"));

router.put("/notice", putNotice);
router.delete("/notice", deleteNotice);

export default router;
