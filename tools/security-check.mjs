// Vérification de la sécurité : rejoue de VRAIES attaques contre l'API (accès aux données d'autrui, élévation de
// privilèges, jetons falsifiés, injections SQL, faux fichiers, traversée de répertoire, scanners, CORS...).
//   ✅ = l'attaque échoue (bonne défense)      ❌ = l'attaque RÉUSSIT (faille à corriger)
//
//   1. Lancer l'API en local (jamais en production) avec :
//        BOT_PROTECTION=off TRUST_PROXY=1 PORT=5000 npm run dev
//      (BOT_PROTECTION=off : le test poste sans jeton de formulaire ; TRUST_PROXY=1 : il simule des adresses IP
//       différentes via X-Forwarded-For, une par attaque)
//   2. node tools/security-check.mjs 5000
//
// Crée des comptes « sec_*@example.com », des demandes, des messages et des fichiers de test, et SUPPRIME tout
// ensuite (tools/security-check-db.ts). Code de sortie 1 s'il reste au moins une faille.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const [port = "5000", apiDirArg] = process.argv.slice(2);
const apiDir = path.resolve(apiDirArg ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const BASE = `http://localhost:${port}`;
const U = `${BASE}/api`;
const J = { "content-type": "application/json" };
let pass = 0;
const failures = [];
const created = { uploads: [] };

function check(ok, title, detail = "") {
  console.log(`  ${ok ? "✅" : "❌"} ${title}${detail ? "  — " + detail : ""}`);
  if (ok) pass++; else failures.push(title);
}
const section = (t) => console.log(`\n── ${t}`);

async function call(method, url, { token, body, headers = {}, raw } = {}) {
  const res = await fetch(url.startsWith("http") ? url : U + url, {
    method,
    headers: { ...(raw ? {} : J), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}
// Requête avec chemin BRUT (fetch normalise les « .. » : on veut les envoyer tels quels)
function rawGet(rawPath) {
  return new Promise((resolve) => {
    const req = http.request({ host: "localhost", port, path: rawPath, method: "GET" }, (res) => {
      let data = ""; res.on("data", (c) => (data += c)); res.on("end", () => resolve({ status: res.statusCode, text: data, headers: res.headers }));
    });
    req.on("error", () => resolve({ status: 0, text: "", headers: {} })); req.end();
  });
}
function rawGetIp(rawPath, ip) {
  return new Promise((resolve) => {
    const req = http.request({ host: "localhost", port, path: rawPath, method: "GET", headers: { "x-forwarded-for": ip } }, (res) => {
      let data = ""; res.on("data", (c) => (data += c)); res.on("end", () => resolve({ status: res.statusCode, text: data, headers: res.headers }));
    });
    req.on("error", () => resolve({ status: 0, text: "", headers: {} })); req.end();
  });
}
const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");

function db(mode) {
  return execFileSync("npx", ["tsx", "tools/security-check-db.ts", ...mode.split(" ")], { cwd: apiDir, encoding: "utf8", shell: true });
}

let ipCounter = 20;
const nextIp = () => `198.51.100.${ipCounter++}`;
process.on("exit", () => { try { db("clean"); } catch { /* rien à nettoyer */ } });
const stamp = Date.now().toString(36);
async function register(label, extra = {}) {
  const r = await call("POST", "/auth/register", { body: { email: `sec_${label}_${stamp}@example.com`.toLowerCase(), password: "password123", firstName: label, lastName: "SEC", ...extra } });
  return { ...r, email: `sec_${label}_${stamp}@example.com`.toLowerCase() };
}

// ── Comptes : deux citoyens, un agent, un administrateur ──────────────────────────────
const A = await register("A"), B = await register("B"), AG = await register("agent"), AD = await register("admin");
db(`roles ${AG.email} ${AD.email}`); // // rôles posés en base AVANT le premier appel authentifié (cache des droits)
const tA = A.json.accessToken, tB = B.json.accessToken, tAG = AG.json.accessToken, tAD = AD.json.accessToken;
const idA = A.json.user.id;

// ── Données de A : une demande, un message, un rendez-vous ───────────────────────────
const reqA = (await call("POST", "/requests", { token: tA, body: { subject: "Ma demande privée", description: "Contenu confidentiel de A" } })).json;
const msgA = (await call("POST", "/contact-messages", { token: tA, body: { subject: "Message prive", message: "Texte confidentiel de A, 123 rue secrète" } })).json?.contactMessage;
const start = new Date(Date.now() + 3 * 86400_000).toISOString(), end = new Date(Date.now() + 3 * 86400_000 + 1800_000).toISOString();
const slot = (await call("POST", "/appointments", { token: tAG, body: { startAt: start, endAt: end } })).json;
const bookedA = slot?.id ? await call("POST", `/appointments/${slot.id}/book`, { token: tA, body: { subject: "RDV privé de A" } }) : null;
await call("PATCH", `/requests/${reqA.id}`, { token: tAG, body: { status: "in_progress", note: "pris en charge" } }); // génère une notification pour A
const notifsA = (await call("GET", "/notifications", { token: tA })).json;
const notifA = (notifsA?.notifications ?? notifsA ?? [])[0];

section("1. ACCÈS AUX DONNÉES D'AUTRUI (le citoyen B attaque les données du citoyen A)");
let r = await call("GET", `/requests/mine/${reqA.id}`, { token: tB });
check(r.status === 404, "B lit la demande de A via /requests/mine/:id", `${r.status} (404 attendu)`);
r = await call("GET", `/requests/${reqA.id}`, { token: tB });
check(r.status === 403, "B lit la demande de A via la vue agent", `${r.status} (403 attendu)`);
r = await call("PATCH", `/requests/${reqA.id}`, { token: tB, body: { status: "rejected", note: "pirate" } });
check(r.status === 403, "B modifie le statut de la demande de A", `${r.status} (403 attendu)`);
r = await call("GET", `/contact-messages/${msgA.id}`, { token: tB });
check(r.status === 404, "B lit le message privé de A", `${r.status} (404 attendu)`);
r = await call("PATCH", `/contact-messages/${msgA.id}/status`, { token: tB, body: { status: "processed" } });
check(r.status === 403, "B change le statut du message de A", `${r.status} (403 attendu)`);
if (slot?.id && (bookedA?.status === 200 || bookedA?.status === 201)) {
  r = await call("DELETE", `/appointments/mine/${slot.id}`, { token: tB });
  const still = (await call("GET", "/appointments/mine", { token: tA })).text.includes("RDV privé de A");
  check(r.status !== 204 && still, "B annule le rendez-vous de A", `${r.status}, rendez-vous de A toujours présent : ${still}`);
} else console.log(`  ⚠ test du rendez-vous ignoré (créneau ${slot?.id}, réservation : ${bookedA?.status} ${bookedA?.text?.slice(0, 140)})`);
if (notifA?.id) {
  r = await call("PATCH", `/notifications/${notifA.id}/read`, { token: tB });
  const after = (await call("GET", "/notifications", { token: tA })).json;
  const n = (after?.notifications ?? after ?? []).find((x) => x.id === notifA.id);
  check(r.status !== 200 && n && !n.readAt, "B marque la notification de A comme lue", `${r.status}, reste non lue pour A : ${n && !n.readAt}`);
}
r = await call("GET", `/users/${idA}`, { token: tB });
check(r.status === 403, "B lit la fiche complète de A (/users/:id)", `${r.status} (403 attendu)`);
r = await call("GET", "/users", { token: tB });
check(r.status === 403, "B liste tous les utilisateurs", `${r.status} (403 attendu)`);
r = await call("GET", `/citizen-accounts/${idA}`, { token: tB });
check(r.status === 403, "B lit le compte citoyen de A", `${r.status} (403 attendu)`);
r = await call("GET", "/citizen-accounts", { token: tB });
check(r.status === 403, "B liste les comptes citoyens", `${r.status} (403 attendu)`);

section("2. ÉLÉVATION DE PRIVILÈGES");
r = await call("POST", `/users/${B.json.user.id}/roles`, { token: tB, body: { role: "admin" } });
check(r.status === 403, "B s'attribue le rôle admin via l'API", `${r.status} (403 attendu)`);
r = await call("PATCH", "/auth/me", { token: tB, body: { firstName: "Z", roles: ["admin"], role: "admin", permissions: ["admin.users.manage"], isActive: false, id: 1, passwordHash: "x", emailVerified: true } });
const me = (await call("GET", "/auth/me", { token: tB })).json;
check(!me.roles.includes("admin") && me.isActive !== false && me.id === B.json.user.id, "B s'élève via des champs en trop dans PATCH /auth/me", `rôles : ${me.roles.join(",")}`);
r = await register("evil1", { role: "admin" });
check(r.status === 400, "Inscription avec role=admin", `${r.status} (400 attendu)`);
r = await register("evil2", { role: "agent" });
const evil2 = r.json?.user?.roles ?? [];
check(r.status === 201 && evil2.includes("agent"), "Inscription libre en tant qu'agent : possible (choix de produit), voir le scénario 11 pour ce qu'il peut faire", `${r.status}, rôles : ${evil2.join(",")}`);
r = await register("evil3", { isActive: false, id: 1, roles: ["admin"], permissions: ["admin.users.manage"] });
check(r.status === 201 && !(r.json.user.roles ?? []).includes("admin") && r.json.user.id !== 1, "Inscription avec champs en trop (roles, id, permissions)", `rôles : ${(r.json.user?.roles ?? []).join(",")}`);
for (const [name, tok] of [["citoyen", tB], ["agent", tAG]]) {
  for (const p of ["/roles", "/permissions", "/audit-logs", "/security/bots", "/users"]) {
    const x = await call("GET", p, { token: tok });
    if (x.status !== 403) check(false, `${name} accède à la route d'administration ${p}`, `${x.status}`);
  }
}
check(true, "citoyen et agent refusés (403) sur /roles /permissions /audit-logs /security/bots /users");

section("3. FALSIFICATION DE JETON (JWT)");
const goodSub = AD.json.user.id;
const none = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: String(goodSub), exp: Math.floor(Date.now() / 1000) + 3600 })}.`;
r = await call("GET", "/auth/me", { token: none });
check(r.status === 401, "Jeton sans signature (alg:none) au nom d'un admin", `${r.status} (401 attendu)`);
const sign = (secret, alg = "HS256") => { const h = b64({ alg, typ: "JWT" }), p = b64({ sub: String(goodSub), exp: Math.floor(Date.now() / 1000) + 3600 }); return `${h}.${p}.${crypto.createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url")}`; };
for (const guess of ["secret", "changeme", "jwt_secret", "password", ""]) {
  r = await call("GET", "/auth/me", { token: sign(guess) });
  if (r.status !== 401) check(false, `Jeton signé avec le secret deviné « ${guess} »`, `${r.status}`);
}
check(true, "Jetons signés avec des secrets courants (secret, changeme, jwt_secret...) refusés");
const pastExp = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: String(goodSub), exp: 1 })}.AAAA`;
r = await call("GET", "/auth/me", { token: pastExp });
check(r.status === 401, "Jeton expiré / signature invalide", `${r.status} (401 attendu)`);

section("4. INJECTIONS SQL");
const sqli = ["' OR '1'='1", "admin'--", "1; DROP TABLE users;--", "' UNION SELECT password_hash FROM users--", "\\' OR 1=1#"];
let leak = false, err500 = [];
for (const p of sqli) {
  const l = await call("POST", "/auth/login", { body: { email: p, password: p }, headers: { "x-forwarded-for": nextIp() } });
  if (l.status === 200 || l.status >= 500) err500.push(`login(${p}) -> ${l.status}`);
  const q = encodeURIComponent(p);
  for (const url of [`/users?q=${q}`, `/users?role=${q}`, `/announcements?q=${q}`, `/requests?status=${q}`, `/requests/mine/${q}`, `/contact-messages?q=${q}`, `/services/${q}`, `/audit-logs?action=${q}`]) {
    const x = await call("GET", url, { token: tAD, headers: { "x-forwarded-for": nextIp() } });
    if (x.status >= 500) err500.push(`${url} -> ${x.status}`);
    if (/password_hash|passwordHash|scrypt\$/.test(x.text)) leak = true;
  }
}
check(err500.length === 0, "Injections SQL dans connexion, recherches, filtres et identifiants (refusées à l'entrée ou sans effet)", err500.length ? err500.slice(0, 3).join(" ; ") : "aucune erreur 500, aucune connexion obtenue");
check(!leak, "Aucun hachage de mot de passe dans les réponses aux injections");
const still = (await call("GET", "/users?limit=1", { token: tAD })).json;
check(still && (still.users?.length ?? 0) >= 0 && (await call("GET", "/auth/me", { token: tA })).status === 200, "Les tables sont intactes après les tentatives (DROP TABLE sans effet)");

section("5. FUITE DE DONNÉES SENSIBLES DANS LES RÉPONSES");
const bodies = [
  A.text, (await call("POST", "/auth/login", { body: { email: A.email, password: "password123" } })).text,
  (await call("GET", "/auth/me", { token: tA })).text, (await call("GET", `/requests/${reqA.id}`, { token: tAG })).text,
  (await call("GET", `/users/${idA}`, { token: tAD })).text, (await call("GET", "/users", { token: tAD })).text,
  (await call("GET", "/contact-messages", { token: tAG })).text, (await call("GET", `/citizen-accounts/${idA}`, { token: tAD })).text,
];
const forbidden = /passwordHash|password_hash|tokenHash|token_hash|"password"|scrypt\$/;
check(bodies.every((t) => !forbidden.test(t)), "Ni mot de passe, ni hachage, ni hachage de jeton dans login, /me, /users, demandes, messages");

section("6. FICHIERS : DÉPÔT ET LECTURE");
const rawFiles = ["/.env", "/src/app.ts", "/package.json", "/uploads/../.env", "/uploads/%2e%2e/.env", "/uploads/..%2f.env", "/uploads/projects/../../.env", "/uploads/..\\.env", "/uploads/%00.env", "/api/../.env"];
let exposed = [];
for (const f of rawFiles) { const x = await rawGetIp(f, nextIp()); if (x.status === 200 && /JWT_ACCESS_SECRET|DB_PASSWORD|"name": "api"/.test(x.text)) exposed.push(f); }
check(exposed.length === 0, "Lecture de .env, du code source ou de package.json (traversée de répertoire)", exposed.length ? "EXPOSÉ : " + exposed.join(", ") : `${rawFiles.length} chemins tentés`);
const fd = (name, type, content) => { const f = new FormData(); f.append("image", new Blob([content], { type }), name); return f; };
const upload = async (name, type, content, tok = tAD) => {
  const x = await fetch(`${U}/uploads/project-image`, { method: "POST", headers: { authorization: `Bearer ${tok}` }, body: fd(name, type, content) });
  const t = await x.text(); let j = null; try { j = JSON.parse(t); } catch {}
  if (j?.url) created.uploads.push(j.url);
  return { status: x.status, json: j, text: t };
};
r = await upload("x.png", "image/png", Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), tB);
check(r.status === 403, "Un citoyen dépose un fichier", `${r.status} (403 attendu)`);
const html = "<html><body><script>fetch('/api/auth/me')</script></body></html>";
r = await upload("evil.png", "image/png", html);
check(r.status >= 400, "Dépôt d'une page HTML/JavaScript déguisée en image (type annoncé : image/png)", `${r.status} (refus attendu, ${r.status === 201 ? "ACCEPTÉ : " + r.json?.url : "refusé"})`);
r = await upload("evil.svg", "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
check(r.status >= 400, "Dépôt d'un SVG contenant du JavaScript", `${r.status} (refus attendu)`);
const real = await upload("ok.png", "image/png", Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.alloc(64)]));
check(real.status === 201, "Un vrai fichier PNG est accepté (usage normal)", `${real.status}`);
if (real.json?.url) {
  const f = await call("GET", BASE + real.json.url, { headers: { "x-test": "1" } });
  check(f.headers.get("x-content-type-options") === "nosniff", "Les fichiers servis portent X-Content-Type-Options: nosniff", `valeur : ${f.headers.get("x-content-type-options") ?? "ABSENT"}`);
}

section("7. EN-TÊTES ET FUITES D'INFORMATION");
const h = (await call("GET", "/health")).headers;
const want = { "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'", "cross-origin-resource-policy": "same-site", "permissions-policy": "" };
const missing = Object.keys(want).filter((k) => !h.get(k));
check(missing.length === 0, "En-têtes de sécurité HTTP présents", missing.length ? "absents : " + missing.join(", ") : "tous présents");
check(!h.get("x-powered-by"), "L'en-tête X-Powered-By (révèle « Express ») est retiré", h.get("x-powered-by") ? `présent : ${h.get("x-powered-by")}` : "");
const priv = await call("GET", "/auth/me", { token: tA });
check(/no-store/.test(priv.headers.get("cache-control") ?? ""), "Données personnelles non mises en cache (Cache-Control: no-store)", `valeur : ${priv.headers.get("cache-control") ?? "ABSENT"}`);
const bad = await call("POST", "/auth/login", { raw: true, body: "{not json", headers: J });
check(!/at .*\(.*\)|node_modules|\\src\\|\.ts:\d+/.test(bad.text) && bad.status === 400, "JSON malformé : erreur générique, sans trace de pile", `${bad.status} ${bad.text.slice(0, 70)}`);
const e500 = await call("GET", "/requests/mine/" + "9".repeat(400), { token: tA });
check(e500.status < 500 && !/\.ts:\d+|node_modules/.test(e500.text), "Identifiant démesuré : pas d'erreur serveur ni de fuite", `${e500.status}`);
const login = await call("POST", "/auth/login", { body: { email: A.email, password: "password123" } });
const cookie = login.headers.get("set-cookie") ?? "";
check(/httponly/i.test(cookie) && /samesite=lax|samesite=strict/i.test(cookie) && /path=\/api\/auth/i.test(cookie), "Cookie de session : HttpOnly, SameSite, chemin restreint", cookie.split(";").slice(1, 5).join(";").trim());

section("8. CORS (sites tiers)");
let c = await fetch(`${U}/auth/me`, { headers: { origin: "https://evil.example", authorization: `Bearer ${tA}` } });
check(!c.headers.get("access-control-allow-origin"), "Un site tiers (evil.example) ne reçoit pas d'autorisation CORS", `ACAO : ${c.headers.get("access-control-allow-origin") ?? "aucun"}`);
c = await fetch(`${U}/auth/me`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "GET" } });
check(!c.headers.get("access-control-allow-origin"), "Préflight d'un site tiers refusé");
c = await fetch(`${U}/auth/me`, { headers: { origin: "http://localhost:3000", authorization: `Bearer ${tA}` } });
check(c.headers.get("access-control-allow-origin") === "http://localhost:3000", "Le site légitime (localhost:3000) reste autorisé", c.headers.get("access-control-allow-origin") ?? "aucun");

section("9. SCANNERS ET SONDES");
const probes = ["/.git/config", "/wp-login.php", "/phpmyadmin/", "/admin.php", "/api/users?id=1%20UNION%20SELECT%201", "/api/announcements?q=<script>alert(1)</script>", "/api/announcements?q=../../etc/passwd"];
const probeCodes = [];
for (const pth of probes.slice(0, 2)) probeCodes.push((await rawGetIp(pth, "198.51.100.150")).status);
const sqlmap = await call("GET", "/announcements", { token: tA, headers: { "user-agent": "sqlmap/1.7", "x-forwarded-for": nextIp() } });
const attackQ = await call("GET", "/announcements?q=%27%20UNION%20SELECT%20password_hash%20FROM%20users--", { token: tA, headers: { "x-forwarded-for": nextIp() } });
check(attackQ.status === 400 || attackQ.status === 403, "Une requête contenant une signature d'attaque SQL est détectée et refusée", `${attackQ.status} (400/403 attendu)`);
check(sqlmap.status === 403 || sqlmap.status === 400, "Un outil d'attaque connu (User-Agent sqlmap) est refusé", `${sqlmap.status}`);

section("10. NOUVELLES PROTECTIONS");
const legit = ["l'été", "select", "union", "O'Brien", "100%", "eau potable", "rue de l'église 12", "nom --test", "a & b", "coupure d'eau secteur B"];
const flagged = [];
for (const q of legit) { const x = await call("GET", `/announcements?q=${encodeURIComponent(q)}`, { token: tA }); if (x.status !== 200) flagged.push(`${q} -> ${x.status}`); }
check(flagged.length === 0, "Des recherches normales (apostrophe, mots select, union, accents...) ne sont PAS prises pour des attaques", flagged.join(" ; ") || `${legit.length} recherches légitimes passent`);
r = await call("POST", "/auth/refresh", { headers: { origin: "https://evil.example" } });
check(r.status === 403 && r.json?.code === "origin_not_allowed", "Rafraîchissement de session depuis un site tiers refusé (Origin)", `${r.status}`);
r = await call("POST", "/auth/refresh", { headers: { origin: "http://localhost:3000" } });
check(r.status === 401, "Le site légitime atteint toujours le rafraîchissement (401 = pas de cookie, mais pas de blocage)", `${r.status}`);
c = await fetch(`${U}/auth/me`, { headers: { origin: "http://localhost:3000", authorization: `Bearer ${tA}` } });
check((c.headers.get("access-control-expose-headers") ?? "").includes("Retry-After"), "Retry-After lisible par le front (sinon il ne sait pas combien attendre)", c.headers.get("access-control-expose-headers") ?? "ABSENT");
c = await fetch(`${U}/auth/me`, { method: "OPTIONS", headers: { origin: "http://localhost:3000", "access-control-request-method": "POST", "access-control-request-headers": "x-form-token,content-type,authorization" } });
check(c.headers.get("access-control-max-age") === "600" && /x-form-token/i.test(c.headers.get("access-control-allow-headers") ?? ""), "Préflight : en-têtes du front autorisés, réponse gardée 10 min", `max-age ${c.headers.get("access-control-max-age")}`);
c = await fetch(`${U}/auth/me`, { method: "OPTIONS", headers: { origin: "http://localhost:3000", "access-control-request-method": "POST", "access-control-request-headers": "x-evil-header" } });
check(!/x-evil-header/i.test(c.headers.get("access-control-allow-headers") ?? ""), "Un en-tête inconnu n'est pas autorisé en CORS (liste fermée)");
const h2 = (await call("GET", "/health", { headers: { "x-forwarded-proto": "https" } })).headers;
check(!!h2.get("strict-transport-security") && !(await call("GET", "/health")).headers.get("strict-transport-security"), "HSTS envoyé uniquement sur une connexion HTTPS", h2.get("strict-transport-security") ?? "ABSENT");
const up = await upload("ok2.png", "image/png", Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.alloc(32)]));
if (up.json?.url) {
  const f = await fetch(BASE + up.json.url);
  check(/sandbox/.test(f.headers.get("content-security-policy") ?? "") && f.headers.get("cross-origin-resource-policy") === "cross-origin" && f.headers.get("content-type") === "image/png", "Image servie : sandbox + nosniff + affichable sur le site du front", `${f.headers.get("content-type")} | CSP ${f.headers.get("content-security-policy")}`);
}
const gifOk = await upload("g.gif", "image/gif", Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(32)]));
const jpgOk = await upload("j.jpg", "image/jpeg", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]));
const webpOk = await upload("w.webp", "image/webp", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(16)]));
check(gifOk.status === 201 && jpgOk.status === 201 && webpOk.status === 201, "GIF, JPEG et WebP authentiques acceptés (usage normal)", `${gifOk.status}/${jpgOk.status}/${webpOk.status}`);
const lie = await upload("x.jpg", "image/jpeg", Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(32)]));
check(lie.status === 400, "Un PNG annoncé comme JPEG est refusé (type annoncé différent du contenu réel)", `${lie.status}`);

await call("POST", "/auth/login", { body: { email: A.email, password: "password123" }, headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36", "x-forwarded-for": "203.0.113.77" } });
await call("POST", "/auth/login", { body: { email: A.email, password: "mauvais-mot-de-passe" }, headers: { "x-forwarded-for": "198.51.100.77" } });
const sec = (await call("GET", "/auth/me/security", { token: tA })).json;
check(Array.isArray(sec?.sessions) && sec.sessions.length >= 2 && sec.sessions.every((x) => x.id && x.device && "current" in x), "L'utilisateur voit ses sessions ouvertes (appareil, dates)", `${sec?.sessions?.length} sessions : ${sec?.sessions?.map((x) => x.device).join(" | ")}`);
check(sec.events.some((e) => e.action === "login.failed") && sec.events.some((e) => e.action === "login"), "Il voit les événements de son compte, dont l'ÉCHEC de connexion sur son compte", sec.events.slice(0, 4).map((e) => e.action).join(", "));
check(sec.sessions.every((x) => !x.ip || /\.x$|localhost|::x$/.test(x.ip)) && sec.events.every((e) => !e.ip || /\.x$|localhost|::x$/.test(e.ip)), "Les adresses IP sont masquées (dernier octet)", sec.events.map((e) => e.ip).filter(Boolean).slice(0, 3).join(", "));
const sessB = (await call("GET", "/auth/me/security", { token: tB })).json.sessions[0];
r = await call("DELETE", `/auth/me/sessions/${sessB.id}`, { token: tA });
const stillB = (await call("GET", "/auth/me/security", { token: tB })).json.sessions.some((x) => x.id === sessB.id);
check(r.status === 404 && stillB, "A ne peut pas fermer la session de B (ni savoir qu'elle existe)", `${r.status}, session de B intacte : ${stillB}`);
const old = sec.sessions.find((x) => !x.current) ?? sec.sessions[0];
r = await call("DELETE", `/auth/me/sessions/${old.id}`, { token: tA });
const gone = !(await call("GET", "/auth/me/security", { token: tA })).json.sessions.some((x) => x.id === old.id);
check(r.status === 204 && gone, "A ferme une de ses propres sessions", `${r.status}, disparue : ${gone}`);
const trail = (await call("GET", `/audit-logs?entityType=users&entityId=${idA}&limit=50`, { token: tAD })).json;
check(trail?.logs?.length > 0 && trail.logs.every((l) => l.entityType === "users" && l.entityId === idA), "L'administrateur retrouve tout ce qui a touché le compte de A (qui, quand, quoi)", `${trail?.logs?.length} lignes`);

const SIP = "198.51.100.99", scanner = [];
for (const pth of ["/.env", "/wp-login.php", "/api/announcements?q=%27%20UNION%20SELECT%201--", "/phpmyadmin/", "/.git/config"]) scanner.push((await rawGetIp(pth, SIP)).status);
const afterLegit = await rawGetIp("/api/health", SIP);
const otherIp = await rawGetIp("/api/health", "198.51.100.98");
check(scanner[0] === 400 && scanner.includes(429), "Un scanner est refusé puis BLOQUÉ après quelques sondes", `réponses : ${scanner.join(", ")}`);
check(afterLegit.status === 429 && otherIp.status === 200, "L'adresse bloquée n'a plus accès à rien ; les autres visiteurs ne sont pas touchés", `adresse bloquée -> ${afterLegit.status}, autre adresse -> ${otherIp.status}`);

section("11. AGENT INSCRIT LIBREMENT (non validé) : les données personnelles restent protégées");
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
await call("PATCH", "/auth/me", { token: tA, body: { phone: "+2250102030405", address: "12 rue des Dômes" } });
const self = await register("selfagent", { role: "agent" });
const tSA = self.json.accessToken, idSA = self.json.user.id;
check((self.json.user.roles ?? []).includes("agent"), "L'inscription libre en agent fonctionne (accès aux écrans agent)", `rôles : ${(self.json.user.roles ?? []).join(",")}`);
const list = (await call("GET", "/citizen-accounts?limit=20", { token: tSA })).json;
const withPhone = (list?.users ?? []).filter((u) => u.phone || u.address);
check((list?.users?.length ?? 0) > 0 && withPhone.length === 0 && list.users.every((u) => /^.\*\*\*@/.test(u.email)), "Liste des comptes citoyens : e-mails partiels, AUCUN téléphone ni adresse", `${list?.users?.length} comptes, ex. ${list?.users?.[0]?.email}`);
const detail = (await call("GET", `/citizen-accounts/${idA}`, { token: tSA })).json;
check(detail && detail.phone === null && detail.address === null && /^.\*\*\*@/.test(detail.email) && detail.firstName === "A", "Fiche d'un citoyen : nom visible, coordonnées masquées", `${detail?.email} / ${detail?.phone} / ${detail?.address}`);
r = await call("PATCH", `/citizen-accounts/${idA}`, { token: tSA, body: { phone: "0000000000", email: "pirate@example.com" } });
check(r.status === 403 && r.json?.code === "agent_not_validated", "Modifier les données personnelles d'un citoyen est refusé", `${r.status} ${r.json?.code ?? ""}`);
r = await call("PATCH", `/citizen-accounts/${idA}/status`, { token: tSA, body: { isActive: false } });
check(r.status === 403 && r.json?.code === "agent_not_validated", "Désactiver le compte d'un citoyen est refusé", `${r.status}`);
const meA = (await call("GET", "/auth/me", { token: tA })).json;
check(meA && meA.phone === "+2250102030405" && meA.email === A.email, "Le compte de A est resté intact (téléphone, e-mail, actif)");
const inbox = (await call("GET", "/contact-messages", { token: tSA })).json;
check((inbox?.messages?.length ?? 0) > 0 && inbox.messages.every((m) => !m.sender || /^.\*\*\*@/.test(m.sender.email)), "Boîte de messages : e-mail de l'expéditeur partiel", inbox?.messages?.[0]?.sender?.email);
const pend = (await call("GET", "/users/pending-agents", { token: tAD })).json;
check(pend?.users?.some((u) => u.id === idSA), "L'administrateur voit l'agent dans la liste « en attente de validation »", `${pend?.users?.length} en attente`);
r = await call("GET", "/users/pending-agents", { token: tSA });
check(r.status === 403, "Un agent ne peut pas lire la liste de validation ni se valider lui-même", `${r.status}`);
r = await call("POST", `/users/${idSA}/validate-agent`, { token: tSA });
check(r.status === 403, "L'agent tente de se valider lui-même", `${r.status} (403 attendu)`);
let limited = 0;
for (let i = 0; i < 40; i++) { const x = await call("GET", `/requests/${reqA.id}`, { token: tSA }); if (x.status === 429) limited++; }
check(limited > 0, "Aspiration de dossiers : consultation plafonnée (30 par minute pour un agent non validé)", `${limited} refus (429) sur 40 consultations rapides`);
await sleep(1600);
const secA = (await call("GET", "/auth/me/security", { token: tA })).json;
const seen = (secA.dataAccess ?? []).find((d) => d.role === "agent" && d.resource === "request");
check(!!seen, "Le citoyen A VOIT que ce membre du personnel a consulté sa demande (qui, quand)", seen ? `${seen.by} (${seen.role}), ${seen.resource}, ${seen.at}` : "aucune trace");
check((secA.dataAccess ?? []).every((d) => d.by && !("email" in d) && !("ip" in d)), "Cette trace ne révèle ni e-mail ni adresse IP du membre du personnel");
const trailB = (await call("GET", "/auth/me/security", { token: tB })).json;
check(!(trailB.dataAccess ?? []).some((d) => d.at === seen?.at), "B ne voit pas les consultations des données de A");
r = await call("POST", `/users/${idSA}/validate-agent`, { token: tAD });
check(r.status === 200 && r.json?.validated === true, "L'administrateur valide l'agent", `${r.status} ${JSON.stringify(r.json)}`);
const after = (await call("GET", `/citizen-accounts/${idA}`, { token: tSA })).json;
check(after?.phone === "+2250102030405" && after?.email === A.email, "Après validation : coordonnées complètes visibles pour cet agent", `${after?.email} / ${after?.phone}`);
r = await call("PATCH", `/citizen-accounts/${idA}`, { token: tSA, body: { address: "12 rue des Dômes" } });
check(r.status === 200, "Après validation : il peut modifier le compte d'un citoyen (travail normal)", `${r.status}`);
r = await call("GET", "/users", { token: tSA });
check(r.status === 403, "Même validé, un agent n'a pas accès à la liste complète des utilisateurs (administration)", `${r.status}`);

console.log(`\n══ BILAN : ${pass} défenses efficaces, ${failures.length} faille(s)${failures.length ? " :" : ""}`);
failures.forEach((f) => console.log("   ❌ " + f));
fs.writeFileSync(path.join(apiDir, "_sec_uploads.json"), JSON.stringify(created.uploads));
db("clean");
process.exit(failures.length ? 1 : 0);
