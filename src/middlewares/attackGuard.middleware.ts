import { NextFunction, Request, Response } from "express";
import { audit } from "../utils/audit";
import {
  blockInfo,
  ipIsReliable,
  isAllowlisted,
  logBot,
  noteBlockedRequest,
  recordSignal,
} from "../utils/botSignals";

// ATTACK_GUARD : "on" (défaut) refuse et bloque ; "monitor" détecte, journalise et audite SANS refuser ; "off" désactive.
// Indépendant de BOT_PROTECTION (qui ne concerne que les formulaires).
const rawMode = (process.env.ATTACK_GUARD || "on").toLowerCase();
const MODE: "on" | "monitor" | "off" = rawMode === "off" || rawMode === "monitor" ? rawMode : "on";

// Détecte les sondes d'attaque les plus courantes AVANT qu'elles n'atteignent le code de l'application :
// injections SQL, scripts dans l'adresse, traversée de répertoire, recherche de fichiers sensibles (.env, .git,
// phpMyAdmin...), outils d'attaque connus. L'application reste protégée par ailleurs (requêtes paramétrées, droits
// vérifiés à chaque appel) : ceci n'est pas la seule défense, c'est ce qui rend l'attaque VISIBLE et la coupe vite.
//
// Seuls l'adresse (chemin + paramètres) et l'identité du client sont examinés, JAMAIS le contenu d'un formulaire :
// un habitant peut très bien écrire « select » ou une balise dans un message sans être un pirate.
// Chaque détection compte pour l'adresse IP (4 points, blocage à 8) et s'écrit dans le journal d'audit (`bot.attack_probe`).

