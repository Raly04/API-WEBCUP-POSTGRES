import { Router } from "express";
import {
  assignRole,
  getUser,
  listPendingAgents,
  listUsers,
  removeRole,
  setUserStatus,
  validateAgent,
} from "../controllers/user.controller";
import { authenticate, requirePermission } from "../middlewares/auth.middleware";

const router = Router();

router.use(authenticate, requirePermission("admin.users.manage"));

router.get("/", listUsers);
// Agents inscrits seuls, en attente de validation (avant "/:id")
router.get("/pending-agents", listPendingAgents);
router.get("/:id", getUser);
router.patch("/:id/status", setUserStatus);
router.post("/:id/roles", assignRole);
router.post("/:id/validate-agent", validateAgent);
router.delete("/:id/roles/:code", removeRole);

export default router;
