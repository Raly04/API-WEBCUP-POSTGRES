import type { AnnouncementData, AnnouncementPriority, AnnouncementStatus } from "../models/announcement.model";

export interface AnnouncementView {
  id: number;
  title: string;
  content: string;
  status: AnnouncementStatus;
  priority: AnnouncementPriority;
  author: { id: number; firstName: string; lastName: string } | null;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function announcementView(announcement: AnnouncementData): AnnouncementView {
  const { id, title, content, status, priority, author, publishedAt, createdAt, updatedAt } = announcement;
  return {
    id,
    title,
    content,
    status,
    priority,
    author: author ? { id: author.id, firstName: author.firstName, lastName: author.lastName } : null,
    publishedAt: publishedAt ?? null,
    createdAt,
    updatedAt,
  };
}

export interface PublicAnnouncementView {
  id: number;
  title: string;
  content: string;
  // Publiée en direct : le client peut teinter l'alerte sans refaire de requête
  priority: AnnouncementPriority;
  publishedAt: Date | null;
}

// Vue publique : sans auteur ni statut (seules les annonces publiées sont exposées)
export function publicAnnouncementView(announcement: AnnouncementData): PublicAnnouncementView {
  const { id, title, content, priority, publishedAt, createdAt } = announcement;
  return { id, title, content, priority, publishedAt: publishedAt ?? createdAt };
}
