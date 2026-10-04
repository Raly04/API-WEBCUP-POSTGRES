import { Router } from "express";
import {
  changePassword,
  deleteAccount,
  login,
  loginTwoFactor,
  logout,
  logoutAll,
  me,
  refresh,
  register,
  updateProfile,
  welcomeStatus,
} from "../controllers/auth.controller";
import { revokeSession, securityOverview, twoFactorDisable, twoFactorSetup, twoFactorVerify } from "../controllers/accountSecurity.controller";
import { authenticate } from "../middlewares/auth.middleware";
import { trustedOrigin } from "../middlewares/securityHeaders.middleware";
import { botGuard } from "../middlewares/botGuard.middleware";

const router = Router();

router.post("/register", botGuard("register"), register);
router.post("/login", botGuard("login"), login);
// Pas de botGuard ici : le mot de passe a déjà été vérifié par /login, et la limite de débit
// (voir app.ts, LOGIN_RATE_LIMIT_PER_15MIN) couvre le risque d'essais répétés sur le code.
router.post("/login/2fa", loginTwoFactor);
// Les points d'entrée qui s'appuient sur le cookie de session n'acceptent que le site légitime (en plus de SameSite)
router.post("/refresh", trustedOrigin, refresh);

router.post("/logout", trustedOrigin, logout);
router.post("/logout-all", authenticate, logoutAll);
router.get("/me", authenticate, me);
router.get("/me/welcome", authenticate, welcomeStatus);
router.get("/me/security", authenticate, securityOverview);
router.delete("/me/sessions/:id", authenticate, revokeSession);
router.post("/me/2fa/setup", authenticate, twoFactorSetup);
router.post("/me/2fa/verify", authenticate, twoFactorVerify);
router.post("/me/2fa/disable", authenticate, twoFactorDisable);
router.patch("/me", authenticate, updateProfile);
router.patch("/me/password", authenticate, changePassword);
router.delete("/me", authenticate, deleteAccount);

export default router;
