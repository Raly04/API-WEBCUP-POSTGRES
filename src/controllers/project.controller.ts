import { Request, Response } from "express";
import { ExternalEntityModel } from "../models/externalEntity.model";
import { PROJECT_STATUSES, ProjectCommentModel, ProjectModel, ProjectStatus, ProjectUpdate } from "../models/project.model";
import { UserModel } from "../models/user.model";
import { audit } from "../utils/audit";
import { parseId } from "../utils/http";
import { projectCommentView, projectView } from "../views/project.view";

function parseTitle(value: unknown): string | null {
  const title = typeof value === "string" ? value.trim() : "";
  return title.length > 0 && title.length <= 200 ? title : null;
}

function parseStatus(value: unknown): ProjectStatus | null {
  return typeof value === "string" && (PROJECT_STATUSES as readonly string[]).includes(value)
    ? (value as ProjectStatus)
    : null;
}

// Progression (%) : pertinente uniquement pour un projet "en cours"
function parseProgress(value: unknown): number | null | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100 ? value : "invalid";
}

// Texte optionnel : undefined = absent, null (ou "") = à effacer
function parseNullableText(value: unknown, max: number): string | null | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return "invalid";
  const text = value.trim();
  if (text.length > max) return "invalid";
  return text === "" ? null : text;
}

function parseContent(value: unknown): string | null {
  const content = typeof value === "string" ? value.trim() : "";
  return content.length > 0 && content.length <= 2000 ? content : null;
}

// GET /api/projects
export async function listProjects(_req: Request, res: Response) {
  res.json((await ProjectModel.list()).map(projectView));
}

// GET /api/projects/:id
export async function getProject(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const project = await ProjectModel.findById(id);
  if (!project) return res.status(404).json({ message: "Projet introuvable" });
  res.json(projectView(project));
}

// POST /api/projects  { title, description?, imageUrl?, status?, progress? }
export async function createProject(req: Request, res: Response) {
  const title = parseTitle(req.body?.title);
  if (!title) return res.status(400).json({ message: "Titre requis (200 caractères max)" });
  const description = parseNullableText(req.body?.description, 65000);
  if (description === "invalid") return res.status(400).json({ message: "Description invalide" });
  const imageUrl = parseNullableText(req.body?.imageUrl, 500);
  if (imageUrl === "invalid") return res.status(400).json({ message: "Image invalide" });
  let status: ProjectStatus | undefined;
  if (req.body?.status !== undefined) {
    const parsed = parseStatus(req.body.status);
    if (!parsed) return res.status(400).json({ message: `Statut invalide (${PROJECT_STATUSES.join(", ")})` });
    status = parsed;
  }
  const parsedProgress = parseProgress(req.body?.progress);
  if (parsedProgress === "invalid") return res.status(400).json({ message: "Progression invalide (0 à 100)" });
  // La progression n'a de sens que pour un projet en cours : silencieusement ignorée sinon
  const progress = (status ?? "ongoing") === "ongoing" ? parsedProgress : null;

  const project = await ProjectModel.create({ title, description, imageUrl, status, progress }, req.user!.sub);
  await audit(req, "project.create", { entityType: "projects", entityId: project.id });
  res.status(201).json(projectView(project));
}

// PATCH /api/projects/:id
export async function updateProject(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const existing = await ProjectModel.findById(id);
  if (!existing) return res.status(404).json({ message: "Projet introuvable" });

  const data: ProjectUpdate = {};
  if (req.body?.title !== undefined) {
    const title = parseTitle(req.body.title);
    if (!title) return res.status(400).json({ message: "Titre invalide (200 caractères max)" });
    data.title = title;
  }
  const description = parseNullableText(req.body?.description, 65000);
  if (description === "invalid") return res.status(400).json({ message: "Description invalide" });
  if (description !== undefined) data.description = description;
  const imageUrl = parseNullableText(req.body?.imageUrl, 500);
  if (imageUrl === "invalid") return res.status(400).json({ message: "Image invalide" });
  if (imageUrl !== undefined) data.imageUrl = imageUrl;
  if (req.body?.status !== undefined) {
    const status = parseStatus(req.body.status);
    if (!status) return res.status(400).json({ message: `Statut invalide (${PROJECT_STATUSES.join(", ")})` });
    data.status = status;
  }
  const parsedProgress = parseProgress(req.body?.progress);
  if (parsedProgress === "invalid") return res.status(400).json({ message: "Progression invalide (0 à 100)" });
  if (parsedProgress !== undefined) data.progress = parsedProgress;
  // La progression n'a de sens que pour un projet en cours : effacée dès qu'il ne l'est plus
  const effectiveStatus = data.status ?? existing.status;
  if (effectiveStatus !== "ongoing" && existing.progress !== null) data.progress = null;

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ message: "Aucun champ à modifier" });
  }

  const project = await ProjectModel.update(id, data);
  if (!project) return res.status(404).json({ message: "Projet introuvable" });
  await audit(req, "project.update", { entityType: "projects", entityId: id });
  res.json(projectView(project));
}

// DELETE /api/projects/:id
export async function deleteProject(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  if (!(await ProjectModel.delete(id))) return res.status(404).json({ message: "Projet introuvable" });
  await audit(req, "project.delete", { entityType: "projects", entityId: id });
  res.status(204).send();
}

