import type { PublicUser } from "../models/user.model";

export interface UserView extends PublicUser {
  roles?: string[];
  permissions?: string[];
}

// Vue : l'utilisateur sans passwordHash, avec ses rôles et permissions quand on les connaît
export function userView(user: PublicUser, access: { roles?: string[]; permissions?: string[] } = {}): UserView {
  return { ...user, ...access };
}

export function userListView(users: PublicUser[], rolesByUser: Record<number, string[]>): UserView[] {
  return users.map((user) => userView(user, { roles: rolesByUser[user.id] ?? [] }));
}
