import { Router } from "express";
import {
  createPermission,
  deletePermission,
  getPermission,
  listPermissions,
  updatePermission,
} from "../controllers/permission.controller";
import { authenticate, requirePermission } from "../middlewares/auth.middleware";

const router = Router();

router.use(authenticate, requirePermission("admin.users.manage"));

router.get("/", listPermissions);
router.get("/:id", getPermission);
router.post("/", createPermission);
router.patch("/:id", updatePermission);
router.delete("/:id", deletePermission);

export default router;