const PATTERNS: { kind: string; test: RegExp }[] = [
  // Injection SQL : formes qu'un utilisateur ne tape pas par hasard
  { kind: "sqli", test: /\bunion\b[\s\S]{0,60}\bselect\b/i },
  { kind: "sqli", test: /\bselect\b[\s\S]{0,80}\bfrom\b[\s\S]{0,80}\b(information_schema|mysql\.|sqlite_master|pg_catalog|users|password)/i },
  { kind: "sqli", test: /['"`]\s*(or|and)\s+['"`]?\w*['"`]?\s*(=|like)\s*['"`]?\w/i },
  { kind: "sqli", test: /\b(or|and)\s+['"]?\d+['"]?\s*=\s*['"]?\d+/i },
  { kind: "sqli", test: /['"`]\s*(--|#|\/\*)/ },
  { kind: "sqli", test: /;\s*(drop|delete|insert|update|alter|truncate|exec)\b/i },
  { kind: "sqli", test: /\b(sleep|benchmark|load_file|pg_sleep|extractvalue|updatexml)\s*\(/i },
  { kind: "sqli", test: /\binto\s+(out|dump)file\b|\bwaitfor\s+delay\b|\bxp_cmdshell\b|@@version\b/i },
  // Script injecté dans l'adresse
  { kind: "xss", test: /<\s*\/?\s*(script|iframe|object|embed|svg|img)\b/i },
  { kind: "xss", test: /\bjavascript\s*:|\bvbscript\s*:|\bdata\s*:\s*text\/html/i },
  { kind: "xss", test: /\bon(error|load|mouseover|focus|click|toggle)\s*=/i },
  // Traversée de répertoire et accès aux fichiers du serveur
  { kind: "traversal", test: /(\.\.[\\/]|[\\/]\.\.(?:[\\/]|$)|%2e%2e|%252e|\.\.%2f|\.\.%5c)/i },
  { kind: "traversal", test: /\0|%00/ },
  { kind: "traversal", test: /\/etc\/(passwd|shadow|hosts)|[a-z]:\\windows|boot\.ini|\/proc\/self/i },
  // Injection dans les journaux / exécution distante (Log4Shell et assimilés)
  { kind: "rce", test: /\$\{\s*(jndi|env|sys|java|ctx)\s*:/i },
  { kind: "rce", test: /\b(cmd|powershell|bash|sh)\s+(-c|\/c)\b|\|\s*(cat|ls|id|whoami|nc|curl|wget)\b/i },
];

// Fichiers et dossiers qu'un scanner cherche et qu'aucun usage normal de l'API ne demande
const SCANNER_PATH =
  /^\/(\.(env|git|svn|hg|ds_store|htaccess|htpasswd|aws|ssh|npmrc|docker)|wp-(admin|login|content|includes|json|config)|xmlrpc\.php|phpmyadmin|pma|myadmin|admin(er)?\.php|cgi-bin|vendor\/|actuator|server-(status|info)|(package(-lock)?|composer|tsconfig)\.(json|lock)|docker-compose|dockerfile|id_rsa|backup|dump\.sql|database\.sql|src\/|node_modules\/)/i;

// Outils d'attaque et de scan automatisés, qui s'annoncent dans leur User-Agent
const SCANNER_AGENT =
  /(sqlmap|nikto|nmap|masscan|acunetix|nessus|openvas|wpscan|dirbuster|dirb\b|gobuster|ffuf|feroxbuster|havij|zgrab|nuclei|burp|hydra|fimap|w3af|arachni|skipfish|netsparker|metasploit|commix|jaeles)/i;

function decode(value: string): string {
  let out = value;
  // Deux passes : %252e (« %2e » encodé une seconde fois) est une astuce courante pour passer les filtres
  for (let i = 0; i < 2; i++) {
    try {
      out = decodeURIComponent(out);
    } catch {
      break;
    }
  }
  return out;
}

export function detectAttack(req: Request): string | null {
  const agent = req.headers["user-agent"];
  if (typeof agent === "string" && SCANNER_AGENT.test(agent)) return "scanner_agent";

  const [rawPath, ...rest] = req.originalUrl.split("?");
  const path = decode(rawPath);
  if (SCANNER_PATH.test(path)) return "scanner_path";

  // Chemin et paramètres, bruts ET décodés (l'attaquant encode pour passer inaperçu)
  const haystacks = [rawPath, path, rest.join("?"), decode(rest.join("?"))];
  for (const text of haystacks) {
    if (!text) continue;
    for (const { kind, test } of PATTERNS) if (test.test(text)) return kind;
  }
  return null;
}

export function attackGuard(req: Request, res: Response, next: NextFunction) {
  if (MODE === "off" || req.method === "OPTIONS") return next();
  const ip = req.ip ?? "inconnu";
  if (isAllowlisted(ip)) return next();
  const reliable = ipIsReliable(req);

  // Adresse déjà bloquée pour une sonde d'attaque : plus rien ne passe, ni lecture ni formulaire
  if (reliable && MODE === "on") {
    const block = blockInfo(ip);
    if (block.seconds > 0 && block.attack) {
      noteBlockedRequest();
      res.locals.skipAudit = true; // comptée en mémoire, jamais écrite en base : un scanner ne remplit pas le journal
      res.set("Retry-After", String(block.seconds));
      return res.status(429).json({ code: "bot_blocked", message: "Accès temporairement bloqué.", retryAfterSeconds: block.seconds });
    }
  }

  const kind = detectAttack(req);
  if (!kind) return next();

  if (reliable) {
    const outcome = recordSignal(ip, "probe", "attack_probe");
    if (!outcome.alreadyBlocked) {
      void audit(req, "bot.attack_probe", { entityType: kind });
      if (outcome.newlyBlocked) void audit(req, "bot.blocked", { entityType: kind });
    }
    logBot(
      outcome.newlyBlocked
        ? `IP bloquée ${ip} (sonde d'attaque « ${kind} »)`
        : `Sonde d'attaque « ${kind} » depuis ${ip} : ${req.method} ${req.originalUrl.split("?")[0]}`,
      outcome.newlyBlocked
    );
  }
  if (MODE === "monitor") return next();
  res.locals.skipAudit = true; // déjà tracée ci-dessus avec son type d'attaque : pas de seconde ligne générique
  return res.status(kind === "scanner_agent" ? 403 : 400).json({ code: "request_rejected", message: "Requête refusée." });
}
