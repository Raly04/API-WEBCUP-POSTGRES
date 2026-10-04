// Guide permanent « Que faire en cas de... » : les consignes de sécurité de référence, consultables à tout moment, même
// sans alerte en cours. Écrit dans le code et non en base, exprès : il doit rester disponible pendant une panne totale de
// la base de données. Les clés reprennent les dangers des alertes (alert.hazard) : une alerte « flood » renvoie au guide
// « flood ». {emergency} est remplacé par le numéro d'urgence configuré (EMERGENCY_NUMBER).

type Lines = { fr: string[]; en: string[] };

export interface GuideEntry {
  key: string;
  title: { fr: string; en: string };
  summary: { fr: string; en: string };
  before: Lines;
  during: Lines;
  after: Lines;
}

const GUIDE: GuideEntry[] = [
  {
    key: "flood",
    title: { fr: "Montée des eaux, inondation", en: "Rising water, flood" },
    summary: { fr: "Mettez-vous en hauteur et ne traversez jamais l'eau.", en: "Get to higher ground and never cross floodwater." },
    before: {
      fr: ["Repérez un étage ou un lieu en hauteur où vous abriter", "Rangez en hauteur papiers, médicaments et objets de valeur", "Préparez un sac d'urgence (voir la liste)"],
      en: ["Identify an upper floor or high place to shelter", "Store papers, medicine and valuables up high", "Prepare an emergency bag (see the list)"],
    },
    during: {
      fr: [
        "Montez à l'étage ou en hauteur ; n'allez jamais au sous-sol",
        "Coupez l'électricité si l'eau entre chez vous",
        "Ne traversez jamais une zone inondée, ni à pied ni en véhicule",
        "N'allez pas chercher vos enfants à l'école : l'école les protège",
        "Danger pour une personne : appelez le {emergency}",
      ],
      en: [
        "Go upstairs or to high ground; never go to a basement",
        "Switch off the electricity if water comes in",
        "Never cross a flooded area, on foot or by vehicle",
        "Do not fetch your children from school: the school protects them",
        "Someone in danger: call {emergency}",
      ],
    },
    after: {
      fr: ["Attendez l'autorisation avant de rentrer chez vous", "Ne remettez l'électricité qu'une fois l'installation sèche", "Faites bouillir l'eau du robinet jusqu'à avis contraire", "Photographiez les dégâts avant de nettoyer"],
      en: ["Wait for permission before going home", "Only switch the power back on once the installation is dry", "Boil tap water until told otherwise", "Photograph the damage before cleaning"],
    },
  },
  {
    key: "heavy_rain",
    title: { fr: "Fortes pluies", en: "Heavy rain" },
    summary: { fr: "Limitez vos déplacements et éloignez-vous des cours d'eau.", en: "Limit travel and stay away from waterways." },
    before: {
      fr: ["Rentrez ou attachez les objets qui peuvent être emportés", "Reportez les déplacements qui ne sont pas indispensables"],
      en: ["Bring in or secure objects that could be swept away", "Postpone non-essential travel"],
    },
    during: {
      fr: ["Éloignez-vous des cours d'eau, ravines et rues basses", "Ne vous abritez pas sous un arbre", "Ne vous engagez jamais sur une route inondée"],
      en: ["Stay away from waterways, gullies and low streets", "Do not shelter under a tree", "Never drive onto a flooded road"],
    },
    after: {
      fr: ["Signalez arbres tombés, câbles ou routes coupées sur la plateforme", "Restez à distance des câbles électriques au sol"],
      en: ["Report fallen trees, cables or blocked roads on the platform", "Keep away from fallen power lines"],
    },
  },
  {
    key: "cyclone",
    title: { fr: "Cyclone, tempête", en: "Cyclone, storm" },
    summary: { fr: "Préparez-vous avant, restez à l'abri pendant, attendez la levée de l'alerte.", en: "Prepare beforehand, stay sheltered, wait for the all-clear." },
    before: {
      fr: ["Rentrez ou attachez tout ce qui est dehors", "Prévoyez eau, nourriture, lampe, radio et médicaments pour 3 jours", "Rechargez téléphones et batteries"],
      en: ["Bring in or tie down everything outside", "Keep water, food, a torch, a radio and medicine for 3 days", "Charge phones and power banks"],
    },
    during: {
      fr: ["Restez à l'intérieur, loin des fenêtres", "Ne sortez pas pendant l'accalmie de l'œil du cyclone", "Suivez les consignes des alertes"],
      en: ["Stay indoors, away from windows", "Do not go out during the calm of the eye", "Follow the alert instructions"],
    },
    after: {
      fr: ["Ne sortez qu'à la levée de l'alerte", "Évitez les câbles tombés et les zones inondées", "Prenez des nouvelles de vos voisins âgés ou isolés"],
      en: ["Only go out once the alert is lifted", "Avoid fallen cables and flooded areas", "Check on elderly or isolated neighbours"],
    },
  },
  {
    key: "fire",
    title: { fr: "Incendie", en: "Fire" },
    summary: { fr: "Sortez, fermez les portes, appelez le {emergency}.", en: "Get out, close the doors, call {emergency}." },
    before: {
      fr: ["Repérez les sorties de secours de votre immeuble", "Vérifiez que votre détecteur de fumée fonctionne"],
      en: ["Know your building's emergency exits", "Check that your smoke detector works"],
    },
    during: {
      fr: [
        "Appelez le {emergency}",
        "Sortez immédiatement, sans prendre l'ascenseur",
        "Dans la fumée, baissez-vous : l'air est meilleur près du sol",
        "Fermez les portes derrière vous",
        "Bloqué ? Fermez la porte, calfeutrez-la et signalez-vous à la fenêtre",
      ],
      en: ["Call {emergency}", "Get out immediately, without using the lift", "In smoke, stay low: the air is better near the floor", "Close doors behind you", "Trapped? Close the door, seal it and signal from the window"],
    },
    after: { fr: ["Ne retournez pas dans le bâtiment sans l'accord des secours"], en: ["Do not go back in without the emergency services' approval"] },
  },
  {
    key: "power_outage",
    title: { fr: "Coupure d'électricité", en: "Power outage" },
    summary: { fr: "Lampe plutôt que bougie, appareils débranchés, réfrigérateur fermé.", en: "Torch rather than candles, unplug devices, keep the fridge shut." },
    before: { fr: ["Gardez une lampe et des piles à portée de main", "Gardez une batterie externe chargée"], en: ["Keep a torch and batteries within reach", "Keep a power bank charged"] },
    during: {
      fr: [
        "Utilisez une lampe plutôt qu'une bougie",
        "Débranchez les appareils sensibles",
        "Gardez le réfrigérateur fermé : il reste froid environ 4 heures",
        "Signalez les personnes dépendantes d'un appareil médical",
      ],
      en: ["Use a torch rather than a candle", "Unplug sensitive devices", "Keep the fridge closed: it stays cold for about 4 hours", "Report people who depend on medical equipment"],
    },
    after: { fr: ["Rebranchez les appareils un par un", "Jetez les aliments qui ont décongelé"], en: ["Plug devices back in one at a time", "Throw away food that has thawed"] },
  },
  {
    key: "water_outage",
    title: { fr: "Coupure d'eau", en: "Water outage" },
    summary: { fr: "Gardez l'eau potable pour boire ; les points d'eau sont dans les coordonnées utiles.", en: "Keep drinking water for drinking; water points are in useful contacts." },
    before: { fr: ["Gardez une réserve d'eau potable : 2 litres par personne et par jour"], en: ["Keep a drinking water supply: 2 litres per person per day"] },
    during: {
      fr: ["Gardez l'eau en bouteille pour boire et cuisiner", "Économisez la réserve : ni lessive ni bain", "Les points d'eau potable sont listés dans les coordonnées utiles"],
      en: ["Keep bottled water for drinking and cooking", "Save your supply: no laundry or baths", "Drinking water points are listed in useful contacts"],
    },
    after: { fr: ["Laissez couler l'eau quelques minutes avant de la boire", "Faites-la bouillir si un avis le demande"], en: ["Let the water run a few minutes before drinking", "Boil it if a notice says so"] },
  },
  {
    key: "health",
    title: { fr: "Alerte sanitaire", en: "Health alert" },
    summary: { fr: "Suivez les consignes de santé ; appelez avant de vous déplacer.", en: "Follow health guidance; call before going in." },
    before: { fr: ["Gardez une réserve de vos médicaments habituels"], en: ["Keep a supply of your usual medicine"] },
    during: {
      fr: ["Suivez les consignes des services de santé", "Lavez-vous les mains souvent", "En cas de symptômes, appelez avant d'aller au centre médical", "Détresse : appelez le {emergency}"],
      en: ["Follow the health services' instructions", "Wash your hands often", "With symptoms, call before going to the medical centre", "Distress: call {emergency}"],
    },
    after: { fr: ["Restez attentif à la fin d'alerte et à ses consignes"], en: ["Watch for the end of the alert and its instructions"] },
  },
  {
    key: "security",
    title: { fr: "Incident de sécurité", en: "Security incident" },
    summary: { fr: "Éloignez-vous, suivez les agents, ne relayez pas les rumeurs.", en: "Move away, follow officials, do not spread rumours." },
    before: { fr: [], en: [] },
    during: {
      fr: ["Éloignez-vous de la zone ; ne vous approchez pas pour regarder", "Suivez les consignes des agents sur place", "En sécurité ? N'encombrez pas les lignes d'urgence", "Ne relayez que les informations officielles"],
      en: ["Move away from the area; do not go closer to look", "Follow the instructions of officials on site", "Safe? Do not overload emergency lines", "Only share official information"],
    },
    after: { fr: ["Signalez tout objet ou comportement suspect"], en: ["Report any suspicious object or behaviour"] },
  },
  {
    key: "transport",
    title: { fr: "Transports perturbés", en: "Transport disruption" },
    summary: { fr: "La rubrique Transports indique les lignes touchées et un trajet de remplacement.", en: "The Transport section shows affected lines and an alternative route." },
    before: { fr: [], en: [] },
    during: {
      fr: ["Consultez l'état des lignes et la fiche de votre arrêt", "Demandez un trajet de remplacement (départ, arrivée)", "Prévoyez plus de temps pour vos déplacements"],
      en: ["Check line status and your stop's page", "Ask for an alternative route (from, to)", "Allow extra travel time"],
    },
    after: { fr: [], en: [] },
  },
  {
    key: "network",
    title: { fr: "Panne de réseau ou de la plateforme", en: "Network or platform outage" },
    summary: { fr: "Les appels d'urgence passent sans internet ; cette page reste lisible hors ligne.", en: "Emergency calls work without internet; this page stays readable offline." },
    before: {
      fr: ["Gardez cette page sur votre téléphone : elle reste lisible sans connexion", "Notez sur papier les numéros importants"],
      en: ["Keep this page on your phone: it stays readable offline", "Write important numbers down on paper"],
    },
    during: {
      fr: [
        "Un appel d'urgence ({emergency}) passe même sans internet",
        "Les informations affichées datent de la dernière mise à jour (heure indiquée)",
        "Vos signalements partiront automatiquement au retour du réseau",
        "Évitez les appels non urgents pour ne pas saturer le réseau",
      ],
      en: ["An emergency call ({emergency}) works without internet", "Information shown is from the last update (time shown)", "Your reports will be sent automatically when the network returns", "Avoid non-urgent calls so as not to overload the network"],
    },
    after: { fr: ["Rouvrez la plateforme pour voir les alertes à jour"], en: ["Reopen the platform to see up-to-date alerts"] },
  },
];

