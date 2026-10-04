import { Router } from "express";
import {
  createRole,
  deleteRole,
  getRole,
  grantRolePermissions,
  listRolePermissions,
  listRoles,
  revokeRolePermission,
  setRolePermissions,
  updateRole,
} from "../controllers/role.controller";
import { authenticate, requirePermission } from "../middlewares/auth.middleware";

const router = Router();

router.use(authenticate, requirePermission("admin.users.manage"));

router.get("/", listRoles);
router.get("/:id", getRole);
router.post("/", createRole);
router.patch("/:id", updateRole);
router.delete("/:id", deleteRole);

router.get("/:id/permissions", listRolePermissions);
router.post("/:id/permissions", grantRolePermissions);
router.put("/:id/permissions", setRolePermissions);
router.delete("/:id/permissions/:code", revokeRolePermission);

export default router;
