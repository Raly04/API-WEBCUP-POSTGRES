import { Router } from "express";
import {
  createExternalEntity,
  deleteExternalEntity,
  listExternalEntities,
} from "../controllers/externalEntity.controller";
import { authenticate, requirePermission } from "../middlewares/auth.middleware";

const router = Router();

// Réservé aux administrateurs : ce sont eux qui associent des entités externes à un projet
router.use(authenticate, requirePermission("admin.projects.manage"));

router.get("/", listExternalEntities);
router.post("/", createExternalEntity);
router.delete("/:id", deleteExternalEntity);

export default router;
