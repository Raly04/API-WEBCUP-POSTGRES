import { RbacModel } from "../models/rbac.model";
import { UserModel } from "../models/user.model";
import { hashPassword } from "../utils/password";

// Mot de passe partagé des comptes de démo administrateur, fourni par l'équipe.
const ADMIN_PASSWORD = "#Kadmielle475";

const ADMIN_ACCOUNTS = [
  { email: "admin1@terra-nova.world", firstName: "Admin", lastName: "Un" },
  { email: "admin2@terra-nova.world", firstName: "Admin", lastName: "Deux" },
  { email: "admin3@terra-nova.world", firstName: "Admin", lastName: "Trois" },
];

// Idempotent : un email déjà présent n'est jamais recréé ni modifié (mot de passe ou rôle laissés intacts).
export async function seedAdminAccounts() {
  const adminRole = await RbacModel.findRoleByCode("admin");
  if (!adminRole) return { created: 0 };

  let created = 0;
  for (const account of ADMIN_ACCOUNTS) {
    if (await UserModel.findByEmail(account.email)) continue;
    const passwordHash = await hashPassword(ADMIN_PASSWORD);
    const user = await UserModel.create({ ...account, passwordHash });
    await RbacModel.assignRole(user.id, adminRole.id, null);
    created++;
  }
  return { created };
}
