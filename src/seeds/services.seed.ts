import { MunicipalService } from "../models/municipalService.model";

// Même contenu que sql/04_seed_services.sql. Les icônes sont des noms d'icônes (ex. Lucide) que le front interprète.
const SERVICES = [
  {
    code: "etat_civil",
    name: "État civil et identité",
    description: "Inscription des nouveaux habitants, actes de naissance, mariage et décès, cartes d'identité de Terra Nova et changements d'adresse.",
    icon: "id-card",
  },
  {
    code: "eau_energie",
    name: "Eau et énergie",
    description: "Distribution d'eau recyclée, production d'énergie solaire et géothermique, suivi de consommation et signalement des pannes.",
    icon: "zap",
  },
  {
    code: "transport",
    name: "Transports et mobilité",
    description: "Navettes entre les dômes, horaires, abonnements, stationnement des véhicules et déplacements vers les zones extérieures.",
    icon: "bus",
  },
  {
    code: "sante",
    name: "Santé et secours",
    description: "Centres médicaux, rendez-vous, urgences, vaccination, suivi de l'adaptation à la gravité et à l'atmosphère de la planète.",
    icon: "heart-pulse",
  },
  {
    code: "securite",
    name: "Sécurité et protection civile",
    description: "Alertes de sécurité, évacuations, protection contre les tempêtes de poussière et les radiations, assistance d'urgence.",
    icon: "shield-check",
  },
  {
    code: "logement",
    name: "Logement et habitat",
    description: "Attribution et entretien des logements, demandes de travaux, extension des habitations et gestion des parties communes.",
    icon: "home",
  },
  {
    code: "environnement",
    name: "Environnement et agriculture",
    description: "Serres et cultures, gestion des déchets et du recyclage, qualité de l'air, préservation des écosystèmes de Terra Nova.",
    icon: "sprout",
  },
  {
    code: "education",
    name: "Éducation et formation",
    description: "Écoles, formations professionnelles, bibliothèque numérique et programmes pour les nouveaux arrivants.",
    icon: "graduation-cap",
  },
  {
    code: "commerce_emploi",
    name: "Commerce et emploi",
    description: "Offres d'emploi, création d'activité, marchés locaux, approvisionnement et aides aux entrepreneurs.",
    icon: "briefcase",
  },
  {
    code: "culture_loisirs",
    name: "Culture et loisirs",
    description: "Événements, équipements sportifs, lieux de rencontre et activités pour tous les habitants.",
    icon: "palette",
  },
  {
    code: "communications",
    name: "Communications et réseau",
    description: "Réseau interne, liaison avec la Terre, accès aux services numériques et assistance technique.",
    icon: "radio",
  },
  {
    code: "haut_conseil",
    name: "Haut Conseil de Terra Nova",
    description: "Contacter le Haut Conseil, suivre les décisions, participer aux consultations et déposer une proposition citoyenne.",
    icon: "landmark",
  },
];

// Ne sème que sur une table vide : un service supprimé ou modifié par un administrateur n'est jamais recréé ni écrasé.
export async function seedServices() {
  if ((await MunicipalService.count()) > 0) return { inserted: 0 };
  await MunicipalService.bulkCreate(SERVICES.map((service, index) => ({ ...service, sortOrder: (index + 1) * 10 })));
  return { inserted: SERVICES.length };
}
