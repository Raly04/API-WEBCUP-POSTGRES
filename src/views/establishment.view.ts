import type { EstablishmentData } from "../models/establishment.model";

type ServiceRef = { id: number; code: string; name: string; icon: string | null } | null;

function serviceRef(establishment: EstablishmentData): ServiceRef {
  const service = establishment.service;
  return service ? { id: service.id, code: service.code, name: service.name, icon: service.icon } : null;
}

export interface EstablishmentView {
  id: number;
  name: string;
  service: ServiceRef;
  description: string | null;
  address: string;
  isOpen: boolean;
  statusNote: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function establishmentView(establishment: EstablishmentData): EstablishmentView {
  const { id, name, description, address, isOpen, statusNote, isActive, createdAt, updatedAt } = establishment;
  return { id, name, service: serviceRef(establishment), description, address, isOpen, statusNote, isActive, createdAt, updatedAt };
}

// Catalogue public : isActive est absent par construction (filtré côté serveur, inutile aux habitants)
export interface PublicEstablishmentView {
  id: number;
  name: string;
  service: ServiceRef;
  description: string | null;
  address: string;
  isOpen: boolean;
  statusNote: string | null;
}

export function publicEstablishmentView(establishment: EstablishmentData): PublicEstablishmentView {
  const { id, name, description, address, isOpen, statusNote } = establishment;
  return { id, name, service: serviceRef(establishment), description, address, isOpen, statusNote };
}
