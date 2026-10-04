import { Request } from "express";

// Entier strictement positif, sinon null (ids de route, paramètres de pagination)
export function parseId(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// ?page=2&limit=20 (limit plafonné à 100)
export function parsePagination(req: Request) {
  const page = parseId(req.query.page) ?? 1;
  const limit = Math.min(100, parseId(req.query.limit) ?? 20);
  return { page, limit, offset: (page - 1) * limit };
}
