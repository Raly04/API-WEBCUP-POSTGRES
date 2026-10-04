import { Router } from "express";
import {
  addExternalEntity,
  addParticipant,
  createComment,
  createProject,
  deleteComment,
  deleteProject,
  getProject,
  listComments,
  listProjects,
  removeExternalEntity,
  removeParticipant,
  updateProject,
} from "../controllers/project.controller";
import { authenticate, requirePermission } from "../middlewares/auth.middleware";
import { botGuard } from "../middlewares/botGuard.middleware";

const router = Router();

router.use(authenticate);

// Lecture : tout citoyen connecté
router.get("/", requirePermission("citizen.projects.view"), listProjects);
router.get("/:id", requirePermission("citizen.projects.view"), getProject);
router.get("/:id/comments", requirePermission("citizen.projects.view"), listComments);

// Avis citoyen/agent : une critique n'est pas une gestion du projet
router.post("/:id/comments", requirePermission("citizen.projects.comment"), botGuard("comment"), createComment);

// Gestion complète : réservée aux administrateurs
router.post("/", requirePermission("admin.projects.manage"), createProject);
router.patch("/:id", requirePermission("admin.projects.manage"), updateProject);
router.delete("/:id", requirePermission("admin.projects.manage"), deleteProject);
router.post("/:id/participants", requirePermission("admin.projects.manage"), addParticipant);
router.delete("/:id/participants/:userId", requirePermission("admin.projects.manage"), removeParticipant);
router.post("/:id/entities", requirePermission("admin.projects.manage"), addExternalEntity);
router.delete("/:id/entities/:entityId", requirePermission("admin.projects.manage"), removeExternalEntity);
// Modération d'un commentaire : réservée aux administrateurs
router.delete("/:id/comments/:commentId", requirePermission("admin.projects.manage"), deleteComment);

export default router;
