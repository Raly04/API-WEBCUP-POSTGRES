import { Router } from "express";
import {
  bookSlot,
  cancelMyAppointment,
  cancelSlot,
  createSlot,
  deleteSlot,
  getOwnSlot,
  listMyAppointments,
  listMySlots,
  listOpenSlots,
  reopenSlot,
} from "../controllers/appointment.controller";
import { authenticate, requirePermission } from "../middlewares/auth.middleware";
import { botGuard } from "../middlewares/botGuard.middleware";

const router = Router();

router.use(authenticate);

// Citoyen : parcours des créneaux ouverts, réservation, suivi et annulation des siens.
// Les routes littérales (slots, mine) sont déclarées avant "/:id" pour ne pas être
// capturées par le paramètre.
router.get("/slots", requirePermission("citizen.appointments.view"), listOpenSlots);
router.get("/mine", requirePermission("citizen.appointments.view"), listMyAppointments);
router.post("/:id/book", requirePermission("citizen.appointments.manage"), botGuard("appointment"), bookSlot);
router.delete("/mine/:id", requirePermission("citizen.appointments.manage"), cancelMyAppointment);

// Agent : ouverture et gestion de ses propres créneaux
router.post("/", requirePermission("agent.appointments.manage"), createSlot);
router.get("/", requirePermission("agent.appointments.view"), listMySlots);
router.get("/:id", requirePermission("agent.appointments.view"), getOwnSlot);
router.patch("/:id/cancel", requirePermission("agent.appointments.manage"), cancelSlot);
router.patch("/:id/reopen", requirePermission("agent.appointments.manage"), reopenSlot);
router.delete("/:id", requirePermission("agent.appointments.manage"), deleteSlot);

export default router;
