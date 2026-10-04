import type { ExternalEntityData } from "../models/externalEntity.model";

export interface ExternalEntityView {
  id: number;
  name: string;
  type: string | null;
}

export function externalEntityView(entity: ExternalEntityData): ExternalEntityView {
  const { id, name, type } = entity;
  return { id, name, type };
}
