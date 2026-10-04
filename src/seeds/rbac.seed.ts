import { Permission } from "../models/permission.model";
import { RolePermission } from "../models/rbac.model";
import { Role } from "../models/role.model";

// Rôles et permissions de base. Les codes sont imposés par le code :
// CITIZEN_ROLE (models/rbac.model), ADMIN_ROLE + LOCKOUT_PERMISSION (controllers/role.controller)
// et les requirePermission(...) des routes. Même contenu que les scripts SQL (blocs 1-2 et 3).
const PERMISSIONS = [
  { code: "citizen.account.create", label: "Créer un compte citoyen", module: "citizen" },
  { code: "citizen.session.login", label: "Se connecter", module: "citizen" },
  { code: "citizen.message.send", label: "Envoyer un message aux services", module: "citizen" },
  { code: "citizen.services.view", label: "Consulter les services municipaux", module: "citizen" },
  { code: "citizen.establishments.view", label: "Consulter les lieux utiles (carte)", module: "citizen" },
  { code: "citizen.announcements.view", label: "Consulter les annonces", module: "citizen" },
  { code: "citizen.home.view", label: "Accéder à la page d'accueil", module: "citizen" },
  { code: "citizen.requests.create", label: "Déposer une demande", module: "citizen" },
  { code: "citizen.requests.view", label: "Suivre ses demandes", module: "citizen" },
  { code: "citizen.appointments.view", label: "Consulter les créneaux et ses rendez-vous", module: "citizen" },
  { code: "citizen.appointments.manage", label: "Réserver ou annuler un rendez-vous", module: "citizen" },
  { code: "citizen.notifications.view", label: "Consulter ses notifications", module: "citizen" },
  { code: "citizen.notifications.manage", label: "Marquer ses notifications comme lues", module: "citizen" },
  { code: "citizen.projects.view", label: "Consulter les projets de la ville", module: "citizen" },
  { code: "citizen.projects.comment", label: "Donner son avis sur un projet", module: "citizen" },
  { code: "citizen.ideas.create", label: "Proposer une idée pour améliorer la ville", module: "citizen" },
  { code: "citizen.ideas.mentions", label: "Mentionner des objets de la ville dans une idée", module: "citizen" },
  { code: "citizen.guidance.create", label: "Demander une orientation vers le service compétent", module: "citizen" },
  { code: "citizen.partners.view", label: "Consulter les offres des partenaires", module: "citizen" },
  { code: "citizen.partners.request", label: "Contacter un partenaire au sujet d'une offre", module: "citizen" },
  { code: "agent.dashboard.access", label: "Accéder au tableau de bord agent", module: "agent" },
  { code: "agent.requests.view", label: "Consulter les demandes citoyennes", module: "agent" },
  { code: "agent.requests.manage", label: "Traiter les demandes citoyennes", module: "agent" },
  { code: "agent.appointments.view", label: "Consulter ses créneaux de rendez-vous", module: "agent" },
  { code: "agent.appointments.manage", label: "Ouvrir et annuler des créneaux de rendez-vous", module: "agent" },
  { code: "agent.activity.view", label: "Consulter l'activité de la plateforme", module: "agent" },
  { code: "agent.announcements.manage", label: "Gérer les annonces", module: "agent" },
  { code: "agent.messages.manage", label: "Gérer les messages de contact", module: "agent" },
  { code: "agent.citizens.manage", label: "Administrer les comptes citoyens", module: "agent" },
  { code: "agent.establishments.manage", label: "Gérer les établissements (carte)", module: "agent" },
  { code: "citizen.signalements.create", label: "Signaler une urgence ou un incident", module: "citizen" },
  { code: "citizen.signalements.view", label: "Suivre ses signalements", module: "citizen" },
  { code: "agent.signalements.view", label: "Consulter les signalements (urgences, incidents)", module: "agent" },
  { code: "agent.signalements.manage", label: "Traiter les signalements (prise en charge, statut, priorité)", module: "agent" },
  { code: "agent.alerts.manage", label: "Publier et suivre les alertes à la population (quartiers)", module: "agent" },
  { code: "agent.contacts.manage", label: "Tenir à jour les coordonnées utiles (numéros, abris, points d'eau)", module: "agent" },
  { code: "agent.transport.manage", label: "Déclarer les interruptions de transport et les solutions de remplacement", module: "agent" },
  { code: "admin.users.manage", label: "Gérer les utilisateurs", module: "admin" },
  { code: "admin.services.manage", label: "Gérer les services municipaux", module: "admin" },
  { code: "admin.projects.manage", label: "Gérer les projets de la ville", module: "admin" },
  { code: "admin.ideas.manage", label: "Consulter les idées proposées par les habitants", module: "admin" },
  { code: "admin.guidance.manage", label: "Consulter les orientations demandées par les habitants", module: "admin" },
  { code: "admin.platform.manage", label: "Publier un avis d'incident sur la plateforme", module: "admin" },
  { code: "admin.announcements.urgent", label: "Publier une annonce prioritaire du Haut Conseil", module: "admin" },
  { code: "admin.partners.manage", label: "Créer et gérer les comptes partenaires", module: "admin" },
  { code: "partner.dashboard.access", label: "Accéder au tableau de bord partenaire", module: "partner" },
  { code: "partner.services.manage", label: "Gérer ses offres de services partenaires", module: "partner" },
  { code: "partner.requests.view", label: "Consulter les demandes liées à ses offres", module: "partner" },
  { code: "partner.requests.manage", label: "Traiter les demandes liées à ses offres", module: "partner" },
];

const CITIZEN = PERMISSIONS.filter((p) => p.module === "citizen").map((p) => p.code);
const AGENT = PERMISSIONS.filter((p) => p.module === "agent").map((p) => p.code);
const PARTNER = PERMISSIONS.filter((p) => p.module === "partner").map((p) => p.code);

const ROLES = [
  { code: "citizen", label: "Citoyen", level: 1, permissions: CITIZEN },
  { code: "agent", label: "Agent municipal", level: 2, permissions: [...CITIZEN, ...AGENT] },
  { code: "partner", label: "Partenaire", level: 2, permissions: PARTNER },
  { code: "admin", label: "Administrateur", level: 3, permissions: PERMISSIONS.map((p) => p.code) },
];

// Idempotent, et ne défait jamais les réglages faits ensuite par un administrateur :
// une liaison rôle <-> permission n'est posée que lorsque le rôle ou la permission vient d'être créé.
// Un droit retiré à un rôle via l'API le reste donc au redémarrage suivant.
export async function seedRbac() {
  const permissionIds = new Map<string, number>();
  const createdPermissions = new Set<string>();
  for (const permission of PERMISSIONS) {
    const [row, created] = await Permission.findOrCreate({ where: { code: permission.code }, defaults: permission });
    permissionIds.set(row.code, row.id);
    if (created) createdPermissions.add(row.code);
  }

  let linked = 0;
  for (const role of ROLES) {
    const { permissions, ...fields } = role;
    const [row, roleCreated] = await Role.findOrCreate({
      where: { code: role.code },
      defaults: { ...fields, isSystem: true },
    });
    for (const code of permissions) {
      if (!roleCreated && !createdPermissions.has(code)) continue;
      const [, created] = await RolePermission.findOrCreate({
        where: { roleId: row.id, permissionId: permissionIds.get(code)! },
      });
      if (created) linked++;
    }
  }
  return { permissions: createdPermissions.size, links: linked };
}
