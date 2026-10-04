import { NextFunction, Request, Response } from "express";
import { allowedOrigins } from "../config/origins";

// En-têtes de sécurité HTTP. Visibles dans l'onglet Réseau des outils de développement : c'est la preuve la plus
// simple, pour tout le monde, que la protection est active. L'API ne sert que du JSON et des images :
// aucune page HTML, donc la politique peut être la plus stricte possible.
//
//  X-Content-Type-Options   le navigateur n'« interprète » jamais un fichier autrement que son type annoncé
//  X-Frame-Options          aucune page tierce ne peut afficher l'API dans un cadre (détournement de clic)
//  CSP                      rien n'est exécutable ni chargeable depuis une réponse de l'API
//  Referrer-Policy          aucune adresse de page n'est transmise à l'API ou par elle
//  Cross-Origin-Resource-   un site tiers ne peut pas inclure les réponses de l'API (images exceptées, voir /uploads)
//  Policy
//  Permissions-Policy       capteurs, caméra, micro et paiement désactivés
//  HSTS                     le navigateur n'accepte plus que HTTPS pour ce domaine (envoyé seulement sur HTTPS)
export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    "Cross-Origin-Resource-Policy": "same-site",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  });
  // HSTS seulement quand la connexion est bien en HTTPS (directement ou derrière un proxy qui le signale) :
  // l'envoyer en HTTP n'a aucun effet et sur un domaine de test il s'incrusterait dans le navigateur
  const https = req.secure || req.headers["x-forwarded-proto"] === "https";
  if (https) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

  // Réponses personnelles : jamais conservées par le navigateur ni par un proxy partagé (ordinateur public, cache
  // d'entreprise). Valeur par défaut : une route qui sert une donnée non personnelle (annonces, services publics)
  // la remplace explicitement par sa propre politique de cache.
  if (req.headers.authorization || req.headers.cookie || req.path.startsWith("/api/auth")) {
    res.set("Cache-Control", "no-store");
    res.set("Pragma", "no-cache");
  }
  next();
}

// Les points d'entrée qui s'appuient sur le cookie de session (refresh, déconnexion) n'acceptent qu'une requête
// venue du site légitime. SameSite=Lax protège déjà ; ceci est une seconde barrière. Pas d'en-tête Origin
// (application mobile, script) : acceptée, elle n'a de toute façon pas de cookie de navigateur.
export function trustedOrigin(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  if (typeof origin === "string" && !allowedOrigins.includes(origin.replace(/\/$/, ""))) {
    return res.status(403).json({ code: "origin_not_allowed", message: "Origine non autorisée" });
  }
  next();
}
