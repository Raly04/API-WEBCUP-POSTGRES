import { logger } from "../utils/logger";
import { seedAdminAccounts } from "./adminAccounts.seed";
import { seedRbac } from "./rbac.seed";
import { seedServices } from "./services.seed";
import { seedTransport } from "./transport.seed";
import { seedContacts } from "./contacts.seed";

// Lancé à chaque démarrage du serveur (désactivable : SEED_ON_START=false) et par `npm run db:seed`.
// Idempotent et peu coûteux : quelques SELECT quand tout est déjà en place.
export async function runSeeds() {
  const rbac = await seedRbac();
  const services = await seedServices();
  const admins = await seedAdminAccounts();
  const transport = await seedTransport();
  const contacts = await seedContacts();
  const created = [
    rbac.permissions && `${rbac.permissions} permission(s)`,
    rbac.links && `${rbac.links} liaison(s) rôle-permission`,
    services.inserted && `${services.inserted} service(s) municipaux`,
    admins.created && `${admins.created} compte(s) administrateur`,
    transport.inserted && `${transport.inserted} ligne(s) de transport`,
    contacts.inserted && `${contacts.inserted} coordonnée(s) utile(s)`,
  ].filter(Boolean);
  logger.info("SEED", created.length > 0 ? `Données de base créées : ${created.join(", ")}` : "Données de base déjà en place");
}
