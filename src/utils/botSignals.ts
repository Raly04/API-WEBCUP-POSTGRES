import type { Request } from "express";
import { logger } from "./logger";

// Mémoire des comportements suspects, par adresse IP. Un humain ne déclenche jamais ceci : il faut enchaîner
// plusieurs signaux (jeton absent ou rejoué, champ piège rempli, envois en rafale...) pour être bloqué.
// Local à chaque instance de l'API (comme le cache et la limitation de débit).

// BOT_PROTECTION : "on" (défaut) bloque ; "monitor" détecte, journalise et audite SANS bloquer (pour mesurer avant
// d'activer, ou diagnostiquer un faux positif) ; "off" désactive. Un formulaire sans jeton est refusé en mode "on" :
// tout client qui poste sur les formulaires protégés doit envoyer X-Form-Token (voir README, « Protection anti-robots »).
export type BotMode = "on" | "monitor" | "off";
export const BOT_MODE: BotMode = (() => {
  const raw = (process.env.BOT_PROTECTION || "on").toLowerCase();
  return raw === "monitor" || raw === "off" ? raw : "on";
})();

export type BotReason =
  | "missing_token" // aucun jeton : requête postée directement sur l'API, sans passer par le formulaire
  | "bad_token" // jeton falsifié ou destiné à un autre formulaire
  | "too_fast" // formulaire envoyé avant le délai humain minimal
  | "reused_token" // jeton déjà utilisé
  | "honeypot" // champ invisible rempli
  | "velocity" // trop d'envois de formulaires par minute
  | "login_failures" // trop d'échecs de connexion
  | "attack_probe"; // requête contenant une signature d'attaque (injection, traversée de répertoire, scanner...)

// Points ajoutés à l'adresse IP pour chaque signal. Blocage à BLOCK_THRESHOLD points dans la fenêtre.
// Deux familles :
//  - signaux NATURELS, qu'une vraie personne peut produire (double-clic qui rejoue un jeton, formulaire envoyé
//    un peu vite, onglet resté ouvert avant une mise à jour) : peu de points. Derrière une adresse partagée
//    (mairie, Wi-Fi public), ceux de dizaines d'habitants s'additionnent : ils ne doivent jamais suffire à bloquer.
//  - signaux INHUMAINS (jeton falsifié, champ piège rempli, rafale d'envois, bourrage d'identifiants) : beaucoup.
const POINTS: Record<BotReason, number> = {
  too_fast: 0.5,
  missing_token: 1,
  reused_token: 1,
  bad_token: 4,
  honeypot: 4,
  velocity: 100, // blocage immédiat
  login_failures: 100,
  attack_probe: 4, // jamais produit par un usage normal : deux sondes suffisent à bloquer
};
const HARD_REASONS = new Set<BotReason>(["bad_token", "honeypot", "velocity", "login_failures", "attack_probe"]);
export const isHardReason = (reason: BotReason) => HARD_REASONS.has(reason);

const WINDOW_MS = 10 * 60 * 1000;
const BLOCK_THRESHOLD = Number(process.env.BOT_BLOCK_THRESHOLD) || 8;
const BLOCK_MS = 15 * 60 * 1000;
// Envois de formulaires par minute et par IP. Large pour la plupart (plusieurs habitants peuvent partager une IP) ;
// plus strict pour l'inscription, que les fabriques de faux comptes visent en priorité.
const VELOCITY_DEFAULT = Number(process.env.BOT_VELOCITY_PER_MINUTE) || 30;
const VELOCITY_REGISTER = Number(process.env.BOT_VELOCITY_REGISTER_PER_MINUTE) || 10;
// Échecs de connexion par fenêtre et par IP, tous comptes confondus (bourrage d'identifiants). Large : des dizaines
// d'habitants qui oublient leur mot de passe derrière la même adresse ne doivent pas être pris pour un robot.
const LOGIN_FAILURES_MAX = Number(process.env.BOT_LOGIN_FAILURES) || 30;
const MAX_IPS = 50_000;

// Adresses jamais bloquées (bureaux, supervision, machines de test) : BOT_ALLOWLIST="203.0.113.5,10.0.0.7"
const ALLOWLIST = new Set(
  (process.env.BOT_ALLOWLIST || "")
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean)
);
export const isAllowlisted = (ip: string) => ALLOWLIST.has(ip);

interface IpState {
  points: number;
  windowStart: number;
  blockedUntil: number;
  // Blocage « dur » : un signal inhumain l'a causé. Un blocage « souple » (signaux naturels répétés) laisse
  // passer les formulaires en règle, pour ne pas punir les habitants qui partagent l'adresse d'un robot.
  hard: boolean;
  // Blocage causé par une sonde d'attaque : seul celui-là s'étend à TOUTE l'API (voir attackGuard). Un blocage dû à
  // un formulaire (rafale d'inscriptions...) ne touche que les formulaires.
  attack: boolean;
}
const states = new Map<string, IpState>();
const submissions = new Map<string, number[]>(); // horodatages des envois de la dernière minute
const loginFailures = new Map<string, number[]>();

// Compteurs depuis le démarrage, pour la supervision en direct
const counters = { byReason: {} as Record<string, number>, byForm: {} as Record<string, number>, blockedRequests: 0, blocksIssued: 0 };

