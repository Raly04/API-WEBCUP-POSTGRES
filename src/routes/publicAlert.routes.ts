import { Router } from "express";
import { getPublicAlert, listPublicAlerts, listZones } from "../controllers/alert.controller";

// Lecture publique des alertes : AUCUNE authentification. Une alerte de montée des eaux doit atteindre aussi ceux qui
// n'ont pas de compte ou ne sont pas connectés.
const router = Router();

router.get("/", listPublicAlerts);
router.get("/zones", listZones); // avant "/:id"
router.get("/:id", getPublicAlert);

export default router;
