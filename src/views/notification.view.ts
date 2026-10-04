import type { NotificationData } from "../models/notification.model";

export interface NotificationView {
  id: number;
  type: string;
  title: string;
  body: string;
  appointmentId: number | null;
  // Dossier concerné quand la notification décrit une demande : permet au client d'y renvoyer
  // le citoyen. Null pour un rappel de rendez-vous.
  requestId: number | null;
  // Annonce concernée quand la notification reprend une annonce publiée : le client peut
  // ouvrir l'annonce elle-même. Null pour les deux autres types.
  announcementId: number | null;
  read: boolean;
  createdAt: Date;
}

export function notificationView(notification: NotificationData): NotificationView {
  const { id, type, title, body, appointmentId, requestId, announcementId, readAt, createdAt } = notification;
  return {
    id,
    type,
    title,
    body,
    appointmentId,
    requestId,
    announcementId: announcementId ?? null,
    read: readAt !== null,
    createdAt,
  };
}