setInterval(() => {
  const now = Date.now();
  for (const [ip, state] of states) if (state.blockedUntil <= now && state.windowStart + WINDOW_MS <= now) states.delete(ip);
  for (const map of [submissions, loginFailures]) {
    for (const [ip, times] of map) {
      const recent = times.filter((time) => time > now - WINDOW_MS);
      if (recent.length === 0) map.delete(ip);
      else map.set(ip, recent);
    }
  }
}, 60_000).unref();

// Secondes restantes de blocage pour cette IP (0 = pas bloquée) et nature du blocage
export function blockInfo(ip: string): { seconds: number; hard: boolean; attack: boolean } {
  const state = states.get(ip);
  const left = state ? state.blockedUntil - Date.now() : 0;
  return left > 0
    ? { seconds: Math.ceil(left / 1000), hard: state!.hard, attack: state!.attack }
    : { seconds: 0, hard: false, attack: false };
}

export interface SignalOutcome {
  // L'IP vient d'être bloquée par ce signal (à journaliser une fois)
  newlyBlocked: boolean;
  // Elle était déjà bloquée : inutile de réécrire une ligne d'audit pour chaque tentative d'un robot
  alreadyBlocked: boolean;
}

export function recordSignal(ip: string, form: string, reason: BotReason): SignalOutcome {
  counters.byReason[reason] = (counters.byReason[reason] ?? 0) + 1;
  counters.byForm[form] = (counters.byForm[form] ?? 0) + 1;

  const now = Date.now();
  if (states.size >= MAX_IPS) states.clear();
  let state = states.get(ip);
  if (!state || state.windowStart + WINDOW_MS <= now) {
    state = {
      points: 0,
      windowStart: now,
      blockedUntil: state?.blockedUntil ?? 0,
      hard: state?.hard ?? false,
      attack: state?.attack ?? false,
    };
    states.set(ip, state);
  }
  const alreadyBlocked = state.blockedUntil > now;
  state.points += POINTS[reason];
  let newlyBlocked = false;
  if (!alreadyBlocked && state.points >= BLOCK_THRESHOLD) {
    state.blockedUntil = now + BLOCK_MS;
    state.hard = isHardReason(reason);
    state.attack = reason === "attack_probe";
    counters.blocksIssued++;
    newlyBlocked = true;
  } else if (alreadyBlocked && isHardReason(reason)) {
    state.hard = true; // un blocage souple devient dur dès qu'un signal inhumain s'y ajoute
    if (reason === "attack_probe") state.attack = true;
  }
  return { newlyBlocked, alreadyBlocked };
}

// Derrière un proxy (hébergeur, nginx) req.ip est l'adresse du PROXY tant que TRUST_PROXY n'est pas réglé : tous les
// habitants auraient alors la même « adresse », et un blocage par adresse toucherait tout le site. Quand l'en-tête
// X-Forwarded-For prouve la présence d'un proxy alors que TRUST_PROXY est absent, on ne tient donc AUCUN compte par
// adresse (ni points, ni blocage). Un message l'indique une fois dans le journal.
const TRUST_PROXY_SET = Boolean(process.env.TRUST_PROXY);
let warnedUnreliableIp = false;

export function ipIsReliable(req: Request): boolean {
  if (TRUST_PROXY_SET || !req.headers["x-forwarded-for"]) return true;
  if (!warnedUnreliableIp) {
    warnedUnreliableIp = true;
    logBot(
      "Un proxy est présent (X-Forwarded-For) mais TRUST_PROXY n'est pas réglé : le blocage par adresse IP est désactivé " +
        "pour ne pas bloquer tous les habitants à la fois. Réglez TRUST_PROXY (ex. 1) pour l'activer.",
      true
    );
  }
  return false;
}

export function noteBlockedRequest() {
  counters.blockedRequests++;
}

function slide(map: Map<string, number[]>, ip: string, windowMs: number): number {
  const now = Date.now();
  const recent = (map.get(ip) ?? []).filter((time) => time > now - windowMs);
  recent.push(now);
  map.set(ip, recent);
  return recent.length;
}

// Compte un envoi de formulaire ; vrai si l'IP dépasse le débit qu'un humain peut produire sur ce formulaire
export function submissionTooFast(ip: string, form: string): boolean {
  if (submissions.size >= MAX_IPS) submissions.clear();
  return slide(submissions, `${ip}|${form}`, 60_000) > (form === "register" ? VELOCITY_REGISTER : VELOCITY_DEFAULT);
}

// Compte un échec de connexion ; vrai si l'IP essaie trop de comptes
export function loginFailuresTooMany(ip: string): boolean {
  if (loginFailures.size >= MAX_IPS) loginFailures.clear();
  return slide(loginFailures, ip, WINDOW_MS) > LOGIN_FAILURES_MAX;
}

export function liveStats() {
  const now = Date.now();
  let blockedNow = 0;
  for (const state of states.values()) if (state.blockedUntil > now) blockedNow++;
  return { ...counters, blockedIpsNow: blockedNow, trackedIps: states.size };
}

// Un seul message de journal par seconde au plus : sous attaque, le journal ne doit pas devenir le problème
let lastLog = 0;
export function logBot(message: string, force = false) {
  const now = Date.now();
  if (!force && now - lastLog < 1000) return;
  lastLog = now;
  logger.warn("BOT", message);
}
