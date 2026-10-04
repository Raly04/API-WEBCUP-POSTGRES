// Vérification des signalements (urgences, incidents) de bout en bout, avec la protection anti-robots ACTIVE.
//   1. Lancer l'API en local (jamais en production) : PORT=5000 npm run dev
//   2. node tools/signalement-check.mjs 5000
// Le test du temps réel utilise socket.io-client du front (../client/node_modules).
// Crée des comptes « sig_*@example.com » et des signalements, et SUPPRIME tout ensuite. Code de sortie 1 en cas d'échec.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const [port = "5000", apiArg, clientArg] = process.argv.slice(2);
const apiDir = path.resolve(apiArg ?? path.join(here, ".."));
const clientDir = path.resolve(clientArg ?? path.join(apiDir, "..", "client"));
const U = `http://localhost:${port}/api`;
const J = { "content-type": "application/json" };
let pass = 0; const fails = [];
const check = (ok, t, d = "") => { console.log(`  ${ok ? "✅" : "❌"} ${t}${d ? "  — " + d : ""}`); ok ? pass++ : fails.push(t); };
const section = (t) => console.log(`\n── ${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = (args) => execFileSync("npx", ["tsx", "tools/signalement-check-db.ts", ...args], { cwd: apiDir, encoding: "utf8", shell: true });
process.on("exit", () => { try { db(["clean"]); } catch {} });

async function call(method, url, { token, body, headers = {} } = {}) {
  const res = await fetch(U + url, { method, headers: { ...J, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
// Inscription par le vrai parcours du formulaire (jeton anti-robots + délai), la protection étant ACTIVE
const stamp = Date.now().toString(36);
async function register(label, role) {
  const t = (await call("GET", "/forms/token?form=register")).json;
  await sleep(t.minDelayMs + 100);
  const r = await call("POST", "/auth/register", { body: { email: `sig_${label}_${stamp}@example.com`, password: "password123", firstName: label, lastName: "Sig", ...(role ? { role } : {}) }, headers: { "x-form-token": t.token } });
  if (r.status !== 201) throw new Error(`inscription ${label} : ${r.status} ${r.text}`);
  return { token: r.json.accessToken, id: r.json.user.id, email: `sig_${label}_${stamp}@example.com` };
}

const [A, B, AD, AG, SA] = await Promise.all([register("Awa"), register("Kofi"), register("Admin"), register("Marie"), register("Libre", "agent")]);
db(["roles", AD.email, AG.email]);

section("1. DÉCLARANT : une urgence ne se traite pas comme une demande ordinaire");
const types = (await call("GET", "/signalements/types", { token: A.token })).json;
check(types?.length === 9 && types.find((t) => t.code === "medical")?.defaultPriority === "urgent" && types.find((t) => t.code === "medical")?.emergency, "9 types proposés ; « médical » est urgent d'office", types?.map((t) => `${t.code}:${t.defaultPriority}`).join(" "));
let r = await call("POST", "/signalements", { token: A.token, body: { type: "medical", location: "Dôme 3, secteur B, place centrale", description: "Personne âgée inconsciente", contactPhone: "+225 01 02 03 04", priority: "low" } });
const med = r.json;
check(r.status === 201 && med.priority === "urgent" && med.urgent === true, "Urgence médicale envoyée SANS jeton ni délai, alors que l'anti-robots est actif", `${r.status}, priorité ${med?.priority}`);
check(med.priority === "urgent", "Le déclarant ne peut PAS baisser la priorité (« low » demandé, « urgent » appliqué)");
check(med.title === "Urgence médicale" && med.acknowledgeTargetMinutes === 5 && /secours/.test(med.guidance), "Titre automatique, délai de prise en charge visé (5 min) et conseil d'appeler les secours", `${med.title} / ${med.acknowledgeTargetMinutes} min`);
r = await call("POST", "/signalements", { token: A.token, body: { type: "medical", location: "Dôme 3, secteur B, place centrale" } });
check(r.status === 200 && r.json.duplicate === true && r.json.id === med.id, "Double envoi (double-clic) : le même signalement est rendu, pas une seconde alerte", `${r.status}, id ${r.json?.id}`);
const flood = (await call("POST", "/signalements", { token: A.token, body: { type: "flood", location: "Rue des Serres", lifeThreatening: true } })).json;
check(flood.priority === "urgent", "« Une personne est en danger » élève une inondation (important) en urgence", flood.priority);
const panne = (await call("POST", "/signalements", { token: A.token, body: { type: "breakdown", location: "Ascenseur tour 2", contactPhone: "0601020304" } })).json;
const autre = (await call("POST", "/signalements", { token: B.token, body: { type: "other", location: "Parc nord", title: "Banc cassé" } })).json;
const high = (await call("POST", "/signalements", { token: B.token, body: { type: "accident", location: "Carrefour des Dômes" } })).json;
check(panne.priority === "medium" && autre.priority === "low" && high.priority === "high", "Priorité selon le type : panne=moyenne, autre=basse, accident=haute");
for (const [body, what] of [[{ type: "volcan", location: "x y" }, "type inconnu"], [{ type: "fire" }, "lieu manquant"], [{ type: "fire", location: "Ici", contactPhone: "abc" }, "téléphone invalide"]]) {
  r = await call("POST", "/signalements", { token: A.token, body });
  check(r.status === 400, `Refus clair : ${what}`, `${r.status} ${r.json?.message ?? ""}`);
}
check((await call("POST", "/signalements", { body: { type: "fire", location: "Ici" } })).status === 401, "Sans compte : 401");

section("2. DONNÉES DU DÉCLARANT PROTÉGÉES");
check((await call("GET", `/signalements/mine/${med.id}`, { token: B.token })).status === 404, "B ne voit pas l'urgence médicale de A (404)");
check((await call("POST", `/signalements/mine/${med.id}/cancel`, { token: B.token })).status === 404, "B ne peut pas annuler l'alerte de A");
check((await call("GET", "/signalements", { token: B.token })).status === 403, "Un citoyen n'accède pas à la file du personnel (403)");
const mineA = (await call("GET", "/signalements/mine", { token: A.token })).json;
check(mineA.total === 3 && mineA.signalements.every((s) => !("reporter" in s) && !("overdue" in s)), "A voit ses 3 signalements, sans champs internes", `${mineA.total}`);

section("3. PERSONNEL : retrouver tout de suite ce qui demande de l'attention");
db(["backdate", String(panne.id), "300"]); // panne déposée il y a 5 h : délai de 4 h dépassé
const list = (await call("GET", "/signalements", { token: AG.token })).json;
const order = list.signalements.map((s) => `${s.type}:${s.priority}${s.overdue ? ":RETARD" : ""}`);
const idx = (id) => list.signalements.findIndex((s) => s.id === id);
check(idx(med.id) < idx(panne.id) && idx(flood.id) < idx(panne.id) && idx(panne.id) < idx(high.id) && idx(high.id) < idx(autre.id), "Tri par attention : urgences non prises en compte, puis EN RETARD, puis importantes, puis le reste", order.join(" > "));
check(list.signalements.find((s) => s.id === panne.id)?.overdue === true && list.signalements.find((s) => s.id === panne.id)?.ageMinutes >= 300, "La panne en attente depuis 5 h est marquée « en retard »");
const sum = (await call("GET", "/signalements/summary", { token: AG.token })).json;
check(sum.urgentOpen >= 2 && sum.unacknowledged >= 5 && sum.overdue >= 1 && sum.oldestUnacknowledgedMinutes >= 300, "Compteurs : urgences ouvertes, non pris en compte, en retard, plus ancienne attente", JSON.stringify({ open: sum.open, urgentOpen: sum.urgentOpen, unacknowledged: sum.unacknowledged, overdue: sum.overdue, oldest: sum.oldestUnacknowledgedMinutes }));
const urgOnly = (await call("GET", "/signalements?priority=urgent", { token: AG.token })).json;
const overdueOnly = (await call("GET", "/signalements?overdue=true", { token: AG.token })).json;
const medicalOnly = (await call("GET", "/signalements?type=medical", { token: AG.token })).json;
check(urgOnly.signalements.every((s) => s.priority === "urgent") && overdueOnly.signalements.every((s) => s.overdue) && medicalOnly.signalements.every((s) => s.type === "medical"), "Filtres : urgences seules, en retard seules, par type");
const searchHealth = (await call("GET", "/signalements?q=inconsciente", { token: AG.token })).json;
check(searchHealth.total === 0, "La description (données de santé) n'est pas interrogeable par la recherche");

section("4. ALERTE TEMPS RÉEL réservée au personnel");
const require = createRequire(path.join(clientDir, "package.json"));
const { io } = require("socket.io-client");
const connect = (token) => new Promise((resolve) => {
  const s = io(`http://localhost:${port}/staff`, { auth: token ? { token } : {}, transports: ["websocket"], reconnection: false, timeout: 4000 });
  s.on("connect", () => resolve({ s, ok: true })); s.on("connect_error", (e) => resolve({ s, ok: false, err: e.message }));
});
const staffSock = await connect(AG.token);
const citizenSock = await connect(A.token);
const anon = await connect(null);
check(staffSock.ok && !citizenSock.ok && !anon.ok, "Connexion : agent accepté, citoyen et anonyme refusés", `agent ${staffSock.ok}, citoyen ${citizenSock.err}, anonyme ${anon.err}`);
const received = new Promise((resolve) => { staffSock.s.on("signalement:new", resolve); setTimeout(() => resolve(null), 4000); });
const fire = (await call("POST", "/signalements", { token: B.token, body: { type: "fire", location: "Entrepôt 7", description: "Fumée noire, personnes coincées", contactPhone: "0700000000" } })).json;
const evt = await received;
check(evt?.id === fire.id && evt.priority === "urgent", "Un incendie signalé apparaît IMMÉDIATEMENT chez l'agent connecté", evt ? `${evt.type} ${evt.priority} ${evt.location}` : "rien reçu");
check(evt && !("description" in evt) && !("contactPhone" in evt) && !("reporter" in evt), "L'alerte temps réel ne contient ni description, ni téléphone, ni identité");
[staffSock, citizenSock, anon].forEach((x) => x.s.close());

