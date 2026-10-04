import { Router } from "express";
import {
  createAnnouncement,
  deleteAnnouncement,
  getAnnouncement,
  listAnnouncements,
  updateAnnouncement,
} from "../controllers/announcement.controller";
import { authenticate, requirePermission } from "../middlewares/auth.middleware";

const router = Router();

router.use(authenticate);

// Lecture : tout citoyen connecté (annonces publiées uniquement, sauf gestionnaire)
router.get("/", requirePermission("citizen.announcements.view"), listAnnouncements);
router.get("/:id", requirePermission("citizen.announcements.view"), getAnnouncement);

// Gestion : agent et administrateur
router.post("/", requirePermission("agent.announcements.manage"), createAnnouncement);
router.patch("/:id", requirePermission("agent.announcements.manage"), updateAnnouncement);
router.delete("/:id", requirePermission("agent.announcements.manage"), deleteAnnouncement);

export default router;
