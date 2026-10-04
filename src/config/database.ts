import "dotenv/config";
import { Sequelize } from "sequelize";
import pg from "pg";

// Le pilote pg renvoie par défaut les BIGINT (OID 20), les NUMERIC (1700) et les COUNT(*)
// sous forme de chaînes, pour préserver une précision que l'API n'exploite pas : tous les id
// du schéma sont des BIGSERIAL et le code les manipule comme des nombres. Sans ces parseurs,
// `row.id` serait "42" et non 42 — invisible dans les tests unitaires, mais cassant dès
// qu'un id est comparé, sérialisé en JSON ou injecté dans une requête.
pg.types.setTypeParser(20, (v: string) => Number(v));
pg.types.setTypeParser(1700, (v: string) => Number(v));
// Les NUMERIC renvoient déjà une chaîne au lieu d'un nombre : idem, pour les AVG.
pg.types.setTypeParser(700, (v: string) => Number(v));

// Connexion PostgreSQL.
// Priorité à DATABASE_URL (format postgres://user:pass@hote:port/base), le format des
// plateformes managées (Supabase, Neon, Railway). À défaut, les variables DB_* sont
// reassemblées ici, comme auparavant.
const url = process.env.DATABASE_URL;

// TLS : exigé par les bases managées (Render, Supabase, Neon), qui refusent toute connexion
// en clair (« SSL/TLS required », code 28000). Actif dès que DATABASE_URL est fournie, et
// désactivable par DB_SSL=false pour une base locale ou un tunnel. rejectUnauthorized false
// car ces fournisseurs émettent un certificat de leur propre autorité, absent du magasin
// système : la connexion reste chiffrée, seule la vérification du certificat est assouplie.
const useSsl = Boolean(url) && process.env.DB_SSL !== "false";

const sequelize = new Sequelize(
  url ?? "postgres://webcup:webcup@127.0.0.1:5432/webcup",
  {
    host: url ? undefined : process.env.DB_HOST || "127.0.0.1",
    port: url ? undefined : Number(process.env.DB_PORT) || 5432,
    // Sequelize type `ssl` comme un booléen ; les options propres au pilote pg se passent
    // par dialectOptions.
    dialectOptions: useSsl ? { ssl: { require: true, rejectUnauthorized: false } } : {},
    logging: false,
    // Colonnes snake_case en base (created_at...), attributs camelCase dans le code.
    // PG n'a pas d'« ON UPDATE CURRENT_TIMESTAMP » : ce triggers de mise à jour est posé par
    // syncDb.ts (fn_touch_updated_at) et par beforeUpdate dans les modèles qui le déclarent.
    define: { underscored: true },
    pool: { max: Number(process.env.DB_POOL_MAX) || 10, min: 2, idle: 60000, acquire: 10000 },
  }
);

export default sequelize;
