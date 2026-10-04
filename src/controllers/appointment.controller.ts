import { Request, Response } from "express";
import {
  AppointmentModel,
  APPOINTMENT_STATUSES,
  isAppointmentStatus,
  type AppointmentStatus,
} from "../models/appointment.model";
import { MunicipalServiceModel } from "../models/municipalService.model";
import { NotificationModel } from "../models/notification.model";
import { audit } from "../utils/audit";
import { parseId, parsePagination } from "../utils/http";
import { agentAppointmentView, appointmentSlotView, citizenAppointmentView } from "../views/appointment.view";

const MIN_DURATION_MS = 10 * 60 * 1000;
const MAX_DURATION_MS = 8 * 60 * 60 * 1000;

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseServiceId(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null || value === "") return null;
  const id = parseId(value);
  return id === null ? "invalid" : id;
}

// Texte optionnel borné : "" ou absent -> null, trop long -> "invalid"
function parseNullableText(value: unknown, max: number): string | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "invalid";
  const text = value.trim();
  if (text.length > max) return "invalid";
  return text === "" ? null : text;
}

function parseStatusFilter(value: unknown): AppointmentStatus | undefined | "invalid" {
  if (value === undefined) return undefined;
  return isAppointmentStatus(value) ? value : "invalid";
}

// POST /api/appointments  { serviceId?, startAt, endAt, location?, instructions? }
// Un agent crée un créneau pour lui-même : il ne peut jamais en ouvrir un pour un autre agent.
export async function createSlot(req: Request, res: Response) {
  const startAt = parseDate(req.body?.startAt);
  const endAt = parseDate(req.body?.endAt);
  if (!startAt || !endAt) return res.status(400).json({ message: "Date de début et de fin requises (ISO 8601)" });
  if (startAt.getTime() <= Date.now()) return res.status(400).json({ message: "Le créneau doit être dans le futur" });
  const duration = endAt.getTime() - startAt.getTime();
  if (duration < MIN_DURATION_MS || duration > MAX_DURATION_MS) {
    return res.status(400).json({ message: "La durée du créneau doit être comprise entre 10 minutes et 8 heures" });
  }

  const serviceId = parseServiceId(req.body?.serviceId);
  if (serviceId === "invalid") return res.status(400).json({ message: "Service invalide" });
  if (serviceId !== null && !(await MunicipalServiceModel.findById(serviceId))) {
    return res.status(400).json({ message: "Service introuvable" });
  }

  const location = parseNullableText(req.body?.location, 255);
  if (location === "invalid") return res.status(400).json({ message: "Lieu invalide (255 caractères max)" });
  const instructions = parseNullableText(req.body?.instructions, 5000);
  if (instructions === "invalid") return res.status(400).json({ message: "Instructions invalides (5000 caractères max)" });

  const agentId = req.user!.sub;
  if (await AppointmentModel.hasOverlap(agentId, startAt, endAt)) {
    return res.status(409).json({ message: "Ce créneau chevauche un créneau que vous avez déjà ouvert" });
  }

  const slot = await AppointmentModel.createSlot({ agentId, serviceId, startAt, endAt, location, instructions });
  await audit(req, "appointment.slot.create", { entityType: "appointments", entityId: slot.id });
  res.status(201).json(agentAppointmentView(slot));
}

// GET /api/appointments/slots?serviceId=&page=&limit=
// Parcours citoyen : uniquement les créneaux encore ouverts et à venir.
export async function listOpenSlots(req: Request, res: Response) {
  const serviceId = parseServiceId(req.query.serviceId);
  if (serviceId === "invalid") return res.status(400).json({ message: "Service invalide" });

  const { limit, offset } = parsePagination(req);
  const { slots, total } = await AppointmentModel.listOpenSlots({
    serviceId: serviceId ?? undefined,
    limit,
    offset,
  });
  res.json({ slots: slots.map(appointmentSlotView), limit, offset, total });
}

// GET /api/appointments/mine?page=&limit= — rendez-vous réservés et annulés du citoyen connecté
export async function listMyAppointments(req: Request, res: Response) {
  const { limit, offset } = parsePagination(req);
  const { appointments, total } = await AppointmentModel.listMine(req.user!.sub, { limit, offset });
  res.json({ appointments: appointments.map(citizenAppointmentView), limit, offset, total });
}

// POST /api/appointments/:id/book  { subject? }
export async function bookSlot(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });

  const subject = parseNullableText(req.body?.subject, 500);
  if (subject === "invalid") return res.status(400).json({ message: "Motif invalide (500 caractères max)" });

  const slot = await AppointmentModel.findById(id);
  if (!slot) return res.status(404).json({ message: "Créneau introuvable" });
  if (slot.status !== "open" || slot.startAt.getTime() <= Date.now()) {
    return res.status(409).json({ message: "Ce créneau n'est plus disponible, merci d'en choisir un autre" });
  }

  const booked = await AppointmentModel.book(id, req.user!.sub, subject);
  if (!booked) {
    // Un autre habitant vient de réserver ce créneau entre la lecture et l'écriture
    return res.status(409).json({ message: "Ce créneau vient d'être réservé par un autre habitant, merci d'en choisir un autre" });
  }

  await audit(req, "appointment.book", { entityType: "appointments", entityId: id });
  res.json(citizenAppointmentView(booked));
}

