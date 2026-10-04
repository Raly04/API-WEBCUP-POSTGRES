import { Router } from "express";
import { uploadProjectImageHandler } from "../controllers/upload.controller";
import { authenticate, requirePermission } from "../middlewares/auth.middleware";

const router = Router();

router.use(authenticate, requirePermission("admin.projects.manage"));

router.post("/project-image", uploadProjectImageHandler);

export default router;
