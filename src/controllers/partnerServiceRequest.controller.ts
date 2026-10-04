import { Request, Response } from "express";
import { PartnerServiceModel } from "../models/partnerService.model";
import { PartnerServiceRequestModel, isPartnerRequestStatus } from "../models/partnerServiceRequest.model";
import { audit } from "../utils/audit";
import { parseId } from "../utils/http";
import { partnerServiceRequestView } from "../views/partnerServiceRequest.view";

function parseMessage(value: unknown): string | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return "invalid";
  const message = value.trim();
  if (message.length === 0) return null;
  return message.length <= 2000 ? message : "invalid";
}

// POST /api/partner-services/:id/requests  { message? }
export async function createPartnerServiceRequest(req: Request, res: Response) {
  const serviceId = parseId(req.params.id);
  if (!serviceId) return res.status(400).json({ message: "Identifiant invalide" });

  const service = await PartnerServiceModel.findById(serviceId);
  if (!service || !service.isActive) return res.status(404).json({ message: "Offre introuvable" });

  const message = parseMessage(req.body?.message);
  if (message === "invalid") return res.status(400).json({ message: "Message invalide (2000 caractères max)" });

  const request = await PartnerServiceRequestModel.create({
    partnerServiceId: serviceId,
    userId: req.user!.sub,
    message,
  });
  await audit(req, "partner_request.create", { entityType: "partner_service_requests", entityId: request.id });
  res.status(201).json(partnerServiceRequestView(request));
}

// GET /api/partner-requests : les demandes reçues sur les offres du partenaire connecté
export async function listPartnerRequests(req: Request, res: Response) {
  const requests = await PartnerServiceRequestModel.listByPartner(req.user!.sub);
  res.json(requests.map(partnerServiceRequestView));
}

// PATCH /api/partner-requests/:id  { status }
export async function updatePartnerRequestStatus(req: Request, res: Response) {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ message: "Identifiant invalide" });
  if (!isPartnerRequestStatus(req.body?.status)) {
    return res.status(400).json({ message: "Statut invalide (pending, contacted, closed)" });
  }

  const owned = await PartnerServiceRequestModel.findOwnedByPartner(id, req.user!.sub);
  if (!owned) return res.status(404).json({ message: "Demande introuvable" });

  const updated = await PartnerServiceRequestModel.setStatus(id, req.body.status);
  await audit(req, "partner_request.update", { entityType: "partner_service_requests", entityId: id });
  res.json(partnerServiceRequestView(updated!));
}
