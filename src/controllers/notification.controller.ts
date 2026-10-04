import { Request, Response } from "express";
import { NotificationModel, resolveLocale } from "../models/notification.model";
import { parseId, parsePagination } from "../utils/http";
import { notificationView } from "../views/notification.view";

// GET /api/notifications?onlyUnread=&page=&limit=
export async function listNotifications(req: Request, res: Response) {
  const userId = req.user!.sub;
  const locale = resolveLocale(req.headers["accept-language"]);
  await Promise.all([
    NotificationModel.ensureAppointmentReminders(userId, locale),
    NotificationModel.ensureRequestStatusNotifications(userId, locale),
    NotificationModel.ensureAnnouncementNotifications(userId, locale),
  ]);

  const { limit, offset } = parsePagination(req);
  const [{ notifications, total }, unread] = await Promise.all([
    NotificationModel.listForUser(userId, { onlyUnread: req.query.onlyUnread === "true", limit, offset }),
    NotificationModel.countUnread(userId),
  ]);
  res.json({ notifications: notifications.map(notificationView), limit, offset, total, unread });
}

// GET /api/notifications/unread-count
// Génère aussi les rappels dus : un relevé périodique du compteur suffit à faire apparaître
// un rappel sans que le citoyen ait besoin d'ouvrir le panneau de notifications.
export async function getUnreadCount(req: Request, res: Response) {
  const userId = req.user!.sub;
  const locale = resolveLocale(req.headers["accept-language"]);
  await Promise.all([
    NotificationModel.ensureAppointmentReminders(userId, locale),
    NotificationModel.ensureRequestStatusNotifications(userId, locale),
    NotificationModel.ensureAnnouncementNotifications(userId, locale),
  ]);
  res.json({ unread: await NotificationModel.countUnread(userId) });
}

// PATCH /api/notifications/:id/read
export async function markNotificationRead(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  if (!(await NotificationModel.markRead(id, req.user!.sub))) {
    return res.status(404).json({ message: "Notification introuvable ou déjà lue" });
  }
  res.status(204).send();
}

// POST /api/notifications/read-all
export async function markAllNotificationsRead(req: Request, res: Response) {
  const updated = await NotificationModel.markAllRead(req.user!.sub);
  res.json({ updated });
}