section("5. PRISE EN CHARGE ET SUIVI");
r = await call("POST", `/signalements/${med.id}/acknowledge`, { token: AG.token, body: { note: "Équipe médicale en route" } });
check(r.status === 200 && r.json.status === "acknowledged" && r.json.assignedTo === AG.id && r.json.acknowledgedAt, "« Je m'en occupe » en un geste : pris en compte et assigné à l'agent", `${r.status} ${r.json?.status}`);
check((await call("POST", `/signalements/${med.id}/acknowledge`, { token: AG.token })).status === 409, "Deux agents ne prennent pas la même alerte (409 au second)");
const seenByA = (await call("GET", `/signalements/mine/${med.id}`, { token: A.token })).json;
check(seenByA.acknowledged && seenByA.handledBy === "Marie S." && seenByA.timeline.some((t) => t.status === "acknowledged") && !JSON.stringify(seenByA).includes("Équipe médicale en route"), "Le déclarant voit « pris en charge par Marie S. », sans les notes internes", `${seenByA.handledBy}, ${seenByA.timeline.map((t) => t.status).join(" > ")}`);
r = await call("PATCH", `/signalements/${med.id}`, { token: AG.token, body: { status: "cancelled" } });
check(r.status === 400, "Annuler une alerte exige un motif (trace des fausses alertes)", `${r.status}`);
r = await call("PATCH", `/signalements/${med.id}`, { token: AG.token, body: { assignedTo: B.id } });
check(r.status === 400, "Impossible d'assigner un signalement à un citoyen", `${r.status}`);
r = await call("PATCH", `/signalements/${med.id}`, { token: AG.token, body: { status: "in_progress", note: "Sur place" } });
r = await call("PATCH", `/signalements/${med.id}`, { token: AG.token, body: { status: "resolved", note: "Personne prise en charge par l'hôpital" } });
check(r.status === 200 && r.json.status === "resolved" && r.json.resolvedAt && r.json.history.length === 4, "Résolu : date de résolution et historique complet (créé > pris en compte > en cours > résolu)", r.json?.history?.map((h) => h.action).join(" > "));
const autoA = (await call("POST", "/signalements", { token: A.token, body: { type: "other", location: "Lampadaire rue 9" } })).json;
check((await call("POST", `/signalements/mine/${autoA.id}/cancel`, { token: A.token })).json?.status === "cancelled", "Le déclarant annule une alerte envoyée par erreur");
check((await call("POST", `/signalements/mine/${med.id}/cancel`, { token: A.token })).status === 409, "…mais pas une alerte déjà traitée (409)");

