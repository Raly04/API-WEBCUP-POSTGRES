import type { RoleData } from "../models/role.model";

// Vue : forme JSON exposée au client. Le contrôleur ne renvoie jamais une ligne de base brute.
export interface RoleView {
  id: number;
  code: string;
  label: string;
  level: number;
  isSystem: boolean;
  permissions?: string[];
  usersCount?: number;
  createdAt: Date;
  updatedAt: Date;
}

export function roleView(role: RoleData, extras: { permissions?: string[]; usersCount?: number } = {}): RoleView {
  return {
    id: role.id,
    code: role.code,
    label: role.label,
    level: role.level,
    isSystem: role.isSystem,
    ...extras,
    createdAt: role.createdAt,
    updatedAt: role.updatedAt,
  };
}

export function roleListView(roles: RoleData[], permissionsByRole: Record<number, string[]>): RoleView[] {
  return roles.map((role) => roleView(role, { permissions: permissionsByRole[role.id] ?? [] }));
}
