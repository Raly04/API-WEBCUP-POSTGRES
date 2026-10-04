import { Router } from "express";
import {
  createEstablishment,
  deleteEstablishment,
  getEstablishment,
  listEstablishments,
  updateEstablishment,
} from "../controllers/establishment.controller";
import { authenticate, requirePermission } from "../middlewares/auth.middleware";

const router = Router();

router.use(authenticate);

// Lecture : tout citoyen connecté
router.get("/", requirePermission("citizen.establishments.view"), listEstablishments);
router.get("/:id", requirePermission("citizen.establishments.view"), getEstablishment);

// Gestion : agents (et administrateurs)
router.post("/", requirePermission("agent.establishments.manage"), createEstablishment);
router.patch("/:id", requirePermission("agent.establishments.manage"), updateEstablishment);
router.delete("/:id", requirePermission("agent.establishments.manage"), deleteEstablishment);

export default router;
