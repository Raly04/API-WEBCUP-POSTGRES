import "./config/runtime"; // en premier : configure le thread pool avant sa première utilisation
import "dotenv/config";
import app, { allowedOrigins } from "./app";
import sequelize from "./config/database";
import { AuthToken } from "./models/authToken.model";
import { User } from "./models/user.model";
import { attachRealtime } from "./realtime/announcementChannel";
import { attachStaffChannel } from "./realtime/staffChannel";
import { attachAlertChannel } from "./realtime/alertChannel";
import { runSeeds } from "./seeds";
import { primeEssentials } from "./controllers/essentials.controller";
import { flushAuditQueue } from "./utils/auditQueue";
import { describeError } from "./utils/describeError";
import { logger } from "./utils/logger";

const PORT = Number(process.env.PORT) || 5000;

// Arrêt propre : on écrit les dernières lignes d'audit encore en file avant de quitter
// Les requêtes en cours se terminent avant de fermer ; au-delà de 10 s on quitte quand même
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    setTimeout(() => process.exit(0), 10_000).unref();
    server.close(() => {
      void flushAuditQueue().finally(() => process.exit(0));
    });
  });
}

process.on("unhandledRejection", (reason) => {
  const { summary, hint, detail } = describeError(reason);
  logger.error("PROCESS", `Promesse rejetée non gérée : ${summary}${hint ? ` (${hint})` : ""}`, detail);
});

process.on("uncaughtException", (err) => {
  logger.error("PROCESS", `Exception non gérée : ${err.message}`, err.stack);
  process.exit(1);
});

// Vérifie la connexion et la présence des tables au démarrage, sans bloquer le serveur
async function checkDatabase() {
  const target = `${process.env.DB_USER}@${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`;
  try {
    await sequelize.authenticate();
    await User.count();
    await AuthToken.count();
    logger.info("DB", `Connexion OK (${target}), tables users et auth_tokens présentes`);
    if (process.env.SEED_ON_START !== "false") await runSeeds();
    // Copie de secours des informations essentielles dès le démarrage, avant même la première visite
    await primeEssentials();
  } catch (err) {
    const { summary, hint, detail } = describeError(err);
    logger.error("DB", `${summary} (${target})${hint ? `\n  Piste : ${hint}` : ""}\n  Détail : ${detail}`);
  }
}

const server = app.listen(PORT, () => {
  logger.info("SERVER", `API démarrée sur le port ${PORT} (NODE_ENV=${process.env.NODE_ENV || "non défini"})`);
  logger.info("SERVER", `Origines CORS autorisées : ${allowedOrigins.join(", ")}`);
  const io = attachRealtime(server, allowedOrigins);
  attachStaffChannel(io); // alertes d'urgence temps réel, réservées au personnel authentifié
  attachAlertChannel(io); // alertes à la population, sur le canal public
  void checkDatabase();
});

// Connexions persistantes plus longues que celles du proxy (évite des 502 intermittents) ;
// une requête qui n'aboutit pas en 30 s est coupée plutôt que de bloquer un worker
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 30_000;

// Les détails d'erreur ne doivent jamais partir vers les clients d'un site en production (voir middlewares/error)
if (process.env.EXPOSE_ERRORS === "true" && process.env.NODE_ENV === "production") {
  logger.error("SECURITY", "EXPOSE_ERRORS=true en production : la cause technique des erreurs est renvoyée aux visiteurs. À désactiver.");
}

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") logger.error("SERVER", `Le port ${PORT} est déjà utilisé`);
  else logger.error("SERVER", `Impossible de démarrer le serveur : ${err.message}`, err.stack);
  process.exit(1);
});
