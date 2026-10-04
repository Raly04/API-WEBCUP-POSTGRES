import type { PermissionData } from "../models/permission.model";

export interface PermissionView {
  id: number;
  code: string;
  label: string;
  module: string;
  roles?: string[];
  createdAt: Date;
}

export function permissionView(permission: PermissionData, roles?: string[]): PermissionView {
  const { id, code, label, module, createdAt } = permission;
  return { id, code, label, module, ...(roles && { roles }), createdAt };
}

// Groupé par module (citizen, agent, admin) : pratique pour un écran de gestion des droits
export function permissionsByModuleView(permissions: PermissionData[]): Record<string, PermissionView[]> {
  const grouped: Record<string, PermissionView[]> = {};
  for (const permission of permissions) (grouped[permission.module] ??= []).push(permissionView(permission));
  return grouped;
}
