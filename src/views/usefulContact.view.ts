import { ZONE_LABELS, type Zone } from "../models/alert.model";
import { CATEGORY_LABELS, CONTACT_CATEGORIES, type ContactCategory, type UsefulContactData } from "../models/usefulContact.model";

// « 03 10 20 » -> « tel:031020 » : lien d'appel direct sur téléphone (chiffres et + uniquement)
export const telHref = (phone: string | null | undefined) => {
  const digits = (phone ?? "").replace(/[^\d+]/g, "");
  return digits ? `tel:${digits}` : null;
};

export function publicContactView(contact: UsefulContactData) {
  return {
    id: contact.id,
    label: contact.label,
    category: contact.category,
    phone: contact.phone ?? null,
    phoneHref: telHref(contact.phone),
    email: contact.email ?? null,
    address: contact.address ?? null,
    zone: contact.zone ?? null,
    zoneLabel: contact.zone ? ZONE_LABELS[contact.zone as Zone] ?? null : null,
    openingHours: contact.openingHours ?? null,
    available24h: contact.available24h,
    description: contact.description ?? null,
    // Ouvert / fermé n'a de sens que pour un lieu ; pour un numéro, on n'affiche rien
    isOpen: contact.isOpen,
    statusNote: contact.statusNote ?? null,
    updatedAt: contact.updatedAt ?? contact.createdAt,
  };
}

export function staffContactView(contact: UsefulContactData) {
  return { ...publicContactView(contact), serviceId: contact.serviceId ?? null, sortOrder: contact.sortOrder, isActive: contact.isActive };
}

export type PublicContactView = ReturnType<typeof publicContactView>;

// Regroupés par catégorie, dans l'ordre où on les cherche en situation difficile (urgences d'abord)
export function groupedContactsView(contacts: UsefulContactData[]) {
  return CONTACT_CATEGORIES.map((category: ContactCategory) => ({
    category,
    label: CATEGORY_LABELS[category],
    contacts: contacts.filter((contact) => contact.category === category).map(publicContactView),
  })).filter((group) => group.contacts.length > 0);
}
