import { Request } from "express";
import { maskEmail } from "./mask";

// L'inscription libre en agent est un choix de produit : n'importe qui peut obtenir le rôle « agent ». Ce rôle donne
// accès à des données de citoyens ; on distingue donc deux niveaux, sans rien changer à la base de données :
//   - agent VALIDÉ     : un administrateur lui a attribué ou confirmé le rôle (role_user.assigned_by renseigné) ;
//   - agent NON VALIDÉ : il s'est inscrit lui-même (assigned_by vide). Il travaille (traiter les demandes, rendez-vous...)
//                        mais ne voit pas les coordonnées des citoyens, ne modifie pas leurs comptes, et ses
//                        consultations sont plafonnées.
// Les administrateurs sont toujours validés. AGENT_VALIDATION=off rend tous les agents validés (désactive tout ceci).
export const AGENT_VALIDATION_ON = (process.env.AGENT_VALIDATION || "on").toLowerCase() !== "off";

// Consultations de dossiers de citoyens par minute et par compte
export const READ_LIMIT_UNVALIDATED = Number(process.env.SENSITIVE_READS_UNVALIDATED_PER_MINUTE) || 30;
export const READ_LIMIT_VALIDATED = Number(process.env.SENSITIVE_READS_PER_MINUTE) || 150;

// Vrai pour un agent qui s'est inscrit seul et n'a pas encore été validé
export function isUnvalidatedAgent(req: Request): boolean {
  return AGENT_VALIDATION_ON && req.user?.validatedStaff === false;
}

// Coordonnées d'un citoyen telles qu'un agent non validé peut les voir : nom conservé (pour reconnaître le dossier),
// e-mail partiel, téléphone et adresse retirés
export function maskContactDetails<T extends { email?: string; phone?: string | null; address?: string | null }>(user: T): T {
  return {
    ...user,
    ...(user.email !== undefined ? { email: maskEmail(user.email) } : {}),
    ...(user.phone !== undefined ? { phone: null } : {}),
    ...(user.address !== undefined ? { address: null } : {}),
  };
}

export const NOT_VALIDATED_RESPONSE = {
  code: "agent_not_validated",
  message: "Votre compte agent doit d'abord être validé par un administrateur pour effectuer cette action.",
};
