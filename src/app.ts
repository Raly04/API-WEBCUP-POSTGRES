import express from "express";
import cors from "cors";
import compression from "compression";
import cookieParser from "cookie-parser";
import { UPLOADS_DIR } from "./config/upload";
import { attackGuard } from "./middlewares/attackGuard.middleware";
import { auditRequests } from "./middlewares/audit.middleware";
import { securityHeaders } from "./middlewares/securityHeaders.middleware";
import { errorHandler, notFound } from "./middlewares/error.middleware";
import { apiLimiter, authLimiter } from "./middlewares/rateLimit.middleware";
import { requestLogger } from "./middlewares/requestLogger.middleware";
import announcementRoutes from "./routes/announcement.routes";
import appointmentRoutes from "./routes/appointment.routes";
import auditLogRoutes from "./routes/auditLog.routes";
import citizenAccountRoutes from "./routes/citizenAccount.routes";
import citizenRequestRoutes from "./routes/citizenRequest.routes";
import establishmentRoutes from "./routes/establishment.routes";
import formsRoutes from "./routes/forms.routes";
import externalEntityRoutes from "./routes/externalEntity.routes";
import guidanceRequestRoutes from "./routes/guidanceRequest.routes";
import ideaRoutes from "./routes/idea.routes";
import municipalServiceRoutes from "./routes/municipalService.routes";
import notificationRoutes from "./routes/notification.routes";
import authRoutes from "./routes/auth.routes";
import contactMessageRoutes from "./routes/contactMessage.routes";
import partnerAccountRoutes from "./routes/partnerAccount.routes";
import partnerRequestRoutes from "./routes/partnerRequest.routes";
import partnerServiceRoutes from "./routes/partnerService.routes";
import permissionRoutes from "./routes/permission.routes";
import projectRoutes from "./routes/project.routes";
import publicRoutes from "./routes/public.routes";
import roleRoutes from "./routes/role.routes";
import securityRoutes from "./routes/security.routes";
import signalementRoutes from "./routes/signalement.routes";
import alertRoutes from "./routes/alert.routes";
import transportRoutes from "./routes/transport.routes";
import essentialsRoutes from "./routes/essentials.routes";
import { essentialsPage, serviceStatus } from "./controllers/essentials.controller";
import usefulContactRoutes from "./routes/usefulContact.routes";
import platformRoutes from "./routes/platform.routes";
import publicTransportRoutes from "./routes/publicTransport.routes";
import publicAlertRoutes from "./routes/publicAlert.routes";
import uploadRoutes from "./routes/upload.routes";
import userRoutes from "./routes/user.routes";
import sequelize from "./config/database";
import { allowedOrigins } from "./config/origins";
import { logger } from "./utils/logger";

const app = express();

// CLIENT_URL accepte plusieurs origines séparées par des virgules (voir config/origins.ts)
export { allowedOrigins };

// Ne pas annoncer « Express » dans chaque réponse : c'est une aide gratuite pour qui cherche une faille connue
app.disable("x-powered-by");

// Derrière un proxy (hébergeur, nginx), req.ip doit venir de X-Forwarded-For : TRUST_PROXY = nombre de proxys
// de confiance (ex. 1). Sans cela, la limitation de débit et l'audit verraient tous les habitants comme un seul.
if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

// En-têtes de sécurité : posés en premier, donc présents sur TOUTES les réponses (erreurs et refus compris)
app.use(securityHeaders);
// Réponses JSON compressées : divise le volume transféré, précieux sur une connexion lente
app.use(compression());
app.use(requestLogger);
// Audit de toute requête, avant les routes ; l'écriture en base est différée (voir utils/auditQueue)
app.use(auditRequests);
// Sondes d'attaque (injection SQL, traversée de répertoire, scanners...) : refusées et comptées avant d'atteindre l'application
app.use(attackGuard);

