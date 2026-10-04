import { Router } from "express";
import { declareDisruptions, endDisruption, listDisruptions, listLinesForStaff, updateDisruption } from "../controllers/transport.controller";
import { authenticate, requirePermission } from "../middlewares/auth.middleware";

// Interruptions de transport, côté personnel (la lecture publique est sous /api/public/transport)
const router = Router();

router.use(authenticate, requirePermission("agent.transport.manage"));

router.get("/lines", listLinesForStaff);
router.get("/disruptions", listDisruptions);
router.post("/disruptions", declareDisruptions);
router.patch("/disruptions/:id", updateDisruption);
router.post("/disruptions/:id/end", endDisruption);

export default router;
