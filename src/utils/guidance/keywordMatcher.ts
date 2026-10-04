import { tokenize } from "../textSimilarity";
import type { MunicipalServiceData } from "../../models/municipalService.model";

// Routage déterministe par mots-clés, utilisé quand le modèle est indisponible, trop lent ou
// malformé. Il ne cherche pas à être intelligent : à charge de citation faible, l'orientation doit
// rester plausible et la réponse instantanée. Un service null est une réponse valide — l'habitant
// est renvoyé vers le Haut Conseil plutôt que vers un service au hasard.
//
// Deux sources de mots pour un service :
//   - son nom et sa description, lus en base : un service ajouté ou renommé s'adapte seul
//   - un vocabulaire civique ci-dessous, car les synonymes du quotidien ne figurent dans aucun
//     descriptif ("panne d'électricité" ne partage aucun mot avec "Énergie solaire géothermique")

const SERVICE_VOCABULARY: Record<string, string[]> = {
  etat_civil: [
    "acte", "naissance", "mariage", "deces", "identite", "carte", "piece", "papiers",
    "document", "documents", "attestation", "justificatif",
    "inscription", "habitant", "nouvel arrivant", "arriver", "arrive", "arrivee", "arrivant",
    "adresse", "demenagement",
    "residence", "livret", "certificat", "extrait",
  ],
  eau_energie: [
    "electricite", "electrique", "courant", "panne", "coupure", "eau", "robinet", "fuite",
    "chauffage", "chaleur", "froid", "panne", "compteur", "consommation", "energie", "soleil",
    "solaire", "geothermie", "pression", "coupure", "reprise",
  ],
  transport: [
    "navette", "bus", "horaire", "abonnement", "pass", "ticket", "stationnement", "voiture",
    "vehicule", "garage", "conduire", "route", "trafic", "deplacement", "deplacer",
    "transport", "quai", "embarquement", "zone exterieur", "retard", "annule",
  ],
  sante: [
    "medecin", "doctor", "hopital", "clinique", "soins", "vaccin", "vaccination", "dentiste",
    "ordonnance", "medicament", "pharmacie", "urgence", "secours", "maladie", "symptome",
    "malaise", "Rendez-vous medical", "sante", "sang", "allergie", "gravite", "atmosphere",
  ],
  securite: [
    "vol", "vole", "voler", "volee", "voleur", "cambriolage", "injection", "agression", "danger",
    "alerte", "evacuation", "tempete", "poussiere", "radiation", "incendie", "secours",
    "protection", "surveillance", "intrus", "effraction", "racket", "astreinte", "gendarmerie",
    "police", "brigade", "plainte", "disparition", "vols",
    "vitre", "briser", "brise", "casse", "effraction", "tag", " degrade", "degrade",
  ],
  logement: [
    "logement", "appartement", "maison", "attribution", "loge", "dommage", "degat", "fissure",
    "infiltration", "humidite", "chauffage", "travaux", "renovation", "reparation", "copropriete",
    "syndic", "locataire", "proprietaire", "bail", "demenagement", "piece",
  ],
  environnement: [
    "serre", "culture", "jardin", "dechet", "poubelle", "tri", "recyclage", "air", "pollution",
    "qualite de l'air", "ecologie", "ecosysteme", "vegetation", "plant", "arbre", "espace vert",
    "parc", "gravats", "encombrant", "eau usee",
  ],
  education: [
    "ecole", "eleve", "etudiant", "inscription scolaire", "cantine", "garderie", "formation",
    "formation professionnelle", "apprentissage", "bibliotheque", "livre", "numerique",
    "professeur", "cours", "diplome", "certification", "nouvel arrivant", "alphabetisation",
  ],
  commerce_emploi: [
    "emploi", "travail", "offre", "recrutement", "cv", "entretien", "entreprise", "commerçant",
    "commerce", "magasin", "boutique", "artisan", "entreprendre", "creation",
    "aide", "subvention", "financement", "licence", "inventaire", "approvisionnement",
  ],
  culture_loisirs: [
    "culture", "evenement", "concert", "festival", "exposition", "sport", "sportif", "gymnase",
    "piscine", "club", "association", "bibliotheque", "cinema", "theatre", "musique", "loisir",
    "sortie", "rencontre", "foyer", "reservation", "place",
  ],
  communications: [
    "reseau", "internet", "connexion", "wifi", "panne reseau", "liaison", "terre", "transmission",
    "signal", "telephone", "numérique", "numerique", "application", "appli", "applique", "appl",
    "compte", "identifiant", "mdp", "mot de passe", "connexion", "bug", "plante", "bloque",
    "assistant technique", "assistance technique", "coupure", "box", "serveur",
  ],
  haut_conseil: [
    "haut conseil", "conseil", "municipal", "maire", "elue", "elu", "proposition", "consultation",
    "decision", "deliberation", "recours", "plainte", "administratif", "dossier", "demande",
    "service competent", "orientation", "savoir", "competent", "renseignement",
  ],
};

