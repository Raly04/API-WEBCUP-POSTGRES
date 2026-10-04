import type { PartnerServiceData } from "../models/partnerService.model";

// Vue habitant : tout ce qui est nécessaire pour comprendre une offre et agir, rien de plus
export interface PartnerServiceView {
  id: number;
  name: string;
  description: string | null;
  category: string | null;
  address: string | null;
  openingHours: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  isAvailable: boolean;
  availabilityNote: string | null;
  nextActionLabel: string | null;
  nextActionType: string | null;
  nextActionValue: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  partner: { id: number; firstName: string; lastName: string } | null;
}

export function partnerServiceView(service: PartnerServiceData): PartnerServiceView {
  const {
    id,
    name,
    description,
    category,
    address,
    openingHours,
    contactPhone,
    contactEmail,
    isAvailable,
    availabilityNote,
    nextActionLabel,
    nextActionType,
    nextActionValue,
    isActive,
    createdAt,
    updatedAt,
    partner,
  } = service;
  return {
    id,
    name,
    description,
    category,
    address,
    openingHours,
    contactPhone,
    contactEmail,
    isAvailable,
    availabilityNote,
    nextActionLabel,
    nextActionType,
    nextActionValue,
    isActive,
    createdAt,
    updatedAt,
    partner: partner ?? null,
  };
}
