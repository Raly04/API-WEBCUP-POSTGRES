import type { ProjectCommentData, ProjectData } from "../models/project.model";

export interface ProjectView {
  id: number;
  title: string;
  description: string | null;
  imageUrl: string | null;
  status: ProjectData["status"];
  progress: number | null;
  author: { id: number; firstName: string; lastName: string } | null;
  participants: { id: number; firstName: string; lastName: string }[];
  externalEntities: { id: number; name: string; type: string | null }[];
  createdAt: Date;
  updatedAt: Date;
}

export function projectView(project: ProjectData): ProjectView {
  const { id, title, description, imageUrl, status, progress, author, participants, externalEntities, createdAt, updatedAt } =
    project;
  return {
    id,
    title,
    description,
    imageUrl,
    status,
    progress,
    author: author ? { id: author.id, firstName: author.firstName, lastName: author.lastName } : null,
    participants: (participants ?? []).map((user) => ({ id: user.id, firstName: user.firstName, lastName: user.lastName })),
    externalEntities: (externalEntities ?? []).map((entity) => ({ id: entity.id, name: entity.name, type: entity.type })),
    createdAt,
    updatedAt,
  };
}

// Catalogue public : seulement ce qu'il faut pour la page d'accueil (pas de participants/auteur)
export interface PublicProjectView {
  id: number;
  title: string;
  description: string | null;
  imageUrl: string | null;
  status: ProjectData["status"];
  progress: number | null;
  createdAt: Date;
}

export function publicProjectView(project: ProjectData): PublicProjectView {
  const { id, title, description, imageUrl, status, progress, createdAt } = project;
  return { id, title, description, imageUrl, status, progress, createdAt };
}

export interface ProjectCommentView {
  id: number;
  content: string;
  author: { id: number; firstName: string; lastName: string } | null;
  createdAt: Date;
}

export function projectCommentView(comment: ProjectCommentData): ProjectCommentView {
  const { id, content, author, createdAt } = comment;
  return {
    id,
    content,
    author: author ? { id: author.id, firstName: author.firstName, lastName: author.lastName } : null,
    createdAt,
  };
}
