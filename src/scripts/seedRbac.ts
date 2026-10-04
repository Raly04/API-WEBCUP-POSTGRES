// Insère les données de base (rôles, permissions, services municipaux) : npm run db:seed
// Le serveur fait la même chose à chaque démarrage ; ce script sert à le lancer sans démarrer l'API.
// Idempotent : voir seeds/rbac.seed.ts et seeds/services.seed.ts pour ce qui est préservé.
import sequelize from "../config/database";
import { runSeeds } from "../seeds";
import { describeError } from "../utils/describeError";
import { logger } from "../utils/logger";

async function main() {
  try {
    await runSeeds();
  } catch (err) {
    const { summary, hint, detail } = describeError(err);
    logger.error("SEED", `${summary}${hint ? `\n  Piste : ${hint}` : ""}\n  Détail : ${detail}`);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

void main();
