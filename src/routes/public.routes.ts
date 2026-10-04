import { Router } from "express";
// import { listPublicAnnouncements, listPublicServices } from "../controllers/public.controller";
import { publicCache } from "../middlewares/publicCache.middleware";
import { listPublicAnnouncements, listPublicProjects, listPublicServices } from "../controllers/public.controller";

const router = Router();

// Surface publique : aucune authentification, uniquement ce que la ville publie.
// Chaque service ajouté ici reste protégé par son propre RBAC sur /api/services.
// Pages d'accueil ouvertes par tous les visiteurs en même temps : réponses gardées quelques secondes
router.get("/services", publicCache(60), listPublicServices);
router.get("/announcements", publicCache(30), listPublicAnnouncements);
router.get("/projects", listPublicProjects);

export default router;