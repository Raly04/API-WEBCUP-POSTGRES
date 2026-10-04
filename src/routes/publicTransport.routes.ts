import { Router } from "express";
import { getPublicDisruption, lineDetail, listStops, planJourney, stopCard, transportStatus } from "../controllers/transport.controller";

// Transports en commun, lisibles sans compte : état des lignes, arrêts, trajet de remplacement
const router = Router();

router.get("/", transportStatus);
router.get("/stops", listStops);
router.get("/stops/:name", stopCard);
router.get("/lines/:code", lineDetail);
router.get("/journey", planJourney);
router.get("/disruptions/:id", getPublicDisruption);

export default router;