// POST /api/projects/:id/participants  { userId }
export async function addParticipant(req: Request, res: Response) {
  const projectId = parseId(req.params.id);
  const userId = parseId(req.body?.userId);
  if (!projectId || !userId) return res.status(400).json({ message: "Identifiant invalide" });
  if (!(await ProjectModel.findById(projectId))) return res.status(404).json({ message: "Projet introuvable" });
  if (!(await UserModel.findPublicById(userId))) return res.status(400).json({ message: "Utilisateur introuvable" });

  const created = await ProjectModel.addParticipant(projectId, userId, req.user!.sub);
  if (created) await audit(req, "project.participant.add", { entityType: "projects", entityId: projectId });
  res.status(created ? 201 : 200).json(projectView((await ProjectModel.findById(projectId))!));
}

// DELETE /api/projects/:id/participants/:userId
export async function removeParticipant(req: Request, res: Response) {
  const projectId = parseId(req.params.id);
  const userId = parseId(req.params.userId);
  if (!projectId || !userId) return res.status(400).json({ message: "Identifiant invalide" });
  const project = await ProjectModel.findById(projectId);
  if (!project) return res.status(404).json({ message: "Projet introuvable" });
  if (!(await ProjectModel.removeParticipant(projectId, userId))) {
    return res.status(404).json({ message: "Ce participant n'est pas associé à ce projet" });
  }
  await audit(req, "project.participant.remove", { entityType: "projects", entityId: projectId });
  res.json(projectView((await ProjectModel.findById(projectId))!));
}

// POST /api/projects/:id/entities  { externalEntityId } ou { name, type? } (ajout rapide)
export async function addExternalEntity(req: Request, res: Response) {
  const projectId = parseId(req.params.id);
  if (!projectId) return res.status(400).json({ message: "Identifiant invalide" });
  if (!(await ProjectModel.findById(projectId))) return res.status(404).json({ message: "Projet introuvable" });

  let entityId: number;
  if (req.body?.externalEntityId !== undefined) {
    const id = parseId(req.body.externalEntityId);
    if (!id || !(await ExternalEntityModel.findById(id))) {
      return res.status(400).json({ message: "Entité externe introuvable" });
    }
    entityId = id;
  } else {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name || name.length > 150) return res.status(400).json({ message: "Nom d'entité requis (150 caractères max)" });
    const type = typeof req.body?.type === "string" && req.body.type.trim() ? req.body.type.trim().slice(0, 100) : null;
    entityId = (await ExternalEntityModel.findOrCreate(name, type)).id;
  }

  const created = await ProjectModel.addExternalEntity(projectId, entityId, req.user!.sub);
  if (created) await audit(req, "project.entity.add", { entityType: "projects", entityId: projectId });
  res.status(created ? 201 : 200).json(projectView((await ProjectModel.findById(projectId))!));
}

// DELETE /api/projects/:id/entities/:entityId
export async function removeExternalEntity(req: Request, res: Response) {
  const projectId = parseId(req.params.id);
  const entityId = parseId(req.params.entityId);
  if (!projectId || !entityId) return res.status(400).json({ message: "Identifiant invalide" });
  const project = await ProjectModel.findById(projectId);
  if (!project) return res.status(404).json({ message: "Projet introuvable" });
  if (!(await ProjectModel.removeExternalEntity(projectId, entityId))) {
    return res.status(404).json({ message: "Cette entité n'est pas associée à ce projet" });
  }
  await audit(req, "project.entity.remove", { entityType: "projects", entityId: projectId });
  res.json(projectView((await ProjectModel.findById(projectId))!));
}

// GET /api/projects/:id/comments
export async function listComments(req: Request, res: Response) {
  const projectId = parseId(req.params.id);
  if (!projectId) return res.status(400).json({ message: "Identifiant invalide" });
  if (!(await ProjectModel.findById(projectId))) return res.status(404).json({ message: "Projet introuvable" });
  res.json((await ProjectCommentModel.listByProject(projectId)).map(projectCommentView));
}

// POST /api/projects/:id/comments  { content }
export async function createComment(req: Request, res: Response) {
  const projectId = parseId(req.params.id);
  if (!projectId) return res.status(400).json({ message: "Identifiant invalide" });
  if (!(await ProjectModel.findById(projectId))) return res.status(404).json({ message: "Projet introuvable" });
  const content = parseContent(req.body?.content);
  if (!content) return res.status(400).json({ message: "Message requis (2000 caractères max)" });

  const comment = await ProjectCommentModel.create({ projectId, userId: req.user!.sub, content });
  await audit(req, "project.comment.create", { entityType: "project_comments", entityId: comment.id });
  res.status(201).json({
    comment: projectCommentView(comment),
    message: "Votre avis a bien été enregistré.",
  });
}

// DELETE /api/projects/:id/comments/:commentId  (modération)
export async function deleteComment(req: Request, res: Response) {
  const projectId = parseId(req.params.id);
  const commentId = parseId(req.params.commentId);
  if (!projectId || !commentId) return res.status(400).json({ message: "Identifiant invalide" });
  const comment = await ProjectCommentModel.findById(commentId);
  if (!comment || comment.projectId !== projectId) return res.status(404).json({ message: "Commentaire introuvable" });
  await ProjectCommentModel.delete(commentId);
  await audit(req, "project.comment.delete", { entityType: "project_comments", entityId: commentId });
  res.status(204).send();
}
