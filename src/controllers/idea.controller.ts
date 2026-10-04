import { Request, Response } from "express";
import { IdeaModel } from "../models/idea.model";
import {
  IdeaMentionModel,
  MAX_MENTIONS_PER_IDEA,
  MENTION_PERMISSIONS,
  MENTION_TARGETS,
  type MentionRef,
  type MentionTarget,
} from "../models/ideaMention.model";
import { audit } from "../utils/audit";
import { parseId, parsePagination } from "../utils/http";
import { ideaStaffView, ideaView } from "../views/idea.view";

const MIN_CONTENT_LENGTH = 10;
const MAX_CONTENT_LENGTH = 2000;
const MAX_QUERY_LENGTH = 60;

function parseContent(value: unknown): string | null {
  const content = typeof value === "string" ? value.trim() : "";
  return content.length >= MIN_CONTENT_LENGTH && content.length <= MAX_CONTENT_LENGTH ? content : null;
}

// Liste de pointeurs { type, id } : un type inconnu ou un id invalide invalide tout le lot.
// Le nombre d'éléments est vérifié à part, pour que les deux erreurs ne se confondent pas.
function parseMentions(value: unknown): MentionRef[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const refs: MentionRef[] = [];
  for (const item of value) {
    const id = parseId(item?.id);
    const type = item?.type;
    if (!id || typeof type !== "string" || !(MENTION_TARGETS as readonly string[]).includes(type)) return null;
    refs.push({ type: type as MentionTarget, id });
  }
  return refs;
}

// Types que cet utilisateur a le droit de voir : le menu ne propose que ce qui est consultable
function allowedTargets(req: Request): MentionTarget[] {
  const permissions = req.user?.permissions ?? [];
  return MENTION_TARGETS.filter((type) => permissions.includes(MENTION_PERMISSIONS[type]));
}

// POST /api/ideas  { content, mentions? }
// Une seule phrase, un seul texte : l'habitant ne choisit rien, il donne son avis.
// Les objets mentionnés sont validés et Attachés à l'idée ; ceux qui n'existent pas ou ne sont
// pas visibles par l'habitant sont simplement ignorés.
export async function createIdea(req: Request, res: Response) {
  const content = parseContent(req.body?.content);
  if (!content) {
    return res.status(400).json({
      message: `Votre idée doit contenir entre ${MIN_CONTENT_LENGTH} et ${MAX_CONTENT_LENGTH} caractères`,
    });
  }
  const rawMentions = req.body?.mentions;
  if (Array.isArray(rawMentions) && rawMentions.length > MAX_MENTIONS_PER_IDEA) {
    return res.status(400).json({ message: `${MAX_MENTIONS_PER_IDEA} objets à mentionner au maximum` });
  }
  const mentions = parseMentions(rawMentions);
  if (!mentions) return res.status(400).json({ message: "Mention invalide : type ou identifiant inconnu" });

  const userId = req.user!.sub;
  const allowed = new Set(allowedTargets(req));
  const refs = await IdeaMentionModel.resolveExisting(mentions.filter((ref) => allowed.has(ref.type)), userId);
  const idea = await IdeaModel.create({ userId, content });
  await IdeaMentionModel.createForIdea(idea.id, refs);
  void audit(req, "idea.create", { entityType: "ideas", entityId: idea.id });

  const view = ideaView(idea);
  res.status(201).json({
    idea: view,
    confirmation: `Votre idée a bien été enregistrée. Référence : ${view.reference}`,
  });
}

// GET /api/ideas/mentions?q= : suggestions du menu contextuel après un "@"
export async function searchIdeaMentions(req: Request, res: Response) {
  const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, MAX_QUERY_LENGTH) : "";
  const suggestions = await IdeaMentionModel.searchSuggestions(allowedTargets(req), query, req.user!.sub);
  res.json({ suggestions });
}

// GET /api/ideas?page=&limit= : file des idées, réservée aux administrateurs
export async function listIdeas(req: Request, res: Response) {
  const { page, limit, offset } = parsePagination(req);
  const { ideas, total } = await IdeaModel.listAll({ limit, offset });
  const mentions = await IdeaMentionModel.listForIdeas(ideas.map((idea) => idea.id));
  res.json({
    ideas: ideas.map((idea) => ({ ...ideaStaffView(idea), mentions: mentions.get(idea.id) ?? [] })),
    page,
    limit,
    total,
  });
}