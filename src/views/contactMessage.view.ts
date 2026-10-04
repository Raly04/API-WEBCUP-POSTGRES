import type { ContactMessageData, ContactStatus } from "../models/contactMessage.model";
import { maskEmail } from "../utils/mask";

export interface ContactMessageView {
  id: number;
  subject: string;
  message: string;
  status: ContactStatus;
  sentAt: Date;
  confirmedAt: Date | null;
  sender?: { id: number; email: string; firstName: string; lastName: string } | null;
}

// Vue de l'expéditeur : sans l'expéditeur (inutile pour l'intéressé lui-même)
export function contactMessageView(message: ContactMessageData): ContactMessageView {
  const { id, subject, message: body, status, sentAt, confirmedAt } = message;
  return { id, subject, message: body, status, sentAt, confirmedAt: confirmedAt ?? null };
}

// Vue des agents : avec l'expéditeur (email, nom), ou null si son compte a été supprimé.
// Pour un agent non validé (inscrit seul), l'e-mail n'est donné que partiellement (voir utils/staffAccess).
export function contactMessageStaffView(message: ContactMessageData, maskContact = false): ContactMessageView {
  const { sender } = message;
  return {
    ...contactMessageView(message),
    sender: sender
      ? {
          id: sender.id,
          email: maskContact ? maskEmail(sender.email) : sender.email,
          firstName: sender.firstName,
          lastName: sender.lastName,
        }
      : null,
  };
}
