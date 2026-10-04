import type { AppointmentData, AppointmentStatus } from "../models/appointment.model";

// Vue créneau : tout ce qu'il faut au citoyen pour choisir sans ambiguïté et se
// préparer (lieu, agent, service, instructions), rien de plus.
export interface AppointmentSlotView {
  id: number;
  startAt: Date;
  endAt: Date;
  location: string | null;
  instructions: string | null;
  service: { id: number; code: string; name: string } | null;
  agent: { id: number; firstName: string; lastName: string } | null;
}

export function appointmentSlotView(appointment: AppointmentData): AppointmentSlotView {
  const { id, startAt, endAt, location, instructions, service, agent } = appointment;
  return {
    id,
    startAt,
    endAt,
    location,
    instructions,
    service: service ? { id: service.id, code: service.code, name: service.name } : null,
    agent: agent ? { id: agent.id, firstName: agent.firstName, lastName: agent.lastName } : null,
  };
}

// Vue citoyen d'un rendez-vous déjà réservé (ou annulé) : ajoute son propre statut et motif
export interface CitizenAppointmentView extends AppointmentSlotView {
  status: AppointmentStatus;
  subject: string | null;
}

export function citizenAppointmentView(appointment: AppointmentData): CitizenAppointmentView {
  return {
    ...appointmentSlotView(appointment),
    status: appointment.status,
    subject: appointment.subject,
  };
}

// Vue agent : ajoute l'identité du citoyen, nécessaire pour traiter le rendez-vous
export interface AgentAppointmentView extends CitizenAppointmentView {
  citizen: { id: number; firstName: string; lastName: string } | null;
}

export function agentAppointmentView(appointment: AppointmentData): AgentAppointmentView {
  return {
    ...citizenAppointmentView(appointment),
    citizen: appointment.citizen
      ? { id: appointment.citizen.id, firstName: appointment.citizen.firstName, lastName: appointment.citizen.lastName }
      : null,
  };
}
