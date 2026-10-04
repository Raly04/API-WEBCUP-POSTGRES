// Les quelques expressions SQL qui n'existent pas à l'identique en PostgreSQL.
// Tout le reste de l'API passe par l'ORM Sequelize et reste portable ; ce fichier
// isole les cas où le dialecte force une écriture explicite.

// Rang d'une valeur dans une liste ordonnée — équivalent portable du FIELD() MySQL.
// MySQL : FIELD(severity, 'emergency', 'warning', 'watch', 'info')
// PG    : ARRAY_POSITION(ARRAY['emergency','warning',...], severity) - 1
// Le - 1 rend le premier rang nul, comme FIELD(). ASC trie donc par ordre de priorité.
export function enumRank(column: string, values: readonly string[]): string {
  const list = values.map((v) => `'${v}'`).join(",");
  return `(ARRAY_POSITION(ARRAY[${list}], ${column}) - 1)`;
}

// Même chose pour une colonne déjà entre guillemets par l'ORM (ex. "Alert"."severity").
export function enumRankQuoted(quotedColumn: string, values: readonly string[]): string {
  const list = values.map((v) => `'${v}'`).join(",");
  return `(ARRAY_POSITION(ARRAY[${list}], ${quotedColumn}) - 1)`;
}

// Nombre de minutes écoulées depuis une colonne timestamp — équivalent portable de
// TIMESTAMPDIFF(MINUTE, col, UTC_TIMESTAMP()). Volontairement nommée sqlMinutesSince pour
// ne pas être confondu avec l/helpers de même nom de signalement.model.ts, qui calcule la
// même chose en JavaScript sur une Date déjà chargée.
export function sqlMinutesSince(column: string): string {
  return `(EXTRACT(EPOCH FROM (NOW() - ${column})) / 60)`;
}
