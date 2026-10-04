// Traduit une erreur (Sequelize / PostgreSQL / réseau) en cause lisible + piste de correction.
// Le pilote pg remonte un code SQLSTATE normalisé dans err.parent.code (23505, 42P01, ...)
// là où mysql2 remontait un code ER_* et un errno numériques.

export interface ErrorDescription {
  summary: string;
  hint?: string;
  detail: string;
  known: boolean;
}

// Rassemble les codes et messages utiles de l'erreur.
function collect(err: any): string {
  const driver = err?.parent ?? err?.original;
  const values = driver
    ? [driver.code, driver.message]
    : [err?.code, err?.message, err?.cause?.code, err?.cause?.message];
  return values
    .filter((value) => value !== undefined && value !== null && value !== "")
    .map((value) => String(value).trim())
    .join(" | ");
}

const RULES: { test: RegExp; summary: string; hint: string }[] = [
  {
    test: /ECONNREFUSED/,
    summary: "Connexion à la base refusée",
    hint: "Le serveur PostgreSQL est arrêté, ou DATABASE_URL / DB_HOST / DB_PORT sont incorrects",
  },
  {
    test: /ENOTFOUND|EAI_AGAIN/,
    summary: "Hôte de la base introuvable",
    hint: "Vérifier l'hôte dans DATABASE_URL (ou DB_HOST)",
  },
  {
    test: /ETIMEDOUT|connect timeout/i,
    summary: "Délai de connexion à la base dépassé",
    hint: "Vérifier l'hôte et le port dans DATABASE_URL, et que le pare-feu autorise la connexion",
  },
  {
    // 28P01 : invalid_password. Sur une base managée (Supabase, Neon), c'est le symptôme
    // classique d'un mot de passe mal encodé dans l'URL ou d'un utilisateur inexistant.
    test: /28P01|password authentication failed/i,
    summary: "Authentification refusée par PostgreSQL",
    hint: "Vérifier l'utilisateur et le mot de passe dans DATABASE_URL (le mot de passe doit être encodé en URL s'il contient @ : /)",
  },
  {
    // 42501 : insufficient_privilege. 3D000 : la base n'existe pas.
    test: /42501|permission denied for database/i,
    summary: "L'utilisateur PostgreSQL n'a pas les droits sur la base",
    hint: "Accorder les droits à l'utilisateur sur la base (GRANT ALL ON DATABASE …)",
  },
  {
    test: /3D000|database .* does not exist/i,
    summary: "Base de données inconnue",
    hint: "Vérifier le nom de la base dans DATABASE_URL",
  },
  {
    // 42P01 : undefined_table
    test: /42P01|relation .* does not exist/i,
    summary: "Table absente dans la base",
    hint: "Créer les tables : npm run db:sync (avec le DATABASE_URL de cette base)",
  },
  {
    // 42703 : undefined_column
    test: /42703|column .* does not exist/i,
    summary: "Colonne absente dans la base",
    hint: "Le schéma de la base ne correspond pas aux modèles Sequelize (src/models)",
  },
  {
    // 23505 : unique_violation. 23503 : foreign_key_violation. Les deux sont des erreurs
    // métier attendues (doublon, suppression bloquée), mais leur message SQLSTATE aide à les
    // distinguer d'une panne réelle dans les journaux.
    test: /23505|duplicate key value violates unique constraint/i,
    summary: "Valeur en double sur une contrainte d'unicité",
    hint: "Un champ UNIQUE reçoit déjà cette valeur (email, code, référence…)",
  },
  {
    test: /23503|foreign key constraint/i,
    summary: "Clé étrangère : ligne référencée absente ou suppression bloquée",
    hint: "Vérifier les identifiants liés, ou la règle ON DELETE de la contrainte",
  },
  {
    // 42P01/42703 déjà couverts plus haut ; 22000 (numeric_value_out_of_range) et 22003
    // (numeric_value_out_of_range sur division) surviennent quand un `?` reçoit une
    // chaîne non numérique là où PostgreSQL exige un typage strict.
    test: /22P02|invalid_text_representation|invalid input syntax for type/i,
    summary: "Type invalide transmis à PostgreSQL",
    hint: "Un paramètre n'a pas le type attendu (entier, date, booléen) — vérifier le mapping du modèle",
  },
  {
    test: /pool timeout/i,
    summary: "Aucune connexion disponible vers la base",
    hint: "La base est injoignable ou le pool est saturé",
  },
];

export function describeError(err: unknown): ErrorDescription {
  const detail = collect(err) || String(err);
  const rule = RULES.find((r) => r.test.test(detail));
  if (rule) return { summary: rule.summary, hint: rule.hint, detail, known: true };
  const message = err instanceof Error ? err.message.trim().split("\n").pop() : undefined;
  return { summary: message || "Erreur inattendue", detail, known: false };
}
