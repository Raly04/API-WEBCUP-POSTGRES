import { EMERGENCY_NUMBER } from "../config/emergency";
import { UsefulContact } from "../models/usefulContact.model";

// Annuaire de départ. Les numéros courts (31xx) et adresses sont des valeurs de démonstration de la colonie : à remplacer
// par les vraies coordonnées via /api/contacts. Semé uniquement sur une table vide : rien n'est jamais écrasé.
const CONTACTS = [
  {
    label: "Secours — urgence vitale", category: "emergency" as const, phone: EMERGENCY_NUMBER, available24h: true,
    description: "Personne en danger, incendie, accident grave. L'appel passe même sans internet.",
  },
  {
    label: "Cellule de crise municipale", category: "crisis" as const, phone: "3100", email: "crise@terranova.example", available24h: true,
    description: "Informations pendant une crise : évacuations, abris, consignes.",
  },
  {
    label: "Centre médical du Dôme Nord", category: "health" as const, phone: "3400", address: "Dôme Nord, allée des Serres", zone: "north" as const,
    available24h: true, openingHours: "Urgences 24 h/24 ; consultations 8 h – 18 h",
  },
  {
    label: "Hôpital central", category: "health" as const, phone: "3410", address: "Arrêt Hôpital (tram T1)", zone: "west" as const, available24h: true,
  },
  {
    label: "Gymnase du centre — point de rassemblement", category: "shelter" as const, address: "Place des Pionniers", zone: "center" as const,
    openingHours: "Ouvert en cas d'alerte", description: "Point de rassemblement et d'accueil en cas d'évacuation.",
  },
  {
    label: "Abri du Dôme Sud", category: "shelter" as const, address: "Dôme Sud, niveau 2 (hors d'eau)", zone: "south" as const,
    openingHours: "Ouvert en cas d'alerte", description: "Abri en hauteur pour les habitants du quartier sud.",
  },
  {
    label: "Point d'eau potable du Marché", category: "water" as const, address: "Place du Marché", zone: "south" as const, openingHours: "6 h – 22 h",
  },
  {
    label: "Dépannage eau et énergie", category: "utilities" as const, phone: "3200", available24h: true,
    description: "Coupure d'eau ou d'électricité, fuite, câble tombé.",
  },
  { label: "Info transports", category: "transport" as const, phone: "3300", openingHours: "5 h – minuit", description: "Lignes interrompues et trajets de remplacement." },
  {
    label: "Mairie de Terra Nova — accueil", category: "city" as const, phone: "3000", email: "contact@terranova.example",
    address: "Gare Centrale, bâtiment administratif", openingHours: "Lundi – vendredi, 8 h – 17 h",
  },
];

export async function seedContacts() {
  if ((await UsefulContact.count()) > 0) return { inserted: 0 };
  await UsefulContact.bulkCreate(CONTACTS.map((contact, index) => ({ ...contact, sortOrder: (index + 1) * 10 })));
  return { inserted: CONTACTS.length };
}
