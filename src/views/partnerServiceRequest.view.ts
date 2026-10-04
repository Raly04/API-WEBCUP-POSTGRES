import type { PartnerServiceRequestData } from "../models/partnerServiceRequest.model";

export interface PartnerServiceRequestView {
  id: number;
  message: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  service: { id: number; name: string } | null;
  user: { id: number; firstName: string; lastName: string } | null;
}

export function partnerServiceRequestView(request: PartnerServiceRequestData): PartnerServiceRequestView {
  const { id, message, status, createdAt, updatedAt, service, user } = request;
  return {
    id,
    message,
    status,
    createdAt,
    updatedAt,
    service: service ? { id: service.id, name: service.name } : null,
    user: user ?? null,
  };
}
