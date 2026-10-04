import { Request, Response } from "express";
import { CONTACT_STATUSES, ContactMessageModel, ContactStatus } from "../models/contactMessage.model";
import { audit } from "../utils/audit";
import { parseId, parsePagination } from "../utils/http";
import { isUnvalidatedAgent } from "../utils/staffAccess";
import { contactMessageStaffView, contactMessageView } from "../views/contactMessage.view";

const MANAGE_PERMISSION = "agent.messages.manage";
const MAX_SUBJECT_LENGTH = 255;
const MAX_MESSAGE_LENGTH = 3000;

function canManage(req: Request): boolean {
  return req.user?.permissions?.includes(MANAGE_PERMISSION) === true;
}

function parseStatus(value: unknown): ContactStatus | null {
  return (CONTACT_STATUSES as readonly unknown[]).includes(value) ? (value as ContactStatus) : null;
}

// POST /api/contact-messages  { subject, message }
// Le message est enregistré avec son accusé de réception (confirmedAt) et le statut "new".
export async function sendContactMessage(req: Request, res: Response) {
  const subject = typeof req.body?.subject === "string" ? req.body.subject.trim() : "";
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (subject.length < 3 || subject.length > MAX_SUBJECT_LENGTH) {
    return res.status(400).json({ message: `Le sujet doit contenir entre 3 et ${MAX_SUBJECT_LENGTH} caractères` });
  }
  if (message.length < 10 || message.length > MAX_MESSAGE_LENGTH) {
    return res.status(400).json({ message: `Le message doit contenir entre 10 et ${MAX_MESSAGE_LENGTH} caractères` });
  }

  const created = await ContactMessageModel.create({ userId: req.user!.sub, subject, message });
  void audit(req, "contact.send", { entityType: "contact_messages", entityId: created.id });
  res.status(201).json({
    confirmation: `Votre message a bien été reçu. Référence : #${created.id}`,
    contactMessage: contactMessageView(created),
  });
}

// GET /api/contact-messages/mine : l'historique de l'utilisateur connecté
export async function listMyContactMessages(req: Request, res: Response) {
  const messages = await ContactMessageModel.listForUser(req.user!.sub);
  res.json(messages.map(contactMessageView));
}

// GET /api/contact-messages?status=&q=&page=&limit= : boîte de réception des agents
export async function listContactInbox(req: Request, res: Response) {
  const { page, limit, offset } = parsePagination(req);
  const search = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim().slice(0, 100) : undefined;
  let status: ContactStatus | undefined;
  if (req.query.status !== undefined && req.query.status !== "all") {
    const parsed = parseStatus(req.query.status);
    if (!parsed) return res.status(400).json({ message: "status invalide (new, read, processed ou all)" });
    status = parsed;
  }

  const [{ messages, total }, counts] = await Promise.all([
    ContactMessageModel.listInbox({ status, search, limit, offset }),
    ContactMessageModel.countByStatus(),
  ]);
  const masked = isUnvalidatedAgent(req);
  res.json({ messages: messages.map((message) => contactMessageStaffView(message, masked)), counts, page, limit, total });
}

// GET /api/contact-messages/:id : un agent voit tout ; sinon seul l'expéditeur voit son message
export async function getContactMessage(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const message = await ContactMessageModel.findById(id);
  const isOwner = message?.userId !== null && message?.userId === req.user!.sub;
  // 404 plutôt que 403 : on ne révèle pas l'existence du message d'un autre
  if (!message || (!isOwner && !canManage(req))) return res.status(404).json({ message: "Message introuvable" });
  res.json(canManage(req) ? contactMessageStaffView(message, isUnvalidatedAgent(req)) : contactMessageView(message));
}

// PATCH /api/contact-messages/:id/status  { status: "new" | "read" | "processed" }
export async function setContactMessageStatus(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const status = parseStatus(req.body?.status);
  if (!status) return res.status(400).json({ message: "status invalide (new, read ou processed)" });

  const message = await ContactMessageModel.updateStatus(id, status);
  if (!message) return res.status(404).json({ message: "Message introuvable" });
  void audit(req, `contact.${status}`, { entityType: "contact_messages", entityId: id });
  res.json(contactMessageStaffView(message, isUnvalidatedAgent(req)));
}
