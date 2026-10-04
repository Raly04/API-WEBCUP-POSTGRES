import { Router } from "express";
import { GUARDED_FORMS, isGuardedForm, issueFormToken } from "../utils/formToken";

const router = Router();

// GET /api/forms/token?form=register -> { token, minDelayMs, expiresInMs }
// Public et sans état côté serveur (le jeton est signé) : le front le demande à l'affichage d'un formulaire.
router.get("/token", (req, res) => {
  const form = req.query.form;
  if (!isGuardedForm(form)) {
    return res.status(400).json({ message: `Formulaire inconnu (${GUARDED_FORMS.join(", ")})` });
  }
  res.set("Cache-Control", "no-store"); // un jeton ne se partage ni ne se met en cache
  res.json(issueFormToken(form));
});

export default router;