// DELETE /api/appointments/mine/:id — le citoyen annule son propre rendez-vous
export async function cancelMyAppointment(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });

  if (!(await AppointmentModel.cancelByCitizen(id, req.user!.sub))) {
    return res.status(404).json({ message: "Rendez-vous introuvable ou déjà annulé" });
  }
  await NotificationModel.deleteForAppointment(id);
  await audit(req, "appointment.cancel", { entityType: "appointments", entityId: id });
  res.status(204).send();
}

// GET /api/appointments?status=&page=&limit= — créneaux et rendez-vous de l'agent connecté
export async function listMySlots(req: Request, res: Response) {
  const status = parseStatusFilter(req.query.status);
  if (status === "invalid") {
    return res.status(400).json({ message: `Statut invalide (${APPOINTMENT_STATUSES.join(", ")})` });
  }
  const { limit, offset } = parsePagination(req);
  const { appointments, total } = await AppointmentModel.listForAgent(req.user!.sub, { status, limit, offset });
  res.json({ appointments: appointments.map(agentAppointmentView), limit, offset, total });
}

// GET /api/appointments/:id
export async function getOwnSlot(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  const appointment = await AppointmentModel.findOwnSlotById(id, req.user!.sub);
  if (!appointment) return res.status(404).json({ message: "Créneau introuvable" });
  res.json(agentAppointmentView(appointment));
}

// PATCH /api/appointments/:id/cancel — l'agent annule un créneau (ouvert ou réservé)
export async function cancelSlot(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });

  if (!(await AppointmentModel.cancelByAgent(id, req.user!.sub))) {
    return res.status(404).json({ message: "Créneau introuvable ou déjà annulé" });
  }
  await NotificationModel.deleteForAppointment(id);
  await audit(req, "appointment.agent_cancel", { entityType: "appointments", entityId: id });
  const appointment = await AppointmentModel.findOwnSlotById(id, req.user!.sub);
  res.json(agentAppointmentView(appointment!));
}

// PATCH /api/appointments/:id/reopen — remet en circulation un créneau annulé (par le
// citoyen ou par l'agent), pour qu'un horaire libéré ne reste pas perdu pour les autres habitants.
export async function reopenSlot(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });

  const appointment = await AppointmentModel.findOwnSlotById(id, req.user!.sub);
  if (!appointment) return res.status(404).json({ message: "Créneau introuvable" });
  if (appointment.status !== "cancelled") {
    return res.status(400).json({ message: "Seul un créneau annulé peut être rouvert" });
  }
  // Un rendez-vous déjà écoulé ne redevient pas réservable : message explicite plutôt que
  // le 404 générique de reopenByAgent, qui ne distinguish pas "absent" de "trop tard".
  if (appointment.startAt.getTime() <= Date.now()) {
    return res.status(400).json({ message: "Ce rendez-vous est passé, il ne peut pas être rouvert" });
  }
  // Un autre créneau a pu être ouvert sur ce même horaire pendant l'annulation : la même
  // garde qu'à la création, pour ne jamais proposer deux fois le même horaire au choix du citoyen.
  if (await AppointmentModel.hasOverlap(req.user!.sub, appointment.startAt, appointment.endAt)) {
    return res.status(409).json({ message: "Ce créneau chevauche désormais un autre de vos créneaux" });
  }

  if (!(await AppointmentModel.reopenByAgent(id, req.user!.sub))) {
    return res.status(404).json({ message: "Créneau introuvable ou déjà rouvert" });
  }
  await audit(req, "appointment.slot.reopen", { entityType: "appointments", entityId: id });
  const reopened = await AppointmentModel.findOwnSlotById(id, req.user!.sub);
  res.json(agentAppointmentView(reopened!));
}

// DELETE /api/appointments/:id — suppression définitive, réservée aux créneaux jamais réservés
export async function deleteSlot(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });

  const appointment = await AppointmentModel.findOwnSlotById(id, req.user!.sub);
  if (!appointment) return res.status(404).json({ message: "Créneau introuvable" });
  if (appointment.status !== "open") {
    return res.status(400).json({ message: "Un créneau réservé ne peut pas être supprimé, annulez-le plutôt" });
  }

  await AppointmentModel.deleteOpenSlot(id, req.user!.sub);
  await audit(req, "appointment.slot.delete", { entityType: "appointments", entityId: id });
  res.status(204).send();
}
