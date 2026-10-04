import { Router } from "express";
import {
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "../controllers/notification.controller";
import { authenticate, requirePermission } from "../middlewares/auth.middleware";

const router = Router();

router.use(authenticate);

router.get("/unread-count", requirePermission("citizen.notifications.view"), getUnreadCount);
router.get("/", requirePermission("citizen.notifications.view"), listNotifications);
router.patch("/:id/read", requirePermission("citizen.notifications.manage"), markNotificationRead);
router.post("/read-all", requirePermission("citizen.notifications.manage"), markAllNotificationsRead);

export default router;