// Pluriel : "coupures" doit atteindre le mot-clé "coupure". Le français ne prend pas de s après
// e ou a, la règle reste volontairement approximative — un faux positif isolé est sans conséquence.
function singularize(word: string): string {
  return word.length > 4 && word.endsWith("s") ? word.slice(0, -1) : word;
}

// Élision : un habitant écrit "deau", "leelectricite", "lappli" là où le mot-clé est "eau",
// "electricite", "appli". Retirer la consonne ou la particule collée en début de mot rend les deux
// formes comparables. Sans cela, un problème sans accent ne rejoint aucun service du tout.
const ELISION_PREFIXES = ["de", "du", "le", "la", "les", "qu", "n", "d", "l", "j", "m", "t", "s", "c"];

function variants(word: string): string[] {
  const forms = [word];
  for (const prefix of ELISION_PREFIXES) {
    if (word.length > prefix.length + 2 && word.startsWith(prefix)) {
      const rest = word.slice(prefix.length);
      // Une élision ne précède qu'une voyelle : "descendre" ne doit pas devenir "cendre"
      if (/^[aeiouy]/.test(rest)) forms.push(rest);
    }
  }
  return forms;
}

// Formes normalisées d'un mot, la forme d'origine comprise : un mot est donc compté une seule
// fois quel que soit le nombre de variantes qui recoupent le vocabulaire d'un service.
function formsOf(word: string): Set<string> {
  return new Set(variants(singularize(word)));
}

// Index mot -> formes normalisées, pour ne parcourir qu'une fois par mot du problème
function normalizedIndex(words: Iterable<string>): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const word of words) index.set(word, formsOf(word));
  return index;
}

// Aplatit un texte en l'ensemble de toutes ses formes normalisées
function formsOfSet(words: Iterable<string>): Set<string> {
  const forms = new Set<string>();
  for (const word of words) for (const form of formsOf(word)) forms.add(form);
  return forms;
}

// Poids des sources : un mot du nom du service ou du vocabulaire civique vaut plus qu'un mot
// rencontré au hasard dans une description.
const NAME_WEIGHT = 3;
const DESCRIPTION_WEIGHT = 1;

export interface KeywordMatch {
  service: MunicipalServiceData | null;
  score: number;
  // Recoupements trouvés dans le nom ou le vocabulaire civique : un seul suffit à être crédible
  strongHits: number;
  // Recoupements trouvés dans le descriptif : deux au moins, sinon un mot pris au hasard
  // ("ma chroma marche plus") enverrait vers le commerce local
  weakHits: number;
}

// Deux mots du descriptif, ou un seul mot fort : en dessous, aucun service n'est proposé.
const MIN_WEAK_HITS = 2;

/** Choisit le service dont le vocabulaire recoupe le mieux le problème décrit. */
export function matchServiceByKeywords(
  problem: string,
  services: MunicipalServiceData[]
): KeywordMatch {
  const asked = normalizedIndex(tokenize(problem));

  let best: KeywordMatch = { service: null, score: 0, strongHits: 0, weakHits: 0 };
  for (const service of services) {
    const strong = new Set(
      formsOfSet([...tokenize(service.name), ...tokenize(SERVICE_VOCABULARY[service.code]?.join(" ") ?? "")])
    );
    const weak = formsOfSet(tokenize(service.description ?? ""));

    let score = 0;
    let strongHits = 0;
    let weakHits = 0;
    // Le mot du problème est l'unité de comptage : "marche" produit les formes "marche" et
    // "arche", qui peuvent toutes deux recouper le vocabulaire. Le compter deux fois laisserait
    // un seul mot franchir le seuil de crédibilité.
    for (const forms of asked.values()) {
      const isStrong = [...forms].some((form) => strong.has(form));
      if (isStrong) {
        score += NAME_WEIGHT;
        strongHits++;
      } else if ([...forms].some((form) => weak.has(form))) {
        score += DESCRIPTION_WEIGHT;
        weakHits++;
      }
    }
    // À score égal, le service le plus haut dans la liste l'emporte : l'ordre d'affichage est
    // choisi par les administrateurs, autant s'y fier plutôt qu'à l'ordre de la base
    if (score > best.score) best = { service, score, strongHits, weakHits };
  }

  const credible = best.strongHits > 0 || best.weakHits >= MIN_WEAK_HITS;
  return credible ? best : { service: null, score: 0, strongHits: 0, weakHits: 0 };
}