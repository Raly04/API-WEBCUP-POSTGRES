import { Router } from "express";
import { createIdea, listIdeas, searchIdeaMentions } from "../controllers/idea.controller";
import { authenticate, requirePermission } from "../middlewares/auth.middleware";

const router = Router();

router.use(authenticate);

// Déposer une idée, mentionner des objets métier : ouvert à tout citoyen connecté
router.post("/", requirePermission("citizen.ideas.create"), createIdea);
// Suggestions du menu contextuel : les types sont filtrés par les permissions du habitant
router.get("/mentions", requirePermission("citizen.ideas.mentions"), searchIdeaMentions);
// Lire les idées des habitants : administration seule, c'est le seul moyen de les voir toutes
router.get("/", requirePermission("admin.ideas.manage"), listIdeas);

export default router;