import { Router } from "express";
import { createContact, deleteContact, listContacts, updateContact } from "../controllers/usefulContact.controller";
import { authenticate, requirePermission } from "../middlewares/auth.middleware";

// Coordonnées utiles, côté personnel (la lecture publique est GET /api/public/contacts)
const router = Router();

router.use(authenticate, requirePermission("agent.contacts.manage"));

router.get("/", listContacts);
router.post("/", createContact);
router.patch("/:id", updateContact);
router.delete("/:id", deleteContact);

export default router;
