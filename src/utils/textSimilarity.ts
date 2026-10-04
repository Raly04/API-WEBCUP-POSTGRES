// Heuristique texte simple (sans dépendance externe) pour repérer des demandes qui parlent
// probablement du même problème : on compare les mots significatifs de l'objet + description.
// Pas de machine learning, juste un recouvrement de vocabulaire — suffisant pour grouper des
// signalements répétés ("lampadaire cassé rue X" / "éclairage en panne rue X").

// Mots trop courants pour être discriminants ; exclus du calcul de similarité
const STOPWORDS = new Set([
  "le", "la", "les", "un", "une", "des", "de", "du", "et", "ou", "a", "au", "aux",
  "en", "sur", "dans", "pour", "avec", "sans", "par", "ce", "cet", "cette", "ces",
  "mon", "ma", "mes", "votre", "vos", "notre", "nos", "son", "sa", "ses", "leur", "leurs",
  "est", "sont", "ont", "pas", "plus", "très", "bien", "qui", "que", "quoi", "dont", "où",
  "il", "elle", "ils", "elles", "je", "tu", "nous", "vous", "se", "sa", "ce", "il", "y",
  "car", "donc", "mais", "si", "tout", "toute", "tous", "toutes", "depuis", "vers",
]);

// Diacritiques retirées : "cassé" et "casse" doivent compter comme le même mot
function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Mots significatifs d'un texte : minuscules, sans accents, ponctuation retirée,
// stopwords et mots de moins de 3 lettres exclus
export function tokenize(text: string): Set<string> {
  const normalized = stripDiacritics(text.toLowerCase());
  const words = normalized.match(/[a-z0-9]+/g) ?? [];
  return new Set(words.filter((word) => word.length >= 3 && !STOPWORDS.has(word)));
}

// Nombre de mots significatifs communs aux deux textes
export function sharedTokenCount(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const word of a) {
    if (b.has(word)) count++;
  }
  return count;
}

// Deux demandes sont jugées "similaires" à partir de ce nombre de mots significatifs partagés
export const SIMILARITY_THRESHOLD = 2;