// Sac d'urgence : utile quel que soit le danger
const EMERGENCY_KIT = {
  fr: ["Eau : 2 litres par personne et par jour", "Nourriture qui se conserve", "Lampe et piles", "Radio à piles", "Médicaments et ordonnances", "Copies de vos papiers", "Chargeur et batterie externe", "Trousse de premiers secours", "Couverture et vêtements chauds"],
  en: ["Water: 2 litres per person per day", "Long-life food", "Torch and batteries", "Battery radio", "Medicine and prescriptions", "Copies of your documents", "Charger and power bank", "First aid kit", "Blanket and warm clothes"],
};

const fill = (text: string, emergency: string) => text.replaceAll("{emergency}", emergency);
const fillLines = (lines: Lines, emergency: string): Lines => ({ fr: lines.fr.map((l) => fill(l, emergency)), en: lines.en.map((l) => fill(l, emergency)) });

export function safetyGuide(emergency: string) {
  return {
    entries: GUIDE.map((entry) => ({
      ...entry,
      summary: { fr: fill(entry.summary.fr, emergency), en: fill(entry.summary.en, emergency) },
      before: fillLines(entry.before, emergency),
      during: fillLines(entry.during, emergency),
      after: fillLines(entry.after, emergency),
    })),
    kit: EMERGENCY_KIT,
  };
}

export const GUIDE_KEYS = GUIDE.map((entry) => entry.key);
