import { Router } from "express";
import { essentialsPage, getEssentials, getGuide, getGuideEntry } from "../controllers/essentials.controller";
import { listPublicContacts } from "../controllers/usefulContact.controller";

// Informations essentielles, sans compte : ce qui doit rester consultable quand la plateforme est en difficulté
// (monté sous /api/public)
const router = Router();

router.get("/essentials", getEssentials);
router.get("/guide", getGuide);
router.get("/guide/:key", getGuideEntry);
router.get("/contacts", listPublicContacts);
router.get("/secours", essentialsPage);

export default router;
