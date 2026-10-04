import { Router } from "express";
import { botStats } from "../controllers/security.controller";
import { authenticate, requirePermission } from "../middlewares/auth.middleware";

const router = Router();

router.get("/bots", authenticate, requirePermission("admin.users.manage"), botStats);

export default router;