section("6. AGENT NON VALIDÉ (inscription libre) ET TRACE D'ACCÈS");
const viaSA = (await call("GET", "/signalements?status=all", { token: SA.token })).json;
const saPanne = viaSA.signalements.find((s) => s.id === panne.id), saFire = viaSA.signalements.find((s) => s.id === fire.id);
check(saPanne && saPanne.contactPhone === null && saFire && saFire.contactPhone === "0700000000", "Agent non validé : téléphone masqué pour une panne, VISIBLE pour une urgence (joindre une personne en détresse prime)", `panne ${saPanne?.contactPhone} / incendie ${saFire?.contactPhone}`);
check((await call("POST", `/signalements/${fire.id}/acknowledge`, { token: SA.token })).status === 200, "Il peut prendre en charge une urgence (le travail d'urgence n'est jamais bloqué)");
await call("GET", `/signalements/${high.id}`, { token: AG.token });
await sleep(1600);
const secB = (await call("GET", "/auth/me/security", { token: B.token })).json;
check((secB.dataAccess ?? []).some((d) => d.resource === "report"), "Le déclarant voit qu'un agent a consulté son signalement", JSON.stringify((secB.dataAccess ?? []).find((d) => d.resource === "report")));

section("7. ABUS");
let limited = 0;
for (let i = 0; i < 22; i++) { const x = await call("POST", "/signalements", { token: B.token, body: { type: "other", location: `Spam ${i}` } }); if (x.status === 429) limited++; }
check(limited > 0, "Un compte qui inonde de signalements est plafonné (20 par 10 min), avec un message invitant à appeler les secours si urgence", `${limited} refus`);

console.log(`\n══ BILAN : ${pass} vérifications réussies, ${fails.length} échec(s)`);
fails.forEach((f) => console.log("   ❌ " + f));
process.exit(fails.length ? 1 : 0);