// credentials: true -> autorise le front à envoyer le cookie httpOnly du refresh token
app.use(
  cors({
    credentials: true,
    // Liste fermée : ce que le front utilise réellement, rien de plus
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept-Language", "X-Form-Token", "X-Form-Hp"],
    // Retry-After n'est lisible par le front, entre deux origines, que s'il est exposé : sans cela il ne peut
    // pas savoir combien de temps attendre après un 429 ou un 503 et retombe sur un délai générique
    exposedHeaders: ["Retry-After", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"],
    // Le navigateur garde la réponse de préflight 10 minutes : une requête de moins par appel sur réseau lent
    maxAge: 600,
    origin(origin, callback) {
      // Pas d'en-tête Origin : Postman, curl, appel serveur à serveur
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      logger.warn(
        "CORS",
        `Origine refusée : ${origin} (autorisées : ${allowedOrigins.join(", ")}). Ajouter l'origine dans CLIENT_URL`
      );
      callback(null, false);
    },
  })
);
// 100 ko suffisent largement pour ce que l'API reçoit ; un corps géant ne doit pas occuper un worker
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());
// Images uploadées (projets...) : fichiers statiques, pas de session requise pour les afficher.
// Précautions : jamais interprétées comme autre chose qu'une image (nosniff), aucun script exécutable même si un
// fichier piégé passait (CSP + sandbox), affichables sur le site du front (CORP cross-origin), pas de fichiers
// cachés ni de listing de dossier. Les noms sont des identifiants aléatoires : cache d'un an, jamais périmé.
app.use(
  "/uploads",
  (_req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; sandbox",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Content-Disposition": "inline",
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    next();
  },
  express.static(UPLOADS_DIR, { dotfiles: "deny", index: false, redirect: false })
);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok - server is running" });
});

// Disponibilité réelle : le processus répond ET la base aussi. À donner à l'hébergeur ou à un outil de supervision
// (le /api/health simple reste vert même si la base est tombée).
app.get("/api/health/ready", async (_req, res) => {
  const started = Date.now();
  try {
    await Promise.race([
      sequelize.query("SELECT 1"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000).unref()),
    ]);
    res.json({ status: "ready", database: "up", responseMs: Date.now() - started, uptimeSeconds: Math.round(process.uptime()) });
  } catch {
    res.set("Retry-After", "5").status(503).json({ status: "unavailable", database: "down" });
  }
});

// État des services, en clair : interrogé par le client quand une requête échoue (mode dégradé). Avant le limiteur.
app.get("/api/status", serviceStatus);
// Page de secours lisible sans JavaScript, servie par l'API même si le site principal est en panne
app.get("/secours", essentialsPage);

app.use("/api", apiLimiter);
app.use(["/api/auth/login", "/api/auth/login/2fa", "/api/auth/register"], authLimiter);

// Jeton de formulaire (anti-robots) : public, sans état côté serveur
app.use("/api/forms", formsRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/contact-messages", contactMessageRoutes);
app.use("/api/users", userRoutes);
app.use("/api/citizen-accounts", citizenAccountRoutes);
app.use("/api/roles", roleRoutes);
app.use("/api/permissions", permissionRoutes);
app.use("/api/audit-logs", auditLogRoutes);
app.use("/api/security", securityRoutes);
app.use("/api/uploads", uploadRoutes);

app.use("/api/services", municipalServiceRoutes);
app.use("/api/establishments", establishmentRoutes);
app.use("/api/announcements", announcementRoutes);
app.use("/api/requests", citizenRequestRoutes);
// Signalements (urgence médicale, incendie, inondation, panne...) : traités à part des demandes ordinaires
app.use("/api/signalements", signalementRoutes);
// Alertes à la population (montée des eaux, incendie...) : publication par le personnel validé, lecture publique
app.use("/api/alerts", alertRoutes);
app.use("/api/public/alerts", publicAlertRoutes);
// Transports : interruptions déclarées par le personnel, état du réseau et trajets de remplacement publics
app.use("/api/transport", transportRoutes);
app.use("/api/public/transport", publicTransportRoutes);
// Kit essentiel hors ligne (alertes, transports, services, urgence) : toujours servi, même base injoignable
app.use("/api/public", essentialsRoutes);
// Coordonnées utiles (personnel) et avis d'incident sur la plateforme (administrateur)
app.use("/api/contacts", usefulContactRoutes);
app.use("/api/platform", platformRoutes);
app.use("/api/appointments", appointmentRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/projects", projectRoutes);
app.use("/api/ideas", ideaRoutes);
app.use("/api/guidance-requests", guidanceRequestRoutes);
app.use("/api/external-entities", externalEntityRoutes);
app.use("/api/partner-accounts", partnerAccountRoutes);
app.use("/api/partner-services", partnerServiceRoutes);
app.use("/api/partner-requests", partnerRequestRoutes);

// Accessible sans session : alimente la page d'accueil publique
app.use("/api/public", publicRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
